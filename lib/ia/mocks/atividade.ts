/**
 * CDS IA — mocks: atividade.
 *
 * ── Este arquivo e pequeno DE PROPOSITO ─────────────────────────────
 *
 * A maior parte do feed e DERIVADA de `MOCK_TAREFAS` e `MOCK_APROVACOES`
 * por funcoes puras em `lib/ia/atividade.ts`. Digitar aqui uma timeline
 * inteira seria escrever o mesmo fato duas vezes — e as duas copias
 * divergiriam na primeira alteracao.
 *
 * Aqui ficam SOMENTE os eventos que nenhuma fonte atual sustenta:
 *
 *   ia.chamada ....... a fonte real existe (`agentes_ia_chamadas`, e ela
 *                      e append-only de verdade), mas esta fase nao
 *                      consulta banco. Procedencia `simulado`: existiria
 *                      assim quando houver leitura.
 *
 *   agente.alterado .. `agentes.atualizado_em` diz QUANDO algo mudou,
 *                      nunca O QUE. Por isso a frase e generica e nao
 *                      afirma "ativado" nem "permissao alterada".
 *
 * Nao ha evento de decisao humana — nenhum "aprovou" ou "recusou".
 * Nao existe registro de decisor, horario nem justificativa em lugar
 * nenhum, e inventar isso num feed de auditoria seria o pior lugar
 * possivel para mentir.
 *
 * Regras da pasta `lib/ia/mocks/` (ver `index.ts`): todo export usa o
 * prefixo `MOCK_`, todo id e obviamente ficticio, e nao existe dado real
 * de cliente, credencial ou identificador externo.
 */
import type { EventoAtividade } from "@/lib/ia/atividade";

/**
 * `ancoraMs` e o instante da montagem da tela — o mesmo contrato de
 * `MOCK_TAREFAS`. Timestamps relativos a ancora, avaliados uma vez.
 */
export function MOCK_ATIVIDADES(ancoraMs: number): readonly EventoAtividade[] {
  const iso = (deslocamentoMs: number) => new Date(ancoraMs + deslocamentoMs).toISOString();
  const min = 60_000;
  const h = 60 * min;

  return [
    {
      id: "ev-ia-1",
      tipo: "ia.chamada",
      severidade: "info",
      ator: { tipo: "agente", nome: "Atendimento" },
      agenteId: "ag-atendimento",
      agenteNome: "Atendimento",
      instante: iso(-17 * min),
      // Diz que houve chamada e qual modelo. NAO diz custo — isso e a
      // area de Custos — e nunca prompt nem resposta.
      frase: "Consultou o modelo para redigir as respostas.",
      detalhe: "Modelo: claude-sonnet-5 · 2 chamadas nesta tarefa.",
      link: { href: "/ia/agentes/ag-atendimento", rotulo: "Abrir agente" },
      procedencia: "simulado",
    },
    {
      id: "ev-ia-2",
      tipo: "ia.chamada",
      severidade: "atencao",
      ator: { tipo: "agente", nome: "Gerente" },
      agenteId: "ag-gerente",
      agenteNome: "Gerente",
      instante: iso(-3 * min),
      frase: "Chamada ao modelo recusada pelo provedor.",
      detalhe: "Limite de uso do provedor atingido para este período.",
      link: { href: "/ia/agentes/ag-gerente", rotulo: "Abrir agente" },
      procedencia: "simulado",
    },
    {
      id: "ev-agente-1",
      tipo: "agente.alterado",
      severidade: "info",
      // `sistema` porque a fonte nao permite atribuir a alteracao a
      // ninguem: `atualizado_em` nao guarda autor.
      ator: { tipo: "sistema", nome: "Sistema" },
      agenteId: "ag-noturno",
      agenteNome: "Atendimento noturno",
      instante: iso(-11 * h),
      // Frase deliberadamente generica: a fonte nao distingue "ativado"
      // de "instrucoes editadas".
      frase: "Configuração do agente foi alterada.",
      detalhe: "A origem atual registra apenas que houve alteração, não qual campo mudou.",
      link: { href: "/ia/agentes/ag-noturno", rotulo: "Abrir agente" },
      procedencia: "simulado",
    },
  ];
}
