# Estúdio de Anúncios — Upload real da foto do produto — STATUS

> Arquivo de handoff. Se a conversa travar/reiniciar, este documento
> tem tudo que é preciso para retomar do zero, sem perder contexto.
> Última atualização: 2026-08-05.

## 1. Onde estamos

Tarefa em andamento: **"ETAPA — UPLOAD REAL DA FOTO DO PRODUTO"**, dentro
do módulo Central de IA / Estúdio de Anúncios com IA. Ainda **nenhum
código foi escrito** para esta tarefa. O único passo concreto já feito
foi uma migration de banco, já executada e validada (seção 3).

Duas decisões do usuário ainda travam o início da implementação
(seção 4). Depois delas, a implementação segue o plano da seção 5.

## 2. Escopo autorizado (regras que não podem ser violadas)

**Pode alterar:**
- `app/(app)/central-ia/estudio-anuncios/novo/page.tsx`
- `app/(app)/central-ia/estudio-anuncios/[projetoId]/page.tsx`
- `app/api/estudio-anuncios/projetos/[id]/fotos/route.ts`
- `app/api/estudio-anuncios/projetos/[id]/route.ts`
- `lib/estudio-anuncios/tipos.ts`
- `lib/estudio-anuncios/supabase-servidor.ts` (só se necessário)
- `lib/estudio-anuncios/validacao.ts` (só se necessário)

**Pode criar:**
- `lib/estudio-anuncios/fotos.ts`
- `lib/estudio-anuncios/storage.ts`

**Proibido tocar sem parar e pedir autorização:** qualquer outro
arquivo. **Proibido tocar, ponto final:** Worker
(`scripts/estudio-anuncios-worker.mjs`), Gateway, executor de jobs,
catálogo, RPCs já executadas, Sidebar, páginas fora da Central de IA.

**Não implementar nesta tarefa:** Gemini, OpenAI, Claude, Veo, geração
de imagem/vídeo, "Funcionários IA". Nenhuma IA analisa a foto nesta
fase.

## 3. O que já foi confirmado / executado

- Rota `app/api/estudio-anuncios/projetos/[id]/fotos/route.ts` é hoje
  um placeholder 501 (`{ok:false, erro:"Não implementado (Fase 0)"}`).
- Schema real de `estudio_anuncios_imagens_origem` (confirmado por SQL
  direto, não por suposição):
  ```
  id             uuid            NOT NULL (PK)
  projeto_id     uuid            NOT NULL (FK -> estudio_anuncios_projetos, ON DELETE CASCADE)
  storage_path   text            NOT NULL
  ordem          integer         NOT NULL (CHECK ordem > 0)
  e_principal    boolean         NOT NULL DEFAULT false
  largura_px     integer         NULL (CHECK >= 0 ou NULL)
  altura_px      integer         NULL (CHECK >= 0 ou NULL)
  tamanho_bytes  integer         NULL (CHECK >= 0 ou NULL)
  criado_em      timestamptz     NOT NULL DEFAULT now()
  mime_type      text            NULL (CHECK IN ('image/jpeg','image/png','image/webp') ou NULL)  -- NOVO
  nome_original  text            NULL  -- NOVO
  ```
  Índice único parcial já existente (não criado agora):
  `idx_imagens_origem_principal ON estudio_anuncios_imagens_origem (projeto_id) WHERE e_principal = true`.
  Índice comum já existente: `idx_imagens_origem_projeto (projeto_id)`.

- **Migration nova, já criada e EXECUTADA COM SUCESSO pelo usuário**
  (verificado por duas queries de pós-checagem — colunas e constraints
  batem exatamente com o esperado):
  `supabase/migrations/20260808_estudio_anuncios_imagens_origem_add_mime.sql`
  ```sql
  ALTER TABLE estudio_anuncios_imagens_origem
    ADD COLUMN IF NOT EXISTS mime_type TEXT
      CHECK (mime_type IS NULL OR mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
    ADD COLUMN IF NOT EXISTS nome_original TEXT;

  COMMENT ON COLUMN estudio_anuncios_imagens_origem.mime_type IS
    'MIME real detectado por assinatura de bytes (nunca confiado do client). Restrito ao mesmo conjunto aprovado do bucket estudio-anuncios-originais.';
  COMMENT ON COLUMN estudio_anuncios_imagens_origem.nome_original IS
    'Nome do arquivo enviado pelo usuário, só para exibição — nunca usado para montar o caminho no Storage.';
  ```
  Este arquivo de migration **já existe no repositório** — não recriar.

