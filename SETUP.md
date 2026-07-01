# Setup — project-plantio

## Estrutura do repositório

```
project-plantio/
├── index.html                              ← redireciona para formulario.html (GitHub Pages root)
├── portal.html                             ← portal de download dos arquivos por fazenda
└── sistema_preenchimento/
    ├── formulario.html                     ← sistema de preenchimento (SPA) — inclui a aba Admin
    ├── favicon.svg
    ├── supabase_config.example.json         ← copiar pra supabase_config.json com a service_role key
    ├── planilha_config.example.json         ← copiar pra planilha_config.json com a senha da planilha
    ├── SINCRONIZAR_PLANILHA.bat             ← roda engine/sincronizar_planilha.py (write-back pra planilha)
    ├── logs/                                ← logs da engine (fora do git)
    ├── engine/
    │   ├── utils.py                         ← utilitários compartilhados (parse_talhoes, rollup, etc.)
    │   ├── sincronizar_planilha.py          ← write-back: Supabase → planilha de Sequência (via Excel/xlwings)
    │   └── requirements.txt
    ├── cloudflare-worker/
    │   └── release-proxy.js               ← Worker Cloudflare (upload de projeto + importação de demanda)
    └── supabase/
        └── migrations/
            ├── 20260624120000_plantio_schema_init.sql        ← cria o schema "plantio" (ver seção 2 e 5)
            ├── 20260624140000_plantio_grant_sequences.sql    ← grant em sequences (faltava na primeira)
            ├── 20260625000000_plantio_secure_writes.sql      ← funções RPC (registrar_bloco/usuarios)
            ├── 20260625000100_plantio_lock_down_anon.sql     ← revoga insert/update/delete do anon
            └── 20260625000200_plantio_grant_service_role.sql ← grants pra service_role (Worker/engine local)
```

A importação da demanda (Sequência de Plantio + Preparo + Base de Fazendas) e a
gestão de usuários deixaram de depender de pasta local — viraram a aba **Admin**
dentro do próprio `formulario.html` (ver seção 5). Só o **write-back de status
pra dentro da planilha** (`SINCRONIZAR_PLANILHA.bat`) continua sendo um script
local, porque precisa do Excel de verdade pra preservar a formatação condicional
da aba "Sequencia" — a aba Admin tem um botão que ajuda a instalar esse script
direto na pasta de rede onde a planilha mora (ver seção 5).

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
2. Aplique as migrations (cria o schema `plantio`, as tabelas, as funções RPC e os grants):
   ```bash
   supabase link --project-ref <PROJECT_REF_DO_PREPARO>
   supabase db push
   ```
   > As migrations usam nomes com timestamp (`2026062...`) de propósito, pra não colidir
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
   — mas **não use a mesma key do navegador aqui**. Desde a migration `20260625000100`, o role `anon`
   (a publishable key, pública, embutida no `formulario.html`) só tem `select` direto e as 3 funções RPC
   (`registrar_bloco`/`upsert_usuario`/`remover_usuario`) — não consegue mais inserir/atualizar linha
   nenhuma diretamente. A engine local (`SINCRONIZAR_PLANILHA.bat`) precisa da **service_role key**
   (Settings → API → Project API keys → revele "service_role") nesse arquivo. Essa key ignora RLS mas
   **não dispensa o grant de schema/tabela** — é por isso que existe a migration `20260625000200`
   (grant explícito pra `service_role`). Nunca coloque a service_role key no `formulario.html` (é
   pública) nem comite `supabase_config.json`.

## 3. Cloudflare Worker — proxy de upload e importação de demanda

1. No Cloudflare Dashboard → Workers & Pages → Create Worker.
2. Cole o conteúdo de `cloudflare-worker/release-proxy.js`.
3. Settings → Variables → Add secret: `GH_TOKEN` = PAT do GitHub com permissão `Contents: Read/Write` no repo `project-plantio`.
4. Settings → Variables → Add secret: `SUPABASE_SERVICE_KEY` = a mesma service_role key do passo 5 da
   seção 2 (Settings → API → Project API keys → "service_role"). É o que permite ao endpoint
   `/importar-demanda` escrever em massa em `programacao` sem passar pelo `anon` travado.
