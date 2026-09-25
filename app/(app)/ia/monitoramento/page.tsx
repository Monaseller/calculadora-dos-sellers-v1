/**
 * `/ia/monitoramento` — o que o vigia da ingestao viu.
 *
 * ── Por que uma secao nova, e nao uma aba de agente ─────────────────
 *
 * `/ia/agentes/[id]` responde "como esta ESTE agente"; `/ia/atividade`
 * responde "o que aconteceu" e ainda e simulada. A pergunta desta tela
 * e outra: "o que esta quebrado agora na operacao" — e ela precisa ser
 * respondida sem escolher um agente antes, porque quem chega aqui
 * geralmente nao sabe qual agente olhar.
 *
 * ── Por que nao fica na Central IA ──────────────────────────────────
 *
 * `/central-ia` e a casa do Estudio de Anuncios, outro produto. A CDS IA
 * e onde os agentes trabalham, e e ali que a subnav ja existe — a mesma
 * que nasceu preparada para crescer.
 *
 * A pagina e fina de proposito: o painel inteiro vive no componente
 * cliente, porque ele le o relogio para dizer "ha X" e busca por fetch
 * autenticado por cookie.
 */
import PainelMonitoramento from "@/components/ia/monitoramento/PainelMonitoramento";

export default function PaginaMonitoramento() {
  return <PainelMonitoramento />;
}
