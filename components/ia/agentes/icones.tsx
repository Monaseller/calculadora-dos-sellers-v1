/**
 * Icones de traco da area Agentes — F8.3-C1.2.
 *
 * O v0 aprovado usa icones de linha (plug, chave, cerebro, engrenagem...).
 * O projeto nao tem biblioteca de icones, e a regra e nao instalar uma:
 * estes sao SVGs simples, desenhados aqui, herdando `currentColor`.
 */
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { tamanho?: number };

function Base({ tamanho = 16, children, ...resto }: P & { children: React.ReactNode }) {
  return (
    <svg
      width={tamanho} height={tamanho} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false" {...resto}
    >
      {children}
    </svg>
  );
}

export const IconeBusca = (p: P) => (
  <Base {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Base>
);
export const IconePlug = (p: P) => (
  <Base {...p}><path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0V7ZM12 17v5" /></Base>
);
export const IconeChave = (p: P) => (
  <Base {...p}><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4 2.6-2.6Z" /></Base>
);
export const IconeCerebro = (p: P) => (
  <Base {...p}><path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1ZM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1" /></Base>
);
export const IconeEngrenagem = (p: P) => (
  <Base {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></Base>
);
export const IconeMais = (p: P) => (
  <Base {...p} fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="19" cy="12" r="1.9" /></Base>
);
export const IconeExterno = (p: P) => (
  <Base {...p}><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></Base>
);
export const IconeVoltar = (p: P) => (
  <Base {...p}><path d="M19 12H5M12 19l-7-7 7-7" /></Base>
);
export const IconeCadeado = (p: P) => (
  <Base {...p}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Base>
);
export const IconeAlerta = (p: P) => (
  <Base {...p}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01" /></Base>
);

// ── Identidade dos agentes (F8.3-C1.4) ──────────────────────────────
export const IconeHeadset = (p: P) => (
  <Base {...p}><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><rect x="3" y="14" width="4" height="6" rx="1.5" /><rect x="17" y="14" width="4" height="6" rx="1.5" /><path d="M19 20a3 3 0 0 1-3 2h-2" /></Base>
);
export const IconeCarteira = (p: P) => (
  <Base {...p}><path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5" /><path d="M17 13h.01" /></Base>
);
export const IconeMegafone = (p: P) => (
  <Base {...p}><path d="M3 11v3a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1ZM15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12" /></Base>
);
export const IconeEtiqueta = (p: P) => (
  <Base {...p}><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z" /><circle cx="8" cy="8" r="1.5" /></Base>
);
export const IconeCamera = (p: P) => (
  <Base {...p}><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" /><circle cx="12" cy="13" r="3.5" /></Base>
);
export const IconeMaleta = (p: P) => (
  <Base {...p}><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18" /></Base>
);
export const IconeRobo = (p: P) => (
  <Base {...p}><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 4v4M9 13h.01M15 13h.01M9 17h6" /></Base>
);
export const IconeCarrinho = (p: P) => (
  <Base {...p}><circle cx="9" cy="20" r="1.4" /><circle cx="18" cy="20" r="1.4" /><path d="M2 3h3l2.6 12.4a2 2 0 0 0 2 1.6h8.8a2 2 0 0 0 2-1.6L22 7H6" /></Base>
);
export const IconeNovaConversa = (p: P) => (
  <Base {...p}><path d="M12 5v14M5 12h14" /></Base>
);
