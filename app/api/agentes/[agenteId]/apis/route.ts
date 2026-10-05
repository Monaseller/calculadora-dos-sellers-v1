/**
 * APIs de UM agente — F9.2-A.
 *
 *   GET    providers (Mercado Livre, Shopee), as contas do dono em cada um,
 *          a conta deste agente (UMA por provider) e as capabilities, com o
 *          que esta liberado para o agente.
 *   PATCH  `{ provedor, lojaId }` — escolhe UMA conta para o provider e a
 *          aplica a todo recurso que o agente exige dele. `lojaId: null`
 *          desfaz a escolha.
 *
 * Contratos antigos continuam valendo: `/conexoes` (por recurso) e
 * `/permissoes` (por funcao, com o alias de pack) nao mudaram. Esta rota
 * e uma camada de dominio por cima deles, nao uma segunda escrita.
 *
 * Corpo FECHADO: so `provedor` e `lojaId`. `recurso`, `plataforma`,
 * `nivel` ou ids de dono/agente sao recusados — o cliente nao tem
 * autoridade sobre nenhum deles.
 */
import { atravessarPorta, lerCorpo, responder } from "@/lib/agentes/api/porta";
import { definirContaDoProvedor, lerApisDoAgente } from "@/lib/agentes/apis/servico";

export const dynamic = "force-dynamic";

const FALHA_LEITURA = "Falha ao ler as APIs do agente.";
const FALHA_ESCRITA = "Falha ao definir a conta.";

export async function GET(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA_LEITURA);
    if (!porta.ok) return porta.resposta;
    const r = await lerApisDoAgente(porta.userId, porta.agenteId);
    if (!r.ok) return responder({ ok: false, erro: FALHA_LEITURA }, 500);
    return responder({ ok: true, provedores: r.provedores }, 200);
  } catch {
    return responder({ ok: false, erro: FALHA_LEITURA }, 500);
  }
}

export async function PATCH(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA_ESCRITA);
    if (!porta.ok) return porta.resposta;

    const corpo = await lerCorpo(request);
    if (corpo === null ||
        JSON.stringify(Object.keys(corpo).sort()) !== JSON.stringify(["lojaId", "provedor"]) ||
        typeof corpo.provedor !== "string" ||
        (corpo.lojaId !== null && (typeof corpo.lojaId !== "string" || corpo.lojaId.length === 0))) {
      return responder({ ok: false, erro: "Corpo inválido." }, 400);
    }

    const r = await definirContaDoProvedor({
      userId: porta.userId, agenteId: porta.agenteId,
      provedorId: corpo.provedor, lojaId: corpo.lojaId,
    });
    if (r.ok) return responder({ ok: true, provedor: r.provedor, recursos: r.recursos }, 200);

    switch (r.codigo) {
      case "provedor_desconhecido":
        return responder({ ok: false, erro: "API desconhecida." }, 400);
      case "provedor_indisponivel_para_agentes":
        return responder({ ok: false, erro: "Esta API ainda não está disponível para agentes." }, 409);
      case "sem_requisito":
        return responder({ ok: false, erro: "Este agente não usa esta API." }, 409);
      case "conta_indisponivel":
        // Inexistente, alheia, inativa e de outro marketplace: a MESMA resposta.
        return responder({ ok: false, erro: "Conta indisponível para esta API." }, 409);
      default:
        return responder({ ok: false, erro: FALHA_ESCRITA }, 500);
    }
  } catch {
    return responder({ ok: false, erro: FALHA_ESCRITA }, 500);
  }
}
