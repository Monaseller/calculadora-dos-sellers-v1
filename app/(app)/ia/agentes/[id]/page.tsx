/**
 * `/ia/agentes/[id]` — a pagina individual do agente.
 *
 * ── Uma rota, oito abas ─────────────────────────────────────────────
 *
 * A aba vem de `?aba=`, nao de rota-filha: e a mesma pagina do mesmo
 * recurso, vista de angulos diferentes. Oito segmentos criariam oito
 * arquivos repetindo cabecalho e carregamento.
 *
 * ── A query string nunca escolhe componente ─────────────────────────
 *
 * `abaSegura()` compara o valor bruto com uma allowlist de 8 ids e
 * devolve `visao-geral` para qualquer outra coisa — ausente, repetida
 * (`?aba=a&aba=b` chega como array), desconhecida ou de outro tipo.
 * Nada aqui indexa um mapa de componentes com string vinda do usuario.
 *
 * ── Server Component fino, e cada vez mais fino ─────────────────────
 *
 * Ate a SKILL-1D.ui-consumer-C esta pagina resolvia o agente na lista
 * simulada em memoria. Agora a identidade e REAL, e quem a resolve e o
 * container cliente: a pagina valida a aba e entrega o `id` da rota,
 * nada mais.
 *
 * A resolucao desceu de proposito. O agente vem da lista do dono da
 * sessao, e essa leitura e autenticada por cookie — coisa que um
 * Server Component so faria chamando a propria API por HTTP, padrao que
 * este repositorio nao usa em lugar nenhum.
 *
 * "Agente nao encontrado" continua existindo, e continua sendo uma
 * tela e nao uma excecao — so que agora a conclusao vem da lista
 * autenticada do proprio usuario, dentro do container.
 */
import { abaSegura } from "@/lib/ia/abas";
import PaginaAgente from "@/components/ia/agente/PaginaAgente";

export default function PaginaDoAgente({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: { [chave: string]: string | string[] | undefined };
}) {
  return <PaginaAgente agenteId={params.id} aba={abaSegura(searchParams?.aba)} />;
}
