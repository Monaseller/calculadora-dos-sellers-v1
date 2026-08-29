-- ============================================================
-- SKILL-1D.agent-custom-type-B — o setimo perfil: `personalizado`
--
-- NAO APLICADA AINDA. Aplicar ao banco exige autorizacao explicita,
-- separada da criacao deste arquivo.
--
-- ── A PERGUNTA QUE ESTE ARQUIVO RESPONDE ────────────────────────────
--
-- A fundacao (`20260916_agentes_fundacao.sql`) fechou `agentes.tipo`
-- em seis valores, todos nomeando uma FUNCAO conhecida: mensagens,
-- ads, fotos, anuncios, financeiro, gerente. Isso obriga quem cria um
-- agente a escolher, no primeiro segundo, uma caixa que ele muitas
-- vezes ainda nao sabe qual e — e a alternativa que ele realmente
-- queria ("um agente meu, para o que eu precisar") nao existia.
--
-- `personalizado` e essa alternativa.
--
-- ── O QUE `personalizado` NAO SIGNIFICA ─────────────────────────────
--
-- Nada muda de poder. `tipo` nunca concedeu capacidade neste sistema e
-- continua sem conceder: nao ha, em producao, um so `switch` sobre
-- `agentes.tipo`, nenhuma comparacao por valor canonico que libere
-- comportamento, e os unicos mapas exaustivos por tipo sao
-- apresentacao (`DESCRICAO_TIPO`, `CORES_TIPO`).
--
-- O que um agente PODE fazer vem de Skills, Funcoes, conexoes e
-- permissoes — autoridades proprias, cada uma com a sua tabela. Um
-- agente `personalizado` nasce exatamente tao capaz quanto um
-- `financeiro` recem-criado: com nada.
--
-- ── POR QUE UMA MIGRATION FORWARD ───────────────────────────────────
--
-- A fundacional NAO e editada. Ela registra o que o schema foi no dia
-- em que nasceu, e reescreve-la para caber uma decisao de hoje
-- apagaria a historia que ela existe para guardar. A autoridade
-- VIGENTE do vocabulario passa a ser a fundacional MAIS este arquivo,
-- e a suite `scripts/testar-agentes-fundacao.ts` le as duas.
--
-- ── DADOS EXISTENTES ────────────────────────────────────────────────
--
-- Ampliar um `IN` nao invalida nenhuma linha: os seis valores antigos
-- continuam aceitos e nenhuma linha muda. Por isso aqui nao ha — e nao
-- pode haver — UPDATE, INSERT, DELETE ou TRUNCATE. Somente a
-- constraint de vocabulario e trocada; coluna, tipo, nulidade,
-- default, indices, FKs e as demais constraints ficam como estao.
--
-- ── ORDEM DE PUBLICACAO ─────────────────────────────────────────────
--
-- Esta migration precisa estar APLICADA antes de a interface oferecer
-- `personalizado`. Na ordem inversa, o CHECK recusa o INSERT e a
-- criacao falha com erro de infraestrutura.
-- ============================================================

ALTER TABLE public.agentes
  DROP CONSTRAINT IF EXISTS agentes_tipo_valido;

ALTER TABLE public.agentes
  ADD CONSTRAINT agentes_tipo_valido CHECK (
    tipo IN (
      'personalizado',
      'mensagens',
      'ads',
      'fotos',
      'anuncios',
      'financeiro',
      'gerente'
    )
  );
