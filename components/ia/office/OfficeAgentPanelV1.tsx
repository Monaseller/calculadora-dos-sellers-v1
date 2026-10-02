"use client";

/**
 * Office V1 — o painel direito do agente selecionado.
 *
 * ── So dado real, e so dado seguro ──────────────────────────────────
 *
 * Nao existe `descricao` de agente, e `instrucoes` NAO a substitui: e
 * configuracao interna (o prompt), nao texto de vitrine. O painel mostra
 * nome, tipo, o estado derivado e a atividade atual quando ela existe.
 * Sem atividade, nao inventa frase nenhuma.
 *
 * ── Ferramentas: as que o agente TEM ────────────────────────────────
 *
 * A lista vem de `lerAtivacaoDoAgente` — os packs com permissao gravada
 * e as acoes externas vinculadas. A descricao do pack vem do catalogo
 * (`TOOL_PACKS`), que e a mesma fonte que o Wizard usa. Nada e copiado
 * do prototipo, e nenhuma Tool e desenhada sem existir.
 *
 * ── O botao + abre "Gerenciar ferramentas" (F8.2-A) ────────────────
 *
 * Adicionar continua NAO sendo regra deste painel: o drawer usa o mesmo
 * `BuscaDeFerramentas` da etapa 4 e o mesmo `adicionarPackAoAgente` do
 * Wizard, entao o nivel default segue vindo de um lugar so. Remover
 * (F8.2-B) usa o contrato de cada tipo: pack interno volta ao "nao
 * selecionado" por `removerPackDoAgente` (DELETE das permissoes do pack,
 * nunca `bloqueado`); acao externa por `desvincularFerramentaExterna`.
 */
import { useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import { CORES_TIPO } from "@/lib/ia/design";
import { NIVEIS_AUTONOMIA, VOCABULARIO_NIVEL, type NivelAutonomia } from "@/lib/ia/conceitos";
import type { AparenciaAgente } from "@/lib/ia/estados";
import type { AgenteUI } from "@/lib/ia/contratos";
import { removerPackDoAgente } from "@/lib/ia/ferramentas-do-agente";
import {
  desvincularFerramentaExterna,
  lerAtivacaoDoAgente,
  type AtividadeAtualUI,
  type FerramentaDaAtivacaoUI,
  type FerramentaExternaVinculadaUI,
} from "@/lib/ia/agentes-http";
import { packPorId } from "@/lib/agentes/factory/catalogo-ui";
import { StatusDoAgente } from "@/components/ia/office/OfficeSceneV1";
import { hrefDaArea } from "@/components/ia/SubNavIA";
import GerenciarFerramentas from "@/components/ia/office/GerenciarFerramentas";
import { ICONE_ACAO_EXTERNA, iconeDoPack } from "@/lib/ia/icones-ferramentas";
import estilos from "@/components/ia/office/office-v1.module.css";

type LeituraDasFerramentas =
  | { estado: "carregando" }
  | {
      estado: "ok";
      ferramentas: readonly FerramentaDaAtivacaoUI[];
      externas: readonly FerramentaExternaVinculadaUI[];
    }
  | { estado: "falha"; mensagem: string };

function rotuloDoNivel(nivel: string | null): string | null {
  if (nivel === null) return null;
  return (NIVEIS_AUTONOMIA as readonly string[]).includes(nivel)
    ? VOCABULARIO_NIVEL[nivel as NivelAutonomia].rotulo
    : null;
}

/** O nivel de um pack, dito como a resposta o descreve — sem default. */
function nivelDoPack(f: FerramentaDaAtivacaoUI): string {
  if (!f.completo) {
    return f.faltando === 1
      ? "Incompleta — falta 1 permissão"
      : `Incompleta — faltam ${f.faltando} permissões`;
  }
  return rotuloDoNivel(f.nivel) ?? "Níveis diferentes por função";
}

export default function OfficeAgentPanelV1({
  agente,
  aparencia,
  atividade,
}: {
  agente: AgenteUI;
  aparencia: AparenciaAgente;
  atividade: AtividadeAtualUI | null;
}) {
  const [leitura, setLeitura] = useState<LeituraDasFerramentas>({ estado: "carregando" });
  // F8.2-A: releitura apos adicionar/remover, sem recarregar a pagina.
  const [versao, setVersao] = useState(0);
  const [gerenciar, setGerenciar] = useState(false);
  /** Ferramenta com remocao pedida (1o clique) — o 2o confirma. A chave e
   *  `pack:<id>` ou `externa:<funcaoId>`. */
  const [confirmando, setConfirmando] = useState<string | null>(null);
  const [removendo, setRemovendo] = useState<string | null>(null);
  const [erroAcao, setErroAcao] = useState<string | null>(null);
  const configurar = `/ia/agentes/${agente.id}/configurar`;
  const tituloId = `ov1-painel-${agente.id}`;

  // F8.1-C1: as areas administrativas sairam da barra e aparecem AQUI,
  // so quando o estado REAL do agente pede. Sem fetch novo: e o mesmo
  // `aparencia` que o hotspot ja mostra.
  const contexto: { rotulo: string; href: string } | null = aparencia.foraDeOperacao
    ? null
    : aparencia.estado === "aguardando_aprovacao"
      ? { rotulo: "Revisar aprovação pendente", href: hrefDaArea("Aprovações") ?? "" }
      : aparencia.estado === "erro"
        ? { rotulo: "Ver no monitoramento", href: hrefDaArea("Monitoramento") ?? "" }
        : null;

  useEffect(() => {
    let vivo = true;
    const controlador = new AbortController();
    // Releitura (versao > 0) mantem a lista na tela ate a nova chegar:
    // piscar para "carregando" a cada ferramenta adicionada seria ruido.
    setLeitura((l) => (l.estado === "ok" ? l : { estado: "carregando" }));
    (async () => {
      const r = await lerAtivacaoDoAgente(agente.id, controlador.signal);
      if (!vivo) return;
      if (r.estado === "ok") {
        setLeitura({
          estado: "ok",
          ferramentas: r.dados.ferramentas,
          externas: r.dados.ferramentasExternas,
        });
      } else {
        setLeitura({
          estado: "falha",
          mensagem:
            r.estado === "nao_autenticado"
              ? "Sua sessão expirou. Entre novamente para ver as ferramentas."
              : r.estado === "nao_encontrado"
                ? "Este agente não foi encontrado."
                : "Não foi possível carregar as ferramentas deste agente agora.",
        });
      }
    })();
    return () => {
      vivo = false;
      controlador.abort();
    };
  }, [agente.id, versao]);

  /**
   * Remove uma ferramenta — cada tipo pelo SEU contrato (F8.2-B):
   *   pack interno  -> `removerPackDoAgente` (volta ao "nao selecionado")
   *   acao externa  -> `desvincularFerramentaExterna`
   * O 1o clique pede, o 2o confirma.
   */
  async function remover(chave: string, executar: () => Promise<boolean>) {
    if (confirmando !== chave) {
      setConfirmando(chave);
      return;
    }
    setConfirmando(null);
    setErroAcao(null);
    setRemovendo(chave);
    const ok = await executar();
    setRemovendo(null);
    if (!ok) {
      setErroAcao("Não foi possível remover esta ferramenta agora.");
      return;
    }
    setVersao((v) => v + 1);
  }

  const removerPack = (packId: string) => remover(`pack:${packId}`, async () =>
    (await removerPackDoAgente(agente.id, packId)).estado === "ok");
  const removerExterna = (funcaoId: string) => remover(`externa:${funcaoId}`, async () =>
    (await desvincularFerramentaExterna(agente.id, funcaoId)).estado === "ok");

  return (
    <aside aria-labelledby={tituloId} className={estilos.painel}>
      <div className={estilos.painelCabecalho}>
        <span
          aria-hidden="true"
          className={
            aparencia.foraDeOperacao ? `${estilos.avatar} ${estilos.avatarApagado}` : estilos.avatar
          }
          style={{ "--ov1-avatar": CORES_TIPO[agente.tipo] } as CSSProperties}
        >
          {agente.nome.charAt(0).toUpperCase()}
        </span>
        <div className={estilos.painelIdentidade}>
          <h2 id={tituloId} className={estilos.painelNome}>
            {agente.nome}
          </h2>
          <StatusDoAgente aparencia={aparencia} grande />
        </div>
      </div>

      <div className={estilos.painelInfo}>
        <p>Tipo: {agente.tipo}</p>
        {atividade ? (
          <>
            <p className={estilos.atividade}>{atividade.titulo}</p>
            {atividade.progresso > 0 && (
              <div
                role="progressbar"
                aria-valuenow={atividade.progresso}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`Progresso: ${atividade.progresso} por cento`}
                className={estilos.progresso}
              >
                <div className={estilos.progressoBarra} style={{ width: `${atividade.progresso}%` }} />
              </div>
            )}
          </>
        ) : null}
      </div>

      {contexto !== null && contexto.href !== "" && (
        <Link href={contexto.href} className={`${estilos.botao} ${estilos.botaoContexto}`}>
          {contexto.rotulo}
          <span aria-hidden="true">→</span>
        </Link>
      )}

      <div className={estilos.acoes}>
        <Link href={configurar} className={`${estilos.botao} ${estilos.botaoLargo}`}>
          <span aria-hidden="true">⚙</span>
          Configurar agente
        </Link>
      </div>

      <section aria-labelledby={`${tituloId}-ferramentas`} className={estilos.ferramentas}>
        <div className={estilos.ferramentasCabecalho}>
          <h3 id={`${tituloId}-ferramentas`} className={estilos.ferramentasTitulo}>
            Ferramentas do agente
          </h3>
          <button
            type="button"
            onClick={() => setGerenciar(true)}
            aria-label="Gerenciar ferramentas do agente"
            title="Gerenciar ferramentas"
            className={`${estilos.botao} ${estilos.botaoQuadrado}`}
          >
            <span aria-hidden="true">+</span>
          </button>
        </div>

        {erroAcao !== null && <p className={estilos.erro} role="alert">{erroAcao}</p>}

        {leitura.estado === "carregando" ? (
          <p className={estilos.textoFraco} role="status">
            Carregando ferramentas…
          </p>
        ) : leitura.estado === "falha" ? (
          <p className={estilos.erro} role="alert">
            {leitura.mensagem}
          </p>
        ) : leitura.ferramentas.length === 0 && leitura.externas.length === 0 ? (
          <p className={estilos.textoFraco}>Nenhuma ferramenta configurada para este agente.</p>
        ) : (
          <ul className={estilos.ferramentasLista}>
            {leitura.ferramentas.map((f) => {
              const descricao = packPorId(f.id)?.descricao ?? null;
              return (
                <li key={`pack:${f.id}`} className={estilos.ferramenta}>
                  <span aria-hidden="true" className={estilos.ferramentaIcone}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={iconeDoPack(f.id)} alt="" width={24} height={24} />
                  </span>
                  <div className={estilos.ferramentaTexto}>
                    <p className={estilos.ferramentaNome}>{f.nome}</p>
                    {descricao ? <p className={estilos.ferramentaDescricao}>{descricao}</p> : null}
                    <p className={estilos.ferramentaNivel}>{nivelDoPack(f)}</p>
                  </div>
                  <BotaoRemover
                    chave={`pack:${f.id}`} nome={f.nome}
                    confirmando={confirmando} removendo={removendo}
                    aoClicar={() => void removerPack(f.id)}
                    aoSair={() => setConfirmando((c) => (c === `pack:${f.id}` ? null : c))}
                  />
                </li>
              );
            })}
            {leitura.externas.map((e) => {
              const nome = e.toolkit && e.acao ? `${e.toolkit} · ${e.acao}` : e.funcaoId;
              return (
                <li key={`externa:${e.funcaoId}`} className={estilos.ferramenta}>
                  <span aria-hidden="true" className={estilos.ferramentaIcone}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={ICONE_ACAO_EXTERNA} alt="" width={24} height={24} />
                  </span>
                  <div className={estilos.ferramentaTexto}>
                    <p className={estilos.ferramentaNome}>{nome}</p>
                    <p className={estilos.ferramentaDescricao}>Ação externa vinculada</p>
                    <p className={estilos.ferramentaNivel}>
                      {rotuloDoNivel(e.nivel) ?? "Nível ainda não decidido"}
                    </p>
                  </div>
                  <BotaoRemover
                    chave={`externa:${e.funcaoId}`} nome={nome}
                    confirmando={confirmando} removendo={removendo}
                    aoClicar={() => void removerExterna(e.funcaoId)}
                    aoSair={() => setConfirmando((c) => (c === `externa:${e.funcaoId}` ? null : c))}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* O MESMO contrato do Wizard: BuscaDeFerramentas + adicionarPackAoAgente. */}
      <GerenciarFerramentas
        agenteId={agente.id}
        aberto={gerenciar}
        aoFechar={() => setGerenciar(false)}
        packSelecionado={(chave) =>
          leitura.estado === "ok" && leitura.ferramentas.some((f) => f.id === chave)}
        aoMudar={() => setVersao((v) => v + 1)}
      />
    </aside>
  );
}

/** A acao discreta de remover: aparece no hover/foco; o 2o clique confirma. */
function BotaoRemover({
  chave, nome, confirmando, removendo, aoClicar, aoSair,
}: {
  chave: string;
  nome: string;
  confirmando: string | null;
  removendo: string | null;
  aoClicar: () => void;
  aoSair: () => void;
}) {
  const pedindo = confirmando === chave;
  return (
    <button
      type="button"
      onClick={aoClicar}
      onBlur={aoSair}
      disabled={removendo !== null}
      aria-label={pedindo ? `Confirmar remoção de ${nome}` : `Remover ${nome}`}
      className={pedindo
        ? `${estilos.ferramentaRemover} ${estilos.ferramentaRemoverConfirmar}`
        : estilos.ferramentaRemover}
    >
      {removendo === chave ? "…" : pedindo ? "Remover?" : "✕"}
    </button>
  );
}
