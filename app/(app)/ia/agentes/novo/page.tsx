/**
 * `/ia/agentes/novo` — criar um agente (F8.3-C2).
 *
 * O fluxo de 6 etapas (Identidade, Modelo de IA, APIs, Tools, Memoria,
 * Criar). Nao ha criacao paralela: e a unica entrada que CRIA agente, e
 * usa os mesmos contratos do Wizard (`criarAgenteViaApi` na Identidade,
 * agente inativo; `definirAtivacaoDoAgente` no "Criar agente").
 *
 * Depois que a Identidade grava, a URL passa a ser
 * `/ia/agentes/novo?agente=<id>&etapa=<n>`: refresh volta para o mesmo
 * rascunho, NESTE fluxo. O assistente de configuracao de agente existente
 * (`/ia/agentes/[id]/configurar`, com Skills e Arquivos) segue intacto.
 */
import CriarAgente from "@/components/ia/criar/CriarAgente";

export const dynamic = "force-dynamic";

export default function PaginaNovoAgente() {
  return <CriarAgente />;
}
