"use client";

/**
 * O dialogo de criacao de agente — SKILL-1D.agent-create-ui-B.
 *
 * ── O que ele faz, e so isso ────────────────────────────────────────
 *
 * Tres campos, um envio, e devolve ao pai o agente que o servidor
 * criou. Nao le lista, nao navega, nao conhece rota e nao sabe quem e
 * o dono — quem decide o dono e a sessao, no servidor.
 *
 * ── Tres campos, e a lista curta e a decisao ────────────────────────
 *
 * Nome, tipo e instrucoes. Nada de modelo, ferramenta, Skill, fonte,
 * conexao, permissao, memoria ou orcamento: cada um deles e uma frente
 * propria, e um formulario que pede tudo de uma vez faz o usuario
 * decidir coisas que ele ainda nao tem como decidir. `id`, `ativo` e as
 * datas nem aparecem — sao do servidor.
 *
 * ── Fechar durante o envio seria mentira ────────────────────────────
 *
 * Enquanto o POST esta em voo, Escape, clique no fundo e o botao de
 * fechar ficam inertes. Fechar ali daria a impressao de cancelamento,
 * e uma escrita ja despachada nao volta atras porque a tela sumiu.
 *
 * ── Envio duplo, fechado em dois niveis ─────────────────────────────
 *
 * O botao desabilita, e o handler ainda checa `enviando` antes de
 * seguir: `disabled` sozinho nao cobre um Enter repetido no intervalo
 * ate o proximo render. O endpoint nao tem chave de idempotencia — a
 * divida esta registrada —, entao esta e a protecao desta camada.
 *
 * O padrao de acessibilidade (`role="dialog"`, `aria-modal`, Escape,
 * fundo clicavel, foco devolvido a quem abriu) vem de
 * `components/ia/office/PainelAgente.tsx`, que nao foi tocado.
 */
import { useEffect, useRef, useState } from "react";
import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import { DESCRICAO_TIPO } from "@/lib/ia/conceitos";
import { TIPOS_AGENTE_UI } from "@/lib/ia/contratos";
import type { AgenteUI, TipoAgenteUI } from "@/lib/ia/contratos";
import { criarAgenteViaApi } from "@/lib/ia/agentes-http";

const TITULO_ID = "cds-ia-criar-agente-titulo";

