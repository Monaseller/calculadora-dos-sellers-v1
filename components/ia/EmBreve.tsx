/**
 * Placeholder honesto para as areas ainda nao construidas.
 *
 * ── Por que existir em vez de esconder o item da subnav ─────────────
 *
 * A subnav mostra as 6 areas desde o primeiro dia, porque a forma do
 * produto e informacao util. Item que leva a 404 e defeito; item que
 * some ate ficar pronto esconde o mapa. Esta tela e a terceira opcao:
 * diz o que vai existir ali e o que ainda falta para existir.
 *
 * `pendencia` e obrigatorio de proposito — um "Em breve" sem motivo
 * envelhece sem que ninguem saiba o que estava faltando.
 */
import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";

export default function EmBreve({
  titulo,
  descricao,
  pendencia,
}: {
  titulo: string;
  descricao: string;
  pendencia: string;
}) {
  return (
    <section
      style={{
        maxWidth: 620,
        padding: ESPACO.xl,
        background: CROMO.fundoCard,
        border: `1px solid ${CROMO.borda}`,
        borderRadius: RAIO.card,
        font: `13px/1.7 ${FONTE.interface}`,
        color: CROMO.textoFraco,
      }}
    >
      <div
        style={{
          display: "inline-block",
          marginBottom: ESPACO.md,
          padding: "3px 10px",
          borderRadius: 999,
          border: `1px solid ${CROMO.acentoBorda}`,
          background: CROMO.acentoFundo,
          color: CROMO.acento,
          font: `700 11px/1.6 ${FONTE.interface}`,
        }}
      >
        Em breve
      </div>

      <h2 style={{ margin: `0 0 ${ESPACO.sm}px`, fontSize: 17, fontWeight: 800, color: CROMO.texto }}>
        {titulo}
      </h2>

      <p style={{ margin: 0 }}>{descricao}</p>

      <p style={{ margin: `${ESPACO.lg}px 0 0`, fontSize: 12 }}>
        <strong style={{ color: CROMO.texto }}>Falta para liberar:</strong> {pendencia}
      </p>
    </section>
  );
}
