# MARKETPLACE_COMPLIANCE.md — regras de pré-publicação e suas fontes

> Este documento responde a **uma** pergunta: *"de onde veio essa regra?"*
> Ele espelha em prosa o registro versionado que vive no código, em
> `lib/estudio-anuncios/compliance/regras-mercado-livre.ts`. **O código é
> a fonte executável; este arquivo é a origem auditável.** Divergência
> entre os dois é achado a registrar, nunca a silenciar.
>
> Não duplica a Constituição. Não descreve arquitetura — isso é
> `PROJECT_STATE.md`.

---

## O que esta camada responde (e o que não responde)

```
camada editorial  → "este é o conteúdo que o usuário aprovou"
camada compliance → "este conteúdo atende aos requisitos técnicos
                     verificáveis do marketplace?"
```

**Conteúdo aprovado não é conteúdo publicável.** As duas perguntas são
independentes e vivem em camadas separadas.

`status = aprovado` significa **"nenhuma regra que sabemos verificar foi
violada"** — nunca "o marketplace vai aceitar". A validação definitiva do
Mercado Livre é `POST /items/validate`, que exige token OAuth e não é
chamada aqui.

| Status | Significado |
|---|---|
| `aprovado` | Nenhum bloqueio segundo as regras implementadas. |
| `aprovado_com_alertas` | Tecnicamente publicável, com ponto que merece atenção humana. |
| `bloqueado` | Requisito objetivo impede criar o anúncio. |
| `nao_implementado` | Não existe validador para este canal. **Nunca é sinônimo de "sem problemas".** |

---

## Endpoints da API do Mercado Livre — o que é público (2026-08-24)

Verificado com **requisição anônima**, sem token. Isto é o que permite
validar categoria de verdade sem OAuth.

| Endpoint | Sem OAuth | Para que é usado aqui |
|---|---|---|
| `GET /categories/{id}` | **200** | Prova que o `category_id` existe + traz `settings` |
| `GET /categories/{id}/attributes` | **200** | Atributos obrigatórios reais da categoria |
| `GET /sites/MLB/domain_discovery/search?q=` | **200** | *Category predictor* — sugestão por texto |
| `GET /sites/MLB` | 403 | — |
| `GET /sites/MLB/listing_types` | 403 | **Com OAuth** (desde 2026-08-25) é a autoridade sobre o tipo de anúncio |
| `GET /sites/MLB/listing_prices` | 403 | — |
| `GET /categories/{id}/sale_terms` | 403 | Garantia não é validada nesta versão |

**Nenhum `POST` é feito em nenhum momento.** Nada é publicado, nada é
criado, nenhum token é usado.

## Fontes oficiais consultadas

Somente documentação oficial. **Nenhuma regra veio de blog, fórum, vídeo,
documentação de terceiros ou memória do modelo.**

| # | Página | URL | Última atualização declarada | Lida em |
|---|---|---|---|---|
| A | List products | `https://developers.mercadolibre.com.ar/en_us/list-products` | 30/12/2025 | 2026-08-23 |
| B | Working with pictures | `https://developers.mercadolibre.com.ar/en_us/working-with-pictures` | 24/03/2026 | 2026-08-23 |
| C | Listing validator | `https://developers.mercadolibre.com.ar/en_us/listing-validator` | 30/12/2025 | 2026-08-23 |

---

## O achado mais importante: quase todo limite do ML é POR CATEGORIA

A fonte **[A]** mostra o objeto `settings` de `GET /categories/$CATEGORY_ID`:

```
"max_title_length": 60,          "max_description_length": 50000,
"max_pictures_per_item": 12,     "currencies": [...],
"item_conditions": [...],        "price": "required",
"stock": "required",             "listing_allowed": true
```

Todos esses valores são **da categoria**, não do site. Consequência
prática, e é ela que explica o desenho desta camada:

- **Nenhum limite de título foi congelado no código.** O `60` do exemplo
  vale para a categoria do exemplo. Um teste dedicado falha se alguém
  hardcodar um número de caracteres.
- Sem `category_id` resolvido, comprimento de título, comprimento de
  descrição, moeda, atributos obrigatórios e número máximo de imagens são
  **`nao_verificavel`** — e `nao_verificavel` **vira alerta visível**, para
  que silêncio nunca seja lido como aprovação.

### Divergência dentro da própria documentação oficial

A fonte **[A]**, seção *Pictures*, diz literalmente *"you should add an
array of up to six URL pictures"*, enquanto o `settings` da **mesma
página** traz `max_pictures_per_item: 12`. Como o número por categoria é o
que a API de fato aplica, o limite superior é tratado como **não
verificável sem categoria** — nunca como 6, nunca como 12.

