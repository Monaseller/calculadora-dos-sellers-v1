"use client";

/**
 * A edicao de um agente existente — EDITAR-AGENTE-V1.
 *
 * ── Dois campos, e a lista curta e a decisao ────────────────────────
 *
 * Nome e instrucoes. `tipo` nao entra: e escolha de PARTIDA, e a tela
 * de edicao revisita-la sugeriria que ela decide o que o agente e capaz
 * de fazer — ela nao decide. `ativo` tambem nao: desligar um agente
 * para a fila de tarefas dele, e isso e uma decisao com consequencia
 * propria, nao um checkbox no meio de um formulario de texto.
 *
 * ── Quem e dono do estado ───────────────────────────────────────────
 *
 * `PaginaAgente`. Este componente guarda apenas o RASCUNHO — o que esta
 * digitado e ainda nao foi gravado. Ao salvar, ele nao anuncia o que
 * digitou: entrega ao pai a LINHA que o servidor devolveu. Atualizar a
 * tela com o texto do formulario mostraria como salvo algo que o
 * servidor pode ter aparado, recusado ou gravado diferente.
 *
 * ── Cancelar nao escreve ────────────────────────────────────────────
 *
 * Nenhuma requisicao, nenhum aviso ao pai. O rascunho e descartado e a
 * tela volta a exibir o que esta persistido, que nunca deixou de ser a
 * fonte da VisaoGeral ao lado.
 *
 * ── Envio duplo, fechado em dois niveis ─────────────────────────────
 *
 * Mesma doutrina de `CriarAgente`: o botao desabilita E o handler checa
 * um ref antes de seguir. `disabled` sozinho nao cobre um Enter
 * repetido na janela ate o proximo render, e a rota nao tem chave de
 * idempotencia.
 *
 * ── Erro nao destroi trabalho ───────────────────────────────────────
 *
 * Falha mantem o formulario aberto com o que foi digitado. Fechar em
 * erro obrigaria o dono a redigitar um texto que ele acabou de escrever
 * — e a falha pode ser de rede, sem nada de errado com o conteudo.
 */
import { useRef, useState } from "react";
import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import type { AgenteUI } from "@/lib/ia/contratos";
import { atualizarAgenteViaApi } from "@/lib/ia/agentes-http";

const NOME_ID = "cds-ia-editar-nome";
const INSTRUCOES_ID = "cds-ia-editar-instrucoes";
const AJUDA_ID = "cds-ia-editar-ajuda";

/** O texto da caixa vira `null` quando vazio: e assim que o dono LIMPA
 *  as instrucoes, e a rota aceita `null` como pedido explicito. */
const paraCampo = (texto: string): string | null =>
  texto.trim() === "" ? null : texto.trim();

