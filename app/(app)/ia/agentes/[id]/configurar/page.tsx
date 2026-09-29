/**
 * `/ia/agentes/[id]/configurar` — configurar um agente existente.
 *
 * Mesma peca de `/ia/agentes/novo`. Editar um agente nao ganha tela
 * propria: o wizard abre com o estado atual carregado, e a pessoa mexe
 * na etapa que quiser.
 *
 * Esta rota existe separada de `/ia/agentes/[id]` porque aquela, sem
 * `?aba=`, e o WORKSPACE — clicar num agente abre a conversa com ele,
 * nao a configuracao dele.
 */
import { Wizard } from "@/components/ia/factory/Wizard";

export const dynamic = "force-dynamic";

export default function PaginaConfigurarAgente({ params }: { params: { id: string } }) {
  return <Wizard agenteIdInicial={params.id} />;
}
