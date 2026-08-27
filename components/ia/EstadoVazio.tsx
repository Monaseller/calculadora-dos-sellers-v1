/**
 * Estado vazio com texto de verdade.
 *
 * Existe porque "nada aqui" tem muitas causas diferentes — ainda não
 * aconteceu, foi filtrado, não existe, deu erro — e um espaço em branco
 * nao distingue nenhuma delas. Um icone sozinho tambem nao: quem usa
 * leitor de tela ouviria silencio.
 *
 * `acao` e opcional e sempre um `<a>` de navegacao real, nunca um botao
 * que finge fazer algo.
 */
import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";

export default function EstadoVazio({
  titulo,
  descricao,
  acao,
}: {
  titulo: string;
  descricao: string;
  acao?: { href: string; rotulo: string };
}) {
  return (
    <div
      role="note"
      style={{
        padding: ESPACO.xl,
        border: `1px dashed ${CROMO.borda}`,
        borderRadius: RAIO.card,
        background: "transparent",
        font: `13px/1.7 ${FONTE.interface}`,
        color: CROMO.textoFraco,
        textAlign: "center",
      }}
    >
      <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: CROMO.texto }}>{titulo}</p>
      <p style={{ margin: `${ESPACO.sm}px auto 0`, maxWidth: 460 }}>{descricao}</p>

      {acao && (
        <p style={{ margin: `${ESPACO.lg}px 0 0` }}>
          <a
            href={acao.href}
            style={{
              display: "inline-block",
              padding: "8px 16px",
              borderRadius: RAIO.controle,
              border: `1px solid ${CROMO.acentoBorda}`,
              background: CROMO.acentoFundo,
              color: CROMO.acento,
              textDecoration: "none",
              fontWeight: 700,
            }}
          >
            {acao.rotulo}
          </a>
        </p>
      )}
    </div>
  );
}