- Nenhuma biblioteca de imagem/assinatura de arquivo existe hoje no
  projeto (`file-type`/`sharp`/`image-size`/`mmmagic` — 0 no
  `package.json`).
- Nenhum uso de Supabase Storage existe hoje em nenhum arquivo do
  repositório (`storage.from(`/`createSignedUrl` — 0 ocorrências).
  Esta implementação será a primeira.
- Bucket `estudio-anuncios-originais`: segundo o usuário, já existe,
  já é privado, já aprovado (máx. 10MB/arquivo, MIME
  jpeg/png/webp). Não recriar nem reconfigurar — eu não tenho acesso
  para verificar isso ao vivo, confio na afirmação do usuário.
- `next/server` Route Handlers suportam `request.formData()`
  nativamente (Web API) — **multipart/form-data não precisa de
  nenhuma lib nova** (nem `formidable`, nem `busboy`).

## 4. Decisões do usuário ainda PENDENTES (bloqueando o início do código)

### Decisão 1 — biblioteca para assinatura real de arquivo + dimensões
Opções apresentadas ao usuário:
- **`image-size`** (recomendação) — puro JS, detecta formato pelo
  conteúdo real do buffer, devolve `{width, height, type}` para
  JPEG/PNG/WebP. Resolve sozinho tanto a exigência de "assinatura
  real" quanto a de dimensões.
- `file-type` — só assinatura/MIME, sem dimensões (precisaria de uma
  segunda lib). Versões recentes são ESM-only.
- `sharp` — completo, mas binário nativo pré-compilado por
  plataforma, desproporcional para uma tarefa que não redimensiona
  nada nesta fase.
- Nenhuma lib — implementação manual em TypeScript (magic bytes:
  `FF D8 FF` JPEG, `89 50 4E 47 0D 0A 1A 0A` PNG, `RIFF....WEBP`
  WebP; parsers de dimensão por offset fixo). ~80-100 linhas, sem
  dependência nova.

**Ainda sem resposta do usuário.**

