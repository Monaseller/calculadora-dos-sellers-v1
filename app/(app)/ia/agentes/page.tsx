/**
 * `/ia/agentes` — Agentes: lista real + configuracao (master-detail). F8.3-C1.
 *
 * Server Component fino: tudo o que e interativo vive em
 * `components/ia/agentes/GestaoDeAgentes.tsx`. A lista antiga e o dialogo
 * de criacao foram REMOVIDOS (F8.3-C3-C): criar agente e so a aba
 * "Criar agente" da navegacao (`/ia/agentes/novo`), e nao um botao desta pagina.
 */
import GestaoDeAgentes from "@/components/ia/agentes/GestaoDeAgentes";

export default function PaginaAgentes() {
  return <GestaoDeAgentes />;
}
