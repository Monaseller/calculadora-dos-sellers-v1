# O que "Faturamento (pagos)" significa no Mercado Livre

Auditoria do gate F7b.4.8.3 §10. Tudo aqui foi **medido** contra a API
oficial na loja autorizada, em leitura apenas. Onde a medição não fechou,
o caso está marcado `ABERTO` — não há suposição preenchendo lacuna.

> **Atualização F7b.4.8.5.** Este documento descreve a dimensão de
> **PAGAMENTO**, que é `buscarVendasPagasML`. Ela **não é mais** o que o
> agente responde quando alguém pergunta "quanto vendi".
>
> Desde a F7b.4.8.5 o agente responde **VENDAS BRUTAS**:
> `order.date_closed` convertido para America/Sao_Paulo, soma de
> `order.total_amount`, unidades por `Σ order_items[].quantity`, excluindo
> apenas `cancel_code = pack_splitted`. Provado contra o relatório
> detalhado da própria loja: R$ 393.838,47 / 10.898 vendas / 11.361
> unidades em setembro de 2026, com igualdade de conjunto pedido a pedido.
>
> As duas dimensões coexistem de propósito: venda bruta é o que foi
> vendido, pagamento é o que entrou. A segunda segue `PARTIAL`, e é dela
> que o resto deste documento trata.

**Não** descreve o espelho da CDS (tabela `pedidos`, Dashboard, página
Vendas), declarado como
`CDS_SALES_MIRROR_ACCURACY = KNOWN_UNRELIABLE / DEFERRED`.

---

## A regra, em uma frase

Um pedido entra no faturamento de um período quando tem **pagamento
aprovado** (`approved` ou `partially_refunded`) cuja **data de aprovação**,
convertida para o dia civil de São Paulo, cai dentro do período. O valor
somado é o `paid_amount` do pedido.

Três consequências que a frase esconde e que importam:

1. A janela é buscada por **data de criação**, alargada em 5 dias para
   trás, porque a API **não tem** filtro por data de pagamento (medido: o
   parâmetro é ignorado e a consulta devolve o histórico inteiro da loja).
   O recorte financeiro é feito localmente.
2. O **status do pedido não é consultado**. A autoridade é o pagamento.
3. `paid_amount` é o que o **comprador pagou**, e não o que o vendedor
   recebeu. Não é líquido, não desconta tarifa, frete do vendedor, imposto
   nem custo.

---

## Caso por caso

Amostra profunda: os 2042 pedidos criados em 01/08–07/08/2026, cada um
aberto individualmente. Onde aparece uma segunda janela, é 10/09–20/09.

### Pago — `CONTA`

`approved / accredited`: 1937 dos 1959 pagamentos da semana. É o caso
normal.

### Estornado em parte — `CONTA, pelo valor cheio`

`partially_refunded` no pagamento conta, e o critério é o mesmo de
`sync-ml.ts`: a venda aconteceu financeiramente.

Medido em 10/09–20/09: **9 pedidos** com `order.status =
partially_refunded` e pagamento `approved`, somando **R$ 293,29**. Eles
estavam sendo **perdidos** até este gate, porque a consulta filtrava
`order.status=paid` antes de a regra de pagamento ser aplicada — duas
autoridades sobre o mesmo número, discordando. O filtro foi removido.

`ABERTO`: o valor somado continua sendo o `paid_amount` **cheio**, sem
descontar a parte estornada. Um estorno parcial de R$ 30 num pedido de
R$ 100 soma R$ 100. O campo `transaction_amount_refunded` existe e foi
medido, mas **decidir se o faturamento deve ser líquido de estorno é
decisão de negócio**, não de implementação — e mudá-la por iniciativa
própria mudaria todo número histórico que o agente já respondeu.

### Estornado inteiro — `NÃO CONTA`

O pagamento passa a `refunded` e deixa de ser aprovado. Medido na semana:
112 pagamentos `refunded` (88 `bpp_refunded`, 12 `bpp_covered`, 9
`by_admin`, 3 `refunded`), todos em pedidos `cancelled`, com estorno
registrado somando R$ 4.093,79.

Detalhe relevante: nesses pedidos o `paid_amount` medido é **0,00**. Ou
seja, mesmo que a regra os aceitasse, eles não somariam nada.

### Cancelado depois de pago — `NÃO CONTA`

Mesmo caminho do anterior: o cancelamento vem acompanhado de estorno, e o
pagamento sai de `approved`. Medido: 112 pedidos `cancelled` em 2042
criados na semana; 611 não-`paid` em 9685 criados em agosto.

Medido também o caso inverso, que é o que interessa: **0** pedidos
não-`paid` com pagamento ainda aprovado, na semana de agosto. Em
10/09–20/09 esse número foi 9, e todos eram `partially_refunded` — ver o
caso acima.

### Mais de um pagamento — `CONTA UMA VEZ, na data do mais antigo`

Medido na semana: 34 pedidos com 2 pagamentos e 2 com 4 pagamentos; **10
pedidos com mais de um pagamento aprovado**; e em **3 desses, a ordem do
array não começa pelo mais antigo**.

A regra era "o primeiro do array", herdada de `sync-ml.ts` (`.find()`).
Isso deixava a ordem de um array do provedor decidir em que dia — e, na
virada do mês, em que **mês** — a venda entrava. Agora a regra é dita:

> A venda foi paga no **primeiro** instante em que houve pagamento
> aprovado. Um segundo pagamento aprovado depois não empurra a venda para
> a frente no tempo.