5. Anote a URL do worker (ex: `https://project-plantio-proxy.leonardo-malerbo.workers.dev`).
6. No `formulario.html`, substitua:
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

A demanda de Plantio cruza três fontes (ver lógica em `cloudflare-worker/release-proxy.js`,
função `importarDemanda`, e no parsing em `formulario.html`):

- **Sequência de Plantio** (aba `Sequencia`) — fazenda + talhões agrupados em **blocos**, Mês de Plantio (prazo), Ciclo, Ambiente.
- **Preparo** (aba `CONSERVAÇÃO`) — Sist. Conser. por talhão individual. A grafia
  na planilha varia (`EMBUTIDO`/`INTERCALADA`/`INTERCALADO`/`BASE LARGA`/`-`/`SEM DADOS`/vazio) e é
  normalizada pra um rótulo canônico — ver `normaliza_sist_conser()` em `engine/utils.py` e
  `normalizaSistConser()` em `formulario.html` (mantidas em sincronia manualmente):
  - `-`, `SEM DADOS` (e variações) → `''` (vazio)
  - `BASE LARGA` → `Base larga`
  - `EMBUTIDO`/`INTERCALADA`/`INTERCALADO` → `Embutido`
- **Base de Fazendas** — área (ha) por COD FAZ + TALHÃO (opcional — sem ela, talhões novos ficam com área 0).

A migration `20260624120000_plantio_schema_init.sql` cria `plantio.programacao` já com os campos
reais da operação: `projeto` (Pendente/Andamento/Ok), `sist_conser`, `mes_plantio`, `ambiente`,
`mapeamento` (Sim/Não) e `bloco_id` (chave de agrupamento por bloco, recalculada a cada importação —
ver comentário no topo do arquivo de migration).

**Regra de negócio**: blocos com `Sist. Conser.` = `Embutido` exigem `Mapeamento = Sim` antes do
`Projeto` poder avançar de Pendente — o formulário já aplica esse bloqueio automaticamente. Blocos
`Base larga`/vazio não têm o que mapear — `Mapeamento` já nasce/fica `Sim` automaticamente e o
toggle correspondente fica travado. Reimportar a demanda **nunca** mexe em talhões já `Andamento`/`Ok`.

### Aba Admin do formulário

Visível só pra usuários com o perfil `admin` (ver "Gerenciar Usuários" abaixo — o primeiro
usuário admin precisa ser concedido manualmente via `upsert_usuario` no SQL editor do Supabase
ou pela própria RPC, já que sem nenhum admin ninguém vê a aba). Três seções:

- **Usuários** — adicionar/remover usuário e seus perfis (`preenchimento`/`dashboard`/`admin`).
  Tudo salvo direto no Supabase via `upsert_usuario`/`remover_usuario`.
- **Atualizar Demanda** — seleciona a Sequência de Plantio + Preparo (Base de Fazendas opcional)
  e clica em Atualizar. O navegador faz todo o parsing (SheetJS) e manda os registros prontos pro
  Worker (`/importar-demanda`), que escreve no Supabase com a service_role key. Substitui o antigo
  `ATUALIZAR.bat`/`atualizar_programacao.py` (removidos).
- **Sincronizar Planilha** — só Chrome/Edge (usa a File System Access API). Concede acesso a uma
  pasta de rede (a mesma onde a Sequência de Plantio mora) uma vez, e a partir daí o botão
  "Instalar/atualizar arquivos" copia `SINCRONIZAR_PLANILHA.bat`, `engine/sincronizar_planilha.py`,
  `engine/utils.py`, `engine/requirements.txt` e os `.example.json` direto pra lá, sem download
  manual. A execução em si continua manual (duplo clique no `.bat` sempre que quiser atualizar o
  status na planilha) — não tem como disparar isso remotamente sem expor a rede local à internet.