---

## Mercado Livre — regras implementadas (`versaoRegras = 1`)

### Bloqueios

| Código | Campo | Regra | Fonte |
|---|---|---|---|
| `ml_conteudo_nao_aprovado` | — | Só conteúdo com versão editorial **aprovada** é pré-validado. | Decisão de arquitetura do CDS (camada editorial, 2026-08-20) |
| `ml_titulo_ausente` | `title` | `title` é obrigatório. | A, C |
| `ml_categoria_nao_resolvida` | `category_id` | Obrigatório e **só aceita IDs pré-estabelecidos**. Literal: *"This attribute is mandatory and only accepts pre-established ids."* | A |
| `ml_preco_nao_informado` | `price` | Literal: *"It is a required attribute: when you define a new item, it must have a price."* | A |
| `ml_estoque_nao_informado` | `available_quantity` | Exigido pelas categorias com `settings.stock = "required"`. | A |
| `ml_condicao_nao_definida` | `condition` | Obrigatório, conforme `settings.item_conditions`. | A, C |
| `ml_tipo_anuncio_nao_definido` | `listing_type_id` | Obrigatório. | A, C |
| `ml_sem_imagem` | `pictures` | O item precisa de ao menos uma imagem. | A, B |
| `ml_imagem_sem_arquivo` | `pictures` | Imagem referenciada sem objeto no Storage não pode ser enviada. | Decisão do CDS (materialização, 2026-08-22) |
| `ml_imagem_formato_invalido` | `pictures` | Literal: *"Format JPG, JPEG and PNG."* | B |
| `ml_imagem_acima_do_tamanho` | `pictures` | Literal: *"You can upload images up to 10 MB."* | B |
| `ml_imagem_abaixo_da_resolucao_minima` | `pictures` | Literal: *"the minimum is 500px x 500px (version M)"*. | B |

### Alertas

| Código | Regra | Fonte |
|---|---|---|
| `ml_imagem_acima_da_resolucao_maxima` | Acima de 1920×1920 px o ML **redimensiona**. Literal: *"The maximum size accepted is 1920 x 1920 px (version F)"*. Não impede publicar. | B |
| `ml_marca_nao_informada` | `BRAND` é dos atributos mais exigidos; a ficha não tem marca confirmada. | A |
| `ml_modelo_nao_informado` | `MODEL` é exigido em muitas categorias. | A |
| `ml_gtin_nao_informado` | Identificadores de produto são exigidos em parte das categorias. | A |
| `ml_sku_nao_informado` | `SELLER_SKU` é o campo considerado para SKU do vendedor. | A |
| `ml_titulo_menciona_condicao` | Literal: *"If your product is new, used or refurbished, do not include it in the title"*. | A |
| `ml_titulo_menciona_estoque` | Literal: *"It is not allowed to mention stock if you do it your publication will be moderated."* | A |
| `ml_titulo_menciona_servico` | Literal: *"Avoid in the title information of other services, such as returns, free shipping or installment payments"*. | A |
| `ml_imagem_sem_aprovacao_humana` | Imagens da Fase 1 não passam por aprovação editorial própria. | Decisão do CDS |
| `ml_validacao_final_no_marketplace` | A validação definitiva é `POST /items/validate`, com OAuth. **Ressalva permanente.** | C |

As três regras de título são **checagens textuais** e por isso são
**alertas, nunca bloqueios**: um falso positivo jamais pode impedir uma
publicação legítima.

### v2 (2026-08-24) — o que a categoria destravou

Com `category_id` resolvido e o snapshot de `settings` gravado, os limites
deixaram de ser `nao_verificavel` e passaram a ser aplicados de verdade.
**Continuam sem número congelado no código** — todos vêm da categoria.

