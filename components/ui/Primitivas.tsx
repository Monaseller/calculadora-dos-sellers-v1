"use client";

/**
 * As primitivas da Factory — F7b.1.
 *
 * ── Sobre os tokens que JA existem ──────────────────────────────────
 *
 * `lib/ia/design.ts` ja define CROMO, ESPACO, FONTE, RAIO e
 * CORES_ESTADO, e toda a Central de IA os usa. Estas primitivas nao
 * inventam paleta nem escala: elas dao FORMA ao que ja e a identidade da
 * CDS, para que o wizard nao precise repetir os mesmos vinte objetos de
 * estilo em onze telas.
 *
 * ── Poucas, e so as usadas ──────────────────────────────────────────
 *
 * Nao e um design system. Sao os oito componentes que a Factory
 * realmente usa. Cada um a mais seria codigo sem consumidor.
 *
 * ── Acessibilidade nao e enfeite ────────────────────────────────────
 *
 * Todo campo tem `<label>` ligado por `htmlFor`. O foco e visivel (nao
 * `outline: none` sem substituto). Estado nunca depende SO de cor — vem
 * sempre com texto ou simbolo ao lado, porque um daltonico precisa
 * distinguir "concluido" de "atencao".
 */
import type { CSSProperties, ReactNode } from "react";
import { useId } from "react";

import { CROMO, ESPACO, RAIO } from "@/lib/ia/design";

/**
 * Escala de TAMANHO de texto.
 *
 * `lib/ia/design.ts` define familia (`FONTE`), espaco, raio e cor — mas
 * nao tamanho: a UI existente escreve `fontSize: 15` a mao, e os
 * valores 12/15/17 aparecem soltos. Nomear os tres que ja estao em uso
 * e o minimo para onze telas nao inventarem um quarto. NAO e uma escala
 * nova: sao exatamente os numeros que a Central de IA ja usa.
 */
export const TAMANHO = { miudo: 12, corpo: 15, titulo: 17 } as const;

// ─── Botao ────────────────────────────────────────────────────────────

export type TomDoBotao = "primario" | "secundario" | "sutil" | "perigo";

const TONS: Record<TomDoBotao, CSSProperties> = {
  primario: {
    background: CROMO.acento, color: "#12151b", border: "1px solid transparent",
    fontWeight: 600,
  },
  secundario: {
    background: CROMO.fundoCard, color: CROMO.texto, border: `1px solid ${CROMO.borda}`,
  },
  sutil: {
    background: "transparent", color: CROMO.textoFraco, border: "1px solid transparent",
  },
  perigo: {
    background: "rgba(255,90,90,0.10)", color: "#ff8f8f",
    border: "1px solid rgba(255,90,90,0.25)",
  },
};

export function Botao({
  children, onClick, tom = "secundario", desabilitado = false,
  tipo = "button", largura, titulo,
}: {
  children: ReactNode;
  onClick?: () => void;
  tom?: TomDoBotao;
  desabilitado?: boolean;
  tipo?: "button" | "submit";
  largura?: "auto" | "cheia";
  titulo?: string;
}) {
  return (
    <button
      type={tipo}
      onClick={onClick}
      disabled={desabilitado}
      title={titulo}
      // `aria-disabled` alem de `disabled`: leitor de tela anuncia o
      // motivo, e o botao continua alcancavel por tab para a pessoa
      // descobrir que existe.
      aria-disabled={desabilitado}
      style={{
        ...TONS[tom],
        padding: `${ESPACO.sm + 2}px ${ESPACO.lg}px`,
        borderRadius: RAIO.controle,
        fontSize: TAMANHO.corpo,
        cursor: desabilitado ? "not-allowed" : "pointer",
        opacity: desabilitado ? 0.45 : 1,
        width: largura === "cheia" ? "100%" : undefined,
        lineHeight: 1.2,
        transition: "opacity 120ms ease, background 120ms ease",
      }}
    >
      {children}
    </button>
  );
}

// ─── Cartao ───────────────────────────────────────────────────────────

export function Cartao({
  children, destacado = false, aoClicar, comoBotao = false,
}: {
  children: ReactNode;
  destacado?: boolean;
  aoClicar?: () => void;
  comoBotao?: boolean;
}) {
  const estilo: CSSProperties = {
    background: destacado ? CROMO.acentoFundo : CROMO.fundoCard,
    border: `1px solid ${destacado ? CROMO.acentoBorda : CROMO.borda}`,
    borderRadius: RAIO.card,
    padding: ESPACO.lg,
    textAlign: "left",
    width: "100%",
    color: CROMO.texto,
    cursor: aoClicar ? "pointer" : undefined,
  };
  if (comoBotao) {
    return (
      <button type="button" onClick={aoClicar} style={{ ...estilo, display: "block" }}>
        {children}
      </button>
    );
  }
  return <div style={estilo}>{children}</div>;
}

