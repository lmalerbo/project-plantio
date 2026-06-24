# Setup — project-plantio

## Estrutura do repositório

```
project-plantio/
├── index.html                              ← redireciona para formulario.html (GitHub Pages root)
├── portal.html                             ← portal de download dos arquivos por fazenda
└── sistema_preenchimento/
    ├── formulario.html                     ← sistema de preenchimento (SPA)
    ├── favicon.svg
    ├── config.json                         ← config geral da engine (codfaz_excluir_prefixo)
    ├── supabase_config.example.json         ← copiar pra supabase_config.json com a key real
    ├── planilha_config.example.json         ← copiar pra planilha_config.json com a senha da planilha
    ├── ATUALIZAR.bat                        ← roda engine/atualizar_programacao.py (import)
    ├── SINCRONIZAR_PLANILHA.bat             ← roda engine/sincronizar_planilha.py (write-back)
    ├── base_plantio/                        ← colocar aqui a planilha "SEQUÊNCIA DE PLANTIO" (.xlsx, fora do git)
    ├── base_preparo/                        ← colocar aqui a planilha "PREPARO" (.xlsx, fora do git)
    ├── base_fazendas/                       ← colocar aqui a base de fazendas (.xlsx, fora do git)
    ├── logs/                                ← logs das engines (fora do git)
    ├── engine/
    │   ├── utils.py                         ← utilitários compartilhados (parse_talhoes, rollup, etc.)
    │   ├── atualizar_programacao.py         ← import: Sequência + Preparo + Base Fazendas → Supabase
    │   ├── sincronizar_planilha.py          ← write-back: Supabase → planilha de Sequência (via Excel/xlwings)
    │   └── requirements.txt
    ├── cloudflare-worker/
    │   └── release-proxy.js               ← Worker Cloudflare (upload para Releases)
    └── supabase/
        └── migrations/
            └── 20260624120000_plantio_schema_init.sql  ← cria o schema "plantio" (ver seção 2 e 5)
```

## 1. GitHub — configurar Pages

1. Acesse o repo `lmalerbo/project-plantio` no GitHub.
2. Settings → Pages → Source: **Deploy from a branch** → Branch: `main` / `/ (root)`.
3. A URL do site será `https://lmalerbo.github.io/project-plantio/`.
4. O formulário estará em: `https://lmalerbo.github.io/project-plantio/sistema_preenchimento/formulario.html`
5. O portal estará em: `https://lmalerbo.github.io/project-plantio/portal.html`

## 2. Supabase — projeto compartilhado com o project-preparo

A conta tem limite de 2 projetos free (é por usuário, não por organization) e os 2 slots já
estão ocupados (`project-preparo` e `expo-safra`). Por isso o Plantio **reaproveita o mesmo
projeto Supabase do `project-preparo`**, isolado num schema Postgres próprio (`plantio`) —
nunca cria/altera nada em `public`, que pertence ao preparo.

1. Pegue o **Project URL** e a **Publishable key** do `project-preparo`
   (já estão em `project-preparo/sistema_preenchimento/supabase_config.json` localmente).
2. Aplique a migration (cria o schema `plantio` e as tabelas dentro dele):
   ```bash
   supabase link --project-ref <PROJECT_REF_DO_PREPARO>
   supabase db push
   ```
   > A migration usa um nome com timestamp (`20260624120000_...`) de propósito, pra não colidir
   > com as versões já aplicadas pelas migrations do próprio `project-preparo` nesse mesmo projeto.
3. No **Supabase Dashboard → Settings → API → Data API Settings → Exposed schemas**, adicione
   `plantio` à lista (além de `public`) — sem isso a API responde como se as tabelas não existissem.
4. No `formulario.html`, substitua os placeholders pelos mesmos valores do preparo:
   ```js
   const SUPABASE_URL = 'PLACEHOLDER_PLANTIO_SUPABASE_URL';  // → URL do projeto (mesma do preparo)
   const SUPABASE_KEY = 'PLACEHOLDER_PLANTIO_SUPABASE_KEY';  // → anon key (mesma do preparo)
   ```
   As chamadas já incluem os headers `Accept-Profile`/`Content-Profile: plantio` (ver `_sbHeaders`
   em `formulario.html` e `SB_HEADERS` na engine) — é isso que direciona pro schema certo.
