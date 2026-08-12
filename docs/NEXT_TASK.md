# NEXT_TASK — Estúdio de Anúncios com IA

> Arquivo curto (<100 linhas), muda a cada sessão. É a fonte única do
> estado corrente — nunca o `PROJECT_STATE.md`.
> **Ordem de leitura: `CLAUDE_CONSTITUTION.md` primeiro, este arquivo em
> seguida.** A Constituição (v1.0, congelada) é a autoridade máxima.
> Ao encerrar QUALQUER sessão neste módulo, atualizar este arquivo é
> obrigatório, mesmo que a tarefa não tenha terminado.

---

## STATUS

**🏁 Fase 1 · editorial · exportação · ZIP · pré-publicação · dados de
publicação · loja + `/items/validate` · modelo User Products · dados
logísticos da embalagem · imagens no CDN do ML · **PUBLICAÇÃO REAL**
entregues.** O primeiro anúncio existe: **`MLB7395781296`**, status
`active`, conta MONAMOR. **Exatamente UM `POST /items` foi executado.**
O canal está travado — `podePublicarML = false` daqui em diante.

## Última sessão encerrada em

2026-08-31

## Checkpoint

- **Commit `3486448`** na branch `main` — 186 arquivos, código + 39
  migrations + 13 suítes + documentação. Working tree limpa.
- **PUSH E DEPLOY NÃO EXECUTADOS.** Faltam **24 variáveis de ambiente**
  em produção (`SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_AI_API_KEY`,
  `ANTHROPIC_API_KEY`, …). Ver `BUGS.md`.
- ⚠️ **`git push` = deploy** neste repositório: o projeto Vercel está
  conectado ao Git na `main`. O gate vale para o push, não só para o
  deploy.
- Produção hoje: `www.ligadossellers.com.br` saudável; o Estúdio
  responde **404** lá (nunca foi deployado).

## Separação de papéis

```
resultados_pipeline    → histórico TÉCNICO imutável (IA)
conteudo_versoes       → histórico EDITORIAL humano, append-only
pacotes_exportacao     → congelamento do aprovado + ZIP
projetos_marketplace   → dados de publicação + conta + modelo + family_name
compliance_marketplace → parecer LOCAL (regras nossas)
validacoes_publicacao  → parecer do MERCADO LIVRE (API real)
```

Editar ≠ aprovar. Aprovar ≠ publicar. Exportar ≠ publicar. Configurar ≠
publicar. Validar ≠ publicar.

## Modelo User Products — o que mudou

- **Modelo resolvido pela API** (`GET /users/{seller_id}`, tag
  `user_product_seller`), ao **vincular a conta** e revalidado na
  validação oficial. Nunca inferido do erro.
- **`title` NÃO é enviado** (o ML monta o título) e **`family_name` é
  obrigatório**, com limite = `max_title_length` da categoria.
  `variations` nunca é montado.
- **Dois builders explícitos**, um ponto de escolha — sem `if` espalhado.
- **O título editorial continua intacto.** A diferença vive só no adapter.
- **`family_name` não é o título:** há sugestão server-side, rotulada
  como sugestão, editável, e só vira dado quando a pessoa salva.
- Modelo e `family_name` entram no hash: mudar qualquer um invalida a
  validação oficial anterior.

## Publicação real — o que mudou (2026-08-31)

- **Publica-se o que foi VALIDADO.** O payload é lido da linha de
  `validacoes_publicacao`, nunca remontado. Hash e conta conferidos.
  Só transformação de transporte (`pictures` → `[{id}]`).
- **A trava é uma RESERVA no banco, antes da chamada.** UI desabilitada
  não protege; `UNIQUE` parcial protege. Segunda tentativa e duplo
  clique simultâneo → **409 `ja_publicado`**.
- **`publicacao_incerta` ≠ `falha`.** Timeout/5xx podem ter criado o item;
  o código **não reenvia** — reconcilia comparando a lista de anúncios da
  conta de antes e depois.
- **Sem idempotency-key inventada:** a API oficial não tem uma.
- **Não edita, não pausa, não fecha, não exclui, não sincroniza.**

## Warning ≠ erro (2026-08-30)

- **O HTTP do validador não é o veredito.** O ML responde
  `400 validation_error` sempre que tem algo a dizer, inclusive só avisos.
  `error` bloqueia; `warning` não, mas continua **visível**.
