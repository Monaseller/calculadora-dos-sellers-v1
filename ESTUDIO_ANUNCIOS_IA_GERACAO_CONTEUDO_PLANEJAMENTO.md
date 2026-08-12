# Planejamento técnico — etapa `geracao_conteudo`

Documento de arquitetura, sem código. Baseado em leitura direta de:
`lib/estudio-anuncios/executar-job.ts`, `lib/ai-gateway/registro.ts`,
`lib/ai-gateway/cliente.ts`, `lib/ai-gateway/roteamento.ts`, o contrato
final de `analise_visual` (`lib/ai-gateway/provedores/google-tipos.ts`,
`schema_versao=1`), e as migrations `20260803_central_ia_estudio_anuncios_schema.sql`
e `20260805_estudio_anuncios_pipeline_schema.sql` (tabelas
`estudio_anuncios_conteudo_versoes`, `estudio_anuncios_auditoria`,
`central_ia_prompts`, `central_ia_consumo`, `estudio_anuncios_pipeline_catalogo`,
`estudio_anuncios_pipeline_catalogo_jobs`). Nada abaixo é especulação sem
base em código lido.

---

## 1. Fluxo completo da etapa

`geracao_conteudo` é o 1º job da etapa AMPLA `gerar_conteudo` no catálogo
(`versao_catalogo=1`), sequência confirmada em
`estudio_anuncios_pipeline_catalogo_jobs`:

```
gerar_conteudo (etapa ampla)
  1. geracao_conteudo      ← esta etapa
  2. revisao_claude
  3. adaptacao_marketplace
```

Depende de `analise_produto` (etapa ampla anterior, que executa
`analise_visual`) já concluída — `depende_de: {analise_produto}` no
catálogo. Fluxo de execução real, ponto a ponto:

1. Worker reivindica o job `geracao_conteudo` (já existente, criado pela
   RPC de avanço do Pipeline ao concluir `analise_visual`).
2. Rota interna (`executar/route.ts`) valida job + pipeline, chama
   `executarJobEstudioAnuncios()`.
3. **NOVO** (hoje inexistente): esse executor precisa de um branch
   especial equivalente a `usaGoogleAnaliseVisual`, algo como
   `usaProvedorRealGeracaoConteudo` — busca o resultado mais recente de
   `analise_visual` em `estudio_anuncios_resultados_pipeline`
   (`WHERE projeto_id = X AND etapa = 'analise_visual' ORDER BY
   criado_em DESC LIMIT 1`), monta o prompt só com esse JSON (nunca
   Storage, nunca imagem), chama o provedor real de texto, valida a
   resposta contra o contrato desta etapa.
4. Resultado estruturado grava em `estudio_anuncios_resultados_pipeline`
   (reutilizando `registrarResultadoPipeline()`, já 100% genérica — não
   precisa mudar).
5. `registrarPrompt()`/`registrarConsumo()` — reutilizados sem
   alteração, já são genéricos por `tipo`/`resposta`.
6. Rota chama a RPC `estudio_anuncios_pipeline_concluir_job()`, que
   avança pro próximo job da mesma etapa ampla (`revisao_claude`).

---

## 2. Papel da IA

**Redator técnico de e-commerce**, não copywriter livre, não
consultor comercial, não especialista em SEO como categoria separada.
Justificativa: a etapa anterior (`analise_visual`) foi desenhada
inteira em torno de "só afirme o que é evidência" — dar à IA desta
etapa um papel de "copywriter criativo" reintroduziria exatamente o
risco que `origem`/`informacoesNaoConfirmadas` foram criados para
conter, só que uma etapa depois. O papel certo é: transformar fatos
estruturados em texto de anúncio bem escrito, sem adicionar nenhum
fato novo. Persuasão de tom (não de conteúdo) é aceitável; persuasão
por invenção de atributo não.

---

## 3. Campos utilizados (do JSON de `analise_visual`)