5. Copie `sistema_preenchimento/supabase_config.example.json` para `sistema_preenchimento/supabase_config.json`
   com a mesma URL/key — é o que `ATUALIZAR.bat`/`SINCRONIZAR_PLANILHA.bat` usam (nunca commitar esse arquivo).

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

Enviados pelo botão **"📎 Arquivos do projeto"** no painel de cada bloco, dentro do formulário.

## 5. Modelo de dados (Plantio)

A demanda de Plantio cruza três fontes (ver detalhes no código de `engine/atualizar_programacao.py`):

- **Sequência de Plantio** (`base_plantio/*.xlsx`, aba `Sequencia`) — fazenda + talhões agrupados em **blocos**, Mês de Plantio (prazo), Ciclo, Ambiente.
- **Preparo** (`base_preparo/*.xlsx`, aba `CONSERVAÇÃO`) — Sist. Conser. por talhão individual. A grafia
  na planilha varia (`EMBUTIDO`/`INTERCALADA`/`INTERCALADO`/`BASE LARGA`/`-`/`SEM DADOS`/vazio) e é
  normalizada pra um rótulo canônico — ver `normaliza_sist_conser()` em `engine/utils.py` e
  `normalizaSistConser()` em `formulario.html` (mantidas em sincronia manualmente):
  - `-`, `SEM DADOS` (e variações) → `''` (vazio)
  - `BASE LARGA` → `Base larga`
  - `EMBUTIDO`/`INTERCALADA`/`INTERCALADO` → `Embutido`
- **Base de Fazendas** (`base_fazendas/*.xlsx`) — área (ha) por COD FAZ + TALHÃO.

A migration `20260624120000_plantio_schema_init.sql` cria `plantio.programacao` já com os campos
reais da operação: `projeto` (Pendente/Andamento/Ok), `sist_conser`, `mes_plantio`, `ambiente`,
`mapeamento` (Sim/Não) e `bloco_id` (chave de agrupamento por bloco, recalculada pela engine —
ver comentário no topo do arquivo de migration).

**Regra de negócio**: blocos com `Sist. Conser.` = `Embutido` exigem `Mapeamento = Sim` antes do
`Projeto` poder avançar de Pendente — o formulário já aplica esse bloqueio automaticamente. Blocos
`Base larga`/vazio não têm o que mapear — `Mapeamento` já nasce/fica `Sim` automaticamente (engine
e formulário) e o toggle correspondente fica travado.

### Rodando a engine

1. Instale as dependências (uma vez): `pip install -r sistema_preenchimento/engine/requirements.txt`
   — inclui `xlwings`, que **precisa do Microsoft Excel instalado** na máquina (usa automação real do Excel
   pra preservar a formatação condicional e os dropdowns da planilha de Sequência, que `openpyxl` descartaria ao salvar).
2. Coloque os arquivos `.xlsx` mais recentes em `base_plantio/`, `base_preparo/` e `base_fazendas/` (um arquivo por pasta).
3. Copie `planilha_config.example.json` para `planilha_config.json` e preencha `senha_plantio` com a senha de
   gravação da planilha de Sequência (a aba está protegida — sem essa senha, o `SINCRONIZAR_PLANILHA.bat` abre o
   arquivo como somente-leitura e "salva" sem gravar nada, sem aviso nenhum).
4. Duplo clique em **`ATUALIZAR.bat`** — importa a demanda pro Supabase, preservando Mapeamento/Projeto já
   registrados pelos analistas.
5. Duplo clique em **`SINCRONIZAR_PLANILHA.bat`** sempre que quiser refletir os registros feitos no
   formulário de volta na planilha de Sequência (colunas Sist. Conser./Mapeamento/Projeto-Mapa) — **feche a
   planilha no Excel antes de rodar**, senão a sincronização falha (arquivo em uso).
