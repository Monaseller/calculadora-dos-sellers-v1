"use client";

/**
 * Pecas pequenas do fluxo Criar agente (F8.3-C2): interruptor, seletor de
 * nivel, icones e o formato de escrita. Proprias desta area — a pagina
 * Agentes esta congelada e nada daqui a altera.
 */
import type { SVGProps } from "react";
import { VOCABULARIO_NIVEL, type NivelAutonomia } from "@/lib/ia/conceitos";
import estilos from "@/components/ia/criar/criar.module.css";

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(" ");
}

/** Uma escrita: `estado` + mensagem quando o servidor recusou. */
export type ResultadoDeEscrita = { estado: string; mensagem?: string };
export type Escrever = (acao: () => Promise<ResultadoDeEscrita>, falha: string) => Promise<boolean>;

/** Resultado de `adicionarPackAoAgente` no formato que `escrever` entende. */
export async function comoEscrita(
  p: Promise<{ estado: string; resposta?: ResultadoDeEscrita }>
): Promise<ResultadoDeEscrita> {
  const r = await p;
  return r.estado === "recusado" && r.resposta ? r.resposta : { estado: r.estado === "ok" ? "ok" : "falha" };
}

export function Interruptor({
  ligado, aoMudar, rotulo, desabilitado,
}: { ligado: boolean; aoMudar: (v: boolean) => void; rotulo: string; desabilitado?: boolean }) {
  return (
    <button
      type="button" role="switch" aria-checked={ligado} aria-label={rotulo}
      disabled={desabilitado}
      onClick={() => aoMudar(!ligado)}
      className={cx(estilos.interruptor, ligado && estilos.interruptorLigado)}
    />
  );
}

const NIVEIS: readonly NivelAutonomia[] = ["automatico", "aprovacao", "bloqueado"];

/** Automatico / Exige aprovacao / Bloqueado — o vocabulario do dominio. */
export function SeletorDeNivel({
  valor, aoMudar, desabilitado, rotulo,
}: { valor: string | null; aoMudar: (n: NivelAutonomia) => void; desabilitado: boolean; rotulo: string }) {
  return (
    <div role="radiogroup" aria-label={rotulo} className={estilos.segmentos}>
      {NIVEIS.map((n) => (
        <button
          key={n} type="button" role="radio" aria-checked={valor === n} disabled={desabilitado}
          onClick={() => { if (valor !== n) aoMudar(n); }}
          className={cx(estilos.segmento, valor === n && estilos.segmentoAtivo)}
        >
          {VOCABULARIO_NIVEL[n].rotulo}
        </button>
      ))}
    </div>
  );
}

type P = SVGProps<SVGSVGElement> & { tamanho?: number };

function Base({ tamanho = 16, children, ...resto }: P & { children: React.ReactNode }) {
  return (
    <svg width={tamanho} height={tamanho} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...resto}>
      {children}
    </svg>
  );
}

export const IconeCheck = (p: P) => <Base {...p}><path d="M20 6 9 17l-5-5" /></Base>;
export const IconeSetaDireita = (p: P) => <Base {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Base>;
export const IconeSetaEsquerda = (p: P) => <Base {...p}><path d="M19 12H5M11 18l-6-6 6-6" /></Base>;
export const IconeInfo = (p: P) => (
  <Base {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></Base>
);
export const IconeMais = (p: P) => <Base {...p}><path d="M12 5v14M5 12h14" /></Base>;
