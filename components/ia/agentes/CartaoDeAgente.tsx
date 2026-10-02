"use client";

/**
 * Card de um agente na coluna "Seus agentes" — F8.3-C1 (layout final C1.4).
 *
 * Tudo vem de contrato real: o agente e o estado de `listarAgentesDoEscritorio`
 * + `aparenciaDoAgente`; IA, APIs, Tools e memoria de `lerAtivacaoDoAgente`.
 * Quando a ativacao ainda nao chegou (ou falhou), a ficha diz isso — nunca
 * mostra numero inventado.
 *
 * "Configurar" SELECIONA o agente: e a mesma selecao do seletor do topo,
 * do chat e da configuracao (estado unico em GestaoDeAgentes).
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { iconeDe, rotuloDe, type AparenciaAgente } from "@/lib/ia/estados";
import type { AgenteUI } from "@/lib/ia/contratos";
import type { AtivacaoDoAgenteUI } from "@/lib/ia/agentes-http";
import { corDaAparencia } from "@/components/ia/BadgeEstado";
import { projetarCapacidades, resumoDaIa } from "@/lib/ia/agentes-gestao";
import IconeDoAgente from "@/components/ia/agentes/IconeDoAgente";
import estilos from "@/components/ia/agentes/agentes.module.css";
import { IconeCerebro, IconeChave, IconeMais, IconePlug } from "@/components/ia/agentes/icones";

/** O estado canonico: ponto + icone + texto. Nunca so cor. */
export function StatusDoAgente({ aparencia }: { aparencia: AparenciaAgente }) {
  return (
    <span className={estilos.status} style={{ "--ag-status": corDaAparencia(aparencia) } as CSSProperties}>
      <span
        aria-hidden="true"
        className={aparencia.foraDeOperacao
          ? `${estilos.statusPonto} ${estilos.statusPontoVazado}` : estilos.statusPonto}
      />
      <span aria-hidden="true">{iconeDe(aparencia)}</span>
      {rotuloDe(aparencia)}
    </span>
  );
}

function plural(n: number, um: string, varios: string): string {
  return `${n} ${n === 1 ? um : varios}`;
}

/**
 * Os links REAIS do agente — nenhum item de enfeite. So navegacao de USO
 * (Escritorio, conversa em tela cheia); nenhum de configuracao (C1.5).
 */
export function MenuDoAgente({ agente, alinhar = "acima" }: { agente: AgenteUI; alinhar?: "acima" | "abaixo" }) {
  const [aberto, setAberto] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!aberto) return;
    const fora = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setAberto(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setAberto(false); };
    document.addEventListener("mousedown", fora);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", fora);
      document.removeEventListener("keydown", esc);
    };
  }, [aberto]);

  return (
    <div className={estilos.menuAncora} ref={ref}>
      <button
        type="button"
        className={`${estilos.botao} ${estilos.botaoIcone}`}
        aria-label={`Mais opções de ${agente.nome}`}
        aria-haspopup="menu"
        aria-expanded={aberto}
        onClick={() => setAberto((v) => !v)}
      >
        <IconeMais tamanho={16} />
      </button>
      {aberto && (
        <div role="menu" className={`${estilos.menu} ${alinhar === "abaixo" ? estilos.menuAbaixo : ""}`}>
          <Link role="menuitem" href={`/ia?agente=${agente.id}`} className={estilos.menuItem}>
            Abrir no Escritório
          </Link>
          <Link role="menuitem" href={`/ia/agentes/${agente.id}`} className={estilos.menuItem}>
            Abrir conversa em tela cheia
          </Link>
          {/* F8.3-C1.5: sem atalho para o assistente — toda configuração é inline, abaixo do chat. */}
        </div>
      )}
    </div>
  );
}

export default function CartaoDeAgente({
  agente, aparencia, ativacao, ativacaoFalhou, selecionado, aoConfigurar,
}: {
  agente: AgenteUI;
  aparencia: AparenciaAgente;
  /** `null` = ainda carregando (ou falhou, ver `ativacaoFalhou`). */
  ativacao: AtivacaoDoAgenteUI | null;
  ativacaoFalhou: boolean;
  selecionado: boolean;
  aoConfigurar: () => void;
}) {
  const ia = ativacao === null ? null : resumoDaIa(ativacao);
  const cap = ativacao === null ? null : projetarCapacidades(ativacao);
  const carregando = ativacao === null && !ativacaoFalhou;

  const classes = [
    estilos.card,
    selecionado ? estilos.cardSelecionado : "",
    aparencia.foraDeOperacao && !selecionado ? estilos.cardInativo : "",
  ].filter(Boolean).join(" ");

  return (
    <article className={classes} aria-current={selecionado ? "true" : undefined}>
      <div className={estilos.cardTopo}>
        <IconeDoAgente tipo={agente.tipo} usaMercadoLivre={(cap?.packsDeApi.length ?? 0) > 0} tamanho="lg" />
        <div className={estilos.cardIdentidade}>
          <h3 className={estilos.cardNome}>{agente.nome}</h3>
          <StatusDoAgente aparencia={aparencia} />
          <span className={estilos.cardModelo}>
            {carregando ? "Carregando…"
              : ativacaoFalhou || ia === null ? "IA indisponível para leitura"
              : ia.provedor === null ? "IA não configurada"
              : `${ia.provedor}${ia.modelo !== null ? ` · ${ia.modelo}` : ""}${ia.indisponivel ? " · indisponível" : ""}`}
          </span>
        </div>
        <div className={estilos.cardAcoes}>
          <button
            type="button"
            onClick={aoConfigurar}
            aria-pressed={selecionado}
            className={`${estilos.botaoConfigurar} ${selecionado ? estilos.botaoConfigurarAtivo : ""}`}
          >
            Configurar
          </button>
          <MenuDoAgente agente={agente} />
        </div>
      </div>

      {cap !== null && ativacao !== null && (
        <dl className={estilos.fichas}>
          <div className={estilos.ficha}>
            <dt className={estilos.somenteLeitor}>APIs</dt>
            <span className={estilos.fichaIcone}><IconePlug tamanho={14} /></span>
            <dd>{plural(cap.totalApis, "API", "APIs")}</dd>
          </div>
          <div className={estilos.ficha}>
            <dt className={estilos.somenteLeitor}>Tools</dt>
            <span className={estilos.fichaIcone}><IconeChave tamanho={14} /></span>
            <dd>{plural(cap.tools.length, "Tool", "Tools")}</dd>
          </div>
          <div className={estilos.ficha}>
            <dt className={estilos.somenteLeitor}>Memória</dt>
            <span className={`${estilos.fichaIcone} ${ativacao.memoriaAtiva ? estilos.fichaIconeAtivo : ""}`}>
              <IconeCerebro tamanho={14} />
            </span>
            <dd className={ativacao.memoriaAtiva ? undefined : estilos.fraco}>
              {ativacao.memoriaAtiva ? "Memória ativa" : "Memória desativada"}
            </dd>
          </div>
        </dl>
      )}
    </article>
  );
}
