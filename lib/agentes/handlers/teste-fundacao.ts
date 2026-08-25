/**
 * Handler `teste_fundacao` — AGENTES-FASE1C.
 *
 * ── Para que ele existe ─────────────────────────────────────────────
 * Para provar o motor, nao para fazer trabalho util. Ele ecoa a
 * mensagem recebida. E so.
 *
 * Isso e proposital: um handler que faz algo interessante torna o teste
 * de concorrencia ambiguo. Quando dois workers disputam a mesma tarefa,
 * a pergunta e "quem pegou", e a resposta so e limpa se a execucao em si
 * for perfeitamente previsivel.
 *
 * ── DETERMINISTICO, e o que a palavra exige aqui ────────────────────
 * Sem rede, sem `fetch`, sem SDK, sem env, sem banco, sem arquivo, sem
 * `Date.now()`, sem `Math.random()`. A mesma entrada produz o mesmo
 * `resultado`, hoje e daqui a um ano, em qualquer maquina.
 *
 * ── IDEMPOTENTE — requisito, nao coincidencia ───────────────────────
 * O motor da 1C e AT-LEAST-ONCE: um worker que perca o heartbeat por
 * mais de 5 minutos tem sua tarefa reivindicada por outro, e a execucao
 * pode acontecer DUAS VEZES. Ver `20260917_agentes_execucao.sql`, secao
 * 4.
 *
 * Este handler e trivialmente idempotente porque nao tem efeito externo
 * nenhum: rodar duas vezes produz o mesmo resultado e nao muda nada
 * fora de si.
 *
 *   REGRA PARA QUEM VIER DEPOIS: nenhum handler com efeito externo
 *   (enviar mensagem, publicar anuncio, alterar preco, gastar credito
 *   de IA) pode entrar em `registry.ts` antes de provar que executar
 *   duas vezes tem o mesmo efeito que executar uma. Enquanto a
 *   semantica for at-least-once, isso nao e recomendacao.
 */
import type { ContextoTarefa, RelatarProgresso } from "@/lib/agentes/tipos-execucao";
// `ErroEntradaTarefa` MOROU aqui ate a AGENTES-FASE1D-b. Mudou para
// `lib/agentes/erros.ts` porque `executar-tarefa.ts` — codigo de
// producao — a importava DESTE handler de teste. Andaime nao deve ser
// dependencia de codigo real. NAO reexportar daqui: reexport manteria a
// dependencia viva com outro nome.
import { ErroEntradaTarefa } from "@/lib/agentes/erros";

export const TIPO_TESTE_FUNDACAO = "teste_fundacao";

/**
 * entrada:   { "mensagem": "teste" }
 * resultado: { "eco": "teste", "executado": true }
 *
 * O progresso vai 0 -> 50 -> 100. Tres passos, nada mais sofisticado:
 * o suficiente para provar que o executor consegue persistir progresso
 * no meio da execucao, e pouco o bastante para nao virar um mecanismo
 * que ninguem pediu.
 *
 * `async` sem `await` e proposital: o contrato `HandlerTarefa` e
 * assincrono porque handlers futuros serao, e uniformizar agora evita
 * mudar a assinatura depois. Aqui nao ha nada para esperar.
 */
export async function handlerTesteFundacao(
  contexto: ContextoTarefa,
  relatarProgresso: RelatarProgresso
): Promise<Record<string, unknown>> {
  relatarProgresso(0);

  const mensagem = contexto.entrada?.mensagem;
  if (typeof mensagem !== "string" || mensagem.length === 0) {
    throw new ErroEntradaTarefa("entrada.mensagem deve ser uma string nao vazia");
  }

  relatarProgresso(50);

  // Objeto novo a cada chamada. Devolver algo derivado de `entrada` por
  // referencia deixaria o chamador com um caminho para mutar a entrada
  // original depois — e o teste de "nao muta a entrada" passaria por
  // sorte, nao por construcao.
  const resultado: Record<string, unknown> = {
    eco: mensagem,
    executado: true,
  };

  relatarProgresso(100);
  return resultado;
}