// ─── Campo de texto ───────────────────────────────────────────────────

export function Campo({
  rotulo, valor, aoMudar, ajuda, placeholder, maxLength, obrigatorio = false,
}: {
  rotulo: string;
  valor: string;
  aoMudar: (v: string) => void;
  ajuda?: string;
  placeholder?: string;
  maxLength?: number;
  obrigatorio?: boolean;
}) {
  const id = useId();
  const idAjuda = `${id}-ajuda`;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: ESPACO.xs }}>
      <label htmlFor={id} style={{ fontSize: TAMANHO.corpo, color: CROMO.texto }}>
        {rotulo}
        {obrigatorio && <span style={{ color: CROMO.acento }}> *</span>}
      </label>
      <input
        id={id}
        value={valor}
        onChange={(e) => aoMudar(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        aria-describedby={ajuda ? idAjuda : undefined}
        aria-required={obrigatorio}
        style={{
          background: "rgba(0,0,0,0.25)",
          border: `1px solid ${CROMO.borda}`,
          borderRadius: RAIO.controle,
          padding: `${ESPACO.sm + 2}px ${ESPACO.md}px`,
          color: CROMO.texto,
          fontSize: TAMANHO.corpo,
        }}
      />
      {ajuda && (
        <span id={idAjuda} style={{ fontSize: TAMANHO.miudo, color: CROMO.textoFraco }}>
          {ajuda}
        </span>
      )}
    </div>
  );
}

export function AreaTexto({
  rotulo, valor, aoMudar, ajuda, placeholder, linhas = 8, maxLength, obrigatorio = false,
}: {
  rotulo: string;
  valor: string;
  aoMudar: (v: string) => void;
  ajuda?: string;
  placeholder?: string;
  linhas?: number;
  maxLength?: number;
  obrigatorio?: boolean;
}) {
  const id = useId();
  const idAjuda = `${id}-ajuda`;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: ESPACO.xs }}>
      <label htmlFor={id} style={{ fontSize: TAMANHO.corpo, color: CROMO.texto }}>
        {rotulo}
        {obrigatorio && <span style={{ color: CROMO.acento }}> *</span>}
      </label>
      <textarea
        id={id}
        value={valor}
        onChange={(e) => aoMudar(e.target.value)}
        placeholder={placeholder}
        rows={linhas}
        maxLength={maxLength}
        aria-describedby={ajuda ? idAjuda : undefined}
        aria-required={obrigatorio}
        style={{
          background: "rgba(0,0,0,0.25)",
          border: `1px solid ${CROMO.borda}`,
          borderRadius: RAIO.controle,
          padding: ESPACO.md,
          color: CROMO.texto,
          fontSize: TAMANHO.corpo,
          lineHeight: 1.55,
          resize: "vertical",
          fontFamily: "inherit",
        }}
      />
      {ajuda && (
        <span id={idAjuda} style={{ fontSize: TAMANHO.miudo, color: CROMO.textoFraco }}>
          {ajuda}
        </span>
      )}
    </div>
  );
}

// ─── Alternador (toggle) ──────────────────────────────────────────────

