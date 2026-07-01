// Proxy para upload de arquivos de projeto (.dwg/.zip/.pdf) nas Releases do GitHub
// e para a importação de demanda (Sequência de Plantio + Preparo) no Supabase.
//
// Motivo do upload: o formulario.html é estático e público (GitHub Pages) — qualquer
// token do GitHub embutido nele é detectado e revogado automaticamente pelo secret
// scanning. Este Worker guarda o token como secret do Cloudflare (nunca commitado).
//
// Motivo do /importar-demanda: desde a migration 20260625000100, o role "anon"
// (chave pública do formulario.html) não tem mais insert/update direto em
// plantio.programacao — só select e as funções RPC de registrar_bloco/usuarios.
// Importar a demanda mexe em muito mais colunas (fazenda, área, prazo, etc) do
// que essas RPCs deixam, então em vez de abrir uma RPC nova e pública pra isso,
// o navegador só faz o parsing das planilhas e manda os dados pra cá — este
// Worker escreve no Supabase com a service_role key (bypassa RLS), do mesmo
// jeito que a engine Python local fazia antes do ATUALIZAR.bat ser aposentado.
//
// Deploy (via dashboard do Cloudflare):
//   1. Workers & Pages → Create → Create Worker → cole este arquivo.
//   2. Settings → Variables → Add secret: GH_TOKEN = <PAT com permissão "Contents"
//      read/write no repo lmalerbo/project-plantio>.
//   3. Settings → Variables → Add secret: SUPABASE_SERVICE_KEY = <service_role key
//      do projeto Supabase compartilhado — Settings → API → Project API keys>.
//   4. Anote a URL do worker (https://<nome>.<conta>.workers.dev) e configure
//      RELEASE_PROXY_URL no formulario.html com esse valor.

const GH_OWNER = 'lmalerbo';
const GH_REPO  = 'project-plantio';
const ALLOWED_ORIGIN = 'https://lmalerbo.github.io';
const SUPABASE_URL = 'https://msdkrkakuwmskoidxmxl.supabase.co';

// Mesma regra de exclusão administrativa de engine/atualizar_programacao.py
// (config.json, que deixou de existir junto com esse script).
const CODFAZ_EXCLUIR_PREFIXO = '20';

