/**
 * Office V1 — a cena aprovada: a imagem do escritorio com os hotspots
 * dos agentes sobre as mesas.
 *
 * ── A posicao e do CENARIO, nunca do agente ─────────────────────────
 *
 * `AgenteUI` nao tem `x`/`y`, e nao vai ganhar. As seis mesas sao uma
 * propriedade da IMAGEM: quem decide onde fica a mesa 3 e o desenho, nao
 * o banco. Por isso os `OFFICE_SLOTS` vivem aqui, e a lista de agentes
 * (ja ordenada por quem chama) apenas OCUPA os slots, na ordem.
 *
 * Nenhum slot e reservado por nome de agente. Menos de seis agentes:
 * sobram mesas vazias. Mais de seis: os excedentes nao ganham uma setima
 * mesa inventada — aparecem em "Outros agentes", abaixo da cena.
 *
 * ── Estado: o mesmo vocabulario de sempre ───────────────────────────
 *
 * O hotspot recebe `aparencia` ja resolvida por `aparenciaDoAgente` e
 * fala pelo `rotuloDe`/`iconeDe`. Nao ha segunda logica de status aqui,
 * e o estado nunca e comunicado so por cor: ha icone e texto.
 */
import Image from "next/image";
import type { CSSProperties, ReactNode } from "react";
import { iconeDe, rotuloDe, type AparenciaAgente } from "@/lib/ia/estados";
import type { AgenteUI } from "@/lib/ia/contratos";
import { corDaAparencia } from "@/components/ia/BadgeEstado";
import estilos from "@/components/ia/office/office-v1.module.css";

const IMAGE_W = 1804;
const IMAGE_H = 872;
const SCENE_H = 940;

/**
 * A cena e mais alta que a imagem, entao `object-fit: cover` corta as
 * laterais. Remapeia o `left` original para o hotspot continuar em cima
 * da mesa — a mesma matematica do prototipo aprovado.
 */
const ESCALA_HORIZONTAL = SCENE_H / IMAGE_H;
function toSceneX(left: number): string {
  return `${50 + (left - 50) * ESCALA_HORIZONTAL}%`;
}

/** As seis mesas da imagem aprovada (F8.1-A1), em % da imagem original. */
export const OFFICE_SLOTS: readonly { readonly left: number; readonly top: number }[] = [
  { left: 29, top: 28 },
  { left: 47.5, top: 31.5 },
  { left: 66, top: 28 },
  { left: 27.5, top: 61 },
  { left: 65.5, top: 60.5 },
  { left: 87, top: 60 },
];

export interface AgenteNaCena {
  agente: AgenteUI;
  aparencia: AparenciaAgente;
}

/** Status compacto: ponto + icone + texto. A cor e reforco, nao portadora. */
export function StatusDoAgente({
  aparencia,
  grande = false,
}: {
  aparencia: AparenciaAgente;
  grande?: boolean;
}) {
  return (
    <span
      className={grande ? `${estilos.status} ${estilos.statusGrande}` : estilos.status}
      style={{ "--ov1-status": corDaAparencia(aparencia) } as CSSProperties}
    >
      <span aria-hidden="true" className={estilos.statusPonto} />
      <span aria-hidden="true" className={estilos.statusIcone}>
        {iconeDe(aparencia)}
      </span>
      {rotuloDe(aparencia)}
    </span>
  );
}

export default function OfficeSceneV1({
  naCena,
  selecionado,
  onSelecionar,
  aviso,
}: {
  /** No maximo `OFFICE_SLOTS.length` itens, ja na ordem de apresentacao. */
  naCena: readonly AgenteNaCena[];
  selecionado: string | null;
  onSelecionar: (id: string) => void;
  /** Carregando / falha / vazio: dito sobre a cena, nunca fingido. */
  aviso?: ReactNode;
}) {
  return (
    <section aria-label="Escritório dos agentes" className={estilos.cena}>
      <Image
        src="/images/escritorio.png"
        alt="Escritório CDS com mesas de trabalho dos agentes de IA ao pôr do sol"
        fill
        priority
        sizes="(min-width: 1280px) 70vw, 100vw"
        className={estilos.imagem}
      />

      {naCena.slice(0, OFFICE_SLOTS.length).map(({ agente, aparencia }, i) => {
        const slot = OFFICE_SLOTS[i];
        const ativo = agente.id === selecionado;
        const classes = [
          estilos.hotspot,
          ativo ? estilos.hotspotSelecionado : "",
          aparencia.foraDeOperacao ? estilos.hotspotApagado : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <button
            key={agente.id}
            type="button"
            onClick={() => onSelecionar(agente.id)}
            aria-pressed={ativo}
            aria-label={`${agente.nome}, ${rotuloDe(aparencia)}`}
            className={classes}
            style={{ left: toSceneX(slot.left), top: `${slot.top}%` }}
          >
            <span className={estilos.hotspotNome}>{agente.nome}</span>
            <StatusDoAgente aparencia={aparencia} />
          </button>
        );
      })}

      {aviso ? (
        <p className={estilos.avisoCena} role="status">
          {aviso}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Os agentes alem da sexta mesa. Uma lista compacta e honesta — nao uma
 * setima mesa desenhada por cima da imagem.
 */
export function OutrosAgentes({
  agentes,
  selecionado,
  onSelecionar,
}: {
  agentes: readonly AgenteNaCena[];
  selecionado: string | null;
  onSelecionar: (id: string) => void;
}) {
  if (agentes.length === 0) return null;
  return (
    <section aria-labelledby="ov1-outros-titulo" className={estilos.outros}>
      <h2 id="ov1-outros-titulo" className={estilos.outrosTitulo}>
        Outros agentes
      </h2>
      <ul className={estilos.outrosLista}>
        {agentes.map(({ agente, aparencia }) => {
          const ativo = agente.id === selecionado;
          return (
            <li key={agente.id}>
              <button
                type="button"
                onClick={() => onSelecionar(agente.id)}
                aria-pressed={ativo}
                aria-label={`${agente.nome}, ${rotuloDe(aparencia)}`}
                className={
                  ativo ? `${estilos.outroAgente} ${estilos.outroAgenteSelecionado}` : estilos.outroAgente
                }
              >
                <strong>{agente.nome}</strong>
                <StatusDoAgente aparencia={aparencia} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