### Decisão 2 — mensagem da tarefa aparentemente cortada
A mensagem original do usuário ("ETAPA — UPLOAD REAL DA FOTO DO
PRODUTO") termina no meio do bloco de código `RESPOSTA DA ROTA`
(o JSON de sucesso), sem seção de resposta de erro, sem checklist de
`ENTREGA`, sem instrução de encerramento — diferente de todas as
tarefas anteriores deste projeto, que sempre tiveram essas seções.

Duas opções colocadas ao usuário:
- Colar o restante da mensagem original; ou
- Autorizar Claude a completar esses pontos por conta própria (formato
  de erro já padronizado do módulo `{ok:false, erro}`, e uma lista de
  `ENTREGA` proposta no relatório final).

**Ainda sem resposta do usuário.**

## 5. Spec completa da tarefa (texto recebido do usuário, verbatim, preservado)

- Objetivo: permitir, na criação/edição do Projeto Mestre, upload real
  de fotos do produto. Fotos devem ser: validadas no servidor;
  armazenadas no bucket **privado** `estudio-anuncios-originais`;
  registradas em `estudio_anuncios_imagens_origem`; vinculadas a
  usuário+projeto; exibidas via **URL assinada** (nunca pública);
  servirão futuramente de input para o Gemini. **Nenhuma IA analisa a
  foto nesta fase.**
- Fluxo final: usuário preenche nome do produto → seleciona
  marketplaces → escolhe quantidade de imagens → seleciona 1 a 10
  fotos reais → vê previews locais → cria o Projeto Mestre → **depois**
  da criação, as fotos são enviadas → tela de detalhe mostra as fotos
  via URLs assinadas. O CRUD de criação do projeto já existe e **não**
  deve ser refeito.
- **Decisão de fluxo (seguir exatamente)**: o projeto deve ser criado
  primeiro (`POST /api/estudio-anuncios/projetos` já existente, 201).
  Só **depois** desse 201 a UI envia as fotos para
  `POST /api/estudio-anuncios/projetos/[id]/fotos` (hoje placeholder,
  a ser implementada). Se a criação do projeto for bem-sucedida mas o
  upload de alguma foto falhar: não apagar o projeto automaticamente;
  informar quais arquivos falharam; permitir nova tentativa; não
  iniciar o Pipeline automaticamente; nunca deixar uma linha de imagem
  no banco sem o objeto correspondente no Storage.
- **Segurança da rota de fotos**, ordem exata: (1) `getUserId(request)`;
  (2) validar UUID do projeto; (3) buscar projeto por `id` + `user_id`
  da sessão; (4) 404 tanto para projeto inexistente quanto de outro
  usuário; (5) nunca aceitar `user_id` do frontend; (6) usar service
  role só depois de validada a propriedade; (7) nunca devolver a chave
  do Storage; (8) nunca criar URL pública. O caminho do objeto deve
  ser montado exclusivamente no servidor.
- **Bucket**: só `estudio-anuncios-originais`, já existe, privado,
  configuração já aprovada (máx. 10MB/arquivo, MIME jpeg/png/webp).
  Não alterar configuração do bucket nem criar um novo.
- **Convenção de caminho** (determinística, isolada):
  `{user_id}/{projeto_id}/{imagem_id}/{nome_seguro}`. Regras: nunca
  confiar no nome original para segurança; sanitizar o nome; remover
  caracteres perigosos; prevenir `../`; gerar um UUID para
  `imagem_id`; preservar extensão compatível com o MIME validado;
  nunca permitir sobrescrita acidental. Banco deve registrar apenas:
  bucket; caminho do objeto; MIME; tamanho; dimensões (quando obtidas
  com segurança); ordem; indicador de principal; nome original **se a
  tabela tiver coluna apropriada** (agora tem — `nome_original`, ver
  seção 3). Nunca guardar a URL assinada no banco.
- **Validação de arquivo**: aceitar JPEG/PNG/WebP; ≤10MB/arquivo; 1-10
  fotos por projeto; contagem existente + novos arquivos não pode
  ultrapassar 10 no total. Validar: MIME declarado; extensão;
  assinatura real do arquivo ("se viável sem dependência pesada");
  arquivo vazio; contagem; tamanho; projeto cancelado. Não confiar só
  em `file.type`. "Se a validação real da assinatura exigir biblioteca
  nova, pare e apresente a dependência antes de instalar. Não instalar
  bibliotecas sem aprovação."
- **Dimensões**: a foto original não precisa ser 1200x1200 nesta fase
  (é a fonte real do produto). Registrar dimensões originais quando
  possível. Não redimensionar, recortar, nem comprimir de forma
  destrutiva. Futuro: uma "imagem mestre" será criada; imagens
  exportadas para marketplaces serão 1200x1200; a original deve
  permanecer intacta.
- **Banco**: usar `estudio_anuncios_imagens_origem`. "Antes de
  implementar, confirme o schema real da tabela. Mapear apenas colunas
  que realmente existem. Não criar migration sem necessidade." (Já
  feito — seção 3; migration mínima criada e aprovada pelo próprio
  usuário ao decidir a Decisão 1 do handoff anterior — na prática, ao
  escolher "criar migration mínima" na pergunta feita.) Cada registro
  deve vincular: `projeto_id`; Storage; caminho; tipo; tamanho; ordem;
  indicador de principal. Regras: primeira foto do projeto pode ser
  marcada automaticamente como principal; no máximo uma principal por
  projeto, respeitando o índice parcial já existente; uploads
  seguintes não substituem automaticamente a principal; ordem começa
  em 1; novos uploads recebem a próxima ordem disponível.
- **Consistência Storage+banco (sem transação compartilhada)**: tratar
  compensação explicitamente. Fluxo preferido: (1) validar tudo; (2)
  gerar `imagem_id`; (3) fazer upload do objeto ao Storage; (4)
  inserir registro no banco; (5) se o INSERT falhar: apagar o objeto
  recém-enviado; logar erro de forma segura; nunca deixar um arquivo
  órfão. Se a exclusão compensatória também falhar: logar o caminho do
  objeto em um log seguro; devolver um erro controlado; nunca mascarar
  o arquivo órfão; documentar para limpeza futura. Nunca inserir no
  banco primeiro apontando para um objeto ainda não existente.
