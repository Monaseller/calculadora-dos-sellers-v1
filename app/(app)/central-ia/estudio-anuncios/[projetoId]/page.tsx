"use client";

/**
 * Estúdio de Anúncios — Detalhe do Projeto Mestre.
 *
 * AJUSTE (2026-08-06 — UI do Projeto Mestre): substitui o placeholder
 * da Fase 0. Usa EXCLUSIVAMENTE GET /api/estudio-anuncios/projetos/[id]
 * (rota já existente, enriquecida com pipeline/jobs).
 *
 * AJUSTE (2026-08-07 — iniciar/acompanhar Pipeline com Gateway fake):
 * adiciona botão "Iniciar geração" (POST .../pipeline/iniciar, rota
 * nova), polling automático a cada 3s enquanto o Pipeline estiver
 * aguardando/em_execucao (reusando o MESMO GET acima — nenhum endpoint
 * de status separado foi criado), cálculo de progresso 100% client-side
 * (nunca gravado no banco) e mapeamento de status técnicos para texto
 * amigável. Nada aqui chama Worker, Gateway ou RPC diretamente — só a
 * nova rota interna do Next (.../pipeline/iniciar), que por sua vez
 * chama a RPC atômica.
 *
 * AJUSTE (2026-08-19 — UI de resultado): adiciona os blocos de
 * RESULTADO (score, conteúdo, revisão, marketplaces, imagens, análise
 * visual e custos), lendo do MESMO GET já usado aqui — nenhum endpoint
 * paralelo, nenhum fetch novo, nenhuma query Supabase no client. O
 * monitoramento existente (pipeline, progresso, jobs, fotos, polling) foi
 * preservado inteiro e passou a ficar ABAIXO do resultado: negócio
 * primeiro, técnico depois. Cada bloco é independente — etapa sem
 * artefato mostra "Resultado ainda não disponível" sem quebrar o resto,
 * então a tela funciona com o Pipeline parcial, ausente ou em erro.
 *
 * AJUSTE (2026-08-08 — Upload real da foto do produto): adiciona um
 * cartão "Fotos do produto", só leitura, exibindo as fotos já
 * enviadas via URL assinada (vinda do GET enriquecido — nenhuma URL
 * pública, nunca gerada/persistida aqui). Upload de novas fotos a
 * partir desta tela é fora de escopo desta tarefa (o envio acontece
 * na tela de criação do projeto).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BlocoScore,
  BlocoConteudo,
  BlocoRevisao,
  BlocoImagens,
  BlocoAnaliseVisual,
  BlocoCustos,
  type ResultadoProjetoDTO,
} from "./ResultadoProjeto";
import { DirecaoCriativa } from "./DirecaoCriativa";
import { BlocoEditorial, type CanalEditorialDTO } from "./EditorConteudo";
import { BlocoExportacao, type PacoteExportacaoDTO } from "./PacotesExportacao";
import { BlocoPrePublicacao, type ComplianceDTO } from "./PrePublicacao";
import type { PublicacaoCanalDTO } from "./DadosPublicacao";
import type { ValidacaoOficialDTO } from "./ValidacaoOficial";

interface Adaptacao {
  id: string;
  marketplace: string;
  status: string;
}

interface ProjetoDetalhe {
  id: string;
  nome_produto: string;
  modo: string;
  quantidade_imagens_solicitada: number;
  estilo?: string | null;
  direcao_criativa?: string | null;
  direcoes_imagens?: string[] | null;
  permitir_busca_externa: boolean;
  status: string;
  criado_em: string;
  atualizado_em: string;
  concluido_em?: string | null;
  cancelado_em?: string | null;
  adaptacoes: Adaptacao[];
  marketplaces: string[];
}

interface PipelineDetalhe {
  id: string;
  status: string;
  etapaAtual: string;
  jobAtualId: string | null;
  versaoPipeline: number;
  versaoCatalogo: number;
  ultimaExecucao: string | null;
  proximaExecucao: string | null;
  criadoEm: string;
  atualizadoEm: string;
  concluidoEm: string | null;
  canceladoEm: string | null;
  erroTipo: string | null;
  erroMensagem: string | null;
}

interface FotoDetalhe {
  id: string;
  ordem: number;
  principal: boolean;
  mimeType: string | null;
  tamanhoBytes: number | null;
  largura: number | null;
  altura: number | null;
  urlAssinada: string | null;
}

interface JobDetalhe {
  id: string;
  ordem: number;
  etapa: string;
  status: string;
  tentativas: number;
  maxTentativas: number;
  provedor: string | null;
  criadoEm: string;
  iniciadoEm: string | null;
  concluidoEm: string | null;
  erroTipo: string | null;
  erroMensagem: string | null;
}

// Fluxo esperado da Fase 1 (sequencial, só etapas obrigatórias) — usado
// SÓ para calcular progresso na UI. Não é lido do catálogo porque o
// cálculo é puramente visual (task explícita: "não gravar progresso no
// banco, é apenas cálculo da UI").
//
// AVISO (2026-08-07, sinalizado explicitamente pelo usuário — "CUIDADO
// COM O PROGRESSO"): esta lista fixa de 7 etapas é aceita SÓ para a
// Fase 1 fake (Gateway fake, sem quantidade variável de imagens/vídeo
// reais). Ela NÃO reflete quantidade_imagens_solicitada do projeto nem
// geração de vídeo condicional. Quando a Fase 2 (APIs reais) chegar,
// isto precisa ser substituído por um progresso DERIVADO DO CATÁLOGO
// (estudio_anuncios_pipeline_catalogo/_catalogo_jobs) + da quantidade
// real de imagens/vídeos do projeto — não por esta constante hardcoded.
// Não alterado nesta tarefa por instrução explícita ("Não alterar isso
// nesta tarefa").
const ETAPAS_ESPERADAS = [
  "analise_visual",
  "geracao_conteudo",
  "revisao_claude",
  "adaptacao_marketplace",
  "geracao_prompts_imagem",
  "geracao_imagem",
  "calculo_score",
];

const PIPELINE_STATUS_LABEL: Record<string, string> = {
  criado: "Criado",
  aguardando: "Aguardando processamento",
  em_execucao: "Processando",
  aguardando_pendencias: "Aguardando informações",
  concluido: "Concluído",
  erro: "Erro",
  cancelado: "Cancelado",
  pausado: "Pausado",
};

const JOB_STATUS_LABEL: Record<string, string> = {
  pendente: "Aguardando",
  rodando: "Em execução",
  concluido: "Concluído",
  erro: "Erro",
};

// Status de Pipeline em que o polling continua rodando — parar em
// qualquer outro (concluido, cancelado, erro, pausado,
// aguardando_pendencias, e também 'criado', que nunca deveria persistir
// sozinho, mas por segurança não gera polling).
const POLLING_ATIVO = new Set(["aguardando", "em_execucao"]);

// Limiar (ms) para o aviso discreto de fila longa — não especificado
// pela tarefa, valor arbitrário escolhido aqui: 30s sem
// ultima_execucao avançar com o pipeline ainda "aguardando".
const LIMIAR_AVISO_FILA_MS = 30_000;

const STATUS_CORES: Record<string, { cor: string; bg: string; border: string }> = {
  concluido: { cor: "#00D97E", bg: "rgba(0,217,126,0.12)", border: "rgba(0,217,126,0.35)" },
  erro_parcial: { cor: "#ff6b6b", bg: "rgba(255,80,80,0.12)", border: "rgba(255,80,80,0.35)" },
  erro: { cor: "#ff6b6b", bg: "rgba(255,80,80,0.12)", border: "rgba(255,80,80,0.35)" },
  cancelado: { cor: "#9099aa", bg: "rgba(144,153,170,0.12)", border: "rgba(144,153,170,0.3)" },
  rodando: { cor: "#6fa3ff", bg: "rgba(111,163,255,0.12)", border: "rgba(111,163,255,0.35)" },
  em_execucao: { cor: "#6fa3ff", bg: "rgba(111,163,255,0.12)", border: "rgba(111,163,255,0.35)" },
  pendente: { cor: "#9099aa", bg: "rgba(144,153,170,0.1)", border: "rgba(144,153,170,0.25)" },
  pausado: { cor: "#FFD166", bg: "rgba(255,209,102,0.12)", border: "rgba(255,209,102,0.35)" },
};

function corStatus(status: string) {
  return STATUS_CORES[status] ?? { cor: "#FFB600", bg: "rgba(255,182,0,0.12)", border: "rgba(255,182,0,0.35)" };
}

function Badge({ status, tipo = "job" }: { status: string; tipo?: "pipeline" | "job" }) {
  const cores = corStatus(status);
  const label = tipo === "pipeline" ? (PIPELINE_STATUS_LABEL[status] ?? status) : (JOB_STATUS_LABEL[status] ?? status);
  return (
    <span title={status} style={{
      fontSize: "11px", fontWeight: 700, padding: "3px 10px", borderRadius: "6px",
      color: cores.cor, background: cores.bg, border: `1px solid ${cores.border}`, whiteSpace: "nowrap",
    }}>
      {label}
    </span>
  );
}

function formatarData(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatarHora(data: Date | null) {
  if (!data) return "—";
  return data.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function Campo({ label, valor }: { label: string; valor: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: "11px", fontWeight: 700, color: "#9099aa", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "4px" }}>
        {label}
      </div>
      <div style={{ fontSize: "14px", color: "#fff" }}>{valor}</div>
    </div>
  );
}

function Cartao({ titulo, acao, children }: { titulo: string; acao?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{
      background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: "16px", padding: "24px", marginBottom: "20px",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "18px" }}>
        <h2 style={{ fontSize: "15px", fontWeight: 800, color: "#fff", margin: 0 }}>{titulo}</h2>
        {acao}
      </div>
      {children}
    </div>
  );
}

function calcularProgresso(jobs: JobDetalhe[]) {
  const total = ETAPAS_ESPERADAS.length;
  // CORREÇÃO (2026-08-19, achada na validação real da UI): um projeto
  // pode ter MAIS jobs concluídos que etapas (retentativa, regeração), e
  // a tela exibia "8 de 7 etapas concluídas". O clamp é só de EXIBIÇÃO —
  // a derivação continua client-side e continua usando a lista fixa da
  // Fase 1, cuja substituição por um progresso derivado do catálogo segue
  // registrada como dívida no comentário de ETAPAS_ESPERADAS.
  const concluidosBrutos = jobs.filter(j => j.status === "concluido").length;
  const concluidos = Math.min(concluidosBrutos, total);
  const percentual = total > 0 ? Math.min(100, Math.round((concluidos / total) * 100)) : 0;
  const jobAtual = jobs.find(j => j.status === "rodando") ?? jobs.find(j => j.status === "pendente") ?? null;
  const proximaEtapaEsperada = ETAPAS_ESPERADAS[concluidosBrutos] ?? null;
  return { total, concluidos, percentual, jobAtual, proximaEtapaEsperada };
}

export default function EstudioAnunciosProjetoPage({ params }: { params: { projetoId: string } }) {
  const router = useRouter();
  const [projeto, setProjeto] = useState<ProjetoDetalhe | null>(null);
  const [pipeline, setPipeline] = useState<PipelineDetalhe | null>(null);
  const [jobs, setJobs] = useState<JobDetalhe[]>([]);
  const [fotos, setFotos] = useState<FotoDetalhe[]>([]);
  const [resultado, setResultado] = useState<ResultadoProjetoDTO | null>(null);
  const [editorial, setEditorial] = useState<CanalEditorialDTO[]>([]);
  const [exportacao, setExportacao] = useState<PacoteExportacaoDTO[]>([]);
  const [compliance, setCompliance] = useState<ComplianceDTO[]>([]);
  const [publicacao, setPublicacao] = useState<PublicacaoCanalDTO[]>([]);
  const [validacaoOficial, setValidacaoOficial] = useState<ValidacaoOficialDTO[]>([]);
  const [publicacoes, setPublicacoes] = useState<any[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [ultimaAtualizacao, setUltimaAtualizacao] = useState<Date | null>(null);

  const [iniciando, setIniciando] = useState(false);
  const [erroIniciar, setErroIniciar] = useState<string | null>(null);

  const isFetchingRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const buscarDados = useCallback(async (silencioso = false) => {
    // Evita requisições sobrepostas (polling nunca inicia um novo fetch
    // enquanto o anterior ainda está em andamento).
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    if (!silencioso) setCarregando(true);
    try {
      const res = await fetch(`/api/estudio-anuncios/projetos/${params.projetoId}`);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErro(data.erro || "Não foi possível carregar o projeto.");
        return;
      }
      setProjeto(data.projeto);
      setPipeline(data.pipeline);
      setJobs(data.jobs ?? []);
      setFotos(data.fotos ?? []);
      setResultado(data.resultado ?? null);
      setEditorial(data.editorial ?? []);
      setExportacao(data.exportacao ?? []);
      setCompliance(data.compliance ?? []);
      setPublicacao(data.publicacao ?? []);
      setValidacaoOficial(data.validacaoOficial ?? []);
      setPublicacoes(data.publicacoes ?? []);
      setErro(null);
      setUltimaAtualizacao(new Date());
    } catch {
      setErro("Falha de conexão ao carregar o projeto.");
    } finally {
      isFetchingRef.current = false;
      setCarregando(false);
    }
  }, [params.projetoId]);

  // Carga inicial.
  useEffect(() => {
    buscarDados();
  }, [buscarDados]);

  // Polling — só enquanto Pipeline existir e estiver em
  // aguardando/em_execucao; limpa o timer ao desmontar ou quando o
  // status muda para fora dessa lista; pausa quando a aba está oculta.
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (!pipeline || !POLLING_ATIVO.has(pipeline.status)) return;

    intervalRef.current = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      buscarDados(true);
    }, 3000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [pipeline?.status, buscarDados]);

  async function iniciarGeracao() {
    setIniciando(true);
    setErroIniciar(null);
    try {
      const res = await fetch(`/api/estudio-anuncios/projetos/${params.projetoId}/pipeline/iniciar`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErroIniciar(data.erro || "Não foi possível iniciar a geração.");
        setIniciando(false);
        return;
      }
      await buscarDados();
      setIniciando(false);
    } catch {
      setErroIniciar("Falha de conexão ao iniciar a geração.");
      setIniciando(false);
    }
  }

  if (carregando && !projeto) {
    return (
      <div style={{ padding: "32px", maxWidth: "1000px", margin: "0 auto", color: "#9099aa", fontSize: "14px", textAlign: "center" }}>
        Carregando projeto...
      </div>
    );
  }

  if (erro && !projeto) {
    return (
      <div style={{ padding: "32px", maxWidth: "1000px", margin: "0 auto" }}>
        <div style={{
          background: "rgba(255,80,80,0.08)", border: "1px solid rgba(255,80,80,0.3)",
          borderRadius: "10px", padding: "16px 20px", color: "#ff6b6b", fontSize: "14px", fontWeight: 600, marginBottom: "20px",
        }}>
          {erro}
        </div>
        <button
          type="button"
          onClick={() => router.push("/central-ia/estudio-anuncios")}
          style={{
            padding: "10px 20px", borderRadius: "10px", border: "1px solid rgba(255,255,255,0.1)",
            background: "transparent", color: "#9099aa", fontWeight: 700, fontSize: "13px", cursor: "pointer",
          }}
        >
          ← Voltar para a lista
        </button>
      </div>
    );
  }

  if (!projeto) return null;

  const podeIniciar = !pipeline && projeto.status !== "cancelado" && projeto.status !== "concluido";
  const semFotos = fotos.length === 0;
  const progresso = calcularProgresso(jobs);
  const aguardandoHaMuitoTempo =
    !!pipeline &&
    pipeline.status === "aguardando" &&
    !!pipeline.ultimaExecucao &&
    Date.now() - new Date(pipeline.ultimaExecucao).getTime() > LIMIAR_AVISO_FILA_MS;

  return (
    <div style={{ padding: "32px", maxWidth: "1000px", margin: "0 auto" }}>
      <button
        type="button"
        onClick={() => router.push("/central-ia/estudio-anuncios")}
        style={{ background: "none", border: "none", color: "#9099aa", fontSize: "13px", fontWeight: 600, cursor: "pointer", padding: 0, marginBottom: "16px" }}
      >
        ← Voltar para a lista
      </button>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginBottom: "28px", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", minWidth: 0, flex: "1 1 240px" }}>
          {/* overflowWrap/minWidth (2026-08-19): nome de produto sem espaço
              (ex.: "TESTE_..._20260814") não quebra sozinho e estourava a
              largura em 375px. */}
          <h1 style={{ fontSize: "24px", fontWeight: 900, color: "#fff", margin: 0, overflowWrap: "anywhere", minWidth: 0 }}>{projeto.nome_produto}</h1>
          <Badge status={projeto.status} />
        </div>

        {podeIniciar && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "6px" }}>
            <button
              type="button"
              onClick={iniciarGeracao}
              disabled={iniciando || semFotos}
              title={semFotos ? "Adicione pelo menos uma foto do produto para iniciar a geração." : undefined}
              style={{
                padding: "10px 24px", borderRadius: "10px", border: "none",
                background: (iniciando || semFotos) ? "rgba(255,182,0,0.3)" : "linear-gradient(135deg, #FFB600 0%, #FF6B00 100%)",
                color: "#000", fontWeight: 800, fontSize: "14px", cursor: (iniciando || semFotos) ? "not-allowed" : "pointer",
              }}
            >
              {iniciando ? "Iniciando..." : "Iniciar geração"}
            </button>
            {semFotos && (
              <span style={{ fontSize: "12px", color: "#9099aa", fontWeight: 600 }}>
                Adicione pelo menos uma foto do produto para iniciar a geração.
              </span>
            )}
          </div>
        )}
      </div>

      {erroIniciar && (
        <div style={{
          background: "rgba(255,80,80,0.08)", border: "1px solid rgba(255,80,80,0.3)",
          borderRadius: "10px", padding: "12px 16px", color: "#ff6b6b",
          fontSize: "13px", fontWeight: 600, marginBottom: "20px",
        }}>
          {erroIniciar}
        </div>
      )}

      {erro && projeto && (
        <div style={{
          background: "rgba(255,80,80,0.08)", border: "1px solid rgba(255,80,80,0.3)",
          borderRadius: "10px", padding: "12px 16px", color: "#ff6b6b",
          fontSize: "13px", fontWeight: 600, marginBottom: "20px",
        }}>
          {erro} — mostrando os últimos dados carregados.
        </div>
      )}

      <Cartao titulo="Dados do projeto">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "20px" }}>
          <Campo label="Modo" valor={projeto.modo} />
          <Campo label="Estilo visual" valor={projeto.estilo ?? "—"} />
          <Campo label="Quantidade de imagens" valor={projeto.quantidade_imagens_solicitada} />
          <Campo label="Marketplaces" valor={projeto.marketplaces.length > 0 ? projeto.marketplaces.join(", ") : "—"} />
          <Campo label="Criado em" valor={formatarData(projeto.criado_em)} />
          <Campo label="Última atualização" valor={formatarData(projeto.atualizado_em)} />
        </div>
      </Cartao>

      <Cartao titulo="Direção criativa das imagens">
        <DirecaoCriativa
          projetoId={projeto.id}
          quantidade={projeto.quantidade_imagens_solicitada}
          direcaoInicial={projeto.direcao_criativa ?? null}
          direcoesInicial={projeto.direcoes_imagens ?? null}
          // Depois que o pipeline existe, o planejamento já foi feito
          // (ou está em curso) — editar aqui não mudaria nada.
          editavel={!pipeline && projeto.status !== "cancelado" && projeto.status !== "concluido"}
          onSalvo={() => buscarDados(true)}
        />
      </Cartao>

      <Cartao
        titulo="Pipeline"
        acao={
          pipeline && (
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span style={{ fontSize: "11px", color: "#9099aa" }}>
                Atualizado às {formatarHora(ultimaAtualizacao)}
              </span>
              <button
                type="button"
                onClick={() => buscarDados()}
                style={{
                  padding: "6px 14px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.1)",
                  background: "rgba(255,255,255,0.04)", color: "#fff", fontWeight: 700, fontSize: "12px", cursor: "pointer",
                }}
              >
                Atualizar
              </button>
            </div>
          )
        }
      >
        {pipeline ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "20px", marginBottom: "20px" }}>
              <Campo label="Etapa atual" valor={pipeline.etapaAtual} />
              <Campo label="Status" valor={<Badge status={pipeline.status} tipo="pipeline" />} />
              <Campo label="Versão do pipeline" valor={pipeline.versaoPipeline} />
              <Campo label="Versão do catálogo" valor={pipeline.versaoCatalogo} />
              <Campo label="Job atual" valor={pipeline.jobAtualId ?? "—"} />
            </div>

            {/* Progresso — cálculo 100% client-side, nunca gravado no banco. */}
            <div style={{ marginBottom: aguardandoHaMuitoTempo ? "16px" : 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "#9099aa", marginBottom: "6px" }}>
                <span>{progresso.concluidos} de {progresso.total} etapas concluídas</span>
                <span>{progresso.percentual}%</span>
              </div>
              <div style={{ height: "8px", borderRadius: "999px", background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
                <div style={{
                  height: "100%", width: `${progresso.percentual}%`,
                  background: "linear-gradient(135deg, #FFB600 0%, #FF6B00 100%)",
                  transition: "width 0.3s ease",
                }} />
              </div>
              <div style={{ display: "flex", gap: "20px", fontSize: "12px", color: "#9099aa", marginTop: "8px", flexWrap: "wrap" }}>
                <span>Job atual: {progresso.jobAtual ? (JOB_STATUS_LABEL[progresso.jobAtual.status] ?? progresso.jobAtual.status) + " — " + progresso.jobAtual.etapa : "—"}</span>
                <span>Próxima etapa esperada: {progresso.proximaEtapaEsperada ?? "nenhuma (fluxo concluído)"}</span>
              </div>
            </div>

            {aguardandoHaMuitoTempo && (
              <div style={{
                background: "rgba(255,182,0,0.08)", border: "1px solid rgba(255,182,0,0.25)",
                borderRadius: "10px", padding: "10px 14px", color: "#FFB600", fontSize: "12px", fontWeight: 600,
              }}>
                A geração foi enfileirada e aguarda o processador da Central de IA.
              </div>
            )}
          </>
        ) : (
          <p style={{ fontSize: "13px", color: "#9099aa", margin: 0 }}>
            Este projeto ainda não tem um Pipeline associado.
            {podeIniciar && " Clique em \"Iniciar geração\" para começar."}
          </p>
        )}
      </Cartao>

      {/* ── RESULTADO ─────────────────────────────────────────────────
          Negócio primeiro, técnico depois. Cada bloco é independente:
          etapa sem artefato mostra "ainda não disponível" e o resto da
          tela continua funcionando (Pipeline parcial, ausente ou em
          erro). Nada aqui recalcula nada — só apresenta o persistido. */}
      <BlocoScore score={resultado?.score ?? null} />
      <BlocoConteudo conteudo={resultado?.conteudo ?? null} />
      <BlocoRevisao revisao={resultado?.revisao ?? null} />
      {/* A camada editorial substitui o bloco somente-leitura de
          marketplaces: ela ja mostra o conteudo (da IA ou da versao
          editorial) e adiciona editar/aprovar/historico por cima. */}
      <BlocoEditorial canais={editorial} projetoId={params.projetoId} onMudou={() => buscarDados(true)} />

      <BlocoExportacao
        pacotes={exportacao}
        podeExportar={editorial.some(c => c.versaoAprovada !== null)}
        projetoId={params.projetoId}
        onMudou={() => buscarDados(true)}
      />

      {/* Pre-publicacao (2026-08-23): vem DEPOIS de editorial e exportacao
          porque so faz sentido perguntar "da para publicar?" sobre um
          conteudo ja aprovado. Nao publica nada. */}
      <BlocoPrePublicacao
        marketplaces={projeto.marketplaces}
        compliance={compliance}
        publicacao={publicacao}
        validacaoOficial={validacaoOficial}
        publicacoes={publicacoes}
        projetoId={params.projetoId}
        onMudou={() => buscarDados(true)}
      />

      <BlocoImagens imagens={resultado?.imagens ?? []} />
      <BlocoAnaliseVisual analise={resultado?.analiseVisual ?? null} />

      <Cartao titulo="Fotos do produto">
        {fotos.length === 0 ? (
          <p style={{ fontSize: "13px", color: "#9099aa", margin: 0 }}>Nenhuma foto enviada para este projeto.</p>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "14px" }}>
            {fotos.map(foto => (
              <div key={foto.id} style={{ position: "relative", width: "120px" }}>
                <div style={{
                  width: "120px", height: "120px", borderRadius: "12px", overflow: "hidden",
                  background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
                  display: "grid", placeItems: "center",
                }}>
                  {foto.urlAssinada ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={foto.urlAssinada} alt={`Foto ${foto.ordem}`} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <span style={{ fontSize: "11px", color: "#9099aa" }}>URL indisponível</span>
                  )}
                </div>
                {foto.principal && (
                  <span style={{
                    position: "absolute", top: "6px", left: "6px", background: "#FFB600", color: "#000",
                    fontSize: "9px", fontWeight: 800, padding: "2px 6px", borderRadius: "6px",
                  }}>
                    Principal
                  </span>
                )}
                <div style={{ fontSize: "11px", color: "#9099aa", marginTop: "6px" }}>
                  {foto.largura && foto.altura ? `${foto.largura}×${foto.altura}px` : "dimensões n/d"}
                  {foto.tamanhoBytes ? ` · ${(foto.tamanhoBytes / (1024 * 1024)).toFixed(1)}MB` : ""}
                </div>
              </div>
            ))}
          </div>
        )}
      </Cartao>

      <BlocoCustos custos={resultado?.custos ?? { totalEstimadoUsd: 0, porEtapa: [], temModeloSemPreco: false }} />

      <Cartao titulo="Histórico técnico (jobs)">
        {jobs.length === 0 ? (
          <p style={{ fontSize: "13px", color: "#9099aa", margin: 0 }}>Nenhum job registrado para este projeto.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#9099aa", textTransform: "uppercase", letterSpacing: "0.5px", fontSize: "10px" }}>
                  <th style={{ padding: "8px 10px" }}>Ordem</th>
                  <th style={{ padding: "8px 10px" }}>Etapa</th>
                  <th style={{ padding: "8px 10px" }}>Status</th>
                  <th style={{ padding: "8px 10px" }}>Tentativas</th>
                  <th style={{ padding: "8px 10px" }}>Provedor</th>
                  <th style={{ padding: "8px 10px" }}>Criado em</th>
                  <th style={{ padding: "8px 10px" }}>Iniciado em</th>
                  <th style={{ padding: "8px 10px" }}>Concluído em</th>
                  <th style={{ padding: "8px 10px" }}>Erro</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map(job => (
                  <tr key={job.id} style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                    <td style={{ padding: "10px", color: "#fff" }}>{job.ordem}</td>
                    <td style={{ padding: "10px", color: "#fff" }}>{job.etapa}</td>
                    <td style={{ padding: "10px" }}><Badge status={job.status} tipo="job" /></td>
                    <td style={{ padding: "10px", color: "#fff" }}>{job.tentativas}/{job.maxTentativas}</td>
                    <td style={{ padding: "10px", color: "#fff" }}>{job.provedor ?? "—"}</td>
                    <td style={{ padding: "10px", color: "#9099aa" }}>{formatarData(job.criadoEm)}</td>
                    <td style={{ padding: "10px", color: "#9099aa" }}>{formatarData(job.iniciadoEm)}</td>
                    <td style={{ padding: "10px", color: "#9099aa" }}>{formatarData(job.concluidoEm)}</td>
                    <td style={{ padding: "10px", color: job.erroMensagem ? "#ff6b6b" : "#9099aa", maxWidth: "220px" }}>
                      {job.erroMensagem ? `${job.erroTipo ?? ""}: ${job.erroMensagem}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Cartao>
    </div>
  );
}