| Código | Tipo | Regra | Fonte |
|---|---|---|---|
| `ml_categoria_nao_permite_publicacao` | bloqueio | `listing_allowed` deve ser `true` e `status` `enabled`. Literal: *"the listing_allowed field should have true value and the status field, enabled value"*. | A |
| `ml_titulo_acima_do_limite` | bloqueio | Título acima de `settings.max_title_length`. | A |
| `ml_descricao_acima_do_limite` | bloqueio | Descrição acima de `settings.max_description_length`. | A |
| `ml_condicao_invalida_para_categoria` | bloqueio | Condição fora de `settings.item_conditions`. | A |
| `ml_moeda_indefinida_para_categoria` | bloqueio | Moeda ausente ou fora de `settings.currencies`. **Derivada, nunca digitada**; categoria com mais de uma moeda não é resolvida sozinha. | A |
| `ml_imagens_acima_do_maximo` | bloqueio | Mais imagens que `settings.max_pictures_per_item`. | A, B |
| `ml_atributo_obrigatorio_ausente` | bloqueio | Atributo com tag `required` em `/categories/{id}/attributes` e sem valor real. | A |
| `ml_atributo_condicional_ausente` | alerta | Atributo `conditional_required`: a condição de exigência não é conhecida offline. | A |
| `ml_tipo_anuncio_invalido` | bloqueio | Fora de `gold_pro`, `gold_special`, `silver`, `bronze` — os quatro que aparecem **literalmente** nos exemplos das fontes A e C. | A, C |
| `ml_tipo_anuncio_nao_verificado_na_conta` | alerta | Quais tipos a conta permite exige `/sites/{site}/listing_types`, que é **403 sem OAuth**. | A |
| `ml_categoria_nao_folha` | alerta | Categoria com subcategorias; o ML publica em folha. | A |

### Não verificáveis sem categoria

`ml_titulo_limite_nao_verificavel`, `ml_descricao_limite_nao_verificavel`,
`ml_moeda_nao_verificavel`, `ml_atributos_obrigatorios_nao_verificaveis`,
`ml_quantidade_imagens_nao_verificavel` — todos da fonte **[A]**, todos
emitidos como alerta enquanto `category_id` não existir.

---

## O que a camada se recusa a fazer

Cada item abaixo tem teste dedicado que falha se a proibição for quebrada:

- **Não inventa `category_id`.** `categoriaProvavel` da IA e o campo
  `categoria` da ficha são **texto livre** — nunca um `MLB…`. Desde
  2026-08-24 existe seleção assistida pelo *category predictor* oficial,
  mas o id só é gravado depois de `GET /categories/{id}` confirmar que
  existe: `MLB999999999` (formato certo, inexistente) é rejeitado.
- **Não inventa preço, estoque, condição nem tipo de anúncio.** São
  digitados por uma pessoa e validados no servidor; o que não foi
  preenchido continua `null` e bloqueia. **Preencher com qualquer string
  não remove bloqueio**: condição é conferida contra a categoria, tipo de
  anúncio contra a lista documentada, preço e estoque contra o domínio.
- **Preço e estoque não vêm de `anuncios`.** Aquela tabela só contém
  anúncios **já publicados** (todas as linhas têm `ml_item_id`) e não tem
  vínculo com projetos do Estúdio; casar por nome seria heurística.
  Estoque não existe em nenhuma tabela do CDS.
- **Não usa `entradas_produto.quantidade` como estoque.** Aquele campo é
  *unidades por embalagem*; tratá-lo como `available_quantity` seria
  inventar estoque.
- **Não tira medida de foto nem usa inferência da IA como dado
  logístico.** `logistica` é um bloco próprio, hoje inteiramente `null`.
- **Não preenche atributo obrigatório com valor vazio.** Atributo sem
  valor real é **omitido** do payload — e a omissão é que gera o alerta.
- **Não chama IA.** Zero token, zero custo.
- **Não publica, não cria/altera anúncio, não faz OAuth, não chama API de
  marketplace.**

---

## Payload de pré-publicação

O validador produz **o payload que a integração futura vai consumir** —
assim compliance valida A e a publicação envia exatamente A, em vez de
montar B. Ele existe mesmo com bloqueios, com `null` nos campos ausentes,
e `payloadCompleto` distingue "pronto para enviar" de "esqueleto com
lacunas".

Imagens entram **por id** (`imagem_gerada_id`) — nunca bytes, nunca URL
assinada (que expira), nunca caminho de Storage. A URL pública que o ML
exige é gerada apenas na publicação real.

### O portão único

`podePublicarMarketplace()` (em `compliance/registry.ts`) é o **único**
lugar que decide publicabilidade. Retorna `true` só quando: há validador,
o status não é bloqueado, existe versão aprovada, o payload está completo
e o parecer **não está desatualizado**. Qualquer integração real futura
passa por ele — nunca por leitura solta de `status`.

---

## Persistência: parecer imutável

`estudio_anuncios_compliance_marketplace` é **append-only**. Regras de
marketplace mudam; uma versão aprovada hoje pode ser bloqueada amanhã, e
*"por que este anúncio foi considerado publicável em agosto?"* só tem
resposta se o parecer daquela data continuar existindo.

- **Idempotência por conteúdo:** `UNIQUE (projeto_id, marketplace,
  hash_entrada)`, onde o hash cobre conteúdo aprovado + imagens +
  categoria + atributos + preço + estoque + logística **+ `versaoRegras`**.
