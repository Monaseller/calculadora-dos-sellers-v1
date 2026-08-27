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
 * ── Server Component fino ───────────────────────────────────────────
 *
 * Resolve o agente e valida a aba; o resto e cliente, porque depende do
 * relogio. Resolver aqui mantem "agente inexistente" fora do JavaScript
 * do navegador.
 *
 * ── Resolucao por MOCK, e so por mock ───────────────────────────────
 *
 * `MOCK_AGENTE_POR_ID` procura na lista em memoria. Sem fetch, sem
 * consulta, sem rota de API. Os ids sao os ficticios (`ag-atendimento`),
 * e continuam assim de proposito: um UUID falso seria indistinguivel de
 * um real numa captura de tela.
 */
import { abaSegura } from "@/lib/ia/abas";
import { MOCK_AGENTE_POR_ID } from "@/lib/ia/mocks";
import PaginaAgente from "@/components/ia/agente/PaginaAgente";
import EstadoVazio from "@/components/ia/EstadoVazio";

export default function PaginaDoAgente({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: { [chave: string]: string | string[] | undefined };
}) {
  const agente = MOCK_AGENTE_POR_ID(params.id);

  // Id desconhecido nao derruba a pagina e nao vira 404 seco: a area
  // continua navegavel e o usuario recebe o caminho de volta. E o mesmo
  // criterio de "recusa fechada, nunca no-op silencioso" que as RPCs
  // seguem — so que aqui a recusa e uma tela, nao uma excecao.
  if (!agente) {
    return (
      <EstadoVazio
        titulo="Agente não encontrado"
        descricao="Nenhum agente corresponde a este endereço. Ele pode ter sido removido, ou o link pode estar incorreto."
        acao={{ href: "/ia/agentes", rotulo: "Ver todos os agentes" }}
      />
    );
  }

  return <PaginaAgente agente={agente} aba={abaSegura(searchParams?.aba)} />;
}
