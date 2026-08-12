"use client";

/**
 * Camada EDITORIAL da tela de detalhe — leitura, edição e aprovação do
 * conteúdo por marketplace (2026-08-20).
 *
 * Substitui o bloco somente-leitura de marketplaces, preservando a
 * visualização anterior: por padrão a tela continua em modo leitura, e o
 * modo edição só entra por ação explícita.
 *
 * O que este arquivo NÃO faz: publicar, exportar, regenerar, recalcular
 * score, mexer em imagens ou reabrir Pipeline. Aprovar significa apenas
 * "esta versão foi aprovada para uso".
 *
 * Nenhuma query Supabase sai daqui — só POST nas duas rotas dedicadas.
 * A recarga dos dados é responsabilidade da página, pelo mesmo GET que
 * ela já usa.
 */
import { useState } from "react";

export interface ConteudoEditorialDTO {
  titulo: string;
  descricao: string;
  bullets: string[];
  especificacoes: { nome: string; valor: string }[];
  cta?: string;
}

export interface VersaoEditorialDTO {
  id: string;
  numeroVersao: number;
  origem: string;
  conteudo: ConteudoEditorialDTO;
  aprovado: boolean;
  aprovadoEm: string | null;
  aprovadoPor: string | null;
  criadoEm: string;
  criadoPor: string | null;
  resultadoPipelineOrigemId: string | null;
}

export interface CanalEditorialDTO {
  marketplace: string;
  projetoMarketplaceId: string;
  baseIA: ConteudoEditorialDTO | null;
  baseResultadoId: string | null;
  versaoAtual: VersaoEditorialDTO | null;
  versaoAprovada: VersaoEditorialDTO | null;
  historico: VersaoEditorialDTO[];
  editavel: boolean;
}

const ROTULO_ORIGEM: Record<string, string> = {
  ia_adaptacao_marketplace: "Gerado pela IA",
  edicao_manual: "Editado manualmente",
  ia_openai: "Gerado pela IA",
  revisao_claude: "Revisado pela IA",
};

function Cartao({ titulo, acao, children }: { titulo: string; acao?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "16px", padding: "24px", marginBottom: "20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "18px", flexWrap: "wrap" }}>
        <h2 style={{ fontSize: "15px", fontWeight: 800, color: "#fff", margin: 0 }}>{titulo}</h2>
        {acao}
      </div>
      {children}
    </div>
  );
}

function Rotulo({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: "11px", fontWeight: 700, color: "#9099aa", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "6px" }}>
      {children}
    </div>
  );
}

function Selo({ texto, cor }: { texto: string; cor: string }) {
  return (
    <span style={{ fontSize: "10px", fontWeight: 800, color: cor, background: `${cor}1f`, border: `1px solid ${cor}55`, borderRadius: "6px", padding: "3px 8px", textTransform: "uppercase", letterSpacing: "0.4px", whiteSpace: "nowrap" }}>
      {texto}
    </span>
  );
}

const estiloInput: React.CSSProperties = {
  width: "100%", padding: "10px 12px", borderRadius: "9px",
  border: "1px solid rgba(255,255,255,0.12)", background: "rgba(0,0,0,0.25)",
  color: "#fff", fontSize: "13px", fontFamily: "inherit", lineHeight: 1.6, boxSizing: "border-box",
};
const estiloBotao = (primario: boolean, desabilitado = false): React.CSSProperties => ({
  padding: "9px 18px", borderRadius: "9px", fontSize: "13px", fontWeight: 800,
  cursor: desabilitado ? "not-allowed" : "pointer",
  border: primario ? "none" : "1px solid rgba(255,255,255,0.12)",
  background: primario ? (desabilitado ? "rgba(255,182,0,0.3)" : "linear-gradient(135deg, #FFB600 0%, #FF6B00 100%)") : "rgba(255,255,255,0.04)",
  color: primario ? "#000" : "#9099aa",
  opacity: desabilitado && !primario ? 0.5 : 1,
});

