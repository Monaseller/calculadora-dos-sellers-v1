/**
 * Badge de estado do agente.
 *
 * Usado no palco (escritorio) e fora dele (lista, drawer) — por isso ele
 * recebe `variante`: a forma muda, o VOCABULARIO nao. Ter dois badges
 * diferentes seria o comeco de duas linguagens de estado.
 *
 * ── Cor nunca sozinha ───────────────────────────────────────────────
 *
 * Todo badge mostra icone + texto. A cor e reforco, nao portadora. Quem
 * nao distingue verde de vermelho continua lendo "Concluído" e "Erro".
 */
import { CORES_ESTADO, COR_FORA_DE_OPERACAO, FONTE, PALCO, RAIO } from "@/lib/ia/design";
import { iconeDe, rotuloDe, type AparenciaAgente } from "@/lib/ia/estados";

export function corDaAparencia(aparencia: AparenciaAgente): string {
  return aparencia.foraDeOperacao ? COR_FORA_DE_OPERACAO : CORES_ESTADO[aparencia.estado];
}

export default function BadgeEstado({
  aparencia,
  variante = "cromo",
}: {
  aparencia: AparenciaAgente;
  variante?: "palco" | "cromo";
}) {
  const cor = corDaAparencia(aparencia);
  const noPalco = variante === "palco";

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: noPalco ? "3px 7px" : "4px 10px",
        border: `2px solid ${cor}`,
        borderRadius: noPalco ? RAIO.palco : 999,
        background: noPalco ? PALCO.rodape : "transparent",
        color: cor,
        font: `${noPalco ? 9 : 11}px/1.2 ${noPalco ? FONTE.palco : FONTE.interface}`,
        letterSpacing: noPalco ? 1 : 0.2,
        whiteSpace: "nowrap",
      }}
    >
      {/* aria-hidden: o icone é redundante com o texto ao lado, e um
          leitor de tela nao deve anunciar "sinal de exclamacao". */}
      <span aria-hidden="true">{iconeDe(aparencia)}</span>
      {rotuloDe(aparencia)}
    </span>
  );
}
