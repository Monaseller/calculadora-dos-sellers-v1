"use client";

/**
 * Conta do Mercado Livre + VALIDAÇÃO OFICIAL (2026-08-25).
 *
 * **NÃO PUBLICA NADA.** Não existe botão de publicar aqui. "Validado"
 * significa que o Mercado Livre aceitou o payload no `/items/validate` —
 * nenhum anúncio foi criado.
 *
 * O token nunca chega ao navegador: a listagem de contas devolve só id,
 * nome e apelido, e a validação acontece inteira no servidor.
 *
 * Os erros do Mercado Livre aparecem SEPARADOS dos bloqueios locais, com
 * o **código oficial preservado** ao lado da mensagem — traduzir de um
 * jeito que mude o significado seria pior que não traduzir.
 */
import { useEffect, useState } from "react";

interface ProblemaML {
  codigo: string;
  mensagem: string;
  campo: string | null;
  tipo: string | null;
}

export interface ValidacaoOficialDTO {
  id: string;
  marketplace: string;
  status: "validado" | "validado_com_alertas" | "bloqueado" | "erro_comunicacao";
  httpStatus: number | null;
  hashPayload: string;
  erros: ProblemaML[];
  alertas: ProblemaML[];
  criadoEm: string;
  desatualizada: boolean;
  podePublicarML: boolean;
  motivoML: string | null;
}

interface LojaDTO {
  id: string;
  nome: string;
  nickname: string;
  sellerId: string;
}

const VISUAL: Record<ValidacaoOficialDTO["status"], { cor: string; icone: string; texto: string }> = {
  validado: { cor: "#00D97E", icone: "🟢", texto: "Mercado Livre aceitou o anúncio na validação" },
  // "Validado com alertas" é aceito, não meio-reprovado: warning é
  // informativo e não impede publicar. O texto não promete aprovação do
  // anúncio — a moderação do ML continua sendo outra coisa.
  validado_com_alertas: { cor: "#FFD166", icone: "🟡", texto: "Validado pelo Mercado Livre com alertas" },
  bloqueado: { cor: "#ff6b6b", icone: "🔴", texto: "Mercado Livre apontou problemas" },
  erro_comunicacao: { cor: "#9099aa", icone: "⚪", texto: "Não foi possível falar com o Mercado Livre" },
};