### Segurança: o que a publishable key (anon) pode fazer

A key embutida no `formulario.html` é pública por natureza — qualquer um que abrir a página a vê.
Desde as migrations `20260625000000`/`20260625000100`, o role `anon` só pode:

- `select` direto em `programacao`/`usuarios`/`log_exportacoes` (precisa pra renderizar a tela);
- chamar 3 funções RPC (`security definer`, validam a entrada e só tocam as colunas certas):
  - `plantio.registrar_bloco(p_layers, p_mapeamento, p_projeto, p_usuario)` — usada pelo botão
    "Registrar"; atualiza `mapeamento`/`projeto` dos talhões do bloco e grava o log numa só
    transação.
  - `plantio.upsert_usuario(p_nome, p_perfis)` / `plantio.remover_usuario(p_nome)` — usadas pela
    aba Admin → Usuários; único jeito de escrever em `usuarios`.

Não há mais `insert`/`update`/`delete` direto nas tabelas pra `anon`. A importação de demanda em
massa (que toca `fazenda`/`área`/`prazo`, campos demais pra uma RPC pública) passa pelo Worker
(`SUPABASE_SERVICE_KEY`, seção 3), não pelo `anon` — ver `/importar-demanda` em `release-proxy.js`.

### Rodando o sincronizador de status (write-back pra planilha)

Preferencialmente pela aba Admin → "Sincronizar Planilha" (ver acima — instala os arquivos
automaticamente na pasta certa). Manualmente, os passos são:

1. Instale as dependências (uma vez): `pip install -r sistema_preenchimento/engine/requirements.txt`
   — inclui `xlwings`, que **precisa do Microsoft Excel instalado** na máquina (usa automação real do Excel
   pra preservar a formatação condicional e os dropdowns da planilha de Sequência, que `openpyxl` descartaria ao salvar).
2. Coloque `SINCRONIZAR_PLANILHA.bat`, a pasta `engine/` e a planilha de Sequência de Plantio
   **na mesma pasta** — o script procura o `.xlsx` no diretório onde ele está, não numa subpasta.
3. Copie `planilha_config.example.json` para `planilha_config.json` (na mesma pasta) e preencha
   `senha_plantio` com a senha de gravação da planilha (a aba está protegida — sem essa senha, o
   script abre em modo somente-leitura e "salva" sem gravar nada, sem aviso nenhum).
4. Duplo clique em **`SINCRONIZAR_PLANILHA.bat`** sempre que quiser refletir os registros feitos no
   formulário de volta na planilha de Sequência (colunas Sist. Conser./Mapeamento/Projeto-Mapa) — **feche a
   planilha no Excel antes de rodar**, senão a sincronização falha (arquivo em uso).

## 6. Backlog — melhorias futuras

- **Autenticação real no formulário.** Hoje "selecionar usuário" é só escolher um nome numa lista —
  sem senha, sem verificação de identidade; o `p_usuario` enviado pras RPCs (`registrar_bloco` etc.)
  é só um texto que o navegador informa, sem garantia de que é mesmo aquela pessoa. Trocar por login
  de verdade via **Supabase Auth** (email/senha ou magic link) daria identidade confiável por sessão,
  abriria a porta pra RLS por usuário autenticado (em vez de só "anon pode chamar a RPC") e tornaria
  o log de exportações inviolável. Trade-off: precisa criar conta de cada analista, tela de login e
  gerenciamento de sessão — desproporcional pro tamanho da equipe hoje, por isso ficou pra depois.
- Origin check no Cloudflare Worker (`/upload` e `/importar-demanda` aceitam chamada de qualquer
  lugar que souber a URL — sem autenticação real, isso só fica resolvido de fato junto do item acima).
- Ajuste de fuso (UTC vs. horário local) no cálculo de "entregue no prazo" do dashboard.