// Mantenha em sincronia com SIST_CONSER_PRECISA_MAPEAMENTO em
// formulario.html/engine/utils.py — não há como compartilhar código aqui.
const SIST_CONSER_PRECISA_MAPEAMENTO = new Set(['Embutido']);

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function ghHeaders(env, extra) {
  return Object.assign({
    'Authorization': `Bearer ${env.GH_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'project-plantio-release-proxy',
  }, extra || {});
}

function sbHeaders(env, extra) {
  return Object.assign({
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Accept-Profile': 'plantio',
    'Content-Profile': 'plantio',
  }, extra || {});
}

async function getOrCreateRelease(env, tag, name) {
  let res = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/tags/${tag}`,
    { headers: ghHeaders(env) });
  if (res.status === 404) {
    res = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases`, {
      method: 'POST',
      headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ tag_name: tag, name, target_commitish: 'main' }),
    });
  }
  if (!res.ok) throw new Error(`release ${tag}: ${res.status} ${await res.text()}`);
  return res.json();
}

// Rollup de Sist. Conser. por bloco: qualquer Embutido → bloco inteiro Embutido;
// senão, vale o valor com mais ocorrências. Mirror de rollupSistConser() em
// formulario.html / rollup_sist_conser() em engine/utils.py.
function rollupSistConser(valores) {
  const vals = valores.filter(Boolean);
  if (!vals.length) return '';
  if (vals.some(v => SIST_CONSER_PRECISA_MAPEAMENTO.has(v))) return 'Embutido';
  const counts = {};
  vals.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

// Importa a demanda (registros já parseados/explodidos pelo navegador) — porta
// fiel de engine/atualizar_programacao.py (etapas 1 e 6 em diante).
async function importarDemanda(env, talhoes) {
  // 1. Estado atual (preservar Mapeamento/Projeto de layers existentes).
  const preservedRes = await fetch(
    `${SUPABASE_URL}/rest/v1/programacao?select=layer,mapeamento,projeto`,
    { headers: sbHeaders(env) }
  );
  if (!preservedRes.ok) throw new Error(`leitura programacao: ${preservedRes.status} ${await preservedRes.text()}`);
  const preserved = new Map();
  for (const row of await preservedRes.json()) {
    preserved.set(String(row.layer), { mapeamento: row.mapeamento || 'Não', projeto: row.projeto || 'Pendente' });
  }

  // 2. Dedupe por layer (último ganha) — o navegador já manda deduplicado, reforça aqui.
  const porLayer = new Map();
  for (const t of talhoes) {
    const layer = Number(t.layer);
    const codFaz = Number(t.cod_faz);
    const talhao = Number(t.talhao);
    if (!Number.isFinite(layer) || !Number.isFinite(codFaz) || !Number.isFinite(talhao)) continue;
    if (String(codFaz).startsWith(CODFAZ_EXCLUIR_PREFIXO)) continue;
    porLayer.set(String(layer), {
      layer, cod_faz: codFaz, talhao,
      periodo_op: t.periodo_op ?? null,
      fazenda: String(t.fazenda ?? '').trim(),
      area_ha: Number(t.area_ha) || 0,
      mes_plantio: t.mes_plantio || null,
      ciclo: String(t.ciclo ?? '').trim(),
      ambiente: String(t.ambiente ?? '').trim(),
      sist_conser: String(t.sist_conser ?? '').trim(),
      bloco_id: String(t.bloco_id ?? ''),
    });
  }

  // 3. Rollup de Sist. Conser. por bloco.
  const blocoSistConser = new Map();
  for (const rec of porLayer.values()) {
    const arr = blocoSistConser.get(rec.bloco_id) || [];
    arr.push(rec.sist_conser);
    blocoSistConser.set(rec.bloco_id, arr);
  }
  const blocoRollup = new Map();
  for (const [blocoId, vals] of blocoSistConser) blocoRollup.set(blocoId, rollupSistConser(vals));

  function statusInicial(blocoId, mapeamento) {
    const sc = blocoRollup.get(blocoId) || '';
    if (SIST_CONSER_PRECISA_MAPEAMENTO.has(sc) && mapeamento !== 'Sim') return 'Aguard. Map.';
    return 'Pendente';
  }

  // 4. Monta linhas finais (preserva Mapeamento/Projeto de layers já existentes,
  //    nunca mexe em Andamento/Ok — só recalcula Pendente/Aguard. Map.).
  let novos = 0, corrigidos = 0, mapeamentoCorrigido = 0, semArea = 0, semSistConser = 0;
  const progRows = [];
  for (const rec of porLayer.values()) {
    if (!rec.area_ha) semArea++;
    if (!rec.sist_conser) semSistConser++;
    const scBloco = blocoRollup.get(rec.bloco_id) || '';
    const semMapeamentoPendente = !SIST_CONSER_PRECISA_MAPEAMENTO.has(scBloco);
    const lyStr = String(rec.layer);
    let mapeamento, projeto;
    if (preserved.has(lyStr)) {
      const p = preserved.get(lyStr);
      mapeamento = p.mapeamento;
      projeto = p.projeto;
      if (semMapeamentoPendente && mapeamento !== 'Sim') {
        mapeamento = 'Sim';
        mapeamentoCorrigido++;
      }
      if (projeto === 'Pendente' || projeto === 'Aguard. Map.') {
        const novoProjeto = statusInicial(rec.bloco_id, mapeamento);
        if (novoProjeto !== projeto) corrigidos++;
        projeto = novoProjeto;
      }
    } else {
      mapeamento = semMapeamentoPendente ? 'Sim' : 'Não';
      projeto = statusInicial(rec.bloco_id, mapeamento);
      novos++;
    }
    progRows.push({ ...rec, mapeamento, projeto });
  }

  // 5. Upsert em lotes de 500.
  const BATCH = 500;
  for (let i = 0; i < progRows.length; i += BATCH) {
    const chunk = progRows.slice(i, i + BATCH);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/programacao`, {
      method: 'POST',
      headers: sbHeaders(env, { 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(chunk),
    });
    if (!res.ok) throw new Error(`upsert lote ${i}-${i + chunk.length}: ${res.status} ${await res.text()}`);
  }

  // 6. Aviso de layers preenchidos que sumiram da nova base (dado continua no
  //    Supabase, só não recebe mais atualização da planilha).
  const layersNovos = new Set(progRows.map(r => String(r.layer)));
  const removidos = [];
  for (const [ly, p] of preserved) {
    const temPreenchimento = (p.mapeamento && p.mapeamento !== 'Não') || (p.projeto && p.projeto !== 'Pendente');
    if (temPreenchimento && !layersNovos.has(ly)) removidos.push({ layer: ly, mapeamento: p.mapeamento, projeto: p.projeto });
  }

  return {
    totalEnviado: progRows.length, novos, corrigidos, mapeamentoCorrigido,
    semArea, semSistConser, preservados: progRows.length - novos, removidos,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === '/upload' && request.method === 'POST') {
        const tag      = url.searchParams.get('tag');
        const name     = url.searchParams.get('name') || tag;
        const filename = url.searchParams.get('filename');
        if (!tag || !filename) {
          return new Response('tag e filename são obrigatórios', { status: 400, headers: corsHeaders() });
        }

        const release = await getOrCreateRelease(env, tag, name);

        const existente = (release.assets || []).find(a => a.name === filename);
        if (existente) {
          await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/assets/${existente.id}`,
            { method: 'DELETE', headers: ghHeaders(env) });
        }

        const uploadUrl = release.upload_url.replace('{?name,label}', '') + `?name=${encodeURIComponent(filename)}`;
        const res = await fetch(uploadUrl, {
          method: 'POST',
          headers: ghHeaders(env, { 'Content-Type': request.headers.get('Content-Type') || 'application/octet-stream' }),
          body: await request.arrayBuffer(),
        });
        if (!res.ok) throw new Error(`upload ${filename}: ${res.status} ${await res.text()}`);

        return new Response(await res.text(), { headers: { ...corsHeaders(), 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/importar-demanda' && request.method === 'POST') {
        const body = await request.json();
        if (!Array.isArray(body.talhoes) || !body.talhoes.length) {
          return new Response('talhoes (array não vazio) é obrigatório', { status: 400, headers: corsHeaders() });
        }
        const resumo = await importarDemanda(env, body.talhoes);
        return new Response(JSON.stringify(resumo), { headers: { ...corsHeaders(), 'Content-Type': 'application/json' } });
      }

      return new Response('Not found', { status: 404, headers: corsHeaders() });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }
  },
};