- **Subir `versaoRegras` invalida os pareceres anteriores**, porque a
  versão entra no hash. É assim que "a regra mudou" se propaga.
- **Parecer corrente ≠ parecer mais recente.** Como a validação é
  idempotente, revalidar após voltar a uma aprovação anterior *reencontra*
  um parecer antigo, que passa a ser o correto sem ser o último criado. O
  corrente é o parecer que descreve a **versão aprovada agora**; se nenhum
  descreve, o último é exibido marcado como `desatualizado` — e
  desatualizado **nunca publica**. (Buraco encontrado na validação real de
  2026-08-23 e fechado no mesmo dia; ver `BUGS.md`.)

---

## Validação OFICIAL — `POST /items/validate` (2026-08-25)

Depois do compliance local vem o validador do próprio Mercado Livre. São
**duas autoridades**, e o sistema guarda as duas separadas: quando algo é
reprovado, dá para dizer quem reprovou.

- **Não cria anúncio.** `/items/validate` é o endpoint que a fonte [C]
  recomenda para conferir o item antes de publicar. Não existe
  `POST /items` em nenhum arquivo do módulo, e um teste falha se aparecer.
- **Um payload só.** O corpo submetido é o produzido por
  `montarPayloadPublicacaoMercadoLivre()` a partir do parecer de
  compliance — o mesmo artefato que a publicação futura consumirá.
- **Imagens não vão no corpo.** O ML espera `pictures: [{source: URL}]`
  baixável; o bucket é privado e URL assinada curta expiraria. As imagens
  seguem por id, fora do payload, e o envio real fica para a publicação.
- **Estados:** `validado`, `validado_com_alertas`, `bloqueado`,
  `erro_comunicacao`. **Nenhum se chama `publicado`.** Falha de rede,
  401/403/429/5xx e timeout viram `erro_comunicacao` e **não liberam** o
  portão — não saber o que o ML acha ≠ ele ter aprovado.
- **Códigos oficiais preservados**, nunca traduzidos de um jeito que mude
  o significado. Problema sem `type` declarado conta como **erro**.
- **`podePublicarMercadoLivre()`** é o portão obrigatório: conteúdo
  aprovado + compliance corrente e publicável + loja vinculada +
  validação oficial corrente e sem erro + payload não alterado depois.

### Tipos de anúncio: a conta manda

`GET /sites/MLB/listing_types` (403 anônimo) revelou, na conta real, sete
tipos: `gold_pro`, `gold_premium`, `gold_special`, `gold`, `silver`,
`bronze`, `free` — três a mais que os quatro dos exemplos oficiais. Com a
conta vinculada, **a lista dela é a autoridade**; sem conta, vale a
documentada. Em nenhum caso se aceita string arbitrária.

## Modelo User Products (2026-08-26)

Fonte oficial: `https://developers.mercadolibre.com.ar/en_us/user-products`
("User Products", atualizada 19/12/2025), lida em 2026-08-26.

**Como o modelo é identificado.** Literal: *"How can I identify sellers
who are already under the new Price per Variation model? Through the
`user_product_seller` tag in the /users API."* Resolvido em
`GET /users/{seller_id}` com o token da conta — **nunca inferido do erro
de `/items/validate`**, que só diria que algum campo faltou. As tags
cruas ficam gravadas datadas, para a decisão continuar auditável.

Na conta real (2026-08-26) o retorno foi:
`["normal","business","messages_as_seller","eshop","user_product_seller","warehouse_management","large_seller","brand"]`
→ modelo **`user_products`**.

**O que muda no payload.**

| | `legacy` | `user_products` |
|---|---|---|
| `title` | enviado | **NÃO enviado** — o ML monta o título |
| `family_name` | não existe | **obrigatório** |
| `variations` | (fora de escopo) | **proibido** |

Literais que sustentam isso — fonte [A], seção Title: *"In the new way of
publishing (User Products) the title field will change its function and
should not be included in the publication."* Doc User Products: *"Will it
be possible to send the variations array after a seller is activated…?
No, you will not be able to send the array."*

**`family_name` não é o título.** É o nome *genérico* da família, usado
pelo ML para agrupar variações (`PARENT_PK` define a família; `CHILD_PK` e
atributos custom variam dentro dela). Na categoria de teste, `PARENT_PK` =
BRAND e MODEL; `CHILD_PK` = COLOR. A responsabilidade é do integrador —
literal: *"Will the family_name be managed by the integrator? … Yes, it is
the responsibility of the seller/integrator."*

