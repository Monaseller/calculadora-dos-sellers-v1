"use client";

/**
 * O feed de atividade da CDS IA.
 *
 * ── Estrategia hibrida ──────────────────────────────────────────────
 *
 * A maior parte do feed e DERIVADA das fontes que ja existem — tarefas e
 * aprovacoes — por funcoes puras em `lib/ia/atividade.ts`. Somente os
 * eventos sem fonte alguma vem de `MOCK_ATIVIDADES`. Assim nenhum fato e
 * digitado duas vezes, e a derivacao e a mesma que servira para DTOs
 * reais quando houver leitura.
 *
 * ── Filtros sao filtros, nao abas ───────────────────────────────────
 *
 * Sao `<button>` com `aria-pressed`, dentro de um `role="group"`. O
 * padrao ARIA de tabs promete paineis e setas do teclado; aqui a lista e
 * a mesma e o que muda e o recorte. Marcar como tab mentiria sobre o
 * comportamento — e eles FILTRAM de verdade, nao sao enfeite.
 *
 * ── Sem periodo e sem "Carregar mais" ───────────────────────────────
 *
 * Com mocks, um seletor de 7/30 dias seria cenografia. E paginacao sem
 * backend seria um botao que nao carrega nada. O limite de
 * `LIMITE_FEED` e aplicado de verdade e a tela diz quantos esta
 * mostrando.
 */
import { useEffect, useMemo, useState } from "react";
import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import {
  FILTROS,
  LIMITE_FEED,
  ROTULO_FILTRO,
  aplicarFiltro,
  montarFeed,
  type Filtro,
} from "@/lib/ia/atividade";
import {
  MOCK_AGENTES,
  MOCK_APROVACOES,
  MOCK_ATIVIDADES,
  MOCK_AVISO,
  MOCK_TAREFAS,
} from "@/lib/ia/mocks";
import ItemAtividade from "@/components/ia/atividade/ItemAtividade";
import EstadoVazio from "@/components/ia/EstadoVazio";

export default function Timeline() {
  // `ancoraMs` fixa os dados; `agoraMs` alimenta o "ha X". Mesmo motivo
  // do Escritorio: ler o relogio no servidor e no cliente produziria
  // HTML divergente.
  const [ancoraMs, setAncoraMs] = useState<number | null>(null);
  const [agoraMs, setAgoraMs] = useState<number | null>(null);
  const [filtro, setFiltro] = useState<Filtro>("tudo");

  useEffect(() => {
    const inicio = Date.now();
    setAncoraMs(inicio);
    setAgoraMs(inicio);
  }, []);

  const eventos = useMemo(() => {
    if (ancoraMs === null) return [];
    return montarFeed({
      tarefas: MOCK_TAREFAS(ancoraMs),
      agentes: MOCK_AGENTES,
      aprovacoes: MOCK_APROVACOES,
      extras: MOCK_ATIVIDADES(ancoraMs),
    });
  }, [ancoraMs]);

  const visiveis = useMemo(() => aplicarFiltro(eventos, filtro), [eventos, filtro]);

  return (
    <section aria-label="Atividade da operação">
      <style>{css}</style>

      <header className="cds-ia-at-topo">
        <div>
          <h2 className="cds-ia-at-titulo">Atividade</h2>
          <p className="cds-ia-at-sub">
            O que aconteceu na sua operação de IA, do mais recente para o mais antigo.
            Alguns acontecimentos ainda não são registrados pelo sistema e por isso não
            aparecem aqui.
          </p>
        </div>
        <span className="cds-ia-at-simulado">{MOCK_AVISO}</span>
      </header>

      <div className="cds-ia-at-filtros" role="group" aria-label="Filtrar atividade">
        {FILTROS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFiltro(f)}
            aria-pressed={filtro === f}
            className={filtro === f ? "cds-ia-at-filtro cds-ia-at-filtro-ativo" : "cds-ia-at-filtro"}
          >
            {ROTULO_FILTRO[f]}
          </button>
        ))}
      </div>

      {agoraMs === null ? (
        <p className="cds-ia-at-nota">Carregando…</p>
      ) : visiveis.length === 0 ? (
        <EstadoVazio
          titulo={filtro === "tudo" ? "Nenhuma atividade registrada" : "Nada neste filtro"}
          descricao={
            filtro === "tudo"
              ? "Quando seus agentes começarem a trabalhar, o que acontecer aparecerá aqui. Por enquanto, esta tela mostra dados simulados — a leitura da operação real ainda não está conectada."
              : "Nenhum acontecimento deste tipo entre os que estão sendo mostrados. Experimente o filtro “Tudo”."
          }
        />
      ) : (
        <>
          <ul className="cds-ia-at-lista">
            {visiveis.map((e) => (
              <ItemAtividade key={e.id} evento={e} agoraMs={agoraMs} />
            ))}
          </ul>
          <p className="cds-ia-at-nota">
            {visiveis.length === eventos.length
              ? `${visiveis.length} ${visiveis.length === 1 ? "acontecimento" : "acontecimentos"}.`
              : `${visiveis.length} de ${eventos.length} acontecimentos.`}{" "}
            O feed mostra no máximo os {LIMITE_FEED} mais recentes.
          </p>
        </>
      )}
    </section>
  );
}

const css = `
  .cds-ia-at-topo {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 12px; flex-wrap: wrap; margin-bottom: ${ESPACO.lg}px;
  }
  .cds-ia-at-titulo { margin: 0; font: 800 16px/1.3 ${FONTE.interface}; color: ${CROMO.texto}; }
  .cds-ia-at-sub {
    margin: 6px 0 0; max-width: 66ch;
    font: 13px/1.6 ${FONTE.interface}; color: ${CROMO.textoFraco};
  }
  .cds-ia-at-simulado {
    flex-shrink: 0;
    padding: 3px 10px; border-radius: 999px;
    border: 1px solid ${CROMO.acentoBorda}; background: ${CROMO.acentoFundo};
    color: ${CROMO.acento}; font: 700 11px/1.6 ${FONTE.interface};
  }
  .cds-ia-at-filtros {
    display: flex; flex-wrap: wrap; gap: ${ESPACO.xs}px;
    margin-bottom: ${ESPACO.md}px;
  }
  .cds-ia-at-filtro {
    padding: 6px 14px;
    border: 1px solid ${CROMO.borda}; border-radius: 999px;
    background: transparent; cursor: pointer;
    font: 600 12px/1.4 ${FONTE.interface}; color: ${CROMO.textoFraco};
  }
  .cds-ia-at-filtro:hover { color: ${CROMO.texto}; }
  .cds-ia-at-filtro:focus-visible { outline: 2px solid ${CROMO.acento}; outline-offset: 2px; }
  /* Selecionado: fundo E borda, alem de aria-pressed. Cor sozinha nao
     distinguiria para quem nao a percebe. */
  .cds-ia-at-filtro-ativo {
    border-color: ${CROMO.acentoBorda};
    background: ${CROMO.acentoFundo};
    color: ${CROMO.acento};
    font-weight: 700;
  }
  .cds-ia-at-lista {
    margin: 0; padding: 0 ${ESPACO.lg}px; list-style: none;
    border: 1px solid ${CROMO.borda}; border-radius: ${RAIO.card}px;
    background: ${CROMO.fundoCard};
  }
  .cds-ia-at-nota {
    margin: ${ESPACO.md}px 0 0;
    font: 12px/1.6 ${FONTE.interface}; color: ${CROMO.textoFraco};
  }
`;