- **A exceção ao 400 é estreita:** só o envelope conhecido
  (`validation_error` + `cause` interpretado) e sem causa bloqueante.
  Qualquer outro 400 → bloqueio seguro. 401/403/429/5xx/timeout →
  `erro_comunicacao`.

## Pictures no CDN do ML (2026-08-30)

- **`POST /pictures/items/upload`** (oficial, multipart) devolve picture
  ids **estáveis para a conta**; o payload leva `pictures: [{ id }]`.
- **Por quê:** o payload validado e o que um `POST /items` enviaria viram
  **o mesmo objeto** — nada efêmero no meio. O caminho por `source` não
  foi apagado, só deixou de ser o principal.
- **Mapa `(loja, imagem, checksum) → ml_picture_id`**, append-only. O
  checksum está na chave para que bytes novos nunca reaproveitem um id
  que aponta para a imagem antiga no CDN.
- **Sem atomicidade ML↔Postgres:** em concorrência, o perdedor do UNIQUE
  vira picture **órfã** no CDN deles — reportada, nunca escondida.

## Imagens — o que mudou (2026-08-29)

- **Duas representações, nunca confundidas.** IDENTIDADE
  (`{id, checksum, ordem, principal}`) entra no hash e é persistida;
  TRANSPORTE (`{source}`, URL assinada de 300 s) nasce no instante da
  chamada e **nunca** é persistido, logado ou hasheado.
- **Se a URL entrasse no hash**, toda validação nasceria desatualizada.
  Confirmado: URLs novas → mesmo hash; checksum diferente → stale.
- **Bucket segue PRIVADO.** Zero `getPublicUrl`, zero base64, zero
  `storage_path` enviado ao ML.
- **Seleção determinística:** principal → `ordem` → id. Limite vem de
  `max_pictures_per_item` da categoria.
- **`POST /pictures/items/upload` existe e é oficial** — mas cria recurso
  na conta do ML. Registrado, **não implementado**.

## Embalagem — o que mudou (2026-08-27)

- **A caixa não é o produto.** Nada deriva `seller_package_*` de
  `ficha.peso` ou `ficha.medidas` — nem como valor inicial. Teste `83`
  existe só para provar isso.
- **Unidades da API, sem conversão:** dimensões em `cm`, peso em `g`
  (`allowed_units` conferidas em `/categories/{id}/attributes`).
- **Apenas INTEIROS** (`versaoRegras = 6`). Decimal é **recusado**, nunca
  arredondado: banco `INTEGER`, servidor `Number.isInteger`, UI `step=1`.
  Nenhum `Math.round/floor/ceil/trunc`, `parseInt` ou `toFixed` no caminho.
- **O parecer distingue AUSENTE de MAL FORMATADO** — um pede preencher, o
  outro pede corrigir. As quatro medidas entram no hash do parecer e da
  submissão.
- **Só `SELLER_PACKAGE_*` é enviado.** `PACKAGE_*` é `read_only`.

## Última validação

- ✅ **Ciclo limpo do `family_name`: 16/16.** Sem ele → bloqueio +
  sugestão (banco continua `NULL`); com ele → bloqueio some e o ML aceita
  o campo. Acima do limite → 400 **sem truncar**.
- ✅ **`/items/validate` real:** `family_name` **não aparece mais** como
  campo faltando; `title` fora do payload; `variations` ausente.
- ✅ **Novo requisito oficial revelado:**
  `item.attribute.missing.seller.package.dimensions` — peso e dimensões
  da embalagem.
- ✅ 9 auditorias SQL, 0 achados. **0 anúncios criados, 0 consumo de IA.**
- ✅ 46/46, 85/85, 32, 23, 30, 31, 22, 56, 40, 36, 60, 52, 58;
  `tsc --noEmit` limpo.
- ✅ **Imagens (2026-08-29): 26/26 na validação real.** As 3 imagens do
  projeto foram submetidas; `requiresPictures` **sumiu** e a lista de
  **erros ficou VAZIA**. Teste de download real: HTTP 200, 459.049 bytes,
  `image/jpeg`, checksum conferido — URL nunca impressa.
- ✅ **Publicação real (2026-08-31): 42/43 na auditoria.** Item
  `MLB7395781296` `active`, **zero divergências** entre payload validado e
  item criado, 3 imagens, 4 `SELLER_PACKAGE_*` presentes. A única
  diferença: o ML aplicou title-case no `family_name` (formatação dele).
  Segunda tentativa → 409; duplo clique → 409/409; nenhuma linha nova.
  `anuncios` intacta (1.579), Pipeline/score/editorial/pacotes intactos,
  zero consumo de IA.
