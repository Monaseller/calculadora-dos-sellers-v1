/**
 * `/ia` — Escritorio, a home visual da CDS IA.
 *
 * A pagina e fina de proposito: o palco inteiro vive em
 * `components/ia/office/Escritorio.tsx`, que e um Client Component
 * porque abre drawer e le o relogio. Manter a rota como Server Component
 * evita marcar a arvore inteira como cliente so por causa do palco.
 *
 * ── O aviso de simulacao SAIU daqui ─────────────────────────────────
 *
 * Ele era global, no shell de `/ia`. Virou desta tela quando `/ia/agentes`
 * e `/ia/agentes/[id]` passaram a ler dado real, porque um aviso de area
 * inteira tinha virado mentira sobre elas.
 *
 * Agora ele saiu tambem daqui, pelo mesmo motivo e pela regra que ele
 * mesmo carregava: o aviso morre junto com a simulacao que o justifica.
 * O palco le os agentes REAIS do dono e o snapshot operacional deles.
 * Manter o selo seria a tela afirmando falso sobre si mesma — e aviso
 * que mente para menos ensina a ignorar avisos.
 */
import Escritorio from "@/components/ia/office/Escritorio";

export default function PaginaEscritorio() {
  return <Escritorio />;
}
