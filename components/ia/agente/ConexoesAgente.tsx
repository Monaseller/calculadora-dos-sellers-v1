"use client";

/**
 * A aba Conexões — M2-I1-A5.
 *
 * ── O que esta tela decide, e o que ela não decide ──────────────────
 *
 * Ela escolhe QUAL conta já conectada o agente usa para cada requisito.
 * Não conecta conta nenhuma: não faz OAuth, não recebe token, não fala
 * com marketplace. Conectar é o fluxo do CDS, que já existe; aqui o dono
 * apenas aponta, entre o que já está conectado, qual conta vale para
 * cada par `(plataforma, recurso)`.
 *
 * ── Os requisitos são do SERVIDOR ───────────────────────────────────
 *
 * Esta tela não conhece Skill, Function nem registry. A lista inteira
 * vem de `buscarConexoesDoAgente`, que o servidor deriva dos requisitos
 * reais do agente. Não há id escrito aqui, não há mock e não há `[0]`:
 * um requisito novo aparece sozinho, e zero requisitos é um estado
 * legítimo — e diferente de "zero contas".
 *
 * ── LOCAL_ELIGIBLE não é REMOTE_CONFIRMED ───────────────────────────
 *
 * `lojasElegiveis` são as contas conectadas, do dono, compatíveis com a
 * plataforma. Elas NÃO foram verificadas contra o provider: a cobertura
 * remota é apurada na hora da execução, e consultá-la aqui faria um 429
 * do Mercado Livre impedir o dono de configurar. Por isso o texto desta
 * tela nunca diz "verificada", "confirmada" ou "pronta para uso".
 *
 * ── A seleção que não serve precisa aparecer ────────────────────────
 *
 * `lojaIdSelecionada` preenchido com `utilizavel: false` significa que
 * existe uma conta escolhida e ela não serve — tipicamente uma loja de
 * outro marketplace, que `agente_conexoes` permite gravar porque não há
 * invariante de banco ligando plataforma a marketplace. Mostrar isso
 * como "nenhuma conta escolhida" apagaria a única pista de que há algo a
 * corrigir. É o estado mais importante desta tela.
 *
 * ── UMA conta por provider — F9.2-A4 ────────────────────────────────
 *
 * Esta tela continua acessivel (aba Conexoes de `PaginaAgente` e o Wizard
 * de configurar), e listava UM seletor por requisito ("Mercado Livre ·
 * Perguntas", "· Vendas") — o oposto do produto aprovado. Agora os
 * requisitos sao AGRUPADOS por plataforma: um item e um seletor por
 * provider, sem recurso na tela. Provider com capability para agentes
 * grava pelo `PATCH /apis` (tudo ou nada). Plataforma sem capability (so
 * por requisito de Skill — nunca o Mercado Livre) segue o contrato antigo,
 * com a MESMA escolha para todos os recursos dela.
 *
 * ── Sem otimismo ────────────────────────────────────────────────────
 *
 * Nada muda na tela antes de o servidor confirmar, e a confirmação do
 * PATCH não basta: `utilizavel` e a lista de contas dependem de fatos
 * que só o GET recalcula. Sucesso e conflito terminam do mesmo jeito —
 * buscando de novo.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  buscarConexoesDoAgente,
  definirContaDaApi,
  definirConexaoDoAgente,
  type ConexaoRequisitoUI,
  type LojaElegivelUI,
} from "@/lib/ia/agentes-http";
import { provedorDeAgentesDaPlataforma } from "@/lib/ia/agentes-gestao";

/**
 * Os requisitos de UMA plataforma, vistos como UMA conexao — F9.2-A4.
 *
 * `selecionada`: a conta, quando todos os recursos concordam; `null` sem
 * escolha. `divergente`: recursos com contas DIFERENTES (estado antigo) —
 * a tela pede uma escolha, e ela vale para todos.
 */
export interface ConexaoDaPlataforma {
  readonly plataforma: string;
  readonly recursos: readonly ConexaoRequisitoUI[];
  readonly obrigatoria: boolean;
  readonly lojasElegiveis: readonly LojaElegivelUI[];
  readonly selecionada: string | null;
  readonly divergente: boolean;
  readonly incompleta: boolean;
  readonly utilizavel: boolean;
}