export default function EditarAgente({
  agente,
  onAtualizado,
}: {
  agente: AgenteUI;
  onAtualizado: (agente: AgenteUI) => void;
}) {
  const [editando, setEditando] = useState(false);
  const [nome, setNome] = useState(agente.nome);
  const [instrucoes, setInstrucoes] = useState(agente.instrucoes ?? "");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  // Espelha `salvando` para o handler ler o valor do INSTANTE, sem
  // esperar o proximo render — que e justamente a janela do Enter duplo.
  const salvandoRef = useRef(false);

  function abrir() {
    // Os campos partem SEMPRE do que esta persistido agora, nunca de um
    // rascunho antigo: reabrir depois de cancelar nao pode ressuscitar
    // texto que o dono ja descartou.
    setNome(agente.nome);
    setInstrucoes(agente.instrucoes ?? "");
    setErro(null);
    setEditando(true);
  }

  function cancelar() {
    if (salvandoRef.current) return;
    setErro(null);
    setEditando(false);
  }

  const nomeValido = nome.trim() !== "";

  async function aoSalvar(evento: React.FormEvent) {
    evento.preventDefault();
    if (salvandoRef.current || !nomeValido) return;

    salvandoRef.current = true;
    setSalvando(true);
    setErro(null);

    // Campo a campo. O objeto do formulario NUNCA e encaminhado inteiro.
    const resultado = await atualizarAgenteViaApi(agente.id, {
      nome: nome.trim(),
      instrucoes: paraCampo(instrucoes),
    });

    salvandoRef.current = false;
    setSalvando(false);

    if (resultado.estado === "ok") {
      // A LINHA DO SERVIDOR, nunca o rascunho.
      onAtualizado(resultado.agente);
      setEditando(false);
      return;
    }
    if (resultado.estado === "dados_invalidos") {
      setErro(resultado.mensagem);
      return;
    }
    if (resultado.estado === "nao_autenticado") {
      setErro("Sua sessão expirou. Entre novamente para salvar as alterações.");
      return;
    }
    if (resultado.estado === "nao_encontrado") {
      setErro("Este agente não está mais disponível.");
      return;
    }
    setErro("Não foi possível salvar. Tente novamente em instantes.");
  }

  if (!editando) {
    return (
      <>
        <style>{css}</style>
        <div className="cds-ia-editar-barra">
          <button
            type="button"
            onClick={abrir}
            className="cds-ia-editar-abrir"
            aria-label={`Editar nome e instruções de ${agente.nome}`}
          >
            Editar
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <style>{css}</style>

      <form onSubmit={aoSalvar} className="cds-ia-editar" aria-label="Editar agente">
        <label className="cds-ia-editar-campo" htmlFor={NOME_ID}>
          <span className="cds-ia-editar-rotulo">Nome</span>
        </label>
        <input
          id={NOME_ID}
          type="text"
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          disabled={salvando}
          className="cds-ia-editar-controle"
        />

        <label className="cds-ia-editar-campo" htmlFor={INSTRUCOES_ID}>
          <span className="cds-ia-editar-rotulo">Instruções</span>
        </label>
        <textarea
          id={INSTRUCOES_ID}
          value={instrucoes}
          onChange={(e) => setInstrucoes(e.target.value)}
          disabled={salvando}
          rows={6}
          className="cds-ia-editar-controle"
          placeholder="Como este agente deve trabalhar."
          aria-describedby={AJUDA_ID}
        />
        <span id={AJUDA_ID} className="cds-ia-editar-ajuda">
          As instruções orientam o agente em toda conversa. Deixar em branco remove as
          instruções atuais.
        </span>

        {erro && (
          <p className="cds-ia-editar-erro" role="alert">
            {erro}
          </p>
        )}

        <div className="cds-ia-editar-acoes">
          <button
            type="button"
            onClick={cancelar}
            disabled={salvando}
            className="cds-ia-editar-secundario"
            aria-label="Cancelar a edição e descartar as alterações"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={salvando || !nomeValido}
            className="cds-ia-editar-primario"
            aria-label="Salvar nome e instruções"
          >
            {salvando ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </form>
    </>
  );
}

const css = `
  .cds-ia-editar-barra {
    display: flex;
    justify-content: flex-end;
    margin-bottom: ${ESPACO.sm}px;
  }
  .cds-ia-editar-abrir {
    padding: ${ESPACO.xs}px ${ESPACO.md}px;
    font: 600 13px/1.2 ${FONTE.interface};
    color: ${CROMO.texto};
    background: ${CROMO.fundoCard};
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.controle}px;
    cursor: pointer;
  }
  .cds-ia-editar-abrir:hover { border-color: ${CROMO.textoFraco}; }
  .cds-ia-editar-abrir:focus-visible {
    outline: 2px solid ${CROMO.acento};
    outline-offset: 2px;
  }
  .cds-ia-editar {
    display: grid;
    gap: ${ESPACO.xs}px;
    margin-bottom: ${ESPACO.md}px;
    padding: ${ESPACO.lg}px;
    background: ${CROMO.fundoCard};
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.card}px;
  }
  .cds-ia-editar-campo { display: block; }
  .cds-ia-editar-rotulo {
    font: 600 12px/1.4 ${FONTE.interface};
    color: ${CROMO.textoFraco};
  }
  .cds-ia-editar-controle {
    width: 100%;
    margin-bottom: ${ESPACO.sm}px;
    padding: ${ESPACO.sm}px ${ESPACO.md}px;
    font: 400 14px/1.4 ${FONTE.interface};
    color: ${CROMO.texto};
    background: ${CROMO.fundo};
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.controle}px;
    box-sizing: border-box;
    resize: vertical;
  }
  .cds-ia-editar-controle:focus-visible {
    outline: 2px solid ${CROMO.acento};
    outline-offset: 1px;
  }
  .cds-ia-editar-controle:disabled { opacity: 0.6; }
  .cds-ia-editar-ajuda {
    font: 400 12px/1.4 ${FONTE.interface};
    color: ${CROMO.textoFraco};
  }
  /* A paleta da area nao tem cor de erro propria, e inventar uma aqui
     criaria um segundo vermelho no produto. Mesma escolha de
     \`CriarAgente\`: o acento marca o aviso. */
  .cds-ia-editar-erro {
    margin: ${ESPACO.sm}px 0 0;
    font: 400 13px/1.4 ${FONTE.interface};
    color: ${CROMO.acento};
  }
  .cds-ia-editar-acoes {
    display: flex;
    justify-content: flex-end;
    gap: ${ESPACO.sm}px;
    margin-top: ${ESPACO.md}px;
  }
  .cds-ia-editar-secundario,
  .cds-ia-editar-primario {
    padding: ${ESPACO.sm}px ${ESPACO.lg}px;
    font: 600 13px/1.2 ${FONTE.interface};
    border-radius: ${RAIO.controle}px;
    cursor: pointer;
  }
  .cds-ia-editar-secundario {
    color: ${CROMO.texto};
    background: transparent;
    border: 1px solid ${CROMO.borda};
  }
  .cds-ia-editar-primario {
    color: ${CROMO.fundo};
    background: ${CROMO.acento};
    border: 1px solid ${CROMO.acento};
  }
  .cds-ia-editar-secundario:disabled,
  .cds-ia-editar-primario:disabled { opacity: 0.55; cursor: default; }
  .cds-ia-editar-secundario:focus-visible,
  .cds-ia-editar-primario:focus-visible {
    outline: 2px solid ${CROMO.acento};
    outline-offset: 2px;
  }
`;