function formatarData(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function LeituraConteudo({ c }: { c: ConteudoEditorialDTO }) {
  return (
    <>
      <div style={{ marginBottom: "16px" }}>
        <Rotulo>Título</Rotulo>
        <div style={{ fontSize: "15px", fontWeight: 700, color: "#fff", lineHeight: 1.4 }}>{c.titulo}</div>
      </div>
      {c.bullets.length > 0 && (
        <div style={{ marginBottom: "16px" }}>
          <Rotulo>Destaques</Rotulo>
          <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "13px", color: "#d6dae2", lineHeight: 1.8 }}>
            {c.bullets.map((b, i) => <li key={i}>{b}</li>)}
          </ul>
        </div>
      )}
      <div style={{ marginBottom: "16px" }}>
        <Rotulo>Descrição</Rotulo>
        <div style={{ fontSize: "13px", color: "#d6dae2", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{c.descricao}</div>
      </div>
      {c.especificacoes.length > 0 && (
        <div style={{ marginBottom: "16px" }}>
          <Rotulo>Especificações</Rotulo>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "8px" }}>
            {c.especificacoes.map((e, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: "10px", fontSize: "13px", padding: "8px 12px", background: "rgba(255,255,255,0.03)", borderRadius: "8px" }}>
                <span style={{ color: "#9099aa" }}>{e.nome}</span>
                <span style={{ color: "#fff", fontWeight: 600, textAlign: "right" }}>{e.valor}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {c.cta && (
        <div>
          <Rotulo>Chamada</Rotulo>
          <div style={{ fontSize: "13px", color: "#FFB600", fontWeight: 700 }}>{c.cta}</div>
        </div>
      )}
    </>
  );
}

function Editor({
  inicial, salvando, erro, onSalvar, onCancelar,
}: {
  inicial: ConteudoEditorialDTO;
  salvando: boolean;
  erro: string | null;
  onSalvar: (c: ConteudoEditorialDTO) => void;
  onCancelar: () => void;
}) {
  // Estado local: cancelar simplesmente descarta, sem gravar nada.
  const [titulo, setTitulo] = useState(inicial.titulo);
  const [descricao, setDescricao] = useState(inicial.descricao);
  const [bullets, setBullets] = useState<string[]>(inicial.bullets.length ? [...inicial.bullets] : [""]);
  const [especs, setEspecs] = useState(inicial.especificacoes.length ? inicial.especificacoes.map(e => ({ ...e })) : [{ nome: "", valor: "" }]);

  return (
    <div>
      <div style={{ marginBottom: "16px" }}>
        <Rotulo>Título</Rotulo>
        <textarea value={titulo} onChange={e => setTitulo(e.target.value)} rows={2} style={estiloInput} />
      </div>

      <div style={{ marginBottom: "16px" }}>
        <Rotulo>Destaques</Rotulo>
        {bullets.map((b, i) => (
          <div key={i} style={{ display: "flex", gap: "8px", marginBottom: "8px", alignItems: "flex-start" }}>
            <textarea
              value={b} rows={2} style={estiloInput}
              onChange={e => setBullets(bs => bs.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <button type="button" onClick={() => setBullets(bs => bs.filter((_, j) => j !== i))}
              style={{ ...estiloBotao(false), padding: "9px 12px", flexShrink: 0 }} aria-label="Remover destaque">✕</button>
          </div>
        ))}
        <button type="button" onClick={() => setBullets(bs => [...bs, ""])} style={{ ...estiloBotao(false), fontSize: "12px" }}>
          + Adicionar destaque
        </button>
      </div>

      <div style={{ marginBottom: "16px" }}>
        <Rotulo>Descrição</Rotulo>
        <textarea value={descricao} onChange={e => setDescricao(e.target.value)} rows={8} style={estiloInput} />
      </div>

      <div style={{ marginBottom: "18px" }}>
        <Rotulo>Especificações</Rotulo>
        {/* Par nome/valor — o domínio é estruturado e continua estruturado. */}
        {especs.map((e, i) => (
          <div key={i} style={{ display: "flex", gap: "8px", marginBottom: "8px", flexWrap: "wrap" }}>
            <input value={e.nome} placeholder="Nome" style={{ ...estiloInput, flex: "1 1 140px", width: "auto" }}
              onChange={ev => setEspecs(es => es.map((x, j) => (j === i ? { ...x, nome: ev.target.value } : x)))} />
            <input value={e.valor} placeholder="Valor" style={{ ...estiloInput, flex: "2 1 180px", width: "auto" }}
              onChange={ev => setEspecs(es => es.map((x, j) => (j === i ? { ...x, valor: ev.target.value } : x)))} />
            <button type="button" onClick={() => setEspecs(es => es.filter((_, j) => j !== i))}
              style={{ ...estiloBotao(false), padding: "9px 12px", flexShrink: 0 }} aria-label="Remover especificação">✕</button>
          </div>
        ))}
        <button type="button" onClick={() => setEspecs(es => [...es, { nome: "", valor: "" }])} style={{ ...estiloBotao(false), fontSize: "12px" }}>
          + Adicionar especificação
        </button>
      </div>

      {erro && (
        <div style={{ background: "rgba(255,80,80,0.08)", border: "1px solid rgba(255,80,80,0.3)", borderRadius: "10px", padding: "10px 14px", color: "#ff6b6b", fontSize: "13px", fontWeight: 600, marginBottom: "14px" }}>
          {erro}
        </div>
      )}

      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={salvando}
          onClick={() => onSalvar({
            titulo, descricao,
            bullets: bullets.filter(b => b.trim().length > 0),
            especificacoes: especs.filter(e => e.nome.trim().length > 0 || e.valor.trim().length > 0),
            ...(inicial.cta ? { cta: inicial.cta } : {}),
          })}
          style={estiloBotao(true, salvando)}
        >
          {salvando ? "Salvando..." : "Salvar nova versão"}
        </button>
        <button type="button" onClick={onCancelar} disabled={salvando} style={estiloBotao(false, salvando)}>
          Cancelar
        </button>
      </div>
      <p style={{ fontSize: "11px", color: "#9099aa", margin: "10px 0 0" }}>
        Salvar cria uma nova versão — a anterior fica preservada no histórico. Aprovar é uma ação separada.
      </p>
    </div>
  );
}

export function BlocoEditorial({
  canais, projetoId, onMudou,
}: {
  canais: CanalEditorialDTO[];
  projetoId: string;
  onMudou: () => void | Promise<void>;
}) {
  const [ativo, setAtivo] = useState(0);
  const [editando, setEditando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [aprovando, setAprovando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [vendoVersao, setVendoVersao] = useState<string | null>(null);

  if (canais.length === 0) {
    return (
      <Cartao titulo="Conteúdo por marketplace">
        <p style={{ fontSize: "13px", color: "#9099aa", margin: 0 }}>Nenhum marketplace selecionado neste projeto.</p>
      </Cartao>
    );
  }

  const canal = canais[Math.min(ativo, canais.length - 1)];
  const versaoExibida = vendoVersao
    ? canal.historico.find(v => v.id === vendoVersao) ?? null
    : canal.versaoAtual;
  const conteudoExibido = versaoExibida?.conteudo ?? canal.baseIA;
  const historicoDaVersao = versaoExibida?.origem ?? "ia_adaptacao_marketplace";

  async function salvar(conteudo: ConteudoEditorialDTO) {
    setSalvando(true);
    setErro(null);
    try {
      const res = await fetch(
        `/api/estudio-anuncios/projetos/${projetoId}/conteudo/${encodeURIComponent(canal.marketplace)}/versoes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // requestId: protege contra duplo clique/retry de rede — o
          // servidor devolve a versão já criada em vez de criar outra.
          body: JSON.stringify({ conteudo, requestId: crypto.randomUUID() }),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErro(data.erro || "Não foi possível salvar.");
        return;
      }
      setEditando(false);
      setVendoVersao(null);
      await onMudou();
    } catch {
      setErro("Falha de conexão ao salvar.");
    } finally {
      setSalvando(false);
    }
  }

  async function aprovar(versaoId: string) {
    setAprovando(true);
    setErro(null);
    try {
      const res = await fetch(
        `/api/estudio-anuncios/projetos/${projetoId}/conteudo/${encodeURIComponent(canal.marketplace)}/aprovar`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ versaoId }) }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErro(data.erro || "Não foi possível aprovar.");
        return;
      }
      await onMudou();
    } catch {
      setErro("Falha de conexão ao aprovar.");
    } finally {
      setAprovando(false);
    }
  }

  return (
    <Cartao
      titulo="Conteúdo por marketplace"
      acao={
        !editando && canal.editavel && conteudoExibido && (
          <button type="button" onClick={() => { setEditando(true); setErro(null); }} style={estiloBotao(false)}>
            Editar conteúdo
          </button>
        )
      }
    >
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "18px" }}>
        {canais.map((c, i) => {
          const sel = i === Math.min(ativo, canais.length - 1);
          return (
            <button
              key={c.marketplace} type="button"
              onClick={() => { setAtivo(i); setEditando(false); setVendoVersao(null); setErro(null); }}
              style={{
                padding: "7px 16px", borderRadius: "9px", fontSize: "13px", fontWeight: 700, cursor: "pointer",
                border: sel ? "1px solid rgba(255,182,0,0.5)" : "1px solid rgba(255,255,255,0.1)",
                background: sel ? "rgba(255,182,0,0.14)" : "rgba(255,255,255,0.03)",
                color: sel ? "#FFB600" : "#9099aa",
              }}
            >
              {c.marketplace}
              {c.versaoAprovada && <span style={{ marginLeft: "6px", color: "#00D97E" }}>✓</span>}
            </button>
          );
        })}
      </div>

      {!canal.editavel || !conteudoExibido ? (
        <p style={{ fontSize: "13px", color: "#9099aa", margin: 0 }}>Conteúdo ainda não disponível.</p>
      ) : (
        <>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginBottom: "16px" }}>
            <Selo texto={ROTULO_ORIGEM[historicoDaVersao] ?? historicoDaVersao} cor={historicoDaVersao === "edicao_manual" ? "#6fa3ff" : "#9099aa"} />
            {versaoExibida
              ? <Selo texto={`Versão ${versaoExibida.numeroVersao}`} cor="#FFB600" />
              : <Selo texto="Sem versão editorial" cor="#9099aa" />}
            {versaoExibida?.aprovado
              ? <Selo texto="Aprovado" cor="#00D97E" />
              : versaoExibida && <Selo texto="Rascunho" cor="#FFD166" />}
            {canal.versaoAprovada && versaoExibida?.id !== canal.versaoAprovada.id && (
              <span style={{ fontSize: "11px", color: "#9099aa" }}>
                (versão aprovada atual: {canal.versaoAprovada.numeroVersao})
              </span>
            )}
          </div>

          {erro && !editando && (
            <div style={{ background: "rgba(255,80,80,0.08)", border: "1px solid rgba(255,80,80,0.3)", borderRadius: "10px", padding: "10px 14px", color: "#ff6b6b", fontSize: "13px", fontWeight: 600, marginBottom: "14px" }}>
              {erro}
            </div>
          )}

          {editando ? (
            <Editor inicial={conteudoExibido} salvando={salvando} erro={erro} onSalvar={salvar} onCancelar={() => { setEditando(false); setErro(null); }} />
          ) : (
            <>
              <LeituraConteudo c={conteudoExibido} />

              {versaoExibida && !versaoExibida.aprovado && (
                <div style={{ marginTop: "18px" }}>
                  <button type="button" disabled={aprovando} onClick={() => aprovar(versaoExibida.id)} style={estiloBotao(true, aprovando)}>
                    {aprovando ? "Aprovando..." : `Aprovar versão ${versaoExibida.numeroVersao}`}
                  </button>
                  <p style={{ fontSize: "11px", color: "#9099aa", margin: "8px 0 0" }}>
                    Aprovar marca esta versão como a aprovada para uso — não publica em nenhum marketplace.
                  </p>
                </div>
              )}
            </>
          )}

          {canal.historico.length > 0 && (
            <details style={{ marginTop: "18px" }} open={!!vendoVersao}>
              <summary style={{ fontSize: "12px", color: "#9099aa", cursor: "pointer", fontWeight: 600 }}>
                Histórico de versões ({canal.historico.length})
              </summary>
              <div style={{ overflowX: "auto", marginTop: "10px" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", minWidth: "480px" }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: "#9099aa", textTransform: "uppercase", fontSize: "10px" }}>
                      <th style={{ padding: "7px 8px" }}>Versão</th>
                      <th style={{ padding: "7px 8px" }}>Origem</th>
                      <th style={{ padding: "7px 8px" }}>Criada em</th>
                      <th style={{ padding: "7px 8px" }}>Autor</th>
                      <th style={{ padding: "7px 8px" }}>Estado</th>
                      <th style={{ padding: "7px 8px" }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {canal.historico.map(v => (
                      <tr key={v.id} style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                        <td style={{ padding: "8px", color: "#fff", fontWeight: 700 }}>{v.numeroVersao}</td>
                        <td style={{ padding: "8px", color: "#9099aa" }}>{ROTULO_ORIGEM[v.origem] ?? v.origem}</td>
                        <td style={{ padding: "8px", color: "#9099aa" }}>{formatarData(v.criadoEm)}</td>
                        <td style={{ padding: "8px", color: "#9099aa" }}>{v.criadoPor ? "usuário" : "IA"}</td>
                        <td style={{ padding: "8px" }}>
                          {v.aprovado ? <Selo texto="Aprovado" cor="#00D97E" /> : <span style={{ color: "#9099aa" }}>rascunho</span>}
                        </td>
                        <td style={{ padding: "8px", textAlign: "right" }}>
                          <button type="button" onClick={() => { setVendoVersao(v.id === canal.versaoAtual?.id ? null : v.id); setEditando(false); }}
                            style={{ background: "none", border: "none", color: "#FFB600", fontSize: "12px", fontWeight: 700, cursor: "pointer", padding: 0 }}>
                            {vendoVersao === v.id ? "voltando..." : "ver"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {vendoVersao && (
                <button type="button" onClick={() => setVendoVersao(null)} style={{ ...estiloBotao(false), marginTop: "10px", fontSize: "12px" }}>
                  Voltar para a versão atual
                </button>
              )}
            </details>
          )}
        </>
      )}
    </Cartao>
  );
}
