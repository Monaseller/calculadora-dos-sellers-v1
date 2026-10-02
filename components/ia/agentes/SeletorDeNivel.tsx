"use client";

/**
 * Nivel de permissao de um pack / acao: o MESMO vocabulario das etapas
 * antigas (`VOCABULARIO_NIVEL`). Usado nas abas APIs e Tools.
 */
import { VOCABULARIO_NIVEL, type NivelAutonomia } from "@/lib/ia/conceitos";
import type { FerramentaDaAtivacaoUI } from "@/lib/ia/agentes-http";
import estilos from "@/components/ia/agentes/agentes.module.css";

const NIVEIS: readonly NivelAutonomia[] = ["automatico", "aprovacao", "bloqueado"];

export default function SeletorDeNivel({
  valor, aoMudar, desabilitado, rotulo,
}: {
  valor: string | null;
  aoMudar: (n: NivelAutonomia) => void;
  desabilitado: boolean;
  rotulo: string;
}) {
  return (
    <div role="radiogroup" aria-label={rotulo} className={estilos.segmentos}>
      {NIVEIS.map((n) => (
        <button
          key={n} type="button" role="radio" aria-checked={valor === n}
          disabled={desabilitado}
          onClick={() => { if (valor !== n) aoMudar(n); }}
          className={`${estilos.segmento} ${valor === n ? estilos.segmentoAtivo : ""}`}
        >
          {VOCABULARIO_NIVEL[n].rotulo}
        </button>
      ))}
    </div>
  );
}

/** Nivel de um pack: o uniforme, ou null se incompleto/divergente. */
export function nivelDoPack(f: FerramentaDaAtivacaoUI): string | null {
  return f.completo ? f.nivel : null;
}
