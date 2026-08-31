/**
 * `/ia` — Escritorio, a home visual da CDS IA.
 *
 * A pagina e fina de proposito: o palco inteiro vive em
 * `components/ia/office/Escritorio.tsx`, que e um Client Component
 * porque abre drawer e le o relogio. Manter a rota como Server Component
 * evita marcar a arvore inteira como cliente so por causa do palco.
 *
 * ── O aviso de simulacao mora AQUI agora ────────────────────────────
 *
 * Ele era global, no shell de `/ia`. Deixou de ser: `/ia/agentes` e
 * `/ia/agentes/[id]` passaram a ler dado real, e um aviso de area
 * inteira virou mentira sobre elas.
 *
 * Nesta tela ele continua VERDADEIRO e por isso continua existindo: o
 * palco desenha `MOCK_AGENTES` e `MOCK_TAREFAS`. Quem avisa e a tela
 * que simula, nunca o shell — assim o aviso morre junto com a
 * simulacao que o justifica, em vez de sobreviver a ela.
 */
import Escritorio from "@/components/ia/office/Escritorio";
import { CROMO, ESPACO, FONTE } from "@/lib/ia/design";
import { MOCK_AVISO } from "@/lib/ia/mocks";

export default function PaginaEscritorio() {
  return (
    <>
      <p style={{ margin: `0 0 ${ESPACO.lg}px` }}>
        <span
          style={{
            display: "inline-block",
            padding: "3px 10px",
            borderRadius: 999,
            border: `1px solid ${CROMO.acentoBorda}`,
            background: CROMO.acentoFundo,
            color: CROMO.acento,
            font: `700 11px/1.6 ${FONTE.interface}`,
          }}
        >
          {MOCK_AVISO}
        </span>
      </p>

      <Escritorio />
    </>
  );
}