**Limite.** Literal: *"The family_name that can be entered must be less
than or equal to the domain's `max_title_length`."* Vem da categoria pela
API — **não há número fixo no código**, e um teste falha se aparecer.

**O contrato editorial não muda.** O título aprovado continua existindo,
versionado e intacto; a diferença vive só no adapter de payload. Mudar a
API externa nunca justifica mudar o contrato interno.

| Código | Tipo | Regra |
|---|---|---|
| `ml_modelo_publicacao_nao_resolvido` | bloqueio | Os dois formatos são incompatíveis: sem saber o modelo não dá para montar o payload. |
| `ml_family_name_nao_informado` | bloqueio | Obrigatório em User Products. |
| `ml_family_name_excede_limite` | bloqueio | Acima de `max_title_length` da categoria. |
| `ml_titulo_nao_enviado_no_modelo_novo` | alerta | Aviso permanente: o título editorial existe, mas não vai ao ML neste modelo. |

### Pendência real encontrada pelo validador oficial

**2026-08-25 — primeira submissão:**

> `body.required_fields` — *"The body does not contains some or none of
> the following properties [family_name]"*

**Resolvido em 2026-08-26** com a adaptação ao modelo User Products.

**2026-08-26 — submissão seguinte, já no modelo novo:**

> `item.attribute.missing.seller.package.dimensions` — *"The attributes
> [seller_package_height, seller_package_width, seller_package_length,
> seller_package_weight] are all required"*

Ou seja: o Mercado Livre exige **peso e dimensões da embalagem**. É a
pendência de logística que já estava registrada como dívida — agora
confirmada pela própria API, e não por suposição. Nada foi mascarado nem
preenchido por estimativa: medida não pode sair de foto nem de inferência
de IA.

Este é o padrão da etapa: cada rodada de validação oficial revela o
próximo requisito real, e cada requisito é resolvido com fonte oficial
antes de seguir.

## Dados logísticos da EMBALAGEM (2026-08-27, `versaoRegras = 6`)

**A caixa não é o produto.** Esta é a frase que explica todo o desenho
desta parte. `SELLER_PACKAGE_*` descreve a embalagem já fechada — com
enchimento e fita —, não o objeto que vai dentro dela. Por isso **nada no
sistema deriva embalagem de `ficha.peso`, `ficha.medidas` ou de qualquer
dado logístico do produto**, nem como valor inicial, nem como palpite.
Um teste (`83`) existe só para provar isso: preenche a ficha do produto
com peso e medidas e verifica que os quatro bloqueios continuam de pé.

### Fonte

A exigência é declarada pela própria API — não por uma página de
documentação, e a distinção importa o suficiente para estar registrada
aqui. Duas evidências:

- `GET https://api.mercadolibre.com/categories/{id}/attributes` — os
  quatro atributos aparecem com `hierarchy: ITEM` e `allowed_units`
  restritas: dimensões só aceitam `cm`, peso só aceita `g`.
- Resposta real de `POST /items/validate` (2026-08-26):
  `item.attribute.missing.seller.package.dimensions`.

Os atributos `PACKAGE_*` (`hierarchy: FAMILY`) são `read_only` e **nunca
são enviados**.

### Unidades: guardadas como o ML pede, sem conversão

As colunas são `NUMERIC(10,2)` em `embalagem_peso_g` (gramas) e
`embalagem_{altura,largura,comprimento}_cm` (centímetros) — exatamente as
unidades da API. Não há conversão em lugar nenhum do caminho, e portanto
não há onde perder precisão. Um teste (`100`) falha se aparecer `kg`,
`mm`, `* 1000` ou `/ 1000` no SQL executável da migration.

### Quatro regras de bloqueio

| código | atributo |
|---|---|
| `ml_peso_embalagem_nao_informado` | `SELLER_PACKAGE_WEIGHT` |
| `ml_altura_embalagem_nao_informada` | `SELLER_PACKAGE_HEIGHT` |
| `ml_largura_embalagem_nao_informada` | `SELLER_PACKAGE_WIDTH` |
| `ml_comprimento_embalagem_nao_informado` | `SELLER_PACKAGE_LENGTH` |
| `ml_embalagem_medida_nao_inteira` | formato dos quatro (ver abaixo) |

As quatro medidas entram no hash do parecer e no hash da submissão:
mudar qualquer uma invalida a validação oficial anterior.

### Apenas INTEIROS (2026-08-28)

Na validação real com largura `13.5 cm`, o validador oficial respondeu:

