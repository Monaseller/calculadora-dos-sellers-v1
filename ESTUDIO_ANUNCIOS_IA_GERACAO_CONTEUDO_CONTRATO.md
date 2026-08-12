# Contrato de domínio — `geracao_conteudo` (conceitual, `schema_versao=1`)

Baseado em `ESTUDIO_ANUNCIOS_IA_GERACAO_CONTEUDO_PLANEJAMENTO_V2.md`
(arquitetura já aprovada). Ainda sem `response_schema`/tool-use/function
calling de nenhum SDK — isso é o contrato de DOMÍNIO, independente de
provedor. Sem código, sem migration.

---

## 1. Análise campo a campo (visão geral)

| Campo | Obrigatório | Omissível | Nullable | Tipo | Fonte permitida |
|---|---|---|---|---|---|
| `tituloBase` | sim | não | não | objeto `{texto, fatoIds}` | só `fatosPermitidos` (nunca ressalva — `fatoIds` só aceita `F*`) |
| `bullets` | não | sim | — | array de objeto | `fatosPermitidos` + `descricoesComRessalva` |
| `descricaoCurta` | sim | não | não | objeto `{texto, contemRessalva, fatoIds}` | ambos |
| `descricaoLonga` | não | sim | — | array de objeto | ambos |
| `especificacoes` | não | sim | — | array de objeto | só `fatosPermitidos` |
| `publicoSugerido` | não | sim | — | objeto `{texto, fatoIds}` | só `fatosPermitidos` |

**Revisão desta seção (rodada de auditoria adicional)**: a versão
anterior deste contrato deixava `tituloBase`/`descricaoCurta`/
`descricaoLonga` sem `fatoIds` — inconsistência real, não estilística.
Sem `fatoIds`, esses 3 campos (os de maior peso comercial no anúncio)
ficavam sem nenhuma checagem determinística de fabricação, dependendo
só da leitura semântica de `revisao_claude` — exatamente o nível de
garantia mais fraco do contrato, aplicado justo ao conteúdo mais
visível. Corrigido: todo campo sintetizado carrega `fatoIds`, sem
exceção.

Nenhum campo é `nullable` — a escolha, em toda a saída, é entre
**presente** (com conteúdo real) e **ausente** (chave nem existe no
JSON). Justificativa: `null` deixaria ambíguo "não havia dado" vs. "a
IA decidiu não preencher" vs. "esqueceu de preencher" — omitir a chave
é uma afirmação mais forte e mais fácil de validar
(`"campo" in objeto` é suficiente, sem precisar checar 2 formas de
vazio).

`tituloBase` e `descricaoCurta` são os únicos 2 campos verdadeiramente
obrigatórios. Se nem esses dois puderem ser produzidos com segurança,
o job falha (seção 10 — Input insuficiente) em vez de devolver um JSON
tecnicamente válido mas vazio de conteúdo real.

**(adicionado nesta rodada)** "Obrigatório" aqui significa presente
**e** não-vazio: `tituloBase.texto` e `descricaoCurta.texto` nunca são
string vazia (`""`). Um campo tecnicamente presente mas com texto
vazio é tratado como equivalente a "não foi possível gerar" — cai na
mesma regra de input insuficiente (seção 11), não é emitido como
sucesso parcial.

---

## 2. Mecanismo de rastreabilidade (base para tudo abaixo)

Antes de descrever cada campo, a peça que sustenta todos eles:
`montarEntradaSeguraGeracaoConteudo()` (V2, seção 3) passa a também
**atribuir um ID opaco e estável a cada item de `fatosPermitidos` e
`descricoesComRessalva`** — por exemplo `F1, F2, F3...` para
`fatosPermitidos`, `R1, R2...` para `descricoesComRessalva`. Não é
caminho estrutural (`"materiais[0]"` — frágil, quebra se a ordem
mudar), é um token sequencial simples, atribuído 1x por chamada,
apresentado à IA junto de cada fato.

Todo campo de saída que representa conteúdo sintetizado (bullets,
descrições, público sugerido) carrega um `fatoIds: string[]` apontando
pra quais desses tokens sustentam aquele trecho. `especificacoes`
carrega `fatoId` (singular — 1 especificação vem de exatamente 1 fato
de origem).

**Por que isso importa mais do que parece**: como o espaço de IDs é
fechado e conhecido pelo servidor (foi ele que atribuiu), a validação
pós-geração pode checar deterministicamente se todo `fatoId`/`fatoIds`
citado **existe** no conjunto que foi realmente enviado. Um ID citado
que não existe no conjunto é prova de fabricação — não depende de
interpretar texto, é uma checagem de pertencimento em um conjunto
fechado. **Limite honesto**: isso pega fabricação (citar fato
inexistente), não pega mau uso (citar um `fatoId` real mas
irrelevante/mal aplicado) — esse segundo caso continua exigindo o
julgamento semântico de `revisao_claude`.

**Regras de validação cruzada (adicionadas nesta revisão)** — vão além
de "o ID existe": também checam consistência interna entre a citação e
a flag declarada, todas determinísticas:
- `F*` só pode vir de `fatosPermitidos`; `R*` só de `descricoesComRessalva`
  — nunca misturado.
- `tituloBase.fatoIds` e `especificacoes[].fatoId` só podem conter `F*`
  — citar um `R*` nesses dois campos é rejeição automática (reforça a
  regra da seção 3/6 de que título e especificações nunca vêm de
  ressalva).
- Campo com `contemRessalva=false` não pode citar nenhum `R*`.
- Campo que cita algum `R*` é obrigado a ter `contemRessalva=true`.
- **(adicionada na auditoria arquitetural)** Um campo presente com
  `fatoIds: []`/`fatoId` ausente (array vazio ou citação nula) é
  tratado com a mesma severidade de um ID inexistente — rejeição, não
  aviso. Um campo sem fatos suficientes deve ser omitido inteiramente
  (seções 4-7), nunca emitido citando zero fatos.

Essas 5 regras pegam casos que a checagem de mera existência de ID
deixava passar: o modelo citar corretamente um fato de ressalva mas
esquecer de marcar a flag (ou marcar a flag sem ter de fato usado
nenhum `R*`), ou emitir um campo tecnicamente presente mas sem
nenhuma citação real por trás.

