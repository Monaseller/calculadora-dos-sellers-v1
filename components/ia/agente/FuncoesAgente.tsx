"use client";

/**
 * A aba Funcoes — PERMISSOES-FUNCTION-V1-B.
 *
 * ── Funcao disponivel e nivel sao a MESMA decisao ───────────────────
 *
 * Nao existe "habilitar" separado de "escolher o nivel". Uma Funcao sem
 * linha em `agente_permissoes` chega com `nivel: null`, e o guard a
 * NEGA — por isso ela aparece como "Nao configurada", nunca como
 * disponivel. Listar Funcoes como se estivessem prontas para uso seria
 * anunciar capacidade que ninguem concedeu.
 *
 * ── O catalogo e do SERVIDOR ────────────────────────────────────────
 *
 * Esta tela nao conhece Funcao nenhuma. A lista inteira vem de
 * `listarPermissoesDoAgente`, que o servidor deriva do registry real.
 * Nao ha id escrito aqui, nao ha mock e nao ha `[0]`: uma Funcao nova
 * aparece sozinha, e zero Funcoes e um estado legitimo.
 *
 * ── CONFIGURAR nao e EXECUTAR ───────────────────────────────────────
 *
 * Nao ha botao de executar, testar ou rodar. Esta tela grava a intencao
 * do dono; quem decide se uma chamada passa e o guard, na hora da
 * chamada, lendo o que ficou gravado.
 *
 * ── `nivelPersistido` contra `nivelSelecionado` ─────────────────────
 *
 * Duas coisas diferentes, e misturar as duas e a forma mais facil de
 * mentir na tela. O selecionado e o que o dono escolheu e ainda nao
 * salvou; o persistido so muda quando o SERVIDOR confirma, e com o
 * valor que ELE devolveu. Enquanto diferem, a linha diz que ha
 * alteracao nao salva.
 *
 * ── Tudo por Funcao, nada global ────────────────────────────────────
 *
 * Selecao, erro e travamento de envio sao indexados por `funcaoId`.
 * Salvar uma Funcao nao mexe na selecao de outra e nao trava o botao
 * dela. Hoje existe uma Funcao so; presumir isso seria escrever um bug
 * com data marcada.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import { NIVEIS_AUTONOMIA, VOCABULARIO_NIVEL, type NivelAutonomia } from "@/lib/ia/conceitos";
import {
  definirPermissaoDeFuncao,
  listarPermissoesDoAgente,
  type PermissaoDeFuncaoUI,
} from "@/lib/ia/agentes-http";
import EstadoVazio from "@/components/ia/EstadoVazio";
import ExecutarConsultaVendas, {
  temSuperficieDeExecucao,
} from "@/components/ia/agente/ExecutarConsultaVendas";

/** O que a tela sabe sobre a leitura. `carregando` e estado proprio, e
 *  nunca lista vazia: "nao consegui perguntar" e "nao ha nada" pedem
 *  coisas diferentes do dono. */
type Leitura =
  | { estado: "carregando" }
  | { estado: "pronto"; permissoes: readonly PermissaoDeFuncaoUI[] }
  | { estado: "erro"; mensagem: string };

const TEXTO_NAO_CONFIGURADA =
  "O agente não pode usar esta função até você escolher um nível.";

/** A falha generica da gravacao. Tambem cobre a resposta que veio sobre
 *  outra Funcao: o dono nao tem o que corrigir nesse caso, e revelar o
 *  que voltou so exporia forma interna. */
const MENSAGEM_FALHA_SALVAR = "Não foi possível salvar. Tente novamente em instantes.";

const ROTULO_ACESSO: Record<"leitura" | "escrita", string> = {
  leitura: "Leitura",
  escrita: "Escrita",
};

