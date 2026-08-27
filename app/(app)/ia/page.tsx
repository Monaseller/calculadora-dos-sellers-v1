/**
 * `/ia` — Escritorio, a home visual da CDS IA.
 *
 * A pagina e fina de proposito: o palco inteiro vive em
 * `components/ia/office/Escritorio.tsx`, que e um Client Component
 * porque abre drawer e le o relogio. Manter a rota como Server Component
 * evita marcar a arvore inteira como cliente so por causa do palco.
 */
import Escritorio from "@/components/ia/office/Escritorio";

export default function PaginaEscritorio() {
  return <Escritorio />;
}
