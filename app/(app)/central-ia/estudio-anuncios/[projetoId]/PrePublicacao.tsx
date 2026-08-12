"use client";

/**
 * Bloco de PRÉ-PUBLICAÇÃO (2026-08-23).
 *
 * NÃO PUBLICA NADA. Não existe botão de publicar aqui, e o texto da tela
 * diz explicitamente que "pronto para publicar" significa "nenhuma regra
 * verificada foi violada" — nunca que o marketplace aprovou. A validação
 * final é do próprio marketplace.
 *
 * O componente não decide nada: `podePublicar` e `motivo` vêm prontos do
 * servidor, derivados do portão único `podePublicarMarketplace()`.
 */
import { useState } from "react";
import { FormularioPublicacao, type PublicacaoCanalDTO } from "./DadosPublicacao";
import { BlocoValidacaoOficial, type ValidacaoOficialDTO } from "./ValidacaoOficial";
import { PublicarAnuncio, type PublicacaoDTO } from "./PublicarAnuncio";

type StatusCompliance = "aprovado" | "aprovado_com_alertas" | "bloqueado" | "nao_implementado";

interface ItemCompliance {
  codigo: string;
  campo: string | null;
  mensagem: string;
  responsavel: "usuario" | "sistema" | "marketplace";
}

interface Verificacao {
  codigo: string;
  rotulo: string;
  resultado: "ok" | "bloqueio" | "alerta" | "nao_verificavel";
  detalhe?: string;
}

export interface ComplianceDTO {
  id: string;
  marketplace: string;
  status: StatusCompliance;
  versaoRegras: number;
  criadoEm: string;
  podePublicar: boolean;
  motivo: string | null;
  /** A versão aprovada mudou depois desta validação — precisa revalidar. */
  desatualizado?: boolean;
  resultado: {
    status: StatusCompliance;
    motivoNaoImplementado?: string;
    bloqueios: ItemCompliance[];
    alertas: ItemCompliance[];
    verificacoes: Verificacao[];
    fonteEditorial: { numeroVersao: number } | null;
  };
}

const SLUG: Record<string, string> = {
  ML: "mercado-livre",
  Shopee: "shopee",
  Amazon: "amazon",
  "TikTok Shop": "tiktok-shop",
};

const ROTULO: Record<string, string> = {
  ML: "Mercado Livre",
  Shopee: "Shopee",
  Amazon: "Amazon",
  "TikTok Shop": "TikTok Shop",
};

const CORES: Record<StatusCompliance, { cor: string; icone: string; texto: string }> = {
  aprovado: { cor: "#00D97E", icone: "🟢", texto: "Sem pendências conhecidas" },
  aprovado_com_alertas: { cor: "#FFD166", icone: "🟡", texto: "Publicável, com pontos de atenção" },
  bloqueado: { cor: "#ff6b6b", icone: "🔴", texto: "Itens pendentes" },
  nao_implementado: { cor: "#9099aa", icone: "⚪", texto: "Sem validador" },
};

const ICONE_VERIFICACAO: Record<Verificacao["resultado"], string> = {
  ok: "✅",
  bloqueio: "❌",
  alerta: "⚠️",
  nao_verificavel: "❔",
};

