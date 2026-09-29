/**
 * `/ia/agentes/novo` — criar um agente.
 *
 * O MESMO wizard de `/ia/agentes/[id]/configurar`, com `null` no lugar
 * do id. Nao existe tela paralela de criacao: a diferenca entre criar e
 * editar e so se a etapa 1 faz `POST` ou `PATCH`, e quem decide isso e
 * o wizard, olhando se ja tem id.
 *
 * Assim que a etapa 1 grava, a URL passa a ser `/[id]/configurar` — um
 * refresh a partir dali volta para o mesmo rascunho, e nao para um
 * formulario em branco.
 */
import { Wizard } from "@/components/ia/factory/Wizard";

export const dynamic = "force-dynamic";

export default function PaginaNovoAgente() {
  return <Wizard agenteIdInicial={null} />;
}
