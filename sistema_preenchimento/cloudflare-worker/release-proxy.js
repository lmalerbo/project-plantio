// Proxy para upload de arquivos de projeto (.dwg/.zip/.pdf) nas Releases do GitHub,
// importação de demanda (Sequência de Plantio) e atualização de Preparo (Sist. Conser.).
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
// Chave anon pública — já exposta em formulario.html, pode ficar hardcoded aqui.
const SUPABASE_ANON_KEY = 'sb_publishable_eJA9YDyXdRI73lqPPYnATA_INEU3vzu';

// Mesma regra de exclusão administrativa de engine/atualizar_programacao.py
// (config.json, que deixou de existir junto com esse script).
const CODFAZ_EXCLUIR_PREFIXO = '20';

// Mantenha em sincronia com SIST_CONSER_MAPEAMENTO_AUTO em
// formulario.html — não há como compartilhar código aqui.
const SIST_CONSER_MAPEAMENTO_AUTO = new Set(['Base Larga', 'Livre']);

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// CORS aberto apenas para endpoints de relatório (somente-leitura, dado não sensível).
function corsHeadersOpen() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

// Headers de leitura com anon key pública — suficiente para SELECT sem RLS especial.
function sbAnonHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Accept-Profile': 'plantio',
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
  if (vals.some(v => v === 'Embutido')) return 'Embutido';
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
      seq_plantio: String(t.seq_plantio ?? '').trim(),
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
    if (!SIST_CONSER_MAPEAMENTO_AUTO.has(sc) && mapeamento !== 'Sim') return 'Aguard. Map.';
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
    const autoSim = SIST_CONSER_MAPEAMENTO_AUTO.has(scBloco);
    const lyStr = String(rec.layer);
    let mapeamento, projeto;
    if (preserved.has(lyStr)) {
      const p = preserved.get(lyStr);
      mapeamento = p.mapeamento;
      projeto = p.projeto;
      if (autoSim && mapeamento !== 'Sim') {
        mapeamento = 'Sim';
        mapeamentoCorrigido++;
      }
      if (projeto === 'Pendente' || projeto === 'Aguard. Map.') {
        const novoProjeto = statusInicial(rec.bloco_id, mapeamento);
        if (novoProjeto !== projeto) corrigidos++;
        projeto = novoProjeto;
      }
    } else {
      mapeamento = autoSim ? 'Sim' : 'Não';
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

// Atualiza APENAS sist_conser dos talhões já existentes na programação,
// sem reimportar a demanda inteira. Preserva todos os outros campos.
async function atualizarPreparo(env, camadas) {
  const updateMap = new Map(camadas.map(c => [Number(c.layer), String(c.sist_conser ?? '').trim()]));

  const res = await fetch(`${SUPABASE_URL}/rest/v1/programacao?select=*`, { headers: sbHeaders(env) });
  if (!res.ok) throw new Error(`leitura programacao: ${res.status} ${await res.text()}`);
  const rows = await res.json();

  const toUpsert = [];
  let mapeamentoCorrigido = 0;
  for (const row of rows) {
    const layer = Number(row.layer);
    if (!updateMap.has(layer)) continue;
    const newSc = updateMap.get(layer);
    if (newSc === (row.sist_conser || '')) continue;
    const updated = { ...row, sist_conser: newSc };
    if (SIST_CONSER_MAPEAMENTO_AUTO.has(newSc) && row.mapeamento !== 'Sim') {
      updated.mapeamento = 'Sim';
      mapeamentoCorrigido++;
    }
    toUpsert.push(updated);
  }

  const BATCH = 500;
  for (let i = 0; i < toUpsert.length; i += BATCH) {
    const chunk = toUpsert.slice(i, i + BATCH);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/programacao`, {
      method: 'POST',
      headers: sbHeaders(env, { 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(chunk),
    });
    if (!r.ok) throw new Error(`upsert preparo lote ${i}: ${r.status} ${await r.text()}`);
  }

  const layersExistentes = new Set(rows.map(r => Number(r.layer)));
  const semCorrespondencia = [...updateMap.keys()].filter(l => !layersExistentes.has(l)).length;
  return { atualizados: toUpsert.length, semCorrespondencia, mapeamentoCorrigido };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      const h = url.pathname.startsWith('/report/') ? corsHeadersOpen() : corsHeaders();
      return new Response(null, { headers: h });
    }
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

      if (url.pathname === '/atualizar-preparo' && request.method === 'POST') {
        const body = await request.json();
        if (!Array.isArray(body.camadas) || !body.camadas.length) {
          return new Response('camadas (array não vazio) é obrigatório', { status: 400, headers: corsHeaders() });
        }
        const resumo = await atualizarPreparo(env, body.camadas);
        return new Response(JSON.stringify(resumo), { headers: { ...corsHeaders(), 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/releases' && request.method === 'GET') {
        const tags = [];
        let page = 1;
        while (true) {
          const res = await fetch(
            `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases?per_page=100&page=${page}`,
            { headers: ghHeaders(env) }
          );
          if (!res.ok) throw new Error(`releases pág. ${page}: ${res.status}`);
          const data = await res.json();
          if (!data.length) break;
          tags.push(...data.map(r => r.tag_name));
          if (data.length < 100) break;
          page++;
        }
        return new Response(JSON.stringify(tags), { headers: { ...corsHeaders(), 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/report/fazendas' && request.method === 'GET') {
        const res = await fetch(
          `${SUPABASE_URL}/rest/v1/programacao?select=cod_faz,fazenda,projeto,sist_conser&order=cod_faz`,
          { headers: sbAnonHeaders() }
        );
        if (!res.ok) throw new Error(`fazendas: ${res.status} ${await res.text()}`);
        const rows = await res.json();

        // Agrupa por cod_faz
        const fazMap = new Map();
        for (const row of rows) {
          if (!fazMap.has(row.cod_faz)) fazMap.set(row.cod_faz, { cod_faz: row.cod_faz, fazenda: row.fazenda, _talhoes: [] });
          fazMap.get(row.cod_faz)._talhoes.push(row);
        }

        // Mesmo cálculo de getFazStatus() do formulario.html
        const fazendas = [];
        for (const [, faz] of fazMap) {
          const projetos = faz._talhoes.map(t => t.projeto);
          let status;
          if (projetos.every(p => p === 'Ok')) status = 'OK';
          else if (projetos.some(p => p === 'Andamento' || p === 'Ok')) status = 'ANDAMENTO';
          else status = 'PENDENTE';
          const sist_conser = rollupSistConser(faz._talhoes.map(t => t.sist_conser));
          fazendas.push({ cod_faz: faz.cod_faz, fazenda: faz.fazenda, status, sist_conser, total_talhoes: faz._talhoes.length });
        }
        fazendas.sort((a, b) => a.cod_faz - b.cod_faz);

        return new Response(JSON.stringify(fazendas), {
          headers: { ...corsHeadersOpen(), 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/report/talhoes' && request.method === 'GET') {
        const res = await fetch(
          `${SUPABASE_URL}/rest/v1/programacao` +
          `?select=layer,cod_faz,fazenda,talhao,periodo_op,ciclo,area_ha,mes_plantio,ambiente,sist_conser,mapeamento,projeto,bloco_id` +
          `&order=cod_faz,talhao`,
          { headers: sbAnonHeaders() }
        );
        if (!res.ok) throw new Error(`talhoes: ${res.status} ${await res.text()}`);
        const rows = await res.json();
        return new Response(JSON.stringify(rows), {
          headers: { ...corsHeadersOpen(), 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not found', { status: 404, headers: corsHeaders() });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }
  },
};
