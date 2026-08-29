"use client";

/**
 * `/ia/agentes` — a lista de agentes.
 *
 * ── Duas funcoes, nao uma ───────────────────────────────────────────
 *
 * 1. E a lista propriamente dita, com clique para o resumo do agente.
 * 2. E a REPRESENTACAO ADAPTADA do escritorio para telas estreitas. O
 *    palco pixel art some abaixo de 720px e aponta para ca; a informacao
 *    e a mesma (quem e, como esta, o que faz, quanto avancou), so a
 *    forma muda. Espremer o mapa em 375px nao o tornaria util.
 *
 * Por isso ela usa exatamente o mesmo vocabulario de estado e o mesmo
 * drawer — nao existe uma "versao mobile" com regras proprias.
 *
 * ── Dados REAIS desde a SKILL-1D.ui-consumer-C ──────────────────────
 *
 * Esta tela deixou de ler a lista simulada: os agentes vem do dono da
 * sessao, pelo unico modulo de rede da area. E com eles veio uma perda
 * deliberada — as TAREFAS continuam sem fonte real, e associar as
 * simuladas a um agente de verdade seria misturar duas verdades na
 * mesma linha. Ate existir leitura real de tarefas, cada agente e
 * avaliado com a lista VAZIA: `derivarStatusAgente` ja trata esse caso,
 * e o cartao mostra apenas o que se sabe — ativo ou desligado.
 *
 * Falha e sessao expirada tem estados PROPRIOS. Nenhuma das duas vira
 * "voce nao tem agentes", e em nenhuma hipotese a tela cai de volta
 * para os dados simulados.
 */
import { useEffect, useMemo, useState } from "react";
import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import { JANELA_CONCLUIDO_MS, aparenciaDoAgente, rotuloDe } from "@/lib/ia/estados";
import { listarAgentes, type RespostaAgentes } from "@/lib/ia/agentes-http";
import type { AgenteUI, TarefaUI } from "@/lib/ia/contratos";
import BadgeEstado, { corDaAparencia } from "@/components/ia/BadgeEstado";
import PainelAgente from "@/components/ia/office/PainelAgente";
import CriarAgente from "@/components/ia/agente/CriarAgente";

/** Enquanto nao ha leitura real de tarefas, ninguem tem tarefa. */
const NENHUMA_TAREFA: readonly TarefaUI[] = [];