> `item.attribute.invalid.format.seller.package.dimensions` — *"The
> attributes [seller_package_width] are in the wrong format - Only
> integers are accepted for dimensions and weight, with centimeters 'cm'
> as the unit for dimensions and grams 'g' as the unit for weight.
> Examples: 10 cm, 100 g"*

Com largura `13` (inteiro), o erro **desaparece por completo**.

**A resposta foi mudar o domínio, não arredondar.** Guardar 13,5 e enviar
13 seria gravar um número e publicar outro — o sistema estaria decidindo,
no lugar da pessoa, o tamanho da caixa. Então:

- as quatro colunas são `INTEGER` (migration `20260828`);
- o servidor exige `Number.isInteger(valor) && valor > 0`;
- a UI usa `step=1` e **recusa** decimal com mensagem própria;
- o compliance bloqueia com `ml_embalagem_medida_nao_inteira`, separado do
  "não informado" — um pede preencher, o outro pede corrigir;
- **não existe `Math.round`, `Math.floor`, `Math.ceil`, `Math.trunc`,
  `parseInt` nem `toFixed` em nenhum ponto deste caminho.** O teste `115`
  varre os quatro arquivos e falha se algum aparecer.

Um detalhe do banco que quase passou despercebido: os parâmetros da RPC
continuam `NUMERIC` **de propósito**. Com `INTEGER`, o próprio Postgres
converteria `13.5` em `14` no cast — arredondamento silencioso, dentro do
banco, sem rastro nenhum. Mantendo `NUMERIC`, o valor chega como veio e a
função o recusa com `EMBALAGEM_VALOR_NAO_INTEIRO`.

## Imagens: identidade estável vs transporte efêmero (2026-08-29, `versaoRegras = 7`)

**Uma imagem tem duas representações, e confundi-las é o erro que esta
camada existe para impedir.**

```
IDENTIDADE (estável — entra no hash, é persistida)
  { imagemGeradaId, checksum, ordem, principal }

TRANSPORTE (efêmero — nunca persistido, nunca hasheado)
  { source: "<URL assinada, TTL de 300 s>" }
```

A URL assinada carrega um token e uma expiração. Se ela entrasse no
hash, **toda validação oficial nasceria desatualizada**: duas URLs do
mesmo objeto produziriam hashes diferentes. Isso não afrouxa a garantia
de *"validar A e publicar A"* — o que define A é o `checksum` dos bytes,
conferido nos dois momentos. A URL é só a credencial de download daquele
instante.

Confirmado no fluxo real: revalidar com URLs novas **manteve o mesmo
hash** e reaproveitou a linha existente; trocar o checksum invalida.

### Contrato oficial de `pictures`

Fonte [B] (*Working with pictures*, atualizada 24/03/2026):

| Requisito | Literal da fonte |
|---|---|
| Formato | *"Format JPG, JPEG and PNG."* |
| Tamanho | *"You can upload images up to 10 MB."* |
| Resolução | mínimo *"500px x 500px (version M)"*, máximo *"1920 x 1920 px (version F)"* — acima disso o ML **redimensiona**, não recusa |
| Quantidade | `max_pictures_per_item` **da categoria** (12 na de teste) |
| `source` | `pictures: [{"source": "http://..."}]` — o ML **baixa** a imagem da URL |

A mesma fonte alerta sobre o download feito pelo ML: sem redirecionamento,
certificado válido, e a lista de erros possíveis inclui `Connect timed
out` e `Slow_domain`. É daí que sai o TTL de **300 s** — a janela cobre
uma requisição lenta com folga e continua curta.

### Alternativa oficial encontrada e NÃO implementada

A fonte [B] descreve também `POST /pictures/items/upload` (multipart),
que devolve um `picture id` reutilizável:

> *"We recommend using the obtained ID to make a new publication or
> associate the image with an existing publication."*

Não foi implementada. É um `POST` que **cria um recurso na conta do
Mercado Livre** — decisão do usuário, não escolha técnica silenciosa. A
via adotada (`source` + URL assinada) não escreve nada do lado deles.

### Seleção determinística

Principal primeiro → `ordem` crescente → `imagemGeradaId` como desempate.
O desempate por id não é preciosismo: sem ele, duas imagens com a mesma
`ordem` poderiam trocar de lugar entre execuções e mudar o hash sem nada
ter mudado.

Acima do limite da categoria, o corte é pelo **fim dessa mesma ordem** —
nunca aleatório — e o que ficou de fora é nomeado no alerta.