export function agruparPorPlataforma(conexoes: readonly ConexaoRequisitoUI[]): ConexaoDaPlataforma[] {
  const ordem: string[] = [];
  const por = new Map<string, ConexaoRequisitoUI[]>();
  for (const c of conexoes) {
    if (!por.has(c.plataforma)) { por.set(c.plataforma, []); ordem.push(c.plataforma); }
    por.get(c.plataforma)!.push(c);
  }
  return ordem.map((plataforma) => {
    const recursos = por.get(plataforma)!;
    const lojas = new Map<string, LojaElegivelUI>();
    for (const r of recursos) for (const l of r.lojasElegiveis) lojas.set(l.id, l);
    const escolhidas = new Set(recursos.filter((r) => r.lojaIdSelecionada !== null).map((r) => r.lojaIdSelecionada));
    return {
      plataforma,
      recursos,
      obrigatoria: recursos.some((r) => r.obrigatoria),
      lojasElegiveis: [...lojas.values()],
      // Incompleta (parte sem conta) aparece como "sem escolha": UMA escolha aplica a todos.
      selecionada: escolhidas.size === 1 && !recursos.some((r) => r.lojaIdSelecionada === null)
        ? ([...escolhidas][0] as string) : null,
      divergente: escolhidas.size > 1,
      incompleta: escolhidas.size === 1 && recursos.some((r) => r.lojaIdSelecionada === null),
      utilizavel: recursos.every((r) => r.utilizavel),
    };
  });
}

/**
 * Rótulos das poucas plataformas e recursos que existem hoje.
 *
 * Mapa MÍNIMO, com fallback para o identificador técnico. Um registry
 * grande de rótulos seria manutenção sem leitor: quando surgir a terceira
 * plataforma, ela aparece pelo id — feio, porém verdadeiro — e alguém
 * decide o nome com contexto.
 */
const ROTULO_PLATAFORMA: Readonly<Record<string, string>> = {
  mercado_livre: "Mercado Livre",
  shopee: "Shopee",
};

/** O nome visível de uma conta. Nunca `seller_id`. */
function nomeDaLoja(loja: LojaElegivelUI): string {
  const escolhido = loja.nickname ?? loja.nome ?? "";
  return escolhido.trim().length > 0 ? escolhido : "Conta sem nome";
}

type Leitura =
  | { estado: "carregando" }
  | { estado: "ok"; conexoes: readonly ConexaoRequisitoUI[] }
  | { estado: "erro"; mensagem: string };

const MENSAGEM_NAO_AUTENTICADO = "Sua sessão expirou. Entre novamente para ver as conexões.";
const MENSAGEM_NAO_ENCONTRADO = "Agente não encontrado.";
const MENSAGEM_FALHA_LEITURA = "Não foi possível carregar as conexões.";