- **Resposta da rota** (sucesso):
  ```ts
  {
    ok: true,
    fotos: [
      {
        id,
        ordem,
        principal,
        mimeType,
        tamanhoBytes,
        largura,
        altura,
        urlAssinada
      }
    ]
  }
  ```
  (A partir daqui a mensagem original do usuário está cortada — sem
  seção de erro, sem `ENTREGA`, sem instrução de encerramento. Ver
  Decisão 2.)

## 6. Plano de implementação (a executar assim que as 2 decisões chegarem)

1. `lib/estudio-anuncios/tipos.ts` — atualizar `ImagemOrigem` com as
   colunas reais (`largura_px`, `altura_px`, `tamanho_bytes`,
   `mime_type`, `nome_original`, `criado_em`); adicionar tipo de
   resposta da API (`FotoRespostaAPI`).
2. `lib/estudio-anuncios/storage.ts` (novo) — constante do bucket;
   sanitização de nome de arquivo; detecção de assinatura real
   (via biblioteca escolhida ou implementação manual, conforme
   Decisão 1); parser de dimensões; montagem do caminho
   `{user_id}/{projeto_id}/{imagem_id}/{nome_seguro}`; upload/delete
   via cliente service role; geração de URL assinada.
3. `lib/estudio-anuncios/fotos.ts` (novo) — acesso a
   `estudio_anuncios_imagens_origem`: listar fotos por projeto (com
   URLs assinadas geradas na hora, nunca persistidas), contar fotos
   existentes, inserir foto com `ordem`/`e_principal` calculados
   (primeira foto do projeto = principal; demais = não).
4. `app/api/estudio-anuncios/projetos/[id]/fotos/route.ts` —
   implementar o POST real: autenticação/ownership na ordem exigida,
   `request.formData()` para multipart, validação de contagem total
   (existentes + novas ≤ 10) antes de tocar no Storage, processamento
   por arquivo com fluxo validar→upload→insert→compensação em caso de
   falha de INSERT, resposta com `fotos` (sucessos) e `falhas`
   (com nome original + motivo) por arquivo.
5. `app/api/estudio-anuncios/projetos/[id]/route.ts` — estender o GET
   já existente (mesmo padrão usado antes para `pipeline`/`jobs`) para
   incluir `fotos: [...]` com URLs assinadas geradas no momento da
   requisição.
6. `app/(app)/central-ia/estudio-anuncios/novo/page.tsx` — trocar o
   input de "foto principal" único por seletor múltiplo (1 a 10
   arquivos), preview local por arquivo, upload real disparado só
   depois do 201 de criação do projeto, tratamento de falha parcial
   (mostrar quais falharam, permitir nova tentativa sem recriar o
   projeto, sem redirecionar automaticamente se houver falha).
7. `app/(app)/central-ia/estudio-anuncios/[projetoId]/page.tsx` —
   exibir as fotos vindas do GET enriquecido, via URL assinada
   (somente leitura nesta tarefa — sem upload adicional a partir desta
   tela).
8. Validar `tsc --noEmit`, conferir escopo via git (nenhum arquivo fora
   da lista autorizada tocado), e apresentar relatório final para
   testes guiados (mesmo padrão de todo o resto do projeto: sem acesso
   a banco/servidor ao vivo, todo teste é feito pelo usuário e
   validado por mim a partir do que for colado de volta).

## 7. Lembretes de processo (válidos para toda a sessão)

- Zero acesso a banco/rede/servidor ao vivo — toda validação depende
  do usuário rodar e colar o resultado real (nunca aceitar "sucesso"
  sem o dado literal).
- Sem RLS no projeto inteiro — autorização é 100% em código de
  aplicação, sempre filtrando por `user_id` da sessão via
  `getUserId(request)`, nunca confiando em `user_id` do corpo/query.
- Nenhuma migration nova é executada sem o SQL completo ser
  apresentado e aprovado antes.
- Task list interna (fora deste arquivo) já tem os itens #117-#124
  cobrindo exatamente os passos da seção 6.
