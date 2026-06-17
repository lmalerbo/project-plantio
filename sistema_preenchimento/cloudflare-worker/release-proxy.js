// Proxy para upload de arquivos de projeto (.dwg/.zip/.pdf) nas Releases do GitHub.
//
// Motivo: o formulario.html é estático e público (GitHub Pages) — qualquer token do GitHub
// embutido nele é detectado e revogado automaticamente pelo secret scanning. Este Worker
// guarda o token como secret do Cloudflare (nunca commitado) e expõe dois endpoints que o
// formulario.html chama sem precisar de credencial nenhuma.
//
// Deploy (via dashboard do Cloudflare):
//   1. Workers & Pages → Create → Create Worker → cole este arquivo.
//   2. Settings → Variables → Add secret: GH_TOKEN = <PAT com permissão "Contents" read/write
//      no repo lmalerbo/project-plantio>.
//   3. Anote a URL do worker (https://<nome>.<conta>.workers.dev) e configure
//      RELEASE_PROXY_URL no formulario.html com esse valor.

const GH_OWNER = 'lmalerbo';
const GH_REPO  = 'project-plantio';
const ALLOWED_ORIGIN = 'https://lmalerbo.github.io';

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

      return new Response('Not found', { status: 404, headers: corsHeaders() });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    }
  },
};