export function Alternador({
  rotulo, ligado, aoMudar, descricao,
}: {
  rotulo: string;
  ligado: boolean;
  aoMudar: (v: boolean) => void;
  descricao?: string;
}) {
  const id = useId();
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: ESPACO.md }}>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={ligado}
        onClick={() => aoMudar(!ligado)}
        style={{
          width: 44, height: 24, flexShrink: 0,
          borderRadius: 999,
          background: ligado ? CROMO.acento : "rgba(255,255,255,0.12)",
          border: `1px solid ${ligado ? CROMO.acentoBorda : CROMO.borda}`,
          position: "relative", cursor: "pointer", marginTop: 2,
        }}
      >
        <span style={{
          position: "absolute", top: 2, left: ligado ? 22 : 2,
          width: 18, height: 18, borderRadius: 999,
          background: ligado ? "#12151b" : CROMO.textoFraco,
          transition: "left 140ms ease",
        }} />
      </button>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <label htmlFor={id} style={{ fontSize: TAMANHO.corpo, color: CROMO.texto, cursor: "pointer" }}>
          {/* Texto ao lado do switch: o estado nao fica so na cor. */}
          {rotulo} — {ligado ? "ativada" : "desativada"}
        </label>
        {descricao && (
          <span style={{ fontSize: TAMANHO.miudo, color: CROMO.textoFraco, lineHeight: 1.5 }}>
            {descricao}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Escolha unica (radio) ────────────────────────────────────────────

export function EscolhaUnica<T extends string>({
  rotulo, opcoes, valor, aoMudar, recomendado,
}: {
  rotulo: string;
  opcoes: readonly { readonly valor: T; readonly rotulo: string; readonly ajuda?: string }[];
  valor: T | null;
  aoMudar: (v: T) => void;
  recomendado?: T;
}) {
  const nome = useId();
  return (
    <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
      <legend style={{ fontSize: TAMANHO.corpo, color: CROMO.texto, marginBottom: ESPACO.sm }}>
        {rotulo}
      </legend>
      <div style={{ display: "flex", flexDirection: "column", gap: ESPACO.sm }}>
        {opcoes.map((o) => {
          const id = `${nome}-${o.valor}`;
          const marcado = valor === o.valor;
          return (
            <label
              key={o.valor}
              htmlFor={id}
              style={{
                display: "flex", alignItems: "flex-start", gap: ESPACO.sm,
                padding: `${ESPACO.sm}px ${ESPACO.md}px`,
                borderRadius: RAIO.controle,
                border: `1px solid ${marcado ? CROMO.acentoBorda : CROMO.bordaSutil}`,
                background: marcado ? CROMO.acentoFundo : "transparent",
                cursor: "pointer",
              }}
            >
              <input
                type="radio" id={id} name={nome} checked={marcado}
                onChange={() => aoMudar(o.valor)}
                style={{ accentColor: CROMO.acento, marginTop: 3 }}
              />
              <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: TAMANHO.corpo, color: CROMO.texto }}>
                  {o.rotulo}
                  {recomendado === o.valor && (
                    <span style={{ color: CROMO.textoFraco, fontSize: TAMANHO.miudo }}>
                      {"  ·  recomendado"}
                    </span>
                  )}
                </span>
                {o.ajuda && (
                  <span style={{ fontSize: TAMANHO.miudo, color: CROMO.textoFraco }}>{o.ajuda}</span>
                )}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// ─── Aviso ────────────────────────────────────────────────────────────

export type TomDoAviso = "info" | "atencao" | "erro" | "ok";

const AVISOS: Record<TomDoAviso, { cor: string; fundo: string; marca: string }> = {
  // A marca textual existe para o estado nao depender de cor.
  info: { cor: "#9cc4ff", fundo: "rgba(120,170,255,0.10)", marca: "i" },
  atencao: { cor: "#ffcc7a", fundo: "rgba(255,185,80,0.10)", marca: "!" },
  erro: { cor: "#ff8f8f", fundo: "rgba(255,90,90,0.10)", marca: "×" },
  ok: { cor: "#7ddba0", fundo: "rgba(90,220,140,0.10)", marca: "✓" },
};

export function Aviso({ tom = "info", children }: { tom?: TomDoAviso; children: ReactNode }) {
  const a = AVISOS[tom];
  return (
    <div
      role={tom === "erro" ? "alert" : "status"}
      style={{
        display: "flex", gap: ESPACO.sm, alignItems: "flex-start",
        background: a.fundo, border: `1px solid ${a.cor}33`,
        borderRadius: RAIO.controle, padding: ESPACO.md,
        fontSize: TAMANHO.corpo, color: a.cor, lineHeight: 1.5,
      }}
    >
      <span aria-hidden style={{ fontWeight: 700, lineHeight: 1.5 }}>{a.marca}</span>
      <span style={{ color: CROMO.texto }}>{children}</span>
    </div>
  );
}

// ─── Etiqueta ─────────────────────────────────────────────────────────

export function Etiqueta({ children, tom }: { children: ReactNode; tom?: TomDoAviso }) {
  const a = tom ? AVISOS[tom] : null;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      fontSize: TAMANHO.miudo,
      color: a ? a.cor : CROMO.textoFraco,
      background: a ? a.fundo : "rgba(255,255,255,0.05)",
      border: `1px solid ${a ? `${a.cor}33` : CROMO.bordaSutil}`,
      borderRadius: 999, padding: "2px 10px", whiteSpace: "nowrap",
    }}>
      {a && <span aria-hidden>{a.marca}</span>}
      {children}
    </span>
  );
}

// ─── Painel lateral (drawer) ──────────────────────────────────────────

export function PainelLateral({
  aberto, titulo, aoFechar, children,
}: {
  aberto: boolean;
  titulo: string;
  aoFechar: () => void;
  children: ReactNode;
}) {
  if (!aberto) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={titulo}
      // Clique no fundo fecha; `Escape` tambem, pelo handler abaixo.
      onClick={aoFechar}
      onKeyDown={(e) => { if (e.key === "Escape") aoFechar(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 60,
        background: "rgba(0,0,0,0.55)", display: "flex", justifyContent: "flex-end",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(420px, 100%)", height: "100%", overflowY: "auto",
          background: "#161a21", borderLeft: `1px solid ${CROMO.borda}`,
          padding: ESPACO.xl, display: "flex", flexDirection: "column", gap: ESPACO.lg,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: TAMANHO.titulo, color: CROMO.texto }}>{titulo}</h2>
          <Botao tom="sutil" onClick={aoFechar} titulo="Fechar">✕</Botao>
        </div>
        {children}
      </div>
    </div>
  );
}