function formatarData(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function ListaProblemas({ titulo, cor, itens }: { titulo: string; cor: string; itens: ProblemaML[] }) {
  if (itens.length === 0) return null;
  return (
    <div style={{ marginTop: "10px" }}>
      <div style={{ fontSize: "11px", fontWeight: 800, color: cor, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "6px" }}>
        {titulo}
      </div>
      <div style={{ display: "grid", gap: "6px" }}>
        {itens.map((p, i) => (
          <div key={`${p.codigo}-${i}`} style={{ fontSize: "12.5px", color: "#cdd3dd", overflowWrap: "anywhere" }}>
            <span style={{ color: cor, fontWeight: 700 }}>•</span> {p.mensagem}
            {/* O código oficial fica sempre visível, sem tradução. */}
            <code style={{ fontFamily: "monospace", color: "#9099aa", fontSize: "11px", marginLeft: "6px" }}>
              [{p.codigo}{p.campo ? ` · ${p.campo}` : ""}]
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}

export function BlocoValidacaoOficial({
  projetoId, lojaId, modeloPublicacao, validacao, podeValidar, onMudou,
}: {
  projetoId: string;
  lojaId: string | null;
  /** Modelo resolvido da conta — muda o formato do payload. */
  modeloPublicacao: "user_products" | "legacy" | null;
  validacao: ValidacaoOficialDTO | null;
  /** Compliance local sem pendências — só então faz sentido perguntar ao ML. */
  podeValidar: boolean;
  onMudou: () => void | Promise<void>;
}) {
  const [lojas, setLojas] = useState<LojaDTO[] | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [validando, setValidando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const base = `/api/estudio-anuncios/projetos/${projetoId}/marketplaces/mercado-livre`;

  useEffect(() => {
    let vivo = true;
    setCarregando(true);
    fetch(`${base}/lojas`)
      .then(r => r.json())
      .then(d => { if (vivo && d?.ok) setLojas(d.lojas ?? []); })
      .catch(() => { if (vivo) setLojas([]); })
      .finally(() => { if (vivo) setCarregando(false); });
    return () => { vivo = false; };
  }, [base]);

  async function vincular(id: string | null) {
    setErro(null);
    try {
      const res = await fetch(`${base}/lojas`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lojaId: id }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) setErro(d.erro || "Não foi possível vincular a conta.");
      else await onMudou();
    } catch {
      setErro("Falha de conexão ao vincular a conta.");
    }
  }

  async function validarOficial() {
    setValidando(true);
    setErro(null);
    try {
      const res = await fetch(`${base}/validacao-oficial`, { method: "POST" });
      const d = await res.json();
      if (!res.ok || !d.ok) setErro(d.erro || "Não foi possível validar no Mercado Livre.");
      else await onMudou();
    } catch {
      setErro("Falha de conexão ao validar no Mercado Livre.");
    } finally {
      setValidando(false);
    }
  }

  const lojaAtual = lojas?.find(l => l.id === lojaId) ?? null;
  const v = validacao;
  const visual = v ? (v.desatualizada ? { cor: "#FFD166", icone: "🟠", texto: "Desatualizada — os dados mudaram" } : VISUAL[v.status]) : null;

  return (
    <div style={{ marginTop: "14px", paddingTop: "14px", borderTop: "1px solid rgba(255,255,255,0.07)" }}>
      <h3 style={{ fontSize: "13px", fontWeight: 800, color: "#fff", margin: "0 0 4px" }}>
        Conta e validação oficial
      </h3>
      <p style={{ fontSize: "11.5px", color: "#9099aa", margin: "0 0 14px", lineHeight: 1.5 }}>
        Envia o anúncio ao validador oficial do Mercado Livre. <strong style={{ color: "#cdd3dd" }}>Nenhum anúncio é criado</strong> nesta etapa.
      </p>

      {erro && (
        <div style={{ background: "rgba(255,80,80,0.08)", border: "1px solid rgba(255,80,80,0.3)", borderRadius: "8px", padding: "8px 12px", color: "#ff6b6b", fontSize: "12px", fontWeight: 600, marginBottom: "12px" }}>
          {erro}
        </div>
      )}

      {/* ── Conta ─────────────────────────────────────────────────── */}
      <div style={{ marginBottom: "14px" }}>
        <label style={{ display: "block", fontSize: "11px", fontWeight: 700, color: "#9099aa", textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "6px" }}>
          Conta Mercado Livre
        </label>
        {carregando ? (
          <span style={{ fontSize: "12px", color: "#9099aa" }}>Carregando contas...</span>
        ) : lojaAtual ? (
          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: "13px", color: "#fff", overflowWrap: "anywhere" }}>
              {lojaAtual.nome}
              {lojaAtual.sellerId && <code style={{ fontFamily: "monospace", color: "#9099aa", marginLeft: "6px" }}>({lojaAtual.sellerId})</code>}
            </span>
            <button
              type="button"
              onClick={() => vincular(null)}
              style={{ padding: "4px 10px", borderRadius: "6px", border: "1px solid rgba(255,255,255,0.18)", background: "transparent", color: "#9099aa", fontSize: "11px", fontWeight: 600, cursor: "pointer" }}
            >
              Desvincular
            </button>
          </div>
        ) : (lojas?.length ?? 0) === 0 ? (
          <p style={{ fontSize: "12px", color: "#FFD166", margin: 0 }}>
            Nenhuma conta Mercado Livre conectada nesta conta do CDS.
          </p>
        ) : (
          <>
            <p style={{ fontSize: "12px", color: "#cdd3dd", margin: "0 0 8px" }}>Selecione a conta Mercado Livre:</p>
            <div style={{ display: "grid", gap: "6px" }}>
              {lojas!.map(l => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => vincular(l.id)}
                  style={{ textAlign: "left", padding: "9px 12px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.03)", color: "#fff", fontSize: "12.5px", cursor: "pointer", overflowWrap: "anywhere" }}
                >
                  {l.nome}
                  {l.sellerId && <code style={{ fontFamily: "monospace", color: "#9099aa", marginLeft: "6px" }}>({l.sellerId})</code>}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Modelo da conta: define o formato do payload, entao a tela diz
          qual e — e o que isso significa para o titulo. */}
      {lojaId && (
        <div style={{ marginBottom: "14px", fontSize: "12px" }}>
          <span style={{ color: "#9099aa" }}>Modelo da conta: </span>
          {modeloPublicacao === "user_products" ? (
            <>
              <strong style={{ color: "#6fa3ff" }}>User Products</strong>
              <span style={{ color: "#9099aa", display: "block", marginTop: "4px", lineHeight: 1.5 }}>
                O título final do anúncio será gerado pelo Mercado Livre com base nos dados do produto.
                O nome da família é o campo que você preenche acima.
              </span>
            </>
          ) : modeloPublicacao === "legacy" ? (
            <strong style={{ color: "#cdd3dd" }}>Legacy (modelo anterior)</strong>
          ) : (
            <span style={{ color: "#FFD166" }}>ainda não verificado — valide uma vez para resolver</span>
          )}
        </div>
      )}

      {/* ── Validação oficial ─────────────────────────────────────── */}
      <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={validarOficial}
          disabled={validando || !lojaId || !podeValidar}
          style={{
            padding: "9px 18px", borderRadius: "9px", border: "none", fontSize: "13px", fontWeight: 800,
            background: validando || !lojaId || !podeValidar ? "rgba(255,255,255,0.12)" : "linear-gradient(135deg, #FFB600 0%, #FF6B00 100%)",
            color: validando || !lojaId || !podeValidar ? "#9099aa" : "#000",
            cursor: validando || !lojaId || !podeValidar ? "not-allowed" : "pointer",
          }}
        >
          {validando ? "Validando no Mercado Livre..." : "Validar no Mercado Livre"}
        </button>
        {!lojaId && <span style={{ fontSize: "11.5px", color: "#9099aa" }}>vincule uma conta primeiro</span>}
        {lojaId && !podeValidar && <span style={{ fontSize: "11.5px", color: "#9099aa" }}>resolva as pendências locais primeiro</span>}
      </div>

      {v && visual && (
        <div style={{ marginTop: "14px", padding: "12px", borderRadius: "10px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
          <div style={{ fontSize: "12.5px", color: visual.cor, fontWeight: 700 }}>
            {visual.icone} {visual.texto}
          </div>
          {/* Bloqueios e alertas do MARKETPLACE, separados dos locais. */}
          <ListaProblemas titulo="Mercado Livre — bloqueios" cor="#ff6b6b" itens={v.erros} />
          {/* Alertas continuam VISÍVEIS mesmo quando validado: eles não
              bloqueiam, mas escondê-los seria decidir pelo usuário o que
              ele precisa saber sobre o próprio anúncio. */}
          <ListaProblemas titulo="Mercado Livre — alertas" cor="#FFD166" itens={v.alertas} />
          {v.status === "validado_com_alertas" && v.erros.length === 0 && (
            <div style={{ fontSize: "11.5px", color: "#9099aa", marginTop: "8px", lineHeight: 1.5 }}>
              Nenhum erro bloqueante. Os itens acima são avisos do próprio Mercado Livre — normalmente
              sobre configuração de envio da conta ou política da categoria, não sobre o conteúdo do anúncio.
            </div>
          )}
          <div style={{ fontSize: "11px", color: "#9099aa", marginTop: "10px" }}>
            Validado em {formatarData(v.criadoEm)}
            {v.httpStatus != null && ` · HTTP ${v.httpStatus}`}
            {" · "}payload <code style={{ fontFamily: "monospace" }}>{v.hashPayload.slice(0, 10)}</code>
          </div>
          {v.motivoML && (
            <div style={{ fontSize: "11.5px", color: "#FFD166", marginTop: "8px", fontWeight: 600 }}>{v.motivoML}</div>
          )}
          {v.podePublicarML && (
            <div style={{ fontSize: "11.5px", color: "#00D97E", marginTop: "8px", fontWeight: 600 }}>
              Pronto para a etapa de publicação — que ainda não existe. Nada foi publicado.
              Isto não é garantia de aprovação: a moderação do Mercado Livre acontece depois.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