export default function FuncoesAgente({ agenteId }: { agenteId: string }) {
  const [leitura, setLeitura] = useState<Leitura>({ estado: "carregando" });
  /** Escolha ainda NAO salva, por funcaoId. Ausente = nada escolhido. */
  const [selecao, setSelecao] = useState<Record<string, NivelAutonomia>>({});
  /** Erro de gravacao, por funcaoId. */
  const [erros, setErros] = useState<Record<string, string>>({});
  /** Quais Funcoes estao com escrita em voo, por funcaoId. */
  const [salvando, setSalvando] = useState<readonly string[]>([]);

  // Espelha `salvando` para o handler ler o valor do INSTANTE, sem
  // esperar o proximo render — que e justamente a janela do clique
  // duplo. `Set` e nao booleano: o travamento e POR Funcao.
  const salvandoRef = useRef<Set<string>>(new Set());
  /**
   * QUAL agente esta na tela AGORA.
   *
   * O PATCH nao aceita `AbortSignal` de proposito — abortar uma escrita
   * no navegador nao desfaz o que o servidor gravou. Mas isso deixa uma
   * resposta em voo capaz de resolver DEPOIS que a prop mudou, e o
   * `funcaoId` existe nas duas listas (o registry e o mesmo): sem esta
   * ref, a resposta do agente A sobrescreveria o nivel do agente B.
   *
   * Comparar a closure de `agenteId` consigo mesma nao resolveria nada —
   * ela e justamente o valor ANTIGO. A ref e escrita no efeito de troca
   * e lida DEPOIS do await, entao ela responde "quem esta na tela
   * agora", que e a pergunta que importa.
   */
  const agenteAtualRef = useRef(agenteId);

  const carregar = useCallback(
    (sinal?: AbortSignal) => {
      setLeitura({ estado: "carregando" });
      void listarPermissoesDoAgente(agenteId, sinal).then((r) => {
        // Resposta de um agente anterior nao pode povoar a tela de
        // outro. A guarda e do PROPRIO componente: depender so do
        // desmonte do container deixaria a protecao a cargo de um
        // detalhe que nao e desta camada.
        if (sinal?.aborted) return;
        if (r.estado === "ok") {
          setLeitura({ estado: "pronto", permissoes: r.permissoes });
          return;
        }
        if (r.estado === "nao_autenticado") {
          setLeitura({
            estado: "erro",
            mensagem: "Sua sessão expirou. Entre novamente para ver as funções.",
          });
          return;
        }
        if (r.estado === "nao_encontrado") {
          setLeitura({ estado: "erro", mensagem: "Este agente não está mais disponível." });
          return;
        }
        setLeitura({
          estado: "erro",
          mensagem: "Não foi possível carregar as funções. Tente novamente em instantes.",
        });
      });
    },
    [agenteId]
  );

  /**
   * A UNICA atribuicao da identidade atual, e ela vive num LAYOUT
   * effect — nao no passivo abaixo.
   *
   * ── A janela que isto fecha ─────────────────────────────────────
   *
   * `useEffect` e passivo: o React o agenda, nao o executa no commit.
   * Havia, portanto, um intervalo real entre "B ja esta commitado na
   * tela" e "o efeito de B rodou" — e a continuacao de um `await` e
   * microtask, que drena antes do macrotask em que o React agenda os
   * efeitos passivos. Uma resposta de PATCH do agente A que caisse
   * nesse intervalo encontraria o ref ainda em A, passaria pelo guard
   * e escreveria sobre a tela de B. O `funcaoId` existe nas duas
   * listas — o registry e o mesmo —, entao a contaminacao seria
   * silenciosa.
   *
   * Layout effects rodam SINCRONAMENTE dentro do commit, antes de o
   * navegador pintar e antes de qualquer micro ou macrotask posterior.
   * A invariante passa a ser exata: no instante em que a tela
   * representa B, o ref ja diz B.
   *
   * ── Por que NAO no corpo do render ──────────────────────────────
   *
   * Um render concorrente de B pode ser interrompido ou descartado sem
   * nunca commitar. Marcar B como atual ali diria que a tela mudou
   * quando ela ainda mostra A — e um PATCH de A resolvendo nesse
   * momento seria descartado por engano. A identidade pertence ao
   * COMMIT, nao ao render.
   */
  useLayoutEffect(() => {
    agenteAtualRef.current = agenteId;
  }, [agenteId]);

  useEffect(() => {
    const controlador = new AbortController();
    // Estado de outro agente nao sobrevive a troca. Nao ha cache: a
    // resposta anterior nao vale para o agente novo nem por um frame.
    setSelecao({});
    setErros({});
    setSalvando([]);
    // Set NOVO, e nao `.clear()`: cada operacao em voo guardou a
    // referencia do conjunto que usou, e limpar o antigo faria o
    // `finally` dela mexer no conjunto do agente novo.
    salvandoRef.current = new Set();
    carregar(controlador.signal);
    return () => controlador.abort();
  }, [agenteId, carregar]);

  async function salvar(funcaoId: string, nivel: NivelAutonomia) {
    // ── A IDENTIDADE DA OPERACAO, capturada antes de qualquer await ──
    //
    // O conjunto tambem e capturado, e nao relido depois: na troca de
    // agente `salvandoRef.current` passa a apontar para um Set NOVO, e
    // um `delete` sobre ele poderia liberar a trava de uma operacao
    // REAL do agente B. Cada operacao mexe no conjunto que ela mesma
    // usou.
    const conjuntoDaOperacao = salvandoRef.current;
    const agenteDaOperacao = agenteId;

    // `has` e `add` SINCRONOS e adjacentes: sem await entre os dois nao
    // existe janela para um segundo clique passar.
    if (conjuntoDaOperacao.has(funcaoId)) return;
    conjuntoDaOperacao.add(funcaoId);

    /** Esta operacao ainda pertence a tela que esta sendo exibida? */
    const daMesmaTela = () => agenteAtualRef.current === agenteDaOperacao;

    setSalvando((atual) => [...atual, funcaoId]);
    setErros((atual) => {
      const { [funcaoId]: _removido, ...resto } = atual;
      void _removido;
      return resto;
    });

    try {
      // Chave a chave. O objeto da tela NUNCA e encaminhado inteiro.
      const resultado = await definirPermissaoDeFuncao(agenteDaOperacao, { funcaoId, nivel });

      // ── O GUARD, depois do await e ANTES de qualquer setState ──────
      //
      // Trocou de agente enquanto isto voava: o resultado e descartado
      // inteiro. Nao vira nivel, nao vira selecao e nao vira erro na
      // tela de outro agente. A escrita ja aconteceu no servidor, e ela
      // continua valendo para o agente A — o que nao pode acontecer e
      // ela APARECER no B.
      if (!daMesmaTela()) return;

      if (resultado.estado === "ok") {
        // A resposta precisa ser sobre a Funcao que foi pedida. Um id
        // divergente atualizaria a linha ERRADA, em silencio — entao
        // vira falha sanitizada, sem revelar o que voltou.
        if (resultado.funcaoId !== funcaoId) {
          setErros((atual) => ({ ...atual, [funcaoId]: MENSAGEM_FALHA_SALVAR }));
          return;
        }
        // O NIVEL DO SERVIDOR, nunca o que foi escolhido na tela.
        setLeitura((atual) =>
          atual.estado !== "pronto"
            ? atual
            : {
                estado: "pronto",
                permissoes: atual.permissoes.map((p) =>
                  p.id === funcaoId ? { ...p, nivel: resultado.nivel } : p
                ),
              }
        );
        setSelecao((atual) => ({ ...atual, [funcaoId]: resultado.nivel }));
        return;
      }

      const mensagem =
        resultado.estado === "dados_invalidos"
          ? resultado.mensagem
          : resultado.estado === "nao_autenticado"
            ? "Sua sessão expirou. Entre novamente para salvar."
            : resultado.estado === "nao_encontrado"
              ? "Este agente não está mais disponível."
              : MENSAGEM_FALHA_SALVAR;
      // A selecao do dono NAO e descartada: ele acabou de escolher, e a
      // falha pode ser de rede.
      setErros((atual) => ({ ...atual, [funcaoId]: mensagem }));
    } finally {
      // Sempre, em qualquer saida — sucesso, falha, troca de agente ou
      // um throw futuro do helper. A seguranca desta tela nao pode
      // depender de o transporte nunca lancar.
      conjuntoDaOperacao.delete(funcaoId);
      // Mas o estado REACT so e tocado se a tela ainda for a mesma.
      if (daMesmaTela()) {
        setSalvando((atual) => atual.filter((id) => id !== funcaoId));
      }
    }
  }

  if (leitura.estado === "carregando") {
    return (
      <>
        <style>{css}</style>
        <p className="cds-fn-carregando">Carregando funções…</p>
      </>
    );
  }

  if (leitura.estado === "erro") {
    return (
      <>
        <style>{css}</style>
        <div className="cds-fn-erro-bloco" role="alert">
          <p className="cds-fn-erro-texto">{leitura.mensagem}</p>
          <button
            type="button"
            onClick={() => carregar()}
            className="cds-fn-secundario"
            aria-label="Tentar carregar as funções novamente"
          >
            Tentar novamente
          </button>
        </div>
      </>
    );
  }

  if (leitura.permissoes.length === 0) {
    return (
      <>
        <style>{css}</style>
        <EstadoVazio
          titulo="Nenhuma função disponível"
          descricao="Nenhuma função está registrada na CDS ainda. Quando houver, ela aparece aqui para você escolher o nível de acesso deste agente."
        />
      </>
    );
  }

  return (
    <>
      <style>{css}</style>

      <ul className="cds-fn-lista" aria-label="Funções deste agente">
        {leitura.permissoes.map((permissao) => {
          const escolhido = selecao[permissao.id];
          const emVoo = salvando.includes(permissao.id);
          const erro = erros[permissao.id];
          const alterado = escolhido !== undefined && escolhido !== permissao.nivel;
          const seletorId = `cds-fn-nivel-${permissao.id}`;

          return (
            <li key={permissao.id} className="cds-fn-item">
              <div className="cds-fn-cabecalho">
                <code className="cds-fn-id">{permissao.id}</code>
                <span className="cds-fn-acesso">{ROTULO_ACESSO[permissao.acesso]}</span>
                {permissao.idempotente && (
                  <span className="cds-fn-marca">Repetível sem efeito extra</span>
                )}
              </div>

              {/* Informativo, e so. Quem decide execucao e o guard, no
                  servidor — a tela nao autoriza nem bloqueia por conta
                  da conexao. */}
              {permissao.conexaoNecessaria !== null && (
                <p className="cds-fn-conexao">
                  Precisa de uma conta de {permissao.conexaoNecessaria.plataforma} para{" "}
                  {permissao.conexaoNecessaria.recurso}.
                </p>
              )}

              <p className="cds-fn-estado">
                Nível atual:{" "}
                {permissao.nivel === null ? (
                  <strong className="cds-fn-nao-configurada">Não configurada</strong>
                ) : (
                  <strong>{VOCABULARIO_NIVEL[permissao.nivel].rotulo}</strong>
                )}
              </p>

              {permissao.nivel === null ? (
                <p className="cds-fn-ajuda">{TEXTO_NAO_CONFIGURADA}</p>
              ) : (
                <p className="cds-fn-ajuda">{VOCABULARIO_NIVEL[permissao.nivel].explicacao}</p>
              )}

              <div className="cds-fn-acoes">
                <label className="cds-fn-rotulo" htmlFor={seletorId}>
                  Nível de acesso
                </label>
                <select
                  id={seletorId}
                  value={escolhido ?? ""}
                  onChange={(e) =>
                    setSelecao((atual) => ({
                      ...atual,
                      [permissao.id]: e.target.value as NivelAutonomia,
                    }))
                  }
                  disabled={emVoo}
                  className="cds-fn-select"
                >
                  {/* Placeholder inerte: `value=""` nao e gravavel, e o
                      dono precisa escolher um dos tres explicitamente.
                      NAO existe opcao para voltar a "não configurada" —
                      negar e `Bloqueado`, que grava linha. */}
                  <option value="" disabled>
                    Escolha um nível
                  </option>
                  {NIVEIS_AUTONOMIA.map((nivel) => (
                    <option key={nivel} value={nivel}>
                      {VOCABULARIO_NIVEL[nivel].rotulo}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  onClick={() => {
                    if (escolhido !== undefined) void salvar(permissao.id, escolhido);
                  }}
                  disabled={emVoo || !alterado}
                  className="cds-fn-primario"
                  aria-label={`Salvar o nível de acesso de ${permissao.id}`}
                >
                  {emVoo ? "Salvando…" : "Salvar"}
                </button>
              </div>

              {alterado && !emVoo && (
                <p className="cds-fn-pendente">Alteração ainda não salva.</p>
              )}

              {erro && (
                <p className="cds-fn-erro-texto" role="alert">
                  {erro}
                </p>
              )}

              {/* FUNCTION-RUNTIME-V1-B2B. O nivel entra como PROP, da
                  mesma leitura que ja alimenta esta lista: sem segundo
                  fetch, sem segundo polling de permissao. E vai o nivel
                  SALVO (`permissao.nivel`), nunca o `escolhido` ainda
                  pendente no seletor — o runtime decide pelo que esta
                  gravado, e a tela nao deve prometer diferente. */}
              {temSuperficieDeExecucao(permissao.id) && (
                <ExecutarConsultaVendas agenteId={agenteId} nivel={permissao.nivel} />
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

const css = `
  .cds-fn-carregando {
    margin: 0;
    font: 400 13px/1.5 ${FONTE.interface};
    color: ${CROMO.textoFraco};
  }
  .cds-fn-erro-bloco {
    display: grid;
    gap: ${ESPACO.md}px;
    justify-items: start;
    padding: ${ESPACO.lg}px;
    background: ${CROMO.fundoCard};
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.card}px;
  }
  .cds-fn-lista {
    display: grid;
    gap: ${ESPACO.md}px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .cds-fn-item {
    padding: ${ESPACO.lg}px;
    background: ${CROMO.fundoCard};
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.card}px;
  }
  .cds-fn-cabecalho {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: ${ESPACO.sm}px;
    margin-bottom: ${ESPACO.sm}px;
  }
  .cds-fn-id {
    font: 600 14px/1.3 ${FONTE.palco};
    color: ${CROMO.texto};
  }
  .cds-fn-acesso, .cds-fn-marca {
    padding: 2px ${ESPACO.sm}px;
    font: 600 11px/1.6 ${FONTE.interface};
    color: ${CROMO.textoFraco};
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.controle}px;
  }
  .cds-fn-conexao, .cds-fn-ajuda {
    margin: 0 0 ${ESPACO.sm}px;
    font: 400 12px/1.5 ${FONTE.interface};
    color: ${CROMO.textoFraco};
  }
  .cds-fn-estado {
    margin: 0 0 ${ESPACO.xs}px;
    font: 400 13px/1.5 ${FONTE.interface};
    color: ${CROMO.texto};
  }
  .cds-fn-nao-configurada { color: ${CROMO.acento}; }
  .cds-fn-acoes {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: ${ESPACO.sm}px;
    margin-top: ${ESPACO.md}px;
  }
  .cds-fn-rotulo {
    font: 600 12px/1.4 ${FONTE.interface};
    color: ${CROMO.textoFraco};
  }
  .cds-fn-select {
    padding: ${ESPACO.xs}px ${ESPACO.sm}px;
    font: 400 13px/1.4 ${FONTE.interface};
    color: ${CROMO.texto};
    background: ${CROMO.fundo};
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.controle}px;
  }
  .cds-fn-primario, .cds-fn-secundario {
    padding: 8px 14px;
    font: 700 13px/1 ${FONTE.interface};
    border-radius: ${RAIO.controle}px;
    cursor: pointer;
  }
  .cds-fn-primario {
    background: ${CROMO.acento};
    border: 1px solid ${CROMO.acento};
    color: #000;
  }
  .cds-fn-secundario {
    background: transparent;
    border: 1px solid ${CROMO.borda};
    color: ${CROMO.texto};
  }
  .cds-fn-primario:disabled, .cds-fn-secundario:disabled {
    opacity: .5;
    cursor: not-allowed;
  }
  .cds-fn-select:focus-visible,
  .cds-fn-primario:focus-visible,
  .cds-fn-secundario:focus-visible {
    outline: 2px solid ${CROMO.acento};
    outline-offset: 2px;
  }
  .cds-fn-pendente {
    margin: ${ESPACO.sm}px 0 0;
    font: 400 12px/1.5 ${FONTE.interface};
    color: ${CROMO.textoFraco};
  }
  /* A paleta da area nao tem cor de erro propria, e inventar uma aqui
     criaria um segundo vermelho no produto. Mesma escolha de
     \`CriarAgente\` e \`EditarAgente\`: o acento marca o aviso. */
  .cds-fn-erro-texto {
    margin: ${ESPACO.sm}px 0 0;
    font: 400 12px/1.5 ${FONTE.interface};
    color: ${CROMO.acento};
  }
`;
