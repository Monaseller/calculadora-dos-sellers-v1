-- AGENT-FACTORY-F7b.4.8.3 §29/§30 — identidade do ENVIO.
--
-- ── O bug que esta coluna existe para fechar ────────────────────────
--
-- O Rodrigo mandou "me traz os ultimos 7 dias", a tela disse "Nao foi
-- possivel enviar", ele NAO reenviou, e depois de um tempo o agente
-- respondeu sozinho.
--
-- A mensagem dele JA estava gravada: `responderNaConversa` persiste a fala
-- do usuario ANTES de chamar o modelo. Quem desistiu foi o cliente. A tela
-- afirmou uma falha que nao houve, e essa afirmacao convida a reenviar —
-- e reenviar hoje criaria um segundo turno e uma segunda varredura.
--
-- `envio_id` da identidade ao ENVIO, e nao a mensagem. Reenviar o MESMO
-- envio encontra o turno que ja existe em vez de comecar outro.
--
-- ── Por que NULL e permitido ────────────────────────────────────────
--
-- Toda mensagem gravada antes desta migration nao tem envio, e inventar um
-- seria afirmar que houve. O indice e PARCIAL: ele so cobra unicidade onde
-- o id existe, entao `null` nao colide com `null`.
--
-- ── Escopo da unicidade ─────────────────────────────────────────────
--
-- `(user_id, conversa_id, envio_id)`. `user_id` entra porque um id gerado
-- no navegador nao e autoridade: sem o dono no indice, um envio de alguem
-- poderia colidir com o de outra pessoa.
alter table public.agente_mensagens
  add column if not exists envio_id text;

create unique index if not exists idx_agente_mensagens_envio
  on public.agente_mensagens (user_id, conversa_id, envio_id)
  where envio_id is not null;

-- A coluna e escrita pela rota de conversa, que roda com service_role.
grant select, insert (
  user_id, conversa_id, papel, conteudo, ordem, passos, provedor, modelo,
  tokens_entrada, tokens_saida, tempo_ms, envio_id
) on public.agente_mensagens to service_role;