export default function ConexoesAgente({ agenteId }: { agenteId: string }) {
  const [leitura, setLeitura] = useState<Leitura>({ estado: "carregando" });
  /** Plataformas com escrita em voo. Uma pendente não trava as outras. */
  const [pendentes, setPendentes] = useState<Readonly<Record<string, true>>>({});
  /** Erro de escrita, por plataforma. Some assim que outra tentativa começa. */
  const [errosPorRequisito, setErros] = useState<Readonly<Record<string, string>>>({});

  /** O GET em voo. Um novo cancela o anterior: sem isto, a resposta de um
   *  agente antigo poderia sobrescrever a do agente atual. */
  const requisicaoRef = useRef<AbortController | null>(null);

  const carregar = useCallback(async () => {
    requisicaoRef.current?.abort();
    const controlador = new AbortController();
    requisicaoRef.current = controlador;

    const resposta = await buscarConexoesDoAgente(agenteId, controlador.signal);
    // Abortado: chegou uma requisição mais nova, e ela manda.
    if (controlador.signal.aborted) return;

    if (resposta.estado === "ok") {
      setLeitura({ estado: "ok", conexoes: resposta.conexoes });
      return;
    }
    if (resposta.estado === "nao_autenticado") {
      setLeitura({ estado: "erro", mensagem: MENSAGEM_NAO_AUTENTICADO });
      return;
    }
    if (resposta.estado === "nao_encontrado") {
      setLeitura({ estado: "erro", mensagem: MENSAGEM_NAO_ENCONTRADO });
      return;
    }
    setLeitura({ estado: "erro", mensagem: MENSAGEM_FALHA_LEITURA });
  }, [agenteId]);

  useEffect(() => {
    setLeitura({ estado: "carregando" });
    void carregar();
    return () => requisicaoRef.current?.abort();
  }, [carregar]);

  /**
   * Grava a escolha de UMA plataforma — para todos os recursos dela.
   *
   * Provider de API: `PATCH /apis` (tudo ou nada no servidor). Outra
   * plataforma (requisito de Skill): o contrato antigo, a MESMA loja em
   * cada recurso, parando no primeiro erro.
   *
   * `lojaId === null` remove. Sucesso e conflito terminam igual: novo
   * GET. O conflito significa que o servidor sabe algo que a tela não
   * sabia — o requisito sumiu, ou a conta deixou de ser elegível — e a
   * única resposta correta é ressincronizar, nunca manter na tela uma
   * seleção que foi recusada.
   */
  const definir = useCallback(
    async (grupo: ConexaoDaPlataforma, lojaId: string | null) => {
      const chave = grupo.plataforma;
      setPendentes((atual) => ({ ...atual, [chave]: true }));
      setErros((atual) => {
        const proximo = { ...atual };
        delete proximo[chave];
        return proximo;
      });

      const provedor = provedorDeAgentesDaPlataforma(grupo.plataforma);
      let resposta: { estado: string; mensagem?: string };
      if (provedor !== null) {
        resposta = await definirContaDaApi(agenteId, provedor, lojaId);
      } else {
        resposta = { estado: "ok" };
        for (const r of grupo.recursos) {
          resposta = await definirConexaoDoAgente(agenteId, {
            plataforma: r.plataforma, recurso: r.recurso, lojaId,
          });
          if (resposta.estado !== "ok") break;
        }
      }

      const encerrar = (mensagem?: string) => {
        setPendentes((atual) => {
          const proximo = { ...atual };
          delete proximo[chave];
          return proximo;
        });
        if (mensagem !== undefined) {
          setErros((atual) => ({ ...atual, [chave]: mensagem }));
        }
      };

      if (resposta.estado === "ok") {
        // O eco do PATCH não é suficiente: `utilizavel` e a lista de
        // contas dependem de fatos que só o GET recalcula.
        await carregar();
        encerrar();
        return;
      }

      if (resposta.estado === "conflito" || resposta.estado === "inconsistente") {
        await carregar();
        encerrar(resposta.mensagem);
        return;
      }

      if (resposta.estado === "dados_invalidos") {
        encerrar(resposta.mensagem);
        return;
      }
      if (resposta.estado === "nao_autenticado") {
        encerrar(MENSAGEM_NAO_AUTENTICADO);
        return;
      }
      if (resposta.estado === "nao_encontrado") {
        encerrar(MENSAGEM_NAO_ENCONTRADO);
        return;
      }
      encerrar("Não foi possível salvar esta conexão.");
    },
    [agenteId, carregar]
  );

  if (leitura.estado === "carregando") {
    return <p className="cds-cx-carregando">Carregando conexões…</p>;
  }

  if (leitura.estado === "erro") {
    return (
      <div className="cds-cx-erro-bloco" role="alert">
        <p className="cds-cx-erro-texto">{leitura.mensagem}</p>
        <button
          type="button"
          className="cds-cx-secundario"
          onClick={() => {
            setLeitura({ estado: "carregando" });
            void carregar();
          }}
        >
          Tentar de novo
        </button>
        <style jsx>{ESTILO}</style>
      </div>
    );
  }

  // Zero requisitos e zero contas são coisas DIFERENTES. Este agente
  // simplesmente não exige conexão nenhuma — dizer "você não conectou
  // nenhuma conta" mandaria o dono resolver um problema que não existe.
  if (leitura.conexoes.length === 0) {
    return (
      <div className="cds-cx-vazio">
        <p className="cds-cx-vazio-titulo">Este agente não exige nenhuma conexão</p>
        <p className="cds-cx-vazio-texto">
          Quando uma Skill ou uma Função habilitada exigir uma conta de marketplace,
          o requisito aparece aqui para você escolher qual usar.
        </p>
        <style jsx>{ESTILO}</style>
      </div>
    );
  }

  return (
    <div className="cds-cx-raiz">
      <ul className="cds-cx-lista" aria-label="Conexões deste agente">
        {agruparPorPlataforma(leitura.conexoes).map((conexao) => {
          const chave = conexao.plataforma;
          const pendente = pendentes[chave] === true;
          const erro = errosPorRequisito[chave];
          const selecionada = conexao.lojasElegiveis.find(
            (l) => l.id === conexao.selecionada
          );
          const idSelect = `cds-cx-select-${chave.replace(/[^a-z0-9-]/gi, "-")}`;
          // UM rotulo por provider: o recurso e detalhe do servidor.
          const rotulo = ROTULO_PLATAFORMA[conexao.plataforma] ?? conexao.plataforma;

          return (
            <li key={chave} className="cds-cx-item">
              <div className="cds-cx-cabecalho">
                <span className="cds-cx-rotulo">{rotulo}</span>
                {/* `obrigatoria: false` NAO vira "Opcional": a semantica
                    de produto disso nao foi definida, e batizar agora
                    inventaria promessa. Sem badge basta. */}
                {conexao.obrigatoria && <span className="cds-cx-marca">Obrigatória</span>}
              </div>

              {conexao.divergente ? (
                <p className="cds-cx-estado cds-cx-incompativel" role="status">
                  Este agente está com contas diferentes. Escolha uma.
                </p>
              ) : conexao.selecionada === null ? (
                <p className="cds-cx-estado">Nenhuma conta escolhida</p>
              ) : conexao.utilizavel ? (
                <p className="cds-cx-estado">
                  Conta em uso:{" "}
                  <strong className="cds-cx-conta">
                    {selecionada ? nomeDaLoja(selecionada) : "conta selecionada"}
                  </strong>
                </p>
              ) : (
                <p className="cds-cx-estado cds-cx-incompativel" role="status">
                  {selecionada
                    ? `A conta escolhida (${nomeDaLoja(selecionada)}) não serve para este requisito.`
                    : "A conta escolhida não está mais disponível para este requisito."}{" "}
                  Escolha outra ou remova a seleção.
                </p>
              )}

              {conexao.lojasElegiveis.length === 0 ? (
                <p className="cds-cx-sem-contas">Nenhuma conta compatível conectada</p>
              ) : (
                <div className="cds-cx-controles">
                  <label className="cds-cx-label" htmlFor={idSelect}>
                    Contas conectadas compatíveis
                  </label>
                  <select
                    id={idSelect}
                    className="cds-cx-select"
                    value={conexao.selecionada ?? ""}
                    disabled={pendente}
                    onChange={(evento) => {
                      const valor = evento.target.value;
                      void definir(conexao, valor === "" ? null : valor);
                    }}
                  >
                    <option value="">Nenhuma</option>
                    {conexao.lojasElegiveis.map((loja) => (
                      <option key={loja.id} value={loja.id}>
                        {nomeDaLoja(loja)}
                      </option>
                    ))}
                  </select>

                  {(conexao.selecionada !== null || conexao.divergente || conexao.incompleta) && (
                    <button
                      type="button"
                      className="cds-cx-secundario"
                      disabled={pendente}
                      aria-label={`Remover a conta escolhida para ${rotulo}`}
                      onClick={() => void definir(conexao, null)}
                    >
                      Remover
                    </button>
                  )}

                  {pendente && <span className="cds-cx-salvando">Salvando…</span>}
                </div>
              )}

              {erro && (
                <p className="cds-cx-erro-item" role="alert">
                  {erro}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <style jsx>{ESTILO}</style>
    </div>
  );
}

const ESTILO = `
  .cds-cx-raiz { display: block; }
  .cds-cx-lista { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
  .cds-cx-item {
    border: 1px solid var(--cds-borda, #e2e5ea);
    border-radius: 10px;
    padding: 14px 16px;
    display: grid;
    gap: 8px;
  }
  .cds-cx-cabecalho { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .cds-cx-rotulo { font-weight: 600; }
  .cds-cx-marca {
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--cds-suave, #f1f3f6);
  }
  .cds-cx-estado { margin: 0; font-size: 14px; }
  .cds-cx-conta { font-weight: 600; }
  .cds-cx-incompativel { color: var(--cds-atencao, #a15c00); }
  .cds-cx-sem-contas { margin: 0; font-size: 14px; opacity: 0.8; }
  .cds-cx-controles { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .cds-cx-label { font-size: 13px; opacity: 0.85; }
  .cds-cx-select { padding: 6px 8px; border-radius: 8px; border: 1px solid var(--cds-borda, #e2e5ea); }
  .cds-cx-select:disabled { opacity: 0.6; cursor: progress; }
  .cds-cx-secundario {
    padding: 6px 12px;
    border-radius: 8px;
    border: 1px solid var(--cds-borda, #e2e5ea);
    background: transparent;
    cursor: pointer;
  }
  .cds-cx-secundario:disabled { opacity: 0.6; cursor: progress; }
  .cds-cx-salvando { font-size: 13px; opacity: 0.8; }
  .cds-cx-erro-item { margin: 0; font-size: 13px; color: var(--cds-erro, #b00020); }
  .cds-cx-erro-bloco { display: grid; gap: 10px; justify-items: start; }
  .cds-cx-erro-texto { margin: 0; color: var(--cds-erro, #b00020); }
  .cds-cx-carregando { margin: 0; opacity: 0.8; }
  .cds-cx-vazio { display: grid; gap: 6px; }
  .cds-cx-vazio-titulo { margin: 0; font-weight: 600; }
  .cds-cx-vazio-texto { margin: 0; font-size: 14px; opacity: 0.85; }
`;