| Código | Tipo | Quando |
|---|---|---|
| `ml_sem_imagem` | bloqueio | o projeto não tem imagem nenhuma |
| `ml_sem_imagem_valida_para_envio` | bloqueio | tem imagens, **nenhuma** passa nos requisitos |
| `ml_imagem_principal_ausente` | alerta | nenhuma marcada como principal |
| `ml_imagens_excedentes_nao_enviadas` | alerta | válidas cortadas pelo limite da categoria |

`ml_imagens_acima_do_maximo` **deixou de ser bloqueio** nesta versão:
antes não havia seleção, então imagem demais tornava o anúncio
impublicável. Agora o excedente é cortado e o usuário é avisado.

### O que nunca acontece

Bucket nunca vira público. `storage_path` nunca sai da camada nem chega
ao ML. Nenhuma imagem é regenerada, copiada para bucket público ou lida
de outro projeto — a consulta filtra por `projeto_id` **e** por `id`.
Nenhum `picture id` é inventado. Nenhum byte vai em base64 no payload.

## Warning ≠ erro: como a resposta oficial é lida (2026-08-30)

**O código HTTP do validador não é o veredito.** O `/items/validate`
responde `400 validation_error` sempre que tem algo a dizer — inclusive
quando esse algo são apenas avisos. A documentação oficial separa os dois
tipos, e é essa separação que vale:

| `type` | Significado | Efeito aqui |
|---|---|---|
| `error` | exige alterar o JSON | **bloqueia** |
| `warning` | informativo | não bloqueia, mas fica **visível** |

```
existe cause type=error ....................... bloqueado
zero errors + ≥1 warning (envelope conhecido) . validado_com_alertas
200/204 sem causes ............................ validado
401 · 403 · 429 · 5xx · timeout · ilegível .... erro_comunicacao
400 fora do envelope conhecido ................ bloqueado (seguro)
```

**A exceção ao 400 é estreita de propósito.** Só vale para o envelope
CONHECIDO — `error: "validation_error"` com `cause` em array, de fato
interpretado — e só quando não sobrou nenhuma causa bloqueante. Qualquer
outro 400 continua sendo problema: *"não sei o que aconteceu"* nunca vira
aprovação.

A versão anterior fazia `if (!aceito) return "bloqueado"`, misturando
status de protocolo com resultado semântico — e transformava "validado
com dois avisos" em "bloqueado", mantendo o portão fechado sem nenhum
erro existir.

O portão (`podePublicarMercadoLivre`) aceita `validado` e
`validado_com_alertas`, **e só** se todas as outras invariantes valerem:
compliance corrente, conteúdo aprovado, loja certa, payload corrente,
validação não desatualizada e zero `type: error`.

## Pictures no CDN do Mercado Livre (2026-08-30)

O caminho principal deixou de ser a URL assinada. A fonte [B] descreve o
endpoint oficial e o recomenda explicitamente:

> `POST https://api.mercadolibre.com/pictures/items/upload`
> (`multipart/form-data`) — *"We recommend using the obtained ID to make
> a new publication or associate the image with an existing publication."*

**Por que trocar:** a URL assinada é efêmera, some em minutos. O
`picture id` é **estável para a conta**. Com ele, o payload validado e o
payload que um futuro `POST /items` enviaria são **o mesmo objeto** — não
há nada efêmero no meio que possa ter mudado entre validar e publicar.

O caminho por `source` **não foi apagado**: continua isolado em
`montarPayloadTransporteML()` e testado, como alternativa técnica.

### O mapa, e por que o checksum está na chave

```
(loja_id, imagem_gerada_id, checksum_sha256) → ml_picture_id
```

Sem o checksum, trocar os bytes mantendo o mesmo `imagem_gerada_id`
reaproveitaria um picture id que aponta para a imagem **antiga** no CDN —
publicar-se-ia uma foto que ninguém aprovou, e em silêncio. `loja_id`
entra porque o picture id é da CONTA: o mesmo arquivo subido por duas
contas gera dois ids, e um não serve para a outra.

A tabela `estudio_anuncios_pictures_marketplace` é **append-only**, com
`UNIQUE` nas três partes. Antes de cada upload: pertence ao projeto,
objeto existe, MIME aceito, e o checksum dos bytes bate com o que o
parecer validou.

### Não há atomicidade entre o ML e o Postgres

Subir a imagem lá e gravá-la aqui são dois sistemas sem transação comum.
Em concorrência, os dois uploads acontecem e só um vence o `UNIQUE`; o
perdedor vira um recurso **órfão** no CDN deles — não referenciado,
inofensivo, e **reportado** em `orfaos`. O mesmo vale para "subiu mas não
gravou". Fingir transação distribuída seria mentira.