**Escopo dos IDs (fecha ambiguidade da auditoria)**: `F1`, `F2`, `R1`,
`R2`... são válidos **apenas dentro do envelope da própria linha de
resultado** — nunca comparáveis por igualdade de string entre duas
linhas diferentes. Duas execuções do job (ex. regeneração via
`job_substitui_id`) podem atribuir IDs diferentes aos mesmos fatos de
origem, já que a atribuição é sequencial e recalculada a cada chamada.
Qualquer comparação entre versões de conteúdo precisa resolver por
`campoOrigem`+`valor`, nunca por igualdade de `fatoId`.

### 2.1 Validação e consequência (fecha ambiguidade da auditoria)

A checagem de integridade referencial descrita acima (pertencimento ao
conjunto de IDs conhecido + as 5 regras cruzadas) é executada por
`geracao_conteudo`, na própria execução do job, imediatamente após
receber a resposta da IA e **antes** de chamar
`registrarResultadoPipeline()`. Nenhum resultado com violação chega a
ser persistido — não existe estado intermediário de "resultado
inválido salvo".

Violação (ID inexistente, `F*`/`R*` de conjunto errado, `contemRessalva`
inconsistente com a citação, `fatoIds` vazio) falha o job com
`erro_tipo='conteudo_rejeitado'` (valor já existente no CHECK de
`estudio_anuncios_jobs.erro_tipo`, sem uso até hoje). Política de
retentativas segue a mesma infraestrutura já existente de
`tentativas`/`max_tentativas` — esta revisão não define nem altera
política de retry por `erro_tipo`, isso é responsabilidade da camada
de execução, fora do escopo deste contrato de domínio.

`revisao_claude` (seção 16) mantém a mesma checagem de integridade
referencial, mas como **defesa em profundidade**, não como detector
primário — o dado que ela recebe já deveria ter passado por essa
validação em `geracao_conteudo`. Uma violação encontrada por
`revisao_claude` nesse ponto é sinal de regressão no validador de
`geracao_conteudo` (bug, ou descompasso de versão), não o caminho
esperado — deve ser tratada com a mesma severidade (rejeição), mas
registrada como anomalia digna de investigação à parte, já que indica
falha do gate primário.

---

## 3. `tituloBase`

Elementos permitidos, em ordem recomendada: `produtoIdentificado` →
`marca` (se presente) → 1 atributo mais distintivo de
`fatosPermitidos` (nunca de `descricoesComRessalva`). Marca ausente:
título segue só com produto+categoria+atributo, sem placeholder tipo
"marca não informada". Modelo: nunca entra (V2 já decidiu não usar
`modelo` em nenhum campo, por falta de evidência de que o campo
funciona).

**Regra fechada nesta revisão**: título nunca é construído a partir de
`descricoesComRessalva`. Justificativa: é a peça de maior destaque e
menor contexto do anúncio — a que menos deve carregar incerteza. Se o
único atributo distintivo disponível é hedge-classificado, o título
cai para uma formulação mais genérica baseada só em
`categoriaProvavel`, em vez de arriscar uma afirmação prominente sem
lastro.

**Correção nesta revisão**: `tituloBase` carrega `fatoIds`, sim —
`{ texto: string, fatoIds: string[] }`, sem `contemRessalva` (é
estruturalmente impossível ter ressalva aqui, já que a fonte é
restrita a `fatosPermitidos`). A justificativa anterior ("é curto o
bastante pra não precisar de rastreabilidade granular") não se
sustenta: tamanho do texto não tem relação com se o conteúdo é
auditável — e o título é, de longe, o campo de maior visibilidade do
anúncio, o último lugar onde faria sentido abrir mão da checagem
determinística que o resto do contrato usa. `fatoIds` aqui só aceita
`F*` (seção 2). Sem limite de caracteres fixado (marketplace-agnóstico,
por decisão explícita) — só a orientação qualitativa "curto, objetivo,
sem cauda longa de palavras-chave" (isso é responsabilidade de SEO/
`adaptacao_marketplace`, não desta etapa).

---

## 4. `bullets`

**Formato: B (objeto estruturado), não string simples.**
`revisao_claude` precisa auditar cada bullet individualmente
(fidelidade, ressalva, sobreposição) — string simples exigiria
reinterpretar semanticamente cada bullet do zero pra saber de onde
veio, o que é caro e não-determinístico. Estrutura mínima, sem
complexidade desnecessária:

```
{ texto: string, contemRessalva: boolean, fatoIds: string[] }
```

Sem campo `tipo` (característica/especificação/uso) — decisão
consciente: `especificacoes` já é a seção estruturada pra
especificação técnica; bullets cobrem característica e uso de forma
unificada, em prosa curta. Adicionar `tipo` seria estruturar algo que
já tem seção própria em outro lugar do contrato.

Quantidade: sem número fixo (nenhuma evidência real pra calibrar um
mínimo/máximo). **Regra normativa (revisada nesta rodada — versão
anterior usava "grupos genuinamente distintos", subjetivo e não
checável)**: cada bullet deve conter pelo menos 1 `fatoId` que não
apareça em nenhum outro bullet do mesmo resultado — checagem
determinística de diferença de conjuntos, sem depender de julgamento
sobre "o que é um grupo distinto". Prevenção de repetição adicional:
checagem determinística de sobreposição de `fatoIds` entre bullets
(ex. Jaccard) — sinal auxiliar pra `revisao_claude`, não bloqueio
automático (sobreposição alta pode ser legítima quando 2 bullets
abordam ângulos diferentes do mesmo fato, desde que a regra acima já
esteja satisfeita).

**Nota documental (última rodada de revisão)**: ter 1 `fatoId`
exclusivo por bullet é necessário mas não suficiente contra
redundância — 3 bullets com `{F1,F2,F3}`/`{F2,F3,F4}`/`{F3,F4,F5}`
passam na regra acima e ainda assim são altamente redundantes. A
existência de um fato exclusivo não elimina a necessidade de baixa
redundância entre bullets — esse caso residual continua coberto só
pelo sinal auxiliar de sobreposição (Jaccard) já descrito acima,
propositalmente não-bloqueante, não por uma nova regra determinística.