export default function PaginaAgentes() {
  // `ancoraMs` fixa os dados; `agoraMs` anda e faz o flash expirar. Ver
  // o cabecalho de `Escritorio.tsx`: juntar os dois tornava permanente um
  // estado que existe justamente para ser temporario.
  const [agoraMs, setAgoraMs] = useState<number | null>(null);
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [resposta, setResposta] = useState<RespostaAgentes | null>(null);
  const [criando, setCriando] = useState(false);

  // Tambem evita divergencia de hidratacao: ler o relogio no servidor e
  // no cliente produziria HTML diferente nos dois lados.
  useEffect(() => {
    const inicio = Date.now();
    setAgoraMs(inicio);
    const t = window.setTimeout(() => setAgoraMs(Date.now()), JANELA_CONCLUIDO_MS + 250);
    return () => window.clearTimeout(t);
  }, []);

  // UMA leitura no ciclo normal da tela: sem polling e sem timer. O
  // `AbortController` cancela se a tela sair antes da resposta chegar.
  useEffect(() => {
    const controlador = new AbortController();
    void listarAgentes(controlador.signal).then((r) => {
      if (!controlador.signal.aborted) setResposta(r);
    });
    return () => controlador.abort();
  }, []);

  const agentes: readonly AgenteUI[] =
    resposta !== null && resposta.estado === "ok" ? resposta.agentes : [];

  const linhas = useMemo(() => {
    if (agoraMs === null) return [];
    return agentes.map((agente) => ({
      agente,
      aparencia: aparenciaDoAgente(agente, NENHUMA_TAREFA, agoraMs),
    }));
  }, [agentes, agoraMs]);

  const aberto = linhas.find((l) => l.agente.id === selecionado) ?? null;

  if (agoraMs === null || resposta === null) {
    return <p style={{ color: CROMO.textoFraco, font: `13px/1.6 ${FONTE.interface}` }}>Carregando…</p>;
  }

  const aviso = (texto: string) => (
    <p style={{ color: CROMO.textoFraco, font: `13px/1.6 ${FONTE.interface}` }}>{texto}</p>
  );

  // O agente vem do POST ja no formato publico da lista — inserir o
  // objeto retornado evita uma segunda leitura para saber o que o
  // servidor acabou de dizer. Vai para o FIM porque a listagem preserva
  // a ordem do servidor, que e por `criado_em`.
  const aoCriar = (novo: AgenteUI) => {
    setResposta((atual) =>
      atual !== null && atual.estado === "ok"
        ? { estado: "ok", agentes: [...atual.agentes, novo] }
        : atual
    );
    setCriando(false);
  };

  const dialogo = criando ? (
    <CriarAgente onFechar={() => setCriando(false)} onCriado={aoCriar} />
  ) : null;

  // Os tres desfechos que NAO sao lista, cada um com voz propria: quem
  // perdeu a sessao precisa entrar de novo, quem encontrou falha precisa
  // saber que foi falha, e so quem realmente nao tem agentes ve o vazio.
  if (resposta.estado === "nao_autenticado") {
    return aviso("Sua sessão expirou. Entre novamente para ver seus agentes.");
  }
  if (resposta.estado === "falha") {
    return aviso("Não foi possível carregar seus agentes.");
  }

  // Lista vazia deixou de ser beco sem saida: ela e o lugar onde o
  // primeiro agente nasce.
  if (linhas.length === 0) {
    return (
      <>
        <style>{css}</style>
        {aviso("Você ainda não tem agentes.")}
        <button type="button" className="cds-ia-criar-cta" onClick={() => setCriando(true)}>
          Criar primeiro agente
        </button>
        {dialogo}
      </>
    );
  }

  return (
    <>
      <style>{css}</style>

      <p className="cds-ia-barra">
        <button type="button" className="cds-ia-criar-cta" onClick={() => setCriando(true)}>
          Criar agente
        </button>
      </p>

      <ul className="cds-ia-lista">
        {linhas.map(({ agente, aparencia }) => (
          <li key={agente.id}>
            <button
              type="button"
              onClick={() => setSelecionado(agente.id)}
              className="cds-ia-card"
              aria-label={`${agente.nome}, ${rotuloDe(aparencia)}. Abrir detalhes.`}
            >
              <div style={{ display: "flex", alignItems: "center", gap: ESPACO.md, width: "100%" }}>
                <div
                  aria-hidden="true"
                  style={{
                    width: 34,
                    height: 34,
                    flexShrink: 0,
                    display: "grid",
                    placeItems: "center",
                    borderRadius: RAIO.controle,
                    border: `1px solid ${CROMO.borda}`,
                    background: "rgba(255,255,255,0.04)",
                    color: corDaAparencia(aparencia),
                    font: `800 14px/1 ${FONTE.interface}`,
                  }}
                >
                  {agente.nome.charAt(0).toUpperCase()}
                </div>

                <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: CROMO.texto }}>
                    {agente.nome}
                  </div>
                  <div style={{ fontSize: 12, color: CROMO.textoFraco }}>{agente.tipo}</div>
                </div>

                <BadgeEstado aparencia={aparencia} />
              </div>

              {/* A linha de tarefa saiu com os mocks: nao ha leitura real
                  de tarefas, e texto inventado no lugar seria pior que o
                  espaco vazio. Ela volta quando a fonte existir. */}
            </button>
          </li>
        ))}
      </ul>

      {aberto && (
        <PainelAgente
          agente={aberto.agente}
          aparencia={aberto.aparencia}
          tarefas={NENHUMA_TAREFA}
          onFechar={() => setSelecionado(null)}
        />
      )}

      {dialogo}
    </>
  );
}

const css = `
  .cds-ia-barra { margin: 0 0 12px; display: flex; justify-content: flex-end; }
  .cds-ia-criar-cta {
    padding: 9px 14px;
    background: ${CROMO.acento};
    border: 1px solid ${CROMO.acento};
    border-radius: ${RAIO.controle}px;
    color: #000;
    font: 700 13px/1 ${FONTE.interface};
    cursor: pointer;
  }
  .cds-ia-criar-cta:focus-visible { outline: 2px solid ${CROMO.acento}; outline-offset: 2px; }

  .cds-ia-lista {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 12px;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .cds-ia-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    width: 100%;
    padding: 16px;
    background: ${CROMO.fundoCard};
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.card}px;
    cursor: pointer;
    font: inherit;
    color: inherit;
    text-align: left;
    transition: background .15s;
  }
  .cds-ia-card:hover { background: ${CROMO.fundoCardHover}; }
  .cds-ia-card:focus-visible { outline: 2px solid ${CROMO.acento}; outline-offset: 2px; }

  @media (prefers-reduced-motion: reduce) {
    .cds-ia-card { transition: none; }
  }
`;