export default function CriarAgente({
  onFechar,
  onCriado,
}: {
  onFechar: () => void;
  onCriado: (agente: AgenteUI) => void;
}) {
  const [nome, setNome] = useState("");
  const [tipo, setTipo] = useState<TipoAgenteUI>(TIPOS_AGENTE_UI[0]);
  const [instrucoes, setInstrucoes] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const nomeRef = useRef<HTMLInputElement | null>(null);
  // Espelha `enviando` para o handler ler o valor do INSTANTE, sem
  // esperar o proximo render — que e justamente a janela do Enter duplo.
  const enviandoRef = useRef(false);

  useEffect(() => {
    const anterior = document.activeElement as HTMLElement | null;
    nomeRef.current?.focus();

    function aoTeclar(evento: KeyboardEvent) {
      if (evento.key !== "Escape") return;
      evento.stopPropagation();
      if (enviandoRef.current) return;
      onFechar();
    }
    document.addEventListener("keydown", aoTeclar);

    return () => {
      document.removeEventListener("keydown", aoTeclar);
      if (anterior && anterior.isConnected) anterior.focus();
    };
  }, [onFechar]);

  const nomeValido = nome.trim() !== "";

  async function aoEnviar(evento: React.FormEvent) {
    evento.preventDefault();
    if (enviandoRef.current || !nomeValido) return;

    enviandoRef.current = true;
    setEnviando(true);
    setErro(null);

    // Campo a campo. O objeto do formulario NUNCA e encaminhado inteiro.
    const resultado = await criarAgenteViaApi({
      nome: nome.trim(),
      tipo,
      instrucoes: instrucoes.trim() === "" ? null : instrucoes.trim(),
    });

    enviandoRef.current = false;
    setEnviando(false);

    if (resultado.estado === "ok") {
      onCriado(resultado.agente);
      return;
    }
    if (resultado.estado === "dados_invalidos") {
      setErro(resultado.mensagem);
      return;
    }
    if (resultado.estado === "nao_autenticado") {
      setErro("Sua sessão expirou. Entre novamente para criar o agente.");
      return;
    }
    setErro("Não foi possível criar o agente. Tente novamente em instantes.");
  }

  return (
    <>
      <style>{css}</style>

      <div
        className="cds-ia-criar-fundo"
        onClick={() => {
          if (!enviando) onFechar();
        }}
        aria-hidden="true"
      />

      <div className="cds-ia-criar" role="dialog" aria-modal="true" aria-labelledby={TITULO_ID}>
        <h2 id={TITULO_ID} className="cds-ia-criar-titulo">
          Novo agente
        </h2>

        <form onSubmit={aoEnviar} className="cds-ia-criar-form">
          <label className="cds-ia-criar-campo">
            <span className="cds-ia-criar-rotulo">Nome</span>
            <input
              ref={nomeRef}
              type="text"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              disabled={enviando}
              className="cds-ia-criar-controle"
              placeholder="Atendimento"
            />
          </label>

          <label className="cds-ia-criar-campo">
            <span className="cds-ia-criar-rotulo">Tipo</span>
            <select
              value={tipo}
              onChange={(e) => setTipo(e.target.value as TipoAgenteUI)}
              disabled={enviando}
              className="cds-ia-criar-controle"
            >
              {TIPOS_AGENTE_UI.map((t) => (
                <option key={t} value={t}>
                  {DESCRICAO_TIPO[t]}
                </option>
              ))}
            </select>
          </label>

          <label className="cds-ia-criar-campo">
            <span className="cds-ia-criar-rotulo">Instruções (opcional)</span>
            <textarea
              value={instrucoes}
              onChange={(e) => setInstrucoes(e.target.value)}
              disabled={enviando}
              rows={4}
              className="cds-ia-criar-controle"
              placeholder="Como este agente deve trabalhar."
            />
          </label>

          {erro && (
            <p className="cds-ia-criar-erro" role="alert">
              {erro}
            </p>
          )}

          <div className="cds-ia-criar-acoes">
            <button
              type="button"
              onClick={onFechar}
              disabled={enviando}
              className="cds-ia-criar-secundario"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={enviando || !nomeValido}
              className="cds-ia-criar-primario"
            >
              {enviando ? "Criando…" : "Criar agente"}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

const css = `
  .cds-ia-criar-fundo {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.55);
    z-index: 40;
  }
  .cds-ia-criar {
    position: fixed;
    z-index: 41;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(440px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    overflow: auto;
    padding: ${ESPACO.xl}px;
    background: ${CROMO.fundoCard};
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.card}px;
  }
  .cds-ia-criar-titulo {
    margin: 0 0 ${ESPACO.lg}px;
    font: 700 16px/1.3 ${FONTE.interface};
    color: ${CROMO.texto};
  }
  .cds-ia-criar-form { display: grid; gap: ${ESPACO.md}px; }
  .cds-ia-criar-campo { display: grid; gap: ${ESPACO.sm}px; }
  .cds-ia-criar-rotulo { font: 12px/1.4 ${FONTE.interface}; color: ${CROMO.textoFraco}; }
  .cds-ia-criar-controle {
    width: 100%;
    padding: 10px 12px;
    background: rgba(255,255,255,0.04);
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.controle}px;
    color: ${CROMO.texto};
    font: 13px/1.5 ${FONTE.interface};
  }
  .cds-ia-criar-controle:focus-visible { outline: 2px solid ${CROMO.acento}; outline-offset: 1px; }
  .cds-ia-criar-controle:disabled { opacity: .6; }
  /* A paleta da area nao tem cor de erro propria, e inventar uma aqui
     criaria um token fora do design. O acento ja e o unico destaque
     quente do tema e cumpre o papel sem abrir vocabulario novo. */
  .cds-ia-criar-erro { margin: 0; font: 12px/1.5 ${FONTE.interface}; color: ${CROMO.acento}; }
  .cds-ia-criar-acoes {
    display: flex;
    justify-content: flex-end;
    gap: ${ESPACO.sm}px;
    margin-top: ${ESPACO.sm}px;
  }
  .cds-ia-criar-primario, .cds-ia-criar-secundario {
    padding: 9px 14px;
    border-radius: ${RAIO.controle}px;
    font: 700 13px/1 ${FONTE.interface};
    cursor: pointer;
  }
  .cds-ia-criar-primario {
    background: ${CROMO.acento};
    border: 1px solid ${CROMO.acento};
    color: #000;
  }
  .cds-ia-criar-secundario {
    background: transparent;
    border: 1px solid ${CROMO.borda};
    color: ${CROMO.texto};
  }
  .cds-ia-criar-primario:disabled, .cds-ia-criar-secundario:disabled {
    opacity: .5;
    cursor: not-allowed;
  }
`;