Com input esparso: campo inteiro omitido se não houver fatos
suficientes pra sustentar nem 1 bullet com `fatoIds` reais (nunca gerar
bullet vazio ou genérico sem fato de sustentação).

---

## 5. `descricaoCurta` e `descricaoLonga`

**`descricaoCurta`** — sempre obrigatória (mesmo com pouquíssimo
input, ainda é possível 1 frase-resumo genérica baseada em
`categoriaProvavel`). Função: resumo vendável de 1-3 frases, nunca uma
repetição do título com outras palavras. Estrutura (com `fatoIds`,
correção desta revisão):
`{ texto: string, contemRessalva: boolean, fatoIds: string[] }`.

**`descricaoLonga`** — omissível. Estrutura: array de parágrafos, não
string única — `Array<{ texto: string, contemRessalva: boolean, fatoIds: string[] }>`
(idem, com `fatoIds` por parágrafo).
Array em vez de string com quebras de linha embutidas porque
`adaptacao_marketplace` (consumidor futuro) pode precisar truncar por
parágrafo pra caber em limite de canal, sem ter que reparsear texto
livre pra achar limites de frase. Sem headings — formatação de canal é
responsabilidade de `adaptacao_marketplace`, não desta etapa
marketplace-agnóstica.

Prevenção de repetição entre título/bullets/descrição curta/longa:
regra de prompt (nunca reafirmar literalmente o mesmo fato 2x com
palavras diferentes) — **limite honesto**: isso não é
100% verificável de forma determinística (paráfrase é semântica, não
string-matching), fica como responsabilidade parcial de
`revisao_claude`, não uma garantia do contrato.

Input esparso: `descricaoLonga` é o primeiro campo a desaparecer
(depois `especificacoes`/`publicoSugerido`, depois `bullets` no
limite extremo) — sempre omitido antes de forçar conteúdo raso.

---

## 6. `especificacoes`

```
{ nome: string, valor: string, fatoId: string }
```

**Sem `origem`** — decisão desta revisão, diferente do que o pedido
sugeria como formato candidato: como `especificacoes` só aceita fatos
de `fatosPermitidos` (nunca ressalva, nunca promocional), `origem`
seria sempre `"produto"` — informação sem valor discriminante aqui,
substituída por `fatoId` (mais útil: aponta pro item exato de origem,
não só pra categoria dele).

Regras: só a partir de `fatosPermitidos` (nunca
`descricoesComRessalva` — algo hedge-classificado não é especificação,
por definição). Não duplicar bullets — se um fato já foi usado como
`fatoId` de um bullet, ainda pode aparecer aqui também (formatos
diferentes servem propósitos diferentes: bullet é prosa de venda,
especificação é ficha técnica), mas não o contrário: um `bullet` nunca
deveria ser só uma especificação reescrita em frase. Unidades
preservadas exatamente como vieram do fato de origem — nenhuma
conversão (cm→mm, etc.) nesta etapa. Validação determinística possível
aqui: o `valor` da especificação deve ter correspondência textual
normalizada (substring normalizada ou outra estratégia equivalente que
preserve o mesmo nível de rigor — a implementação pode evoluir a
técnica sem que isso exija nova versão de contrato, desde que a
garantia continue sendo determinística) com o valor literal do fato
apontado por `fatoId` — pega alteração indevida de unidade/número.

Seção inteira omitida (chave ausente, não array vazio) quando não há
nenhum `atributosAdicionais`/`componentes`/`materiais` com
`origem=produto` suficientemente específico pra virar `{nome, valor}`.

---

## 7. `publicoSugerido`

**Mantido, mas com risco real observado nos dados**: no único teste
real que já temos, `publicoProvavel` veio com `origem=indeterminado`
— o que, pela V2 (seção 2), cai em `informacoesProibidas`, nunca em
`fatosPermitidos`. Ou seja: na prática, com a evidência que temos hoje,
este campo provavelmente fica ausente na maioria das chamadas reais,
até algum teste futuro produzir um `publicoProvavel` com
`origem=produto`. Registro isso explicitamente em vez de fingir que o
campo será usado com frequência.