function formatarData(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Canal({
  marketplace, compliance, publicacao, validacaoOficial, publicacaoAnuncio, projetoId, onMudou,
}: {
  marketplace: string;
  compliance: ComplianceDTO | null;
  publicacao: PublicacaoCanalDTO | null;
  validacaoOficial: ValidacaoOficialDTO | null;
  /** Publicação viva deste canal — quando existe, o botão some. */
  publicacaoAnuncio: PublicacaoDTO | null;
  projetoId: string;
  onMudou: () => void | Promise<void>;
}) {
  const [validando, setValidando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aberto, setAberto] = useState(false);

  async function validar() {
    setValidando(true);
    setErro(null);
    try {
      const res = await fetch(`/api/estudio-anuncios/projetos/${projetoId}/compliance/${SLUG[marketplace]}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) setErro(data.erro || "Não foi possível validar.");
      else { setAberto(true); await onMudou(); }
    } catch {
      setErro("Falha de conexão ao validar.");
    } finally {
      setValidando(false);
    }
  }

  const status = compliance?.status ?? null;
  const visual = compliance?.desatualizado
    ? { cor: "#FFD166", icone: "🟠", texto: "Desatualizado" }
    : status
      ? CORES[status]
      : { cor: "#9099aa", icone: "⚪", texto: "Ainda não validado" };
  const r = compliance?.resultado;
  const nBloqueios = r?.bloqueios.length ?? 0;
  const nAlertas = r?.alertas.length ?? 0;

  const resumo = !compliance
    ? "Ainda não validado"
    : compliance.desatualizado
      ? "Desatualizado — a versão aprovada mudou"
      : status === "nao_implementado"
      ? "Sem validador"
      : nBloqueios > 0
        ? `${nBloqueios} ${nBloqueios === 1 ? "item pendente" : "itens pendentes"}`
        : nAlertas > 0
          ? `${nAlertas} ${nAlertas === 1 ? "alerta" : "alertas"}`
          : "Sem pendências conhecidas";

  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "12px", padding: "16px", marginBottom: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: "#fff", fontWeight: 700, fontSize: "14px", overflowWrap: "anywhere" }}>
            {ROTULO[marketplace] ?? marketplace}
          </div>
          <div style={{ fontSize: "12px", color: visual.cor, fontWeight: 600, marginTop: "3px" }}>
            {visual.icone} {resumo}
          </div>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          {compliance && (
            <button
              type="button"
              onClick={() => setAberto(a => !a)}
              style={{ padding: "6px 12px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.18)", background: "transparent", color: "#cdd3dd", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
            >
              {aberto ? "Ocultar" : "Ver checklist"}
            </button>
          )}
          <button
            type="button"
            onClick={validar}
            disabled={validando}
            style={{
              padding: "7px 14px", borderRadius: "8px", border: "none", fontSize: "12px", fontWeight: 800,
              background: validando ? "rgba(255,182,0,0.3)" : "linear-gradient(135deg, #FFB600 0%, #FF6B00 100%)",
              color: "#000", cursor: validando ? "not-allowed" : "pointer",
            }}
          >
            {validando ? "Validando..." : compliance ? "Validar novamente" : "Validar"}
          </button>
        </div>
      </div>

      {erro && <div style={{ fontSize: "12px", color: "#ff6b6b", fontWeight: 600, marginTop: "10px" }}>{erro}</div>}

      {/* Formulário de configuração — só para canal com validador. Fica
          junto do parecer porque é ele que diz o que ainda falta. */}
      {publicacao && status !== "nao_implementado" && (
        <FormularioPublicacao projetoId={projetoId} canal={publicacao} onSalvo={onMudou} />
      )}

      {/* Conta + validacao oficial: so para o ML, e so depois do
          formulario — a ordem da tela e a ordem do fluxo. */}
      {publicacao && marketplace === "ML" && (
        <BlocoValidacaoOficial
          projetoId={projetoId}
          lojaId={publicacao.lojaId}
          modeloPublicacao={publicacao.modeloPublicacao}
          validacao={validacaoOficial}
          podeValidar={compliance?.podePublicar === true}
          onMudou={onMudou}
        />
      )}

      {/* PUBLICAÇÃO REAL — por último na tela porque é o último passo do
          fluxo, e o único irreversível. `podePublicar` vem do SERVIDOR. */}
      {publicacao && marketplace === "ML" && (
        <PublicarAnuncio
          projetoId={projetoId}
          publicacao={publicacaoAnuncio}
          podePublicar={validacaoOficial?.podePublicarML === true}
          motivo={validacaoOficial?.motivoML ?? null}
          resumo={{
            lojaNome: publicacao.lojaId,
            precoCentavos: publicacao.precoCentavos,
            estoque: publicacao.estoque,
            categoriaNome: publicacao.categoriaNome,
            categoriaId: publicacao.categoryId,
            tipoAnuncioId: publicacao.tipoAnuncioId,
            familyName: publicacao.familyName,
          }}
          onMudou={onMudou}
        />
      )}

      {compliance && status === "nao_implementado" && (
        <p style={{ fontSize: "12px", color: "#9099aa", margin: "10px 0 0", lineHeight: 1.5 }}>
          {r?.motivoNaoImplementado}
        </p>
      )}

      {aberto && r && status !== "nao_implementado" && (
        <div style={{ marginTop: "14px", paddingTop: "14px", borderTop: "1px solid rgba(255,255,255,0.07)" }}>
          <div style={{ display: "grid", gap: "7px" }}>
            {r.verificacoes.map(v => (
              <div key={v.codigo} style={{ display: "flex", gap: "8px", fontSize: "12.5px", alignItems: "flex-start" }}>
                <span style={{ flexShrink: 0 }}>{ICONE_VERIFICACAO[v.resultado]}</span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ color: v.resultado === "ok" ? "#cdd3dd" : "#fff", fontWeight: v.resultado === "ok" ? 400 : 600, overflowWrap: "anywhere" }}>
                    {v.rotulo}
                  </span>
                  {v.detalhe && (
                    <span style={{ color: "#9099aa", display: "block", fontSize: "11.5px", marginTop: "2px", overflowWrap: "anywhere" }}>
                      {v.detalhe}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: "11px", color: "#9099aa", marginTop: "12px" }}>
            Validado em {formatarData(compliance.criadoEm)} · regras v{compliance.versaoRegras}
            {r.fonteEditorial && ` · conteúdo versão ${r.fonteEditorial.numeroVersao}`}
          </div>
          {compliance.motivo && (
            <div style={{ fontSize: "11.5px", color: "#FFD166", marginTop: "8px", fontWeight: 600 }}>
              {compliance.motivo}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function BlocoPrePublicacao({
  marketplaces, compliance, publicacao, validacaoOficial, publicacoes, projetoId, onMudou,
}: {
  marketplaces: string[];
  compliance: ComplianceDTO[];
  publicacao: PublicacaoCanalDTO[];
  validacaoOficial: ValidacaoOficialDTO[];
  publicacoes: (PublicacaoDTO & { marketplace: string })[];
  projetoId: string;
  onMudou: () => void | Promise<void>;
}) {
  const porCanal = new Map(compliance.map(c => [c.marketplace, c]));
  const publicacaoPorCanal = new Map(publicacao.map(p => [p.marketplace, p]));
  const validacaoPorCanal = new Map(validacaoOficial.map(v => [v.marketplace, v]));
  const publicacaoAnuncioPorCanal = new Map(publicacoes.map(p => [p.marketplace, p]));

  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "16px", padding: "24px", marginBottom: "20px" }}>
      <h2 style={{ fontSize: "15px", fontWeight: 800, color: "#fff", margin: "0 0 6px" }}>Pré-publicação</h2>
      <p style={{ fontSize: "12px", color: "#9099aa", margin: "0 0 18px", lineHeight: 1.5 }}>
        Validação <strong style={{ color: "#cdd3dd" }}>pré-publicação</strong>: verifica os requisitos técnicos que
        conseguimos checar aqui. Nenhum anúncio é criado nesta tela, e um resultado sem pendências{" "}
        <strong style={{ color: "#cdd3dd" }}>não é garantia de aprovação</strong> — a validação final é sempre do
        marketplace.
      </p>

      {marketplaces.length === 0 ? (
        <p style={{ fontSize: "13px", color: "#9099aa", margin: 0 }}>
          Este projeto não tem nenhum canal configurado.
        </p>
      ) : (
        marketplaces.map(m => (
          <Canal key={m} marketplace={m} compliance={porCanal.get(m) ?? null} publicacao={publicacaoPorCanal.get(m) ?? null} validacaoOficial={validacaoPorCanal.get(m) ?? null} publicacaoAnuncio={publicacaoAnuncioPorCanal.get(m) ?? null} projetoId={projetoId} onMudou={onMudou} />
        ))
      )}
    </div>
  );
}
