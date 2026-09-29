/**
 * `/ia/agentes/[id]` — a pagina individual do agente.
 *
 * ── Duas faces, e o que decide entre elas ───────────────────────────
 *
 * Sem `?aba=`, esta rota e o WORKSPACE: clicar num agente abre a
 * CONVERSA com ele, nao a configuracao dele. Isso e o comportamento
 * principal, e o que a lista e o escritorio apontam.
 *
 * Com `?aba=`, ela continua sendo a pagina de abas que sempre foi.
 *
 * A bifurcacao e por PRESENCA da query, e o motivo e concreto: existem
 * links profundos em producao que dependem de uma aba especifica — a
 * fila de aprovacoes manda `?aba=funcoes&tarefaVendas=…` e a atividade
 * manda `?aba=tarefas`. Fazer o workspace tomar a rota inteira
 * quebraria os dois. Pedir uma aba e um ato explicito; nao pedir
 * nenhuma quer dizer "me leva ao agente".
 *
 * `abaSegura()` NAO foi alterada — ela continua devolvendo
 * `visao-geral` para entrada ausente ou desconhecida, e continua sendo
 * a unica coisa que traduz query em aba. A decisao daqui e anterior a
 * ela: primeiro se a query existe, depois o que ela vale.
 *
 * ── Server Component fino ───────────────────────────────────────────
 *
 * Continua sem resolver o agente. Quem faz isso e o container cliente,
 * em cada um dos dois caminhos, porque a leitura e autenticada por
 * cookie — um Server Component so a faria chamando a propria API por
 * HTTP, padrao que este repositorio nao usa em lugar nenhum.
 */
import { abaSegura } from "@/lib/ia/abas";
import PaginaAgente from "@/components/ia/agente/PaginaAgente";
import { Workspace } from "@/components/ia/factory/Workspace";

export default function PaginaDoAgente({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: { [chave: string]: string | string[] | undefined };
}) {
  // Repetida (`?aba=a&aba=b`) chega como array, e continua sendo um
  // pedido de aba: `abaSegura` ja sabe recusar o valor.
  const pediuAba = searchParams?.aba !== undefined;

  if (!pediuAba) return <Workspace agenteId={params.id} />;

  return <PaginaAgente agenteId={params.id} aba={abaSegura(searchParams?.aba)} />;
}