| Campo | Classificação | Motivo |
|---|---|---|
| `produtoIdentificado` | ESSENCIAL | ponto de partida do título |
| `marca` | ESSENCIAL (se não-nulo) | atributo de maior peso comercial quando existe |
| `categoriaProvavel` | ESSENCIAL | orienta estrutura/vocabulário do texto |
| `resumoVisual` | ÚTIL | contexto geral, não deve virar frase copiada literalmente |
| `caracteristicasVisiveis` (só `origem=produto`) | ESSENCIAL | material bruto dos bullets/descrição |
| `cores`, `materiais`, `componentes` (só `origem=produto`) | ESSENCIAL | especificações objetivas |
| `textosLegiveis` (só `origem=produto`\|`embalagem_fisica`) | ÚTIL | pode confirmar nome/variante, nunca vira alegação de benefício |
| `quantidadeDeclarada` | ÚTIL (se não-nulo) | só quando `valor`+`textoOrigem` presentes juntos |
| `possiveisUsos` (só `origem=produto`) | ESSENCIAL | base dos benefícios de uso reais |
| `publicoProvavel` | ÚTIL | orienta tom, nunca vira afirmação ("ideal para X" é aceitável, "clinicamente indicado para X" não) |
| `atributosAdicionais` (só `origem=produto`) | ÚTIL | especificações técnicas quando existirem |
| `modelo` | NÃO UTILIZAR nesta fase | nas 5 chamadas reais feitas até agora, sempre veio `null` — não há evidência de que o campo funcione; incluir no prompt sem nunca ter visto um valor real é risco sem benefício comprovado |
| `qualidadeDasFotos` | NÃO UTILIZAR | é metadado sobre a qualidade das FOTOS, não sobre o produto — não pertence ao texto do anúncio |
| `fotosAnalisadas`, `metadadosAnalise` | NÃO UTILIZAR | campos técnicos server-side, nunca deveriam chegar a um prompt de copywriting |

`cores`/`materiais`/`componentes`/`caracteristicasVisiveis`/
`possiveisUsos`/`textosLegiveis` com `origem=embalagem_fisica` ficam
FORA da lista "ESSENCIAL/ÚTIL" acima — ver seção 5 sobre por que
embalagem física também precisa de tratamento explícito, não só
`material_promocional`.

**Achado que não estava no meu radar até escrever esta tabela**: o
mesmo cuidado que motivou a criação de `origem=material_promocional`
vale, em menor grau, para `origem=embalagem_fisica`. Um atributo
tagueado como vindo da embalagem (ex.: cor da caixa) nunca deveria
virar uma característica do produto no texto do anúncio. Nenhum dos 5
testes reais teve caracteristicas de produto vs. embalagem realmente
misturadas incorretamente (a validação já filtra por `origem=produto`
nesta proposta), mas o ponto merece ficar explícito: o filtro por
`origem=produto` nos campos acima já resolve isso estruturalmente,
contanto que a implementação realmente filtre por `origem` campo a
campo, não use o array inteiro.

---

## 4. Campos proibidos (nunca gerar)

Preço, prazo de entrega, frete, garantia legal (é texto padrão de
marketplace, não de produto), potência/voltagem/medidas não presentes
em `atributosAdicionais`/`componentes`, composição química/material
não confirmado, certificações (INMETRO, ANVISA, ISO etc.) não
presentes no JSON, alegações de saúde/eficácia clínica de qualquer
tipo (mesmo se `material_promocional` sugerir isso — ver seção 5),
comparação com concorrentes, superlativos não sustentados por dado
("o melhor do mercado", "líder em vendas"), qualquer texto em outro
idioma que não português do Brasil, qualquer especificação numérica
que não venha literalmente de `atributosAdicionais`, `quantidadeDeclarada`
ou `componentes`.

---

## 5. Tratamento de `material_promocional`

Análise das 4 opções apresentadas:

- **(A) Ignorar completamente** — descarta informação real (nos 5
  testes, `material_promocional` sempre correspondeu a um infográfico
  genuinamente presente nas fotos do produto real, não a ruído). Perde
  sinal de para quem/como o vendedor pretende posicionar o produto.