- ✅ **Pictures + warnings (2026-08-30): 24/24 na validação real.** As 3
  imagens subiram ao CDN do ML e voltaram com picture ids; a validação
  ficou **`validado_com_alertas` com zero erros** e o portão abriu
  (`podePublicarML = true`). Revalidar **não subiu nada de novo** (3 → 3),
  manteve o hash e reaproveitou a linha.
- ✅ Auditoria SQL: 0 pictures duplicadas, 0 de projeto errado, 0 token
  persistido, 0 signed URL persistida, 0 bucket público.
- ✅ **Inteiros (2026-08-28): 21/21 na validação real.** Cinco tentativas
  decimais → **400**, e o banco ficou idêntico depois delas. Inteiros
  gravados exatos, coluna `integer`, parecer em v6 sem bloqueio de
  embalagem, payload igual ao banco (`"13 cm"`, `"420 g"`).
- ✅ **`invalid.format.seller.package.dimensions` NÃO aparece mais**, e
  `missing.seller.package.dimensions` também não. Único erro restante:
  `item.listing_type_id.requiresPictures`. Dois alertas de shipping.
- ✅ Regressão 128/128 e 49/49; `tsc --noEmit` limpo; Fase 1, editorial e
  score intactos; **0 anúncios criados, 0 consumo de IA.**

## Próxima tarefa

**Nenhuma autorizada.** Duas coisas esperam por você, nesta ordem:

1. **Configurar as 24 variáveis ausentes em produção** (painel da Vercel).
   São segredos — a configuração é sua. Só depois disso o push/deploy
   pode acontecer, e o Estúdio funcionará em produção.
2. **Revisar o primeiro anúncio real** antes de qualquer segunda operação
   externa.

Explicitamente NÃO autorizado até você decidir: publicar outro anúncio,
editar, pausar, fechar, excluir, sincronizar estoque ou preço, iniciar
Shopee.

⚠️ **O anúncio está ATIVO e vendável, com estoque 999.** Enquanto estiver
`active` ele aparece na vitrine e pode receber pedido real. O Estúdio não
pausa nem encerra anúncio — essa contenção, se for desejada, é decisão e
ação suas.

## Bloqueio de fonte (não de código)

🔴 **Shopee sem validador.** Documentação oficial é SPA ilegível neste
ambiente; nada foi congelado de memória.

## Dívidas registradas

- 🟠 **`getMLLojaById()` não checa dono** — contornado na origem pelo
  Estúdio; qualquer consumidor novo precisa repetir a checagem. Ver `BUGS.md`.
- 🟡 **Warnings de shipping** (`me1`, frete grátis obrigatório) — são da
  conta e da categoria, não do payload.
- 🟡 **Picture órfã no CDN do ML é possível em concorrência** — reportada
  em `orfaos`, nunca escondida. Ver `BUGS.md`.
- 🟡 **`publicacao_incerta` não tem tela de reconciliação** — trava o canal
  até alguém resolver no banco. Deliberado, mas sem UI.
- 🟡 **Anúncio `MLB7395781296` ativo e vendável** (estoque 999), criado de
  projeto de teste. Ver `BUGS.md`.
- 🟡 **Variações / múltiplos User Products** não implementados: esta etapa
  trata publicação mono-produto. `PARENT_PK`/`CHILD_PK` foram preservados
  na semântica, mas nada os usa ainda.
- 🟡 **Garantia (`sale_terms`) não validada.**
- 🟡 **`lojas` com `user_id` NULL** (resíduo de OAuth antigo).
- 🟡 **Imagem não tem aprovação humana própria.**
- 🟡 **Layout da página quebra em 375px** — pré-existente, do app shell.
- 🟡 **Sem política de retenção** do bucket de exportações.
- 🟡 **Amazon e TikTok Shop** `nao_implementado` por escopo.

## Receita de teste de falha sem custo

Job com etapa **`busca_externa`** num pipeline em `analise_produto`: está
no catálogo mas fora de `ETAPAS_SUPORTADAS_FASE1` — o executor rejeita
com `validation` antes de qualquer provedor. Determinístico e gratuito.