## Publicação real — `POST /items` (2026-08-31)

**Publica-se exatamente o que foi validado.** O payload não é remontado
a partir do estado atual do banco: é lido da linha de
`validacoes_publicacao` que o Mercado Livre aprovou. Antes de enviar, três
conferências — o hash bate com o payload de agora, a conta é a mesma da
validação, e **todas** as imagens validadas têm picture id.

A única transformação permitida é de transporte: `pictures` canônicas
viram `[{ id }]` com os MESMOS `ml_picture_id` já validados. Nenhuma
imagem sobe de novo, nenhuma URL assinada é gerada.

### Duas fases, e o motivo

```
1. RESERVA  (status em_andamento, protegida por UNIQUE parcial)
2. POST /items   ← uma vez, sem retry
3. CONCLUSÃO (publicado | falha | publicacao_incerta)
```

Reservar **depois** da chamada permitiria que dois cliques disparassem
dois POSTs antes de qualquer INSERT — e nasceriam dois anúncios. A UI
desabilitada não é proteção; o índice único é.

### "Não sei" é um desfecho

| Resposta do ML | Status | Por quê |
|---|---|---|
| 200/201 com id | `publicado` | item criado |
| 400 · 422 · 401 · 403 · 429 | `falha` | recusado **antes** de criar |
| timeout · 5xx · 200 sem id | `publicacao_incerta` | **pode** ter criado |

`publicacao_incerta` é deliberadamente distinto de `falha`: falha convida
a tentar de novo, incerto exige reconciliar. A reconciliação compara a
lista de anúncios da conta tirada **antes** do POST com a de depois, e só
conclui se aparecer exatamente um item novo. **Nunca reenvia.**

`falha` fica fora do índice único de propósito — um 4xx estruturado prova
que nada foi criado, então tentar de novo depois de corrigir é legítimo.

### Não há idempotency-key

A documentação oficial não descreve `Idempotency-Key`, `X-Request-Id` nem
equivalente para `POST /items` (verificado em 2026-08-31). Mandar um
cabeçalho que o servidor ignora daria falsa sensação de proteção, então
não existe: a proteção é a reserva. Um teste falha se alguém inventar um.

### O título é do Mercado Livre

Em User Products o ML monta o título. Na primeira publicação, enviamos
`family_name: "…Facial e Pedra…"` e o item nasceu com `title` e
`family_name` iguais a `"…Facial E Pedra…"` — title-case aplicado por
eles. A comparação pós-publicação **não** cobra igualdade de título:
comparar texto editorial com título gerado seria comparar semânticas
diferentes.

### O que esta camada nunca faz

Não edita, não pausa, não fecha, não exclui, não sincroniza. Não existe
`DELETE` nem `PUT /items` em nenhum arquivo do módulo — inclusive como
"rollback automático", que seria uma operação destrutiva disfarçada.

## Shopee — `nao_implementado` nesta V1

**Nenhuma regra da Shopee foi implementada, e isso é deliberado.**

A documentação oficial da Shopee Open Platform (`open.shopee.com/documents`)
é uma aplicação renderizada por JavaScript: o HTML servido não contém o
conteúdo, nenhum endpoint público de documentação em JSON foi encontrado, e
as ferramentas disponíveis neste ambiente não conseguem renderizá-la.

A escolha era entre um validador Shopee **inventado** e um
`nao_implementado` **honesto**. Congelar regra de `v2.product.add_item` a
partir de memória ou de fonte não oficial é exatamente o que esta camada
existe para impedir. O canal fica `nao_implementado`, com o motivo
explícito na UI, e **nunca aparece como publicável**.

A arquitetura já está pronta: implementar Shopee é adicionar
`regras-shopee.ts` (com fontes oficiais e datas), `shopee.ts` (validador) e
uma entrada em `VALIDADORES`. Nada mais muda.

**Amazon e TikTok Shop** também são `nao_implementado` — por escopo, não
por indisponibilidade de documentação.

---

## Como adicionar uma regra

1. Confirme na **documentação oficial** do marketplace. Não use memória.
2. Acrescente a entrada em `REGRAS_*` com `fonteOficial` (URL + título +
   data declarada da página) e `verificadoEm`.
3. Aplique-a no validador via `regra*(codigo)` — códigos desconhecidos
   lançam, então não existe item de compliance sem origem.
4. Se a regra muda o parecer de conteúdo já validado, **suba
   `VERSAO_REGRAS_*`**: isso invalida os pareceres anteriores pelo hash.
5. Espelhe a linha na tabela deste documento.
6. Rode `npx tsx scripts/testar-compliance.ts`.
