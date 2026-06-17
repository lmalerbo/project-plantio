# Setup — project-plantio

## Estrutura do repositório

```
project-plantio/
├── index.html                              ← redireciona para formulario.html (GitHub Pages root)
├── portal.html                             ← portal de download dos arquivos por fazenda
└── sistema_preenchimento/
    ├── formulario.html                     ← sistema de preenchimento (SPA)
    ├── favicon.svg
    ├── cloudflare-worker/
    │   └── release-proxy.js               ← Worker Cloudflare (upload para Releases)
    └── supabase/
        └── migrations/
            ├── 0001_init.sql
            └── 0002_programacao_insert_anon.sql
```

## 1. GitHub — configurar Pages

1. Acesse o repo `lmalerbo/project-plantio` no GitHub.
2. Settings → Pages → Source: **Deploy from a branch** → Branch: `main` / `/ (root)`.
3. A URL do site será `https://lmalerbo.github.io/project-plantio/`.
4. O formulário estará em: `https://lmalerbo.github.io/project-plantio/sistema_preenchimento/formulario.html`
5. O portal estará em: `https://lmalerbo.github.io/project-plantio/portal.html`

## 2. Supabase — novo projeto

1. Crie um novo projeto em [supabase.com](https://supabase.com).
2. Anote o **Project URL** e a **Publishable key** (anon key).
3. Aplique as migrations:
   ```bash
   supabase link --project-ref <PROJECT_REF>
   supabase db push
   ```
4. No `formulario.html`, substitua os placeholders:
   ```js
   const SUPABASE_URL = 'PLACEHOLDER_PLANTIO_SUPABASE_URL';  // → URL real
   const SUPABASE_KEY = 'PLACEHOLDER_PLANTIO_SUPABASE_KEY';  // → anon key real
   ```

## 3. Cloudflare Worker — proxy de upload

1. No Cloudflare Dashboard → Workers & Pages → Create Worker.
2. Cole o conteúdo de `cloudflare-worker/release-proxy.js`.
3. Settings → Variables → Add secret: `GH_TOKEN` = PAT do GitHub com permissão `Contents: Read/Write` no repo `project-plantio`.
4. Anote a URL do worker (ex: `https://project-plantio-proxy.leonardo-malerbo.workers.dev`).
5. No `formulario.html`, substitua:
   ```js
   const RELEASE_PROXY_URL = 'PLACEHOLDER_PLANTIO_PROXY_URL';  // → URL real do worker
   ```

## 4. Nomenclatura dos arquivos de projeto

| Tipo       | Padrão                          | Exemplo                            |
|------------|---------------------------------|------------------------------------|
| Projeto    | `{COD_FAZ}_{NOME}_Rev0.dwg`    | `10503_SANTA LUZIA 5_Rev0.dwg`    |
| Exportação | `{COD_FAZ}_{NOME}_Exp0.zip`    | `10503_SANTA LUZIA 5_Exp0.zip`    |
| Mapa       | `{COD_FAZ}_{NOME}_Rev0.pdf`    | `10503_SANTA LUZIA 5_Rev0.pdf`    |

## 5. Base de dados (atualizar programação)

A base de demanda do **PLANTIO** será carregada via "⚙ Gerenciar → Atualizar base ICOL / Fazendas"
no formulário, ou via `engine/atualizar_programacao.py` (quando disponível).

> Campos específicos de PLANTIO serão definidos conforme o formato da base de dados da operação.
