/**
 * Identidade visual de um agente — F8.3-C1.4.
 *
 * SO APRESENTACAO. Nenhuma regra do produto le este registry: o icone e
 * a cor saem do `tipo` (o CHECK de `agentes.tipo`) e, quando o agente usa
 * o Mercado Livre como API, da identidade visual do ML. Sem tipo
 * conhecido, vale o icone generico de agente — nunca a primeira letra.
 */
import type { CSSProperties } from "react";
import type { TipoAgenteUI } from "@/lib/ia/contratos";
import {
  IconeCamera, IconeCarrinho, IconeCarteira, IconeEtiqueta, IconeHeadset, IconeMaleta,
  IconeMegafone, IconeRobo,
} from "@/components/ia/agentes/icones";
import estilos from "@/components/ia/agentes/agentes.module.css";

type Icone = (p: { tamanho?: number }) => JSX.Element;

export interface IdentidadeVisual {
  readonly chave: string;
  readonly Icone: Icone;
  /** Fundo SOLIDO do tile, como no v0. */
  readonly fundo: string;
  /** Cor do icone sobre o fundo. */
  readonly cor: string;
}

const POR_TIPO: Readonly<Record<TipoAgenteUI, IdentidadeVisual>> = Object.freeze({
  mensagens: { chave: "atendimento", Icone: IconeHeadset, fundo: "#3b82f6", cor: "#ffffff" },
  financeiro: { chave: "financeiro", Icone: IconeCarteira, fundo: "#16a34a", cor: "#ffffff" },
  ads: { chave: "marketing", Icone: IconeMegafone, fundo: "#8b5cf6", cor: "#ffffff" },
  anuncios: { chave: "anuncios", Icone: IconeEtiqueta, fundo: "#ea580c", cor: "#ffffff" },
  fotos: { chave: "fotos", Icone: IconeCamera, fundo: "#db2777", cor: "#ffffff" },
  gerente: { chave: "gerente", Icone: IconeMaleta, fundo: "#0d9488", cor: "#ffffff" },
  personalizado: { chave: "agente", Icone: IconeRobo, fundo: "#334155", cor: "#e2e8f0" },
});

/** Agente que vende pelo Mercado Livre: identidade do ML (amarelo + azul). */
const MERCADO_LIVRE: IdentidadeVisual = Object.freeze({
  chave: "mercado-livre", Icone: IconeCarrinho, fundo: "#ffe600", cor: "#2d3277",
});

const GENERICO: IdentidadeVisual = Object.freeze({
  chave: "agente", Icone: IconeRobo, fundo: "#334155", cor: "#e2e8f0",
});

/** Estavel: o mesmo tipo (e a mesma API de ML) da sempre a mesma identidade. */
export function identidadeDoAgente(tipo: TipoAgenteUI, usaMercadoLivre: boolean): IdentidadeVisual {
  if (usaMercadoLivre) return MERCADO_LIVRE;
  return POR_TIPO[tipo] ?? GENERICO;
}

export default function IconeDoAgente({
  tipo, usaMercadoLivre, tamanho = "md",
}: {
  tipo: TipoAgenteUI;
  usaMercadoLivre: boolean;
  tamanho?: "sm" | "md" | "lg";
}) {
  const id = identidadeDoAgente(tipo, usaMercadoLivre);
  const px = tamanho === "sm" ? 34 : tamanho === "lg" ? 52 : 44;
  return (
    <span
      aria-hidden="true"
      className={estilos.tileAgente}
      style={{ width: px, height: px, background: id.fundo, color: id.cor } as CSSProperties}
    >
      <id.Icone tamanho={Math.round(px * 0.5)} />
    </span>
  );
}