- **(B) Virar só restrição** ("não contradiga isto") — fraco demais:
  não aproveita nada de útil, só evita um erro que nem é o principal
  risco aqui (o risco não é contradizer o infográfico, é REPETIR a
  alegação dele como fato).
- **(C) Usar como inspiração livre** — é o mais perigoso: recria
  exatamente o bug que `origem=material_promocional` foi criado pra
  isolar, uma etapa depois. Se a IA de `geracao_conteudo` pode usar
  livremente "melhora a circulação, reduz a inflamação" como
  inspiração, o anúncio final vai conter essas alegações como se
  fossem do vendedor — o mesmo problema, só que persistido no anúncio
  publicado em vez de num campo JSON interno.
- **(D) Tratamento próprio — recomendado.** Regra concreta: campos com
  `origem=material_promocional` podem informar APENAS a **categoria
  de benefício** que o vendedor original quis comunicar (ex.: "cuidados
  faciais", "bem-estar"), nunca a alegação específica nem o verbo de
  efeito. Nunca pode aparecer como frase copiada ou parafraseada
  próxima do original. Regra de prompt sugerida: *"Os itens marcados
  material_promocional revelam a CATEGORIA de uso pretendida pelo
  vendedor, não fatos sobre o produto. Nunca repita, parafraseie ou
  implique a alegação específica de nenhum item aqui. Você pode usar
  isso só para escolher em qual categoria de benefício-de-uso
  enquadrar `possiveisUsos` reais (origem=produto)."* Isso evita tanto
  a alucinação de fato quanto joga fora sinal útil de posicionamento.

---

## 6. Tratamento de `informacoesNaoConfirmadas`

"Nunca afirme nenhum item desta lista" é necessário mas não suficiente
— proíbe afirmação direta, mas não impede a IA de contornar via
paráfrase vaga ("possui certificações de qualidade" sem citar qual).
Estratégia mais forte, em duas partes:

1. Instrução direta: listar os itens literalmente no prompt sob um
   cabeçalho do tipo `NUNCA MENCIONE, AFIRME OU IMPLIQUE:` seguido da
   lista exata.
2. **Mecanismo de autoconferência** (novo, não existe em `analise_visual`
   porque lá não fazia sentido — aqui faz): pedir que a saída inclua um
   campo tipo `fatosEvitados: string[]` ecoando quais itens de
   `informacoesNaoConfirmadas` a IA conscientemente evitou mencionar.
   Não impede alucinação sozinho, mas cria um sinal auditável — se a
   lista vier vazia ou incompleta enquanto `informacoesNaoConfirmadas`
   não está vazia, é sinal de possível não-conformidade a checar na
   validação estrutural (mesmo espírito da checagem cruzada que já
   fizemos manualmente nos 5 testes de `analise_visual`, agora
   embutida no próprio contrato).

Quando a ausência de um dado tornar o texto estranho (ex.: nenhuma
marca confirmada), a instrução deve ser: usar frase genérica de
categoria ("Kit de cuidados faciais em pedra natural") em vez de
inventar. Nunca deixar a lacuna "gritante" motivar a IA a preencher.

---

## 7. Tratamento de `alertas`

Só entram quando `alertas.length > 0` — array vazio não deveria gerar
nenhuma seção/menção no prompt (evita ruído/instrução redundante). Nos
5 testes reais até agora, `alertas` sempre veio vazio — não há ainda
evidência real do que um alerta preenchido parece nem do que ele
deveria mudar no texto final. Tratamento recomendado, na ausência de
evidência: alertas nunca viram conteúdo de marketing (nunca aparecem
como texto no anúncio), servem só para a IA saber que há uma
divergência/risco a considerar ao decidir COMO enquadrar algo (ex.: se
o alerta for "cor da foto diverge entre imagens", a IA deveria evitar
comprometer-se com uma cor específica no título). Como isso ainda não
tem nenhum caso real observado, marco como **item a decidir com
evidência quando o primeiro alerta real aparecer** — não travar a
implementação inicial nisso, só documentar o comportamento default
(alertas nunca geram texto de marketing, na dúvida).

---

## 8. Estratégia anti-alucinação (mecanismos concretos)

1. Prompt restrito a JSON de entrada — nunca reenviar a foto, nunca
   permitir chamada de ferramenta/busca externa nesta etapa.
2. Lista negativa explícita de `informacoesNaoConfirmadas` (seção 6).
3. Filtragem por `origem` ANTES de montar o prompt — campos com
   `origem` diferente de `produto` nunca chegam à seção "fatos
   confirmados" do prompt; entram, se entrarem, em seções à parte com
   regras próprias (material_promocional: seção 5).
4. `fatosEvitados` como autoconferência (seção 6).
5. Validação estrutural pós-resposta (`validarResultadoGeracaoConteudo()`,
   mesmo padrão de `validarResultadoAnaliseVisual()`) rejeitando
   qualquer especificação numérica no texto de saída que não apareça
   literalmente em `atributosAdicionais`/`componentes`/`quantidadeDeclarada`
   de entrada — validação determinística por string-matching, não
   confiança cega na instrução do prompt.
6. `response_schema` estruturado (Gemini) ou `tool use`/JSON mode
   (Claude) — nunca texto livre não tipado, mesma disciplina de
   `analise_visual`.
7. Nenhum campo do contrato de saída aceita string livre sem
   correspondência auditável a um campo de entrada específico — todo
   texto gerado precisa ser rastreável a pelo menos 1 campo do JSON de
   `analise_visual` (ou explicitamente marcado como frase de transição/
   estilo, nunca como fato).

---

## 9. Saídas esperadas (conceitual, sem schema ainda)

- **Título** — obrigatório. Baseado em `produtoIdentificado`+`marca`+
  atributo mais distintivo.
- **Bullets de destaque** (lista curta) — obrigatório. Um por
  característica/uso real confirmado (`origem=produto`).
- **Descrição curta** — obrigatório. 1-2 frases, resumo vendável sem
  invenção.
- **Descrição longa** — obrigatório. Expansão estruturada dos bullets,
  sem repetir texto igual ao título/bullets.
- **Especificações técnicas** (lista estruturada, não prosa) —
  condicional: só gerar se `atributosAdicionais`/`componentes`/
  `materiais` tiverem conteúdo real; nunca inventar seção vazia.
- **Público-alvo sugerido** — opcional, derivado de `publicoProvavel`,
  sempre como sugestão ("indicado para..."), nunca como afirmação
  técnica.
- **`fatosEvitados`** — obrigatório (mecanismo de auditoria, seção 6),
  nunca aparece no anúncio publicado, é campo interno.

Deliberadamente FORA da lista: CTA ("compre agora", "aproveite") —
isso é texto de formatação de marketplace, não de conteúdo do produto,
mais adequado à etapa `adaptacao_marketplace`, que já conhece o
marketplace de destino e suas convenções. Incluir CTA aqui seria
antecipar uma decisão que pertence a uma etapa posterior.

---

## 10. Persistência — `estudio_anuncios_resultados_pipeline` ou estrutura própria?

**Recomendo continuar em `estudio_anuncios_resultados_pipeline`.**
Motivo, com evidência de schema, não preferência estética: existe
`estudio_anuncios_conteudo_versoes`, que à primeira vista parece o
lugar "óbvio" pra conteúdo de anúncio — mas sua FK é
`projeto_marketplace_id UUID NOT NULL REFERENCES
estudio_anuncios_projetos_marketplace(id)`. Ou seja, essa tabela
estruturalmente EXIGE que já exista uma adaptação por marketplace
específica — ela não pode representar um conteúdo-base
marketplace-agnóstico, que é exatamente o que `geracao_conteudo`
produz (o próprio texto do prompt fixo em `executar-job.ts` já diz:
"Gerar título e descrição-base do anúncio", "base" sendo a palavra
certa). Tentar gravar a saída de `geracao_conteudo` em
`estudio_anuncios_conteudo_versoes` exigiria ou (a) criar uma
adaptação de marketplace "genérica" artificial, distorcendo o
propósito da tabela, ou (b) alterar a tabela pra aceitar
`projeto_marketplace_id` nulo, o que quebraria a garantia que ela hoje
oferece (nunca ter um conteúdo "solto" sem marketplace de destino).
`estudio_anuncios_resultados_pipeline` já é `projeto_id`-scoped,
genérica por etapa, e já suporta exatamente esse caso sem nenhuma
mudança de schema.

**Achado correlato, não pedido mas relevante**: `estudio_anuncios_auditoria`
(classificação por campo: `confirmada_visualmente`,
`informada_pelo_usuario`, `encontrada_em_fonte_externa`,
`inferida_pela_ia`, `pendente_confirmacao`, `rejeitada_por_inconsistencia`)
já existe no schema e é EXATAMENTE o tipo de mecanismo de auditoria por
campo que fizemos manualmente para `analise_visual` via `origem` — mas
ela está amarrada a `conteudo_versao_id`, ou seja, só serve a partir de
`adaptacao_marketplace`. Ela não está disponível para `geracao_conteudo`
por esse mesmo motivo estrutural. Não proponho estender essa tabela
agora (fora de escopo), só registro que ela é o destino natural de um
mecanismo de auditoria por campo quando chegarmos em
`adaptacao_marketplace` — e que o mecanismo mais simples que propus pra
`geracao_conteudo` (`fatosEvitados`, seção 6) é deliberadamente mais
leve, porque a estrutura formal ainda não existe nesta etapa.

---

## 11. Versionamento

**`SCHEMA_VERSAO_GERACAO_CONTEUDO` independente**, não compartilhado
com `analise_visual`. `schema_versao` já é uma coluna por LINHA em
`estudio_anuncios_resultados_pipeline`, não um contador global — o
próprio desenho da tabela já pressupõe que cada etapa evolui seu
contrato de forma independente (é literalmente o propósito da coluna
existir por linha e não como constante de sistema). Reaproveitar o
mesmo contador entre etapas diferentes criaria acoplamento artificial
(uma mudança no contrato de `geracao_conteudo` forçaria decidir se
"conta" como nova versão de `analise_visual` também, o que não faz
sentido nenhum).

---

## 12. Consumo pelas próximas etapas

- **`revisao_claude`**: lê o resultado mais recente de
  `estudio_anuncios_resultados_pipeline` onde `etapa='geracao_conteudo'`
  e `projeto_id` bate. Revisa clareza/consistência/adequação (conforme
  o texto de prompt já fixado em `executar-job.ts`). Recomendo que
  também persista SEU PRÓPRIO resultado (`etapa='revisao_claude'`),
  mesmo que seja só uma cópia com pequenos ajustes — preserva o padrão
  "1 resultado por etapa/job" e dá à etapa seguinte uma fonte
  determinística única a consultar, em vez de ter que decidir ela
  mesma "uso o de geracao_conteudo ou o de revisao_claude, dependendo
  se houve mudança".
- **`adaptacao_marketplace`**: lê o resultado de `revisao_claude` (pelo
  ponto acima, sempre existe), + o registro específico de
  `estudio_anuncios_projetos_marketplace` (marketplace de destino).
  Esta é a PRIMEIRA etapa que efetivamente grava em
  `estudio_anuncios_conteudo_versoes` (agora com `projeto_marketplace_id`
  disponível de verdade) — adequa formato/tamanho/regras por
  marketplace, e é onde CTA e formatação específica de canal entram.
- **`geracao_prompts_imagem`**: etapa AMPLA diferente (`gerar_imagens`),
  que no catálogo depende de `gerar_conteudo` como um todo (a etapa
  ampla, não um job específico). **Ambiguidade real, não resolvida por
  este documento**: se `adaptacao_marketplace` pode gerar N versões
  (uma por marketplace), mas a imagem do produto é presumivelmente
  única por projeto (não por marketplace), de qual fonte exata
  `geracao_prompts_imagem` deveria ler — `geracao_conteudo` (a base,
  única) ou `adaptacao_marketplace` (múltipla, por marketplace)? Isso
  precisa ser decidido explicitamente antes de implementar
  `geracao_prompts_imagem`, não decido aqui.

---

## 13. Problemas encontrados (fora do que já foi listado acima)

1. `decidirProvedor()` (`lib/ai-gateway/roteamento.ts`) hoje retorna
   `"fake"` incondicionalmente para `geracao_conteudo` — precisa de
   extensão análoga ao branch de `analise_visual` (`GOOGLE_AI_ENABLED`),
   incluindo a escolha de QUAL provedor usar. `central_ia_prompts.provedor`
   já aceita `'anthropic'` no CHECK — sinal de que a arquitetura original
   pode ter previsto Claude especificamente para texto/copy, diferente
   da escolha de Gemini para visão. Não decido isso aqui — é a pergunta
   #9 do pedido original, e não vi nenhuma decisão registrada em
   nenhum documento lido até agora.
2. `executarJobEstudioAnuncios()` usa um branch condicional hardcoded
   (`usaGoogleAnaliseVisual`) para desviar do Gateway fake — um segundo
   branch equivalente para `geracao_conteudo` funciona, mas se mais
   etapas ganharem execução real depois (`revisao_claude`,
   `adaptacao_marketplace`, `geracao_prompts_imagem`...), esse padrão
   de "1 if por etapa" vai crescer de forma linear e replicada. Vale
   avaliar (não decido aqui) se compensa migrar para um registro/mapa
   de "executor por etapa" antes de crescer mais.
3. `central_ia_prompts.tipo` já tem o valor `'seo'` no CHECK, distinto
   de `'texto'` (que é o que `decidirTipoPrompt()` mapeia hoje para
   `geracao_conteudo`) — não encontrei nenhum lugar do código ou
   documentação que defina quando `'seo'` deveria ser usado. Pode ser
   metadado morto, pode ser uma etapa futura não implementada. Flag,
   não decisão.
4. `modelo` (campo de `analise_visual`) nunca veio preenchido em
   nenhuma das 5 chamadas reais — não há evidência de que funcione.
   Marquei como NÃO UTILIZAR (seção 3) por falta de evidência, não por
   ele ser conceitualmente errado.

---

## 14. Recomendações

- Seguir exatamente o mesmo processo usado em `analise_visual`:
  aprovar este documento → desenhar o contrato JSON completo →
  auditar → só então implementar.
- Resolver a pergunta #9 (qual provedor) antes de desenhar o schema
  de saída, porque schema estruturado (`response_schema` do Gemini vs.
  tool-use/JSON mode do Claude) tem restrições de sintaxe diferentes
  entre provedores — decidir depois do schema pronto arrisca redesenhar.
- Não persiga a mesma cobertura de teste de `analise_visual` (5
  chamadas reais) de uma vez — recomendo 1 chamada real controlada
  primeiro (mesmo padrão), focada em confirmar que a filtragem por
  `origem` e a lista de `informacoesNaoConfirmadas` realmente impedem
  alucinação na prática, antes de expandir para mais cenários.

---

## 15. Itens que precisam ser decididos antes da implementação

1. Qual provedor real usar para `geracao_conteudo` (Gemini, reaproveitando
   o mesmo cliente, ou Claude/Anthropic, novo cliente)?
2. Extensão de `decidirProvedor()` — nome da variável de ambiente de
   liga/desliga (paralela a `GOOGLE_AI_ENABLED`)?
3. `revisao_claude` grava resultado próprio em `estudio_anuncios_resultados_pipeline`
   (recomendado na seção 12) ou só edita/aprova sem persistir linha
   própria?
4. Fonte de dados exata de `geracao_prompts_imagem` — base única
   (`geracao_conteudo`) ou por marketplace (`adaptacao_marketplace`) —
   ver ambiguidade da seção 12.
5. `alertas` — comportamento real só poderá ser confirmado com
   evidência quando o primeiro alerta populado aparecer num teste real
   (seção 7); decisão provisória documentada, não fechada.
6. Uso (ou não) do valor `'seo'` em `central_ia_prompts.tipo` — metadado
   morto ou etapa futura não mapeada (seção 13, item 3)?