Estrutura: `{ texto: string, fatoIds: string[] }`. Regras de
linguagem, sem exceção: sempre sugestivo ("indicado para...", "pode
interessar a..."), nunca afirmação de indicação clínica/médica, nunca
menção a faixa etária, condição de saúde ou enquadramento terapêutico
— **proibição categórica, mesmo que o input sugerisse isso**
(diferente das outras regras deste contrato, que dependem de
`fatoIds`, esta é uma restrição absoluta de conteúdo, não uma questão
de fonte). Omitido quando não houver `publicoProvavel` com
`origem=produto` suficientemente específico.

---

## 8. Mecanismo de ressalva — decisão fechada

**Opção B — metadado por campo (`contemRessalva: boolean`), aplicado
de forma granular** (por bullet, por parágrafo de descrição longa, na
descrição curta) — nunca A (embutida só no texto, não auditável sem
reinterpretação) nem C (estrutura paralela separada, complexidade sem
necessidade já que B resolve no mesmo lugar onde o conteúdo já está).
Sem escala numérica de confiança, conforme já fechado na V2.

`especificacoes` nunca carrega `contemRessalva` — por construção, só
aceita `fatosPermitidos`, nunca teria ressalva pra sinalizar.
`tituloBase` nunca carrega `contemRessalva` pela regra da seção 3
(nunca construído a partir de fato hedge-classificado) — mas carrega
`fatoIds` (só `F*`), diferente da versão anterior deste contrato (ver
correção na seção 1/3).

---

## 9. Informações proibidas — campo interno de apoio

**Nenhum campo novo no JSON gerado pela IA** — decisão explícita,
sem `fatosEvitados` nem equivalente. A cobertura vem inteiramente de
fora do que a IA precisa "confirmar sobre si mesma":
1. Integridade referencial de `fatoIds` (seção 2) — determinística.
2. Substring/paráfrase-próxima contra `informacoesProibidas` e
   `contextoPromocional` (V2, seções 4-5) — parte determinística, parte
   semântica via `revisao_claude`.
3. **Novo nesta revisão**: qualquer fato que foi rebaixado ou excluído
   por causa de `alertas` **não precisa ser relatado pela IA** — o
   servidor já sabe disso ANTES de montar o prompt (é ele que decide
   o rebaixamento/exclusão), então essa informação é anexada
   server-side ao resultado persistido, nunca gerada pela IA. Mesmo
   padrão já usado em `analise_visual` (`fotosAnalisadas`/
   `metadadosAnalise` são montados 100% pelo servidor, nunca pedidos
   ao modelo) — reaproveitado aqui, não inventado de novo.

---

## 10. Alertas — pertence a `geracao_conteudo` ou a `revisao_claude`?

**Nenhum dos dois, como saída de IA — pertence ao servidor.** O efeito
de um alerta (rebaixar um fato de `fatosPermitidos` pra
`descricoesComRessalva`, ou excluí-lo inteiramente) já acontece ANTES
do prompt ser montado (V2, seção 6). O que fica registrado — "o fato X
foi rebaixado/excluído por causa do alerta Y" — é conhecimento que o
servidor já tem no momento de montar a entrada seguem, então é anexado
ao envelope persistido (seção 13) como metadado server-side, igual ao
item 9 acima. A IA nunca precisa (nem deveria) relatar isso.

---

## 11. Input insuficiente — critérios conceituais, sem número mágico

- **Entrada suficiente**: existe `produtoIdentificado` (ou pelo menos
  `categoriaProvavel`) **e** `fatosPermitidos`+`descricoesComRessalva`
  cobrem mais de 1 grupo de campo diferente (ex.: não é só `cores`
  sozinho — combina com `componentes` ou `possiveisUsos`, etc.).
  Resultado esperado: contrato quase completo (título, bullets,
  descrição curta e longa, possivelmente especificações).
- **Entrada limitada, mas utilizável**: `produtoIdentificado`/
  `categoriaProvavel` existe, mas `fatosPermitidos` é raso (1-2 itens,
  ou só `descricoesComRessalva`, nenhum fato confirmado). Resultado
  esperado: `tituloBase` + `descricaoCurta` apenas — todo o resto
  omitido pela própria regra de opcionalidade de cada campo (nenhuma
  lógica especial extra necessária, a degradação é natural).
- **Entrada insuficiente**: nem `produtoIdentificado` nem
  `categoriaProvavel` disponíveis — literalmente nada pra ancorar um
  título. **Job falha com `erro_tipo='validation'`** (valor já
  existente no CHECK de `estudio_anuncios_jobs.erro_tipo`), não gera
  JSON "válido" mas vazio de conteúdo real. Justificativa: um JSON
  tecnicamente correto mas sem substância deixaria o Pipeline avançar
  como se houvesse conteúdo, quando não há — falha explícita é mais
  segura que degradação silenciosa até esse ponto.

Rejeito propositalmente a opção "status conceitual de conteúdo
insuficiente" como campo separado do contrato — seria redundante com
a falha de job por `validation`, que já comunica exatamente isso, sem
precisar de um segundo mecanismo fazendo o mesmo trabalho.

---

## 12. Contrato JSON completo (conceitual)

```
GeracaoConteudoIA {
  tituloBase: {
    texto: string,
    fatoIds: string[]          // >= 1 item, só "F*"
  },

  bullets?: Array<{
    texto: string,
    contemRessalva: boolean,
    fatoIds: string[]          // >= 1 item
  }>,

  descricaoCurta: {
    texto: string,
    contemRessalva: boolean,
    fatoIds: string[]          // >= 1 item
  },

  descricaoLonga?: Array<{
    texto: string,
    contemRessalva: boolean,
    fatoIds: string[]          // >= 1 item
  }>,

  especificacoes?: Array<{
    nome: string,
    valor: string,
    fatoId: string             // só "F*"
  }>,

  publicoSugerido?: {
    texto: string,
    fatoIds: string[]          // >= 1 item, só "F*"
  }
}
```

Envelope persistido (ver seção 13) — não é o que a IA gera, é o que
efetivamente vai pra `estudio_anuncios_resultados_pipeline.resultado`.
Shape explícito dos itens de `entrada` (correção desta revisão — a
versão anterior deixava isso implícito em "com os IDs atribuídos", sem
especificar o formato):

```
{
  fonteAnaliseVisual: {           // NOVO nesta revisão
    jobId: string,                // job de analise_visual consumido
    resultadoId: string,          // id da linha em resultados_pipeline
                                    // de analise_visual (a fonte, não
                                    // esta própria linha)
    schemaVersao: number
  },

  entrada: {
    fatosPermitidos: Array<{
      id: string,                 // "F1", "F2"...
      campoOrigem: CampoOrigem,   // enum, ver abaixo — nunca string livre
      valor: string,              // sempre string — ver regras de
                                    // serialização abaixo para os 2 campos
                                    // de analise_visual que NÃO são string
      origem: OrigemFatoEntrada   // sempre "produto" hoje (V2 filtra
                                    // embalagem_fisica pra fora de
                                    // fatosPermitidos) — mantido mesmo
                                    // redundante, como seguro pra evolução
                                    // futura
    }>,
    descricoesComRessalva: Array<{
      id: string,                 // "R1", "R2"...
      campoOrigem: CampoOrigem,
      valor: string,
      origem: OrigemFatoEntrada
    }>,
    informacoesProibidas: string[],   // texto puro, nunca citável — único
                                        // uso é matching textual (substring/
                                        // paráfrase) por revisao_claude, sem
                                        // necessidade de campoOrigem
    contextoPromocional: string[],    // idem — texto puro, mesmo motivo
    alertas: string[],                // cópia direta de analise_visual.alertas,
                                        // sem transformação
    fatosAfetadosPorAlerta: Array<{   // fecha ambiguidade da auditoria —
      alerta: string,                  // shape antes indefinido ("[...]")
      campoOrigem: CampoOrigem,
      valor: string,
      efeito: "rebaixado" | "excluido"
    }>                                 // server-side, seção 10
                                        // Nota (última rodada de revisão):
                                        // hoje repete alerta+efeito por fato
                                        // afetado (redundância de
                                        // representação, não de conteúdo).
                                        // Agrupar por alerta ({alerta,
                                        // efeito, fatos[]}) é candidato
                                        // razoável pra V2 se este array
                                        // crescer muito na prática — não
                                        // muda auditabilidade nem validação,
                                        // só representação. Registrado, não
                                        // aplicado agora. Se aplicado no
                                        // futuro, é mudança de shape do
                                        // envelope persistido — exige bump
                                        // de schema_versao (seção 15), não
                                        // é evolução silenciosa mesmo que a
                                        // seção 14 hoje só enumere mudanças
                                        // de `saida` explicitamente.
  },

  saida: GeracaoConteudoIA
}
```

`CampoOrigem` (enum, correção desta revisão — antes era `string` livre,
comentada mas não validável):

```
type CampoOrigem =
  | "produtoIdentificado"
  | "marca"
  | "categoriaProvavel"
  | "caracteristicasVisiveis"
  | "cores"
  | "materiais"
  | "componentes"
  | "textosLegiveis"
  | "quantidadeDeclarada"
  | "possiveisUsos"
  | "publicoProvavel"
  | "atributosAdicionais";
```

> **Correção (2026-08-06).** Esta lista tinha **11** valores e omitia
> `publicoProvavel`, o que tornaria o mecanismo de `publicoSugerido`
> (seção 7 deste mesmo documento) inexequível — não haveria campo-fonte
> possível para citar. O código
> (`lib/ai-gateway/provedores/google-tipos.ts`) já usava a versão correta
> de **12** valores, confirmada explicitamente com o usuário em
> 2026-08-11; era este texto que estava desatualizado. Divergência
> registrada na Seção 31 da Constituição e corrigida aqui.

**Derivação de `CampoOrigem` (fecha ambiguidade da auditoria; reforçado
nesta rodada)**: a enumeração acima é **ilustrativa, não normativa** —
serve pra deixar este documento legível sem precisar abrir o código de
`analise_visual`, e para registrar explicitamente a decisão de excluir
`modelo`/`resumoVisual`/`alertas`/`informacoesNaoConfirmadas`/
`qualidadeDasFotos` (não são campos-fonte de fato citável). A
implementação normativa é derivada das chaves reais de
`AnaliseVisualIA` restritas a esse mesmo subconjunto (ex.
`keyof Pick<AnaliseVisualIA, "produtoIdentificado" | ... >`), nunca
copiada à mão a partir da lista escrita aqui — se `AnaliseVisualIA`
mudar, é o tipo derivado que muda, não este texto (que pode ficar
desatualizado sem quebrar nada, exatamente porque nunca é a fonte da
verdade). Mesmo princípio já aplicado a `OrigemFatoEntrada` logo
abaixo (`Extract<OrigemAtributo,...>`).

**Atribuição de `origem` para campos sem origem própria (fecha
ambiguidade da auditoria)** — `produtoIdentificado`, `marca`,
`categoriaProvavel` e `quantidadeDeclarada` não carregam `origem` em
`analise_visual` (são valores/estruturas simples, não
`ItemComOrigem`/`DescricaoComOrigem`). Para esses 4 campos, `origem`
no envelope é uma **atribuição fixa do servidor** (`"produto"`), nunca
copiada de nenhum campo real — justificada por esses 4 representarem
identificação direta do produto fotografado, sem a ambiguidade
produto-vs-embalagem que motiva o campo `origem` nos outros 7. A
classificação B/C desses 4 campos não depende de `origem` (que é
constante aqui) — depende só de presença (campo nulo não gera fato) e
de varredura de hedge-word sobre o próprio texto do valor, o mesmo
mecanismo já usado para os demais campos.

**Ressalva específica para `quantidadeDeclarada`**: diferente dos
outros 3, este campo já possui um campo nativo chamado `textoOrigem`
em `analise_visual` — nome próximo o bastante de `origem` para causar
confusão real. Deixado explícito: `origem="produto"` aqui é uma
**convenção do envelope para fins de classificação A/B/C/D**, atribuída
pelo servidor por construção — não é um valor detectado pelo modelo,
nem tem qualquer relação com `textoOrigem`. A evidência textual efetiva
que sustenta o fato continua sendo `textoOrigem` (que é o que vira
`valor` no envelope, pela regra de serialização abaixo). Um leitor
futuro não deve interpretar `origem: "produto"` neste item como se
tivesse sido observado/classificado item a item pelo modelo, do jeito
que acontece para `cores`/`materiais`/`componentes`/etc.

**Regras de serialização de `valor` (correção desta revisão)** — 2 dos
11 campos de `analise_visual` não são string simples, precisam de
regra explícita:

- **`categoriaProvavel`** (`string[]` em `analise_visual`) → serializado
  como string única com " > " entre níveis (ex.:
  `"Beleza e Cuidados Pessoais > Cuidados com a Pele"`). Nota sobre uma
  tensão real, não escondida: `analise_visual` especificamente
  abandonou representar categoria como string juntada por "/" (decisão
  documentada, baseada em evidência de 4/4 testes reais, pra evitar
  string-splitting frágil em consumo posterior). Reintroduzir join aqui
  não é a mesma armadilha reaparecendo — lá, o problema era código
  precisar separar os níveis programaticamente depois; aqui, nada no
  contrato de `geracao_conteudo` faz isso (nem os validadores, nem
  `revisao_claude`, que só lê texto). O array original de
  `categoriaProvavel` continua intacto na própria linha de resultado de
  `analise_visual` — este join é só uma serialização derivada, local a
  este envelope, não substitui nem altera o contrato de origem.
  **(adicionado nesta rodada)** O separador `" > "` é só desta
  serialização transitória (texto pronto pra prompt/auditoria) — não
  deve ser interpretado nem consumido como formato canônico de
  categoria por nenhum código futuro; o formato canônico continua
  sendo o array em `analise_visual`.
- **`quantidadeDeclarada`** (`{valor: number|null, textoOrigem: string|null}`
  em `analise_visual`) → serializado usando `textoOrigem` (o texto
  exato que sustenta a quantidade) como `valor` aqui. O número em si é
  redundante/derivável do texto se algum consumidor futuro precisar
  dele — só entra em `fatosPermitidos`/`descricoesComRessalva` quando
  os dois (valor+textoOrigem) estão presentes juntos, então
  `textoOrigem` nunca é `null` nos casos que chegam até aqui.

**Reaproveitamento de tipos entre etapas (correção desta revisão)** —
2 ajustes, não 1: primeiro, `origem` acima não deveria ser uma união
independente redefinida (`"produto" | "embalagem_fisica"`) — é um
subconjunto do `OrigemAtributo` que já existe em `analise_visual`
(`"produto" | "embalagem_fisica" | "material_promocional" |
"indeterminado"`). `OrigemFatoEntrada` é declarado como subtipo
derivado desse enum canônico (`Extract<OrigemAtributo, "produto" |
"embalagem_fisica">`, conceitualmente), nunca uma cópia redigitada —
se `OrigemAtributo` ganhar um valor novo um dia, isso nunca precisa
ser lembrado manualmente aqui.

Segundo, `CampoOrigem` — diferente de `OrigemFatoEntrada`, não é o
mesmo conceito de `OrigemAtributo` duplicado (um classifica tipo de
fonte, o outro identifica nome de campo — não têm relação de
sincronia entre si). O motivo real pra centralizar `CampoOrigem` é
outro: ele descreve a ESTRUTURA de `analise_visual` (nomes dos campos
de outro contrato), não algo de `geracao_conteudo` — por isso deve ser
definido/exportado junto de onde os tipos de domínio de
`analise_visual` já vivem, e importado aqui, nunca redigitado como se
fosse propriedade desta etapa.

Os outros 9 campos do enum já são string simples em `analise_visual`
(ou já viram string ao passar pela extração de item individual de um
array de objetos, ex. um item de `componentes`), sem necessidade de
regra adicional.

**Por que `fonteAnaliseVisual` embutido, e não só `job_origem_id` na
tabela de jobs (V2, seção 7)**: `estudio_anuncios_resultados_pipeline`
nunca é atualizado depois de gravado — é o registro mais imutável que
existe no schema. Uma cópia embutida da referência é, por construção,
mais confiável pra auditoria histórica do que depender só da coluna no
job (que, em teoria, uma futura reconciliação poderia tocar). O
embutido responde "o que a IA realmente viu nesta chamada", que é o
que importa pra auditoria — não "o que o job aponta hoje". As duas
coisas coexistem sem conflito: `job_origem_id` serve pra navegação
prática entre jobs; `fonteAnaliseVisual` serve pra o resultado ser
autossuficiente sem precisar de join nenhum pra ser auditado.

---

## 13. Exemplos

**Entrada rica** (produto com vários atributos confirmados +
1 ressalva + 1 item promocional, molde no dado real do rolo de jade):
`fatosPermitidos` inclui produto/categoria/componentes/cores;
`descricoesComRessalva` inclui o material com hedge ("aparência de
jade"); `contextoPromocional` inclui a categoria de bem-estar extraída
do infográfico. Saída esperada: título completo, 3-4 bullets (um deles
com `contemRessalva=true` referenciando o material), descrição curta e
longa, especificações com os componentes estruturados, sem
`publicoSugerido` (porque, como já registrado na seção 7, esse campo
tende a ficar ausente com os dados que já vimos na prática).

**Entrada limitada**: só `categoriaProvavel` + 1 item de
`descricoesComRessalva` (ex.: só a cor, com hedge), tudo mais
`indeterminado`/ausente. Saída esperada: `tituloBase` genérico
("Kit de [categoria]"), `descricaoCurta` curta e honesta sobre o que
se sabe, todo o resto (`bullets`, `descricaoLonga`, `especificacoes`,
`publicoSugerido`) ausente.

**Entrada insuficiente**: `produtoIdentificado=null`,
`categoriaProvavel=null`, `fatosPermitidos` e `descricoesComRessalva`
ambos vazios (cenário extremo, não observado em nenhum dos 5 testes
reais até agora, mas preciso estar coberto). Job falha,
`erro_tipo='validation'`, `erro_mensagem` explicando que a análise
visual não produziu base suficiente pra gerar conteúdo.

---

## 14. Versionamento

`SCHEMA_VERSAO_GERACAO_CONTEUDO = 1`, independente de
`analise_visual` (mesma justificativa já fechada na V2 — `schema_versao`
é por linha/etapa, não contador global).

**(adicionado nesta rodada — fecha ambiguidade de leitura)**
`schema_versao` versiona o envelope persistido inteiro (`entrada` +
`saida`, seção 12/15), não apenas o JSON produzido pela IA (`saida`
sozinha). Uma mudança de shape em qualquer parte de `entrada`
(incluindo `fatosAfetadosPorAlerta`, `fatosPermitidos`,
`descricoesComRessalva` etc.) exige o mesmo bump de versão que uma
mudança em `saida` — não é um versionamento paralelo nem um
mecanismo separado.

**Exige nova versão**: adicionar/remover/renomear campo de nível
superior; mudar obrigatoriedade de `tituloBase`/`descricaoCurta`;
trocar o mecanismo de `fatoIds` por outra forma de rastreabilidade;
trocar o mecanismo de ressalva (`contemRessalva` por algo diferente).

**Pode mudar sem quebrar contrato**: lista de palavras de hedge usada
pra classificar B/C (é lógica server-side de entrada, não muda o
formato da saída); quais campos específicos de `analise_visual`
alimentam `fatosPermitidos` vs. `descricoesComRessalva`; valores do
enum `CampoOrigem` (segue a evolução de `AnaliseVisualIA`, sem exigir
bump de `SCHEMA_VERSAO_GERACAO_CONTEUDO` — explicitado aqui porque
`CampoOrigem` virou enum formal nesta auditoria); provedor usado (por
desenho, o contrato de domínio é agnóstico); texto exato do prompt.

Consumidores (`revisao_claude`, `adaptacao_marketplace`,
`geracao_prompts_imagem`, `calculo_score`) identificam a versão aceita
lendo `estudio_anuncios_resultados_pipeline.schema_versao` — mesmo
mecanismo já em produção para `analise_visual`, sem nada novo a
construir.

---

## 15. Persistência

Confirmado: `estudio_anuncios_resultados_pipeline`, `etapa='geracao_conteudo'`,
`schema_versao=1`, 1 resultado por job, imutável. `resultado` (JSONB)
guarda o envelope `{entrada, saida}` da seção 12 — não só `saida`.

**Por que o envelope, e não só a saída da IA**: se
`resultados_pipeline` guardasse só `saida`, `revisao_claude` (que roda
depois, possivelmente numa execução separada) não teria como saber a
que fato cada `fatoId` corresponde — precisaria recalcular
`montarEntradaSeguraGeracaoConteudo()` de novo a partir do resultado de
`analise_visual`. Isso é perigoso: a lista de hedge-words (seção 2 da
V2) é explicitamente esperada para evoluir com o tempo — recalcular
depois, com uma lista diferente da que existia no momento da geração,
produziria um mapeamento `fatoId→fato` diferente do que a IA realmente
viu, quebrando a rastreabilidade silenciosamente. Persistir o
`entrada` junto do `saida`, congelados juntos no mesmo momento, elimina
esse risco por construção.

`job_origem_id` (V2, seção 7) fica no job, não no resultado — vínculo
de rastreabilidade entre jobs, não entre resultados.

---

## 16. O que `revisao_claude` recebe e consegue avaliar

Recebe o envelope completo (`entrada`+`saida`), não só `saida`.

| Verificação pedida | Consegue avaliar? | Como |
|---|---|---|
| Fidelidade | Sim (defesa em profundidade) | Integridade referencial de `fatoIds`/`fatoId` contra `entrada.fatosPermitidos`/`descricoesComRessalva` — a checagem primária já ocorreu em `geracao_conteudo` antes da persistência (seção 2.1); uma violação encontrada aqui é sinal de regressão no validador primário |
| Repetição | Parcial | Sobreposição de `fatoIds` entre bullets é determinística; paráfrase estilística é leitura própria dela |
| Vazamento de informação proibida | Sim | Substring/paráfrase contra `entrada.informacoesProibidas` |
| Alegação promocional | Sim | Substring/paráfrase contra `entrada.contextoPromocional` (checagem semântica dedicada, V2 seção 4) |
| Preservação de ressalva | Sim | Cruza `contemRessalva=true` com presença real de linguagem de ressalva no `texto` |
| Clareza/consistência/qualidade textual | Sim | Leitura direta, sem dado adicional necessário |

Nada identificado como faltante no contrato pra essa revisão funcionar
— o envelope `{entrada, saida}` (seção 15) é exatamente o motivo pelo
qual nada falta: sem ele, pelo menos fidelidade e ressalva ficariam
inviáveis de checar de forma confiável.

---

## 17. Riscos restantes (honestos, não escondidos)

- Checagem de integridade de `fatoIds` (agora incluindo as regras
  cruzadas `F*`/`R*`/`contemRessalva` da seção 2) pega **fabricação**
  (citar ID inexistente) e **inconsistência interna** (citar `R*` sem
  marcar a flag, ou vice-versa) — mas ainda não pega **mau uso**
  (citar um `fatoId` real, do tipo certo, mas irrelevante ou mal
  aplicado ao contexto) — isso continua exigindo julgamento semântico
  de `revisao_claude`, sem garantia determinística.
- Lista de hedge-words ainda baseada em 1 exemplo real — mapeamento
  B/C pode errar por omissão até crescer com mais evidência.
- Preservação exata de unidade em `especificacoes` depende de
  substring-match — reformatação leve pelo modelo (ex. "10.8CM" →
  "10,8 cm") pode escapar da checagem determinística sem ser
  tecnicamente uma invenção de valor.
- Detecção de repetição estilística (mesma ideia, palavras diferentes)
  entre título/bullets/descrições não é verificável de forma
  determinística — fica só como responsabilidade (não garantia) de
  `revisao_claude`.
- `publicoSugerido`, pela evidência real disponível hoje, tende a ficar
  ausente na maioria das chamadas — o campo existe mas pode se revelar
  pouco útil na prática; só um teste real vai confirmar.
- **(adicionado na auditoria arquitetural)** `especificacoes[].nome` é
  texto livre, sem vocabulário controlado — a checagem determinística
  cobre só `valor` (substring contra o fato de origem), nunca `nome`;
  um `nome` semanticamente errado (ex. rotular um fato de `componentes`
  como "Cor") não é pego por nenhum mecanismo determinístico, fica só
  como responsabilidade de `revisao_claude`.
- **(adicionado na auditoria arquitetural)** Risco residual mesmo após
  fechar a validação da seção 2.1: a checagem de `fatoIds` em
  `revisao_claude` é defesa em profundidade — uma divergência entre o
  validador de `geracao_conteudo` e o de `revisao_claude` (ex.
  atualização de um sem o outro) só seria percebida se `revisao_claude`
  de fato encontrar uma violação que já deveria ter sido barrada antes;
  não há teste automatizado cruzado entre os dois nesta versão do
  contrato.

---

## 18. Pontos que precisam de decisão antes da implementação

1. Provedor real (ainda não escolhido, por decisão explícita).
2. Implementar o executor registry antes do código desta etapa (V2,
   seção 10).
3. Criar as colunas `job_origem_id` (job) — sem migration nesta tarefa.
4. Calibrar, com evidência real, os limiares qualitativos de "entrada
   limitada" vs. "entrada suficiente" (seção 11) — hoje são só
   qualitativos, não têm nem precisam de número fixo agora, mas a
   *primeira chamada real* deve ser usada pra validar se a
   classificação em 3 níveis realmente corresponde ao que aparece na
   prática.
5. Confirmar, com teste real, se a checagem de substring pra unidades
   (seção 6/17) é suficiente ou precisa de normalização mais
   sofisticada.
6. **(adicionado na auditoria arquitetural)** Vocabulário controlado
   (ou mecanismo de normalização) para `especificacoes[].nome` —
   necessário para `adaptacao_marketplace` mapear atributos livres
   para taxonomias fixas de marketplace; não resolvido neste contrato,
   deve ser tratado no contrato próprio dessa etapa.

---

## 19. Conclusão

**SIM** — o contrato passou por auditoria arquitetural crítica (2
problemas estruturais de ambiguidade de especificação — validação de
`fatoIds` e origem dos campos sem `origem` própria — e um conjunto de
lacunas secundárias), todos fechados nesta revisão sem alterar a
arquitetura aprovada na V2. Pronto para implementação, sujeito aos
pontos de decisão explícitos da seção 18 (provedor, executor registry,
migrations, calibração com evidência real).

---

## 20. Registro da revisão adicional (pós-auditoria de contrato)

4 correções incorporadas nesta rodada, todas com origem em revisão
crítica externa ao desenho original, não autoidentificadas: (1)
`fatoIds` estendido a `tituloBase`/`descricaoCurta`/`descricaoLonga`,
que na versão anterior ficavam sem nenhuma checagem determinística —
justo o conteúdo de maior peso comercial; (2) regras de validação
cruzada `F*`/`R*`/`contemRessalva`, que pegam inconsistência interna
que a checagem de mera existência de ID deixava passar; (3)
`fonteAnaliseVisual` embutido no envelope, tornando o resultado
autossuficiente pra auditoria sem depender de join externo, e mais
confiável que a coluna `job_origem_id` sozinha justamente por herdar a
imutabilidade da tabela de resultados; (4) shape explícito dos itens
de `entrada` (`id`, `campoOrigem`, `valor`, `origem`), removendo a
ambiguidade que a versão anterior deixava em aberto.

---

## 21. Registro da auditoria arquitetural crítica (fecha ambiguidades de especificação)

Auditoria externa identificou 2 problemas estruturais reais (não
estilísticos) e um conjunto de lacunas secundárias — nenhum exigiu
redesenho, todos foram fechados como adição de regra em seções já
existentes:

**Problema 1 — integridade de `fatoIds` sem validador definido**:
o contrato descrevia o mecanismo de checagem determinística mas nunca
dizia quem valida, quando, e qual a consequência de uma violação.
Fechado (seção 2.1): `geracao_conteudo` é o validador primário, antes
da persistência, com `erro_tipo='conteudo_rejeitado'` na violação;
`revisao_claude` passa a ser defesa em profundidade, não detector
primário (seção 16 atualizada).

**Problema 2 — origem indefinida para 4 campos sem `origem` própria**:
`produtoIdentificado`, `marca`, `categoriaProvavel` e
`quantidadeDeclarada` não têm campo `origem` em `analise_visual`, mas
o envelope exigia `origem: OrigemFatoEntrada` em todo item. Fechado
(seção 12): atribuição fixa do servidor (`"produto"`), documentada
como convenção de classificação, não detecção — com ressalva
específica para `quantidadeDeclarada` (risco de confusão com o campo
nativo `textoOrigem`, mesmo nome parcial, conceito diferente).

**Correções secundárias, todas obrigatórias exceto as 2 marcadas como
opcionais**: shape explícito de `informacoesProibidas`/
`contextoPromocional` (`string[]`) e `fatosAfetadosPorAlerta`
(estruturado, reaproveitando `CampoOrigem`); `alertas` declarado como
cópia direta de `analise_visual.alertas`; escopo de `F*`/`R*` limitado
ao envelope da própria linha, documentado explicitamente; regra de
array vazio (`fatoIds: []`) promovida a 5ª regra de validação cruzada,
mesma severidade de ID inexistente; `CampoOrigem` declarado como
derivado de `AnaliseVisualIA` (nunca redigitado), fechando o mesmo
risco de dessincronização que `OrigemFatoEntrada` já havia fechado.
Marcados como melhoria opcional, não bloqueante: nomear `CampoOrigem`
explicitamente na lista de mudanças que não exigem bump de
`schema_versao` (seção 14); vocabulário controlado para
`especificacoes[].nome`, adiado para o contrato de `adaptacao_marketplace`
(novo item 6 da seção 18).

---

## 22. Registro de refinamentos documentais (rodada final)

5 ajustes puramente de especificação, sem mudança de arquitetura, sem
novo campo, sem wrapper: (1) enumeração de `CampoOrigem` explicitamente
rotulada como ilustrativa/não-normativa, mantida (não removida — perder
o registro do subconjunto deliberado, incluindo a exclusão de `modelo`,
seria perda de informação, não ganho de precisão); (2) `tituloBase.texto`
e `descricaoCurta.texto` explicitamente nunca vazios, fechando a lacuna
entre "obrigatório" e "não-vazio"; (3) regra de distinção de `bullets`
trocada de critério subjetivo ("grupos genuinamente distintos") por
critério determinístico (≥1 `fatoId` exclusivo por bullet); (4)
validação de `especificacoes[].valor` generalizada de "substring" para
"correspondência textual normalizada ou equivalente", permitindo evoluir
a técnica sem nova versão de contrato; (5) separador `" > "` de
`categoriaProvavel` marcado explicitamente como serialização
transitória, não formato canônico.

**Última leitura crítica (encerramento)**: 2 pontos registrados como
nota documental, não bloqueantes, sem mudança de shape: (a) `bullets`
— fatoId exclusivo por bullet não é suficiente contra redundância de
3+ bullets encadeados por sobreposição parcial; permanece coberto só
pelo sinal Jaccard, não-bloqueante, por decisão explícita; (b)
`fatosAfetadosPorAlerta` — repetição de `alerta`/`efeito` por fato é
redundância de representação, não de conteúdo; agrupamento por alerta
é candidato de V2 futura caso o array cresça, e exigiria bump de
`schema_versao` se aplicado. Nenhum dos dois altera arquitetura,
shape atual ou implementabilidade desta versão. **Contrato aprovado
para implementação.**
