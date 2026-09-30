-- AGENT-FACTORY-F7b.4.4 — quem pode escrever a ORIGEM da aprovacao.
--
-- ── O que a 20261021 esqueceu ───────────────────────────────────────
--
-- Ela criou `conversa_id`, `pedido_id` e `texto_assistente`, e parou ali.
-- `agente_funcao_aprovacoes` tem GRANT POR COLUNA: `service_role` recebeu
-- INSERT em 12 colunas e UPDATE em 8, e mais nada. Coluna nova nasce sem
-- privilegio nenhum — entao a escrita da origem falhava com
-- `42501 permission denied`, silenciosamente, e a retomada nunca achava a
-- conversa.
--
-- Isso apareceu no teste live, nao em revisao: o log dizia "falha ao
-- gravar a origem" e todas as assercoes de retomada caiam junto.
--
-- ── A linha que decide o que pode mudar ─────────────────────────────
--
-- O desenho da tabela e deliberado e vale a pena nomea-lo: as 16 colunas
-- CONGELADAS — `funcao_id`, `argumentos`, `argumentos_hash`,
-- `revisao_funcao`, `acesso`, o alvo de conexao, `fingerprint` — nao tem
-- GRANT de UPDATE para ninguem. Por isso "trocar o que foi aprovado
-- depois de aprovar" nao e impedido por um `if` nosso: e impedido pelo
-- Postgres, venha a instrucao de onde vier.
--
-- As tres colunas de origem ficam do OUTRO lado dessa linha, e o motivo
-- e este:
--
--   AUTORIDADE   o que sera executado, com quais argumentos, sob qual
--                revisao, contra qual conta. Congelado. Sem UPDATE.
--
--   ROTEAMENTO   para qual conversa voltar e qual pedido do modelo
--                remontar. Nao muda NADA do que executa.
--
-- Mudar a origem nao muda uma virgula do que roda — e por isso ela pode
-- receber UPDATE sem afrouxar a garantia que importa.
--
-- ── Por que UPDATE, e nao INSERT ────────────────────────────────────
--
-- A criacao passa pela RPC `aprovacao_criar`, que tem assinatura fixa e
-- carrega a deduplicacao pelo indice unico parcial e a revalidacao de
-- posse. Alargar a assinatura dela para caber tres campos de roteamento
-- mexeria justamente na parte que protege, e criaria uma sobrecarga de
-- funcao — o projeto ja precisou remover uma dessas na 20261003.
--
-- Entao a origem e escrita logo depois, por UPDATE escopado em
-- `(id, user_id)` — o mesmo par que a RPC acabou de validar.
--
-- E o UPDATE tambem serve ao caso `reutilizada`: a mesma acao pedida de
-- outra conversa deve retomar na conversa de AGORA, e nao naquela em que
-- o pedido nasceu. Com a origem congelada, a pessoa aprovaria num chat e
-- a resposta apareceria em outro.

grant update (
  conversa_id,
  pedido_id,
  texto_assistente
) on table public.agente_funcao_aprovacoes to service_role;

-- Os quatro pseudo-roles continuam de fora. `revoke from public` NAO
-- cobre `anon`/`authenticated` neste projeto — ver a §3 do CLAUDE.md e o
-- bug SEC1 que a originou.
revoke all (conversa_id, pedido_id, texto_assistente)
  on table public.agente_funcao_aprovacoes from public;
revoke all (conversa_id, pedido_id, texto_assistente)
  on table public.agente_funcao_aprovacoes from anon;
revoke all (conversa_id, pedido_id, texto_assistente)
  on table public.agente_funcao_aprovacoes from authenticated;

-- E o SELECT do `service_role` ja e da tabela inteira desde a 20260928,
-- entao a leitura da origem nao precisa de grant novo.