Comparação por instante, não por texto, porque dois ISO do mesmo momento
podem vir com offsets diferentes.

`ABERTO`: o espelho da CDS continua com a regra antiga. É divergência
conhecida, dentro do que este gate declarou diferido.

### Chargeback — `NÃO CONTA`

Medido: 3 pagamentos `charged_back / reimbursed` na semana, em pedidos com
`order.status = paid`; em 10/09–20/09, 3 pedidos somando R$ 80,69. O
pagamento não é `approved`, então a regra o recusa. É o resultado certo: o
vendedor não ficou com o dinheiro.

### Em mediação — `NÃO CONTA`

Não estava na lista do §10, e apareceu na medição: **14 pedidos** em
10/09–20/09 com `order.status = paid` e pagamento `in_mediation /
pending`, somando **R$ 650,82**. Dinheiro em disputa não é receita, e o
pagamento não está aprovado.

`ABERTO`: se a mediação for resolvida a favor do vendedor, o pagamento
passa a `approved` e a venda **entra retroativamente** no faturamento
daquele período. Ver "O número de um período passado não é imutável".

### Pagamento recusado ou cancelado — `NÃO CONTA`

Medido na semana: 20 `cancelled` (13 `by_payer`, 7 `expired`) e 10
`rejected` (cartão insuficiente, CVV errado, cartão desabilitado, tipo não
aceito). Nenhum é `approved`.

Provado também que um `rejected` **mais antigo** que o aprovado não vira a
data da venda (`testar-ml-varredura-robusta.ts`, controle I4).

### Pagamento duplicado ou reprocessado — `ABERTO`

Não foi possível distinguir, pelos campos de `/orders/search`, um segundo
pagamento que é **nova cobrança legítima** (parcela, complemento de frete)
de um que é **reprocessamento do mesmo dinheiro**. O que se sabe:

- o pedido é contado **uma vez**, pelo id — dois pagamentos nunca viram
  duas vendas;
- o valor somado é o `paid_amount` do **pedido**, e não a soma dos
  pagamentos, então um pagamento repetido não dobra o valor.

Isso limita o estrago, mas não é o mesmo que classificar o caso. Exigiria
`/payments/{id}` ou `/orders/{id}/payments`, que não foram chamados.

### Pedido com valor alterado — `PARCIAL`

Medido na semana: **228 dos 2042** pedidos têm `paid_amount` diferente de
`total_amount`, e **139** têm `paid_amount` diferente da soma dos
`transaction_amount` dos pagamentos aprovados (R$ 66.656,19 contra
R$ 65.187,58 no agregado).

O que está decidido: a fonte do valor é o `paid_amount` do pedido, que é o
campo oficial do quanto o comprador pagou por aquele pedido — frete
incluído quando o comprador paga o frete.

O que está `ABERTO`: **por que** diferem. As duas explicações prováveis
são frete e desconto/cupom, e nenhuma foi confirmada contra os campos de
`shipping` e `coupon`, que esta auditoria não abriu.

---

## O número de um período passado não é imutável

Consequência direta da regra, e ela precisa ser dita porque contraria a
intuição de quem lê um relatório:

- um estorno hoje **remove** uma venda do faturamento de um mês fechado;
- uma mediação resolvida hoje **acrescenta** uma venda a um mês fechado;
- um chargeback hoje **remove** uma venda de um mês fechado.

Isso foi observado na prática, e foi o que motivou parte desta auditoria:
a janela 10/09–20/09 devolveu 3305 pedidos numa leitura e 3304 quatro
minutos depois. (A causa daquela divergência específica acabou sendo
outra — paginação instável, já corrigida e descrita em
`lib/mercado-livre-vendas.ts` — mas a propriedade continua valendo.)

O agente **não deve** apresentar um número de período passado como
definitivo. Ele é o que a conta do Mercado Livre diz **agora** sobre
aquele período.

---

## O que este número NÃO é

- **Não é líquido.** Não desconta tarifa do Mercado Livre, frete pago pelo
  vendedor, imposto nem custo do produto. A margem da CDS usa líquido
  recebido, e é outra conta (`lib/cds-engine.ts`).
- **Não é volume de pedidos criados.** Pedido criado e não pago não entra.
- **Não é o que o espelho da CDS mostra.** As duas leituras podem
  discordar, e neste gate o espelho está declarado não confiável.

---

## Veredito

`PAYMENT_FINANCIAL_SEMANTICS = PARTIAL`

Sete casos do §10 estão provados com medição e controle negativo: pago,
estornado em parte, estornado inteiro, cancelado depois de pago, mais de
um pagamento, chargeback e — fora da lista — em mediação e pagamento
recusado.

Quatro pontos seguem `ABERTO`, e por isso o veredito não é `PROVEN`:

1. faturamento líquido de estorno parcial — decisão de negócio pendente;
2. distinção entre pagamento duplicado e nova cobrança legítima — exigiria
   endpoint não chamado;
3. a razão da diferença entre `paid_amount` e `total_amount`;
4. a divergência deliberada com a regra do espelho da CDS.

Nenhum dos quatro é resolvido escolhendo por intuição, e é por isso que
estão listados em vez de decididos.

---

## Como reproduzir

```bash
npx tsx scripts/medir-ml-semantica-pagamento.ts   # o censo e os casos
npx tsx scripts/medir-ml-janela-divergente.ts     # o que o filtro escondia
npx tsx scripts/testar-ml-varredura-robusta.ts    # a regra, com controles
```
