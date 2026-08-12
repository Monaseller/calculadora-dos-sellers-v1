"use client";

/**
 * Blocos de RESULTADO da tela de detalhe do projeto (2026-08-19).
 *
 * Só exibição. Nenhuma regra de negócio, nenhum recálculo — em especial,
 * o score é renderizado exatamente como foi persistido: nenhum peso,
 * faixa ou critério é reimplementado aqui. Nenhuma chamada a Supabase
 * sai deste arquivo; tudo chega pronto pelo GET da rota do projeto.
 *
 * Arquivo separado da página por tamanho, não por arquitetura: a página
 * continua sendo a dona do fetch, do polling e do estado. Aqui só entram
 * componentes de apresentação, que reutilizam a identidade visual já
 * existente (mesmos cartões, cores e tipografia — nenhuma biblioteca de
 * UI nova foi introduzida).
 */
import { useState } from "react";

// ────────────────────────────────────────────────────────────────────
// Tipos do DTO (espelham lib/estudio-anuncios/resultados.ts)
// ────────────────────────────────────────────────────────────────────
export interface ResultadoProjetoDTO {
  analiseVisual: {
    produtoIdentificado: string | null;
    marca: string | null;
    modelo: string | null;
    categoria: string[];
    resumoVisual: string;
    confirmado: {
      cores: string[]; materiais: string[]; componentes: string[];
      caracteristicas: string[]; usos: string[]; publico: string[];
      atributos: { nome: string; valor: string }[];
    };
    naoConfirmado: {
      itens: { valor: string; origem: string }[];
      informacoesNaoConfirmadas: string[];
      alertas: string[];
      textosLegiveis: string[];
    };
    qualidadeFotos: { nota: number; problemas: string[]; sugestoes: string[] } | null;
    totalFotosAnalisadas: number;
    analiseParcial: boolean;
  } | null;
  conteudo: {
    origem: "revisao_claude" | "geracao_conteudo";
    tituloBase: { texto: string; fatoIds: string[] };
    descricaoCurta: { texto: string; contemRessalva: boolean; fatoIds: string[] };
    bullets?: { texto: string; contemRessalva: boolean; fatoIds: string[] }[];
    descricaoLonga?: { texto: string; contemRessalva: boolean; fatoIds: string[] }[];
    especificacoes?: { nome: string; valor: string; fatoId: string }[];
    publicoSugerido?: { texto: string; fatoIds: string[] };
  } | null;
  revisao: {
    totalTrechos: number;
    totalAlterados: number;
    alteracoes: { ref: string; rotulo: string; textoOriginal: string; textoRevisado: string; motivo: string | null }[];
    observacoes: string[];
  } | null;
  marketplaces:
    | { marketplace: string; titulo: string; descricao: string; bullets?: string[]; especificacoes?: { nome: string; valor: string }[]; cta?: string }[]
    | null;
  promptsImagem: { total: number; itens: { ordem: number; finalidade: string; principal: boolean; objetivo: string }[] } | null;
  imagens: {
    id: string; ordem: number | null; finalidade: string; finalidadeRotulo: string;
    principal: boolean; largura: number | null; altura: number | null;
    tamanhoBytes: number | null; mimeType: string | null;
    provedor: string | null; modelo: string | null; urlAssinada: string | null;
  }[];
  score: {
    scoreTotal: number;
    classificacao: string;
    versaoRegrasScore: string;
    blocos: {
      codigo: string; nome: string; pesoMaximo: number; pontos: number; percentual: number | null;
      criterios: { codigo: string; pontosPossiveis: number; pontosObtidos: number; status: string; explicacao: string }[];
    }[];
    alertas: string[];
    calculadoEm: string;
  } | null;
  custos: {
    totalEstimadoUsd: number;
    porEtapa: { etapa: string; provedor: string; modelo: string; custoEstimadoUsd: number; tokensEntrada: number | null; tokensSaida: number | null; unidadesGeradas: number | null }[];
    temModeloSemPreco: boolean;
  };
}

// ────────────────────────────────────────────────────────────────────
// Primitivos visuais — mesma linguagem da página
// ────────────────────────────────────────────────────────────────────
export function Cartao({ titulo, acao, children }: { titulo: string; acao?: React.ReactNode; children: React.ReactNode }) {
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

function Vazio({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: "13px", color: "#9099aa", margin: 0 }}>{children}</p>;
}

function Rotulo({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: "11px", fontWeight: 700, color: "#9099aa", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "6px" }}>
      {children}
    </div>
  );
}

function Chips({ itens, cor = "#6fa3ff" }: { itens: string[]; cor?: string }) {
  if (itens.length === 0) return <span style={{ fontSize: "13px", color: "#9099aa" }}>—</span>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
      {itens.map((i, idx) => (
        <span key={`${i}-${idx}`} style={{ fontSize: "12px", color: cor, background: `${cor}1f`, border: `1px solid ${cor}44`, borderRadius: "6px", padding: "3px 9px" }}>
          {i}
        </span>
      ))}
    </div>
  );
}

/** Detalhes técnicos ficam fechados por padrão — fatoIds e afins não poluem a leitura principal. */
function DetalhesTecnicos({ titulo = "Detalhes técnicos", children }: { titulo?: string; children: React.ReactNode }) {
  return (
    <details style={{ marginTop: "14px" }}>
      <summary style={{ fontSize: "12px", color: "#9099aa", cursor: "pointer", fontWeight: 600 }}>{titulo}</summary>
      <div style={{ marginTop: "10px" }}>{children}</div>
    </details>
  );
}

function formatarUsd(v: number) {
  return `US$ ${v.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

const ROTULO_ETAPA: Record<string, string> = {
  analise_visual: "Análise visual",
  geracao_conteudo: "Geração de conteúdo",
  revisao_claude: "Revisão",
  adaptacao_marketplace: "Adaptação por marketplace",
  geracao_prompts_imagem: "Prompts de imagem",
  geracao_imagem: "Geração de imagem",
  calculo_score: "Score",
  ping: "Ping",
};

// ────────────────────────────────────────────────────────────────────
// 1. Score
// ────────────────────────────────────────────────────────────────────
const COR_CLASSIFICACAO: Record<string, string> = {
  excelente: "#00D97E",
  bom: "#8FD14F",
  atencao: "#FFD166",
  insuficiente: "#ff6b6b",
};

export function BlocoScore({ score }: { score: ResultadoProjetoDTO["score"] }) {
  if (!score) {
    return (
      <Cartao titulo="Qualidade técnica do anúncio">
        <Vazio>Resultado ainda não disponível — o score é calculado ao final da geração.</Vazio>
      </Cartao>
    );
  }
  const cor = COR_CLASSIFICACAO[score.classificacao] ?? "#FFB600";
  return (
    <Cartao
      titulo="Qualidade técnica do anúncio"
      acao={<span style={{ fontSize: "11px", color: "#9099aa" }}>regras {score.versaoRegrasScore}</span>}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "20px", flexWrap: "wrap", marginBottom: "20px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "4px" }}>
          <span style={{ fontSize: "44px", fontWeight: 900, color: cor, lineHeight: 1 }}>{score.scoreTotal}</span>
          <span style={{ fontSize: "18px", fontWeight: 700, color: "#9099aa" }}>/100</span>
        </div>
        <span style={{ fontSize: "12px", fontWeight: 800, color: cor, background: `${cor}1f`, border: `1px solid ${cor}55`, borderRadius: "8px", padding: "5px 12px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
          {score.classificacao}
        </span>
        <span style={{ fontSize: "12px", color: "#9099aa", flex: "1 1 220px", minWidth: "200px" }}>
          Mede o quão completo e consistente está o anúncio — não é previsão de vendas.
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: "12px" }}>
        {score.blocos.map(b => {
          const pct = b.percentual ?? 100;
          const corBloco = pct >= 90 ? "#00D97E" : pct >= 70 ? "#FFD166" : "#ff6b6b";
          return (
            <div key={b.codigo} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "12px", padding: "14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px", marginBottom: "8px" }}>
                <span style={{ fontSize: "13px", fontWeight: 700, color: "#fff" }}>{b.nome}</span>
                <span style={{ fontSize: "12px", fontWeight: 700, color: corBloco, whiteSpace: "nowrap" }}>
                  {b.pontos.toFixed(1).replace(".0", "")}/{b.pesoMaximo}
                </span>
              </div>
              <div style={{ height: "6px", borderRadius: "999px", background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${pct}%`, background: corBloco, transition: "width .3s ease" }} />
              </div>
              {b.criterios.filter(c => c.status !== "ok").length > 0 && (
                <ul style={{ margin: "10px 0 0", paddingLeft: "16px", fontSize: "11px", color: "#9099aa", lineHeight: 1.5 }}>
                  {b.criterios.filter(c => c.status !== "ok").map(c => (
                    <li key={c.codigo}>{c.explicacao}</li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {score.alertas.length > 0 && (
        <DetalhesTecnicos titulo={`Observações do cálculo (${score.alertas.length})`}>
          <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "12px", color: "#9099aa", lineHeight: 1.6 }}>
            {score.alertas.map((a, i) => <li key={i}>{a}</li>)}
          </ul>
        </DetalhesTecnicos>
      )}
    </Cartao>
  );
}

// ────────────────────────────────────────────────────────────────────
// 2. Conteúdo
// ────────────────────────────────────────────────────────────────────
export function BlocoConteudo({ conteudo }: { conteudo: ResultadoProjetoDTO["conteudo"] }) {
  if (!conteudo) {
    return (
      <Cartao titulo="Conteúdo do anúncio">
        <Vazio>Resultado ainda não disponível.</Vazio>
      </Cartao>
    );
  }
  return (
    <Cartao
      titulo="Conteúdo do anúncio"
      acao={
        <span style={{ fontSize: "11px", color: "#9099aa" }}>
          {conteudo.origem === "revisao_claude" ? "versão revisada" : "versão original"}
        </span>
      }
    >
      <div style={{ marginBottom: "18px" }}>
        <Rotulo>Título</Rotulo>
        <div style={{ fontSize: "17px", fontWeight: 700, color: "#fff", lineHeight: 1.4 }}>{conteudo.tituloBase.texto}</div>
      </div>

      <div style={{ marginBottom: "18px" }}>
        <Rotulo>Descrição curta</Rotulo>
        <div style={{ fontSize: "14px", color: "#d6dae2", lineHeight: 1.6 }}>{conteudo.descricaoCurta.texto}</div>
      </div>

      {conteudo.bullets && conteudo.bullets.length > 0 && (
        <div style={{ marginBottom: "18px" }}>
          <Rotulo>Destaques</Rotulo>
          <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "14px", color: "#d6dae2", lineHeight: 1.8 }}>
            {conteudo.bullets.map((b, i) => <li key={i}>{b.texto}</li>)}
          </ul>
        </div>
      )}

      {conteudo.descricaoLonga && conteudo.descricaoLonga.length > 0 && (
        <div style={{ marginBottom: "18px" }}>
          <Rotulo>Descrição completa</Rotulo>
          {conteudo.descricaoLonga.map((p, i) => (
            <p key={i} style={{ fontSize: "14px", color: "#d6dae2", lineHeight: 1.7, margin: "0 0 10px" }}>{p.texto}</p>
          ))}
        </div>
      )}

      {conteudo.especificacoes && conteudo.especificacoes.length > 0 && (
        <div style={{ marginBottom: "18px" }}>
          <Rotulo>Especificações</Rotulo>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "8px" }}>
            {conteudo.especificacoes.map((e, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: "10px", fontSize: "13px", padding: "8px 12px", background: "rgba(255,255,255,0.03)", borderRadius: "8px" }}>
                <span style={{ color: "#9099aa" }}>{e.nome}</span>
                <span style={{ color: "#fff", fontWeight: 600, textAlign: "right" }}>{e.valor}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {conteudo.publicoSugerido && (
        <div>
          <Rotulo>Público sugerido</Rotulo>
          <div style={{ fontSize: "14px", color: "#d6dae2" }}>{conteudo.publicoSugerido.texto}</div>
        </div>
      )}

      {/* fatoIds são rastreabilidade técnica — nunca na leitura principal. */}
      <DetalhesTecnicos titulo="Rastreabilidade dos fatos (fatoIds)">
        <div style={{ fontSize: "11px", color: "#9099aa", lineHeight: 1.8, fontFamily: "monospace" }}>
          <div>título: {conteudo.tituloBase.fatoIds.join(", ") || "—"}</div>
          <div>descrição curta: {conteudo.descricaoCurta.fatoIds.join(", ") || "—"}{conteudo.descricaoCurta.contemRessalva ? " (contém ressalva)" : ""}</div>
          {(conteudo.bullets ?? []).map((b, i) => (
            <div key={i}>bullet {i + 1}: {b.fatoIds.join(", ") || "—"}{b.contemRessalva ? " (contém ressalva)" : ""}</div>
          ))}
          {(conteudo.especificacoes ?? []).map((e, i) => <div key={i}>espec. {e.nome}: {e.fatoId}</div>)}
        </div>
      </DetalhesTecnicos>
    </Cartao>
  );
}

// ────────────────────────────────────────────────────────────────────
// 3. Revisão
// ────────────────────────────────────────────────────────────────────
export function BlocoRevisao({ revisao }: { revisao: ResultadoProjetoDTO["revisao"] }) {
  if (!revisao) {
    return (
      <Cartao titulo="Revisão de texto">
        <Vazio>Resultado ainda não disponível.</Vazio>
      </Cartao>
    );
  }
  return (
    <Cartao
      titulo="Revisão de texto"
      acao={<span style={{ fontSize: "11px", color: "#9099aa" }}>{revisao.totalAlterados} de {revisao.totalTrechos} trechos ajustados</span>}
    >
      {revisao.alteracoes.length === 0 ? (
        <Vazio>Nenhum trecho precisou de ajuste — o conteúdo já estava adequado.</Vazio>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {revisao.alteracoes.map(a => (
            <div key={a.ref} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "12px", padding: "14px" }}>
              <div style={{ fontSize: "11px", fontWeight: 700, color: "#FFB600", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "10px" }}>{a.rotulo}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "12px" }}>
                <div>
                  <div style={{ fontSize: "10px", color: "#9099aa", marginBottom: "4px" }}>ANTES</div>
                  <div style={{ fontSize: "13px", color: "#9099aa", lineHeight: 1.6, textDecoration: "line-through", textDecorationColor: "rgba(255,107,107,0.4)" }}>{a.textoOriginal}</div>
                </div>
                <div>
                  <div style={{ fontSize: "10px", color: "#00D97E", marginBottom: "4px" }}>DEPOIS</div>
                  <div style={{ fontSize: "13px", color: "#fff", lineHeight: 1.6 }}>{a.textoRevisado}</div>
                </div>
              </div>
              {a.motivo && <div style={{ fontSize: "12px", color: "#9099aa", marginTop: "10px", fontStyle: "italic" }}>Motivo: {a.motivo}</div>}
            </div>
          ))}
        </div>
      )}
      {revisao.observacoes.length > 0 && (
        <DetalhesTecnicos titulo="Observações do revisor">
          <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "12px", color: "#9099aa", lineHeight: 1.6 }}>
            {revisao.observacoes.map((o, i) => <li key={i}>{o}</li>)}
          </ul>
        </DetalhesTecnicos>
      )}
    </Cartao>
  );
}

// ────────────────────────────────────────────────────────────────────
// 4. Marketplaces
// ────────────────────────────────────────────────────────────────────
export function BlocoMarketplaces({ marketplaces }: { marketplaces: ResultadoProjetoDTO["marketplaces"] }) {
  const lista = marketplaces ?? [];
  const [ativo, setAtivo] = useState(0);
  if (lista.length === 0) {
    return (
      <Cartao titulo="Versão por marketplace">
        <Vazio>Resultado ainda não disponível.</Vazio>
      </Cartao>
    );
  }
  const atual = lista[Math.min(ativo, lista.length - 1)];
  return (
    <Cartao titulo="Versão por marketplace">
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "18px" }}>
        {lista.map((m, i) => {
          const selecionado = i === Math.min(ativo, lista.length - 1);
          return (
            <button
              key={m.marketplace}
              type="button"
              onClick={() => setAtivo(i)}
              style={{
                padding: "7px 16px", borderRadius: "9px", fontSize: "13px", fontWeight: 700, cursor: "pointer",
                border: selecionado ? "1px solid rgba(255,182,0,0.5)" : "1px solid rgba(255,255,255,0.1)",
                background: selecionado ? "rgba(255,182,0,0.14)" : "rgba(255,255,255,0.03)",
                color: selecionado ? "#FFB600" : "#9099aa",
              }}
            >
              {m.marketplace}
            </button>
          );
        })}
      </div>

      <div style={{ marginBottom: "16px" }}>
        <Rotulo>Título</Rotulo>
        <div style={{ fontSize: "15px", fontWeight: 700, color: "#fff", lineHeight: 1.4 }}>{atual.titulo}</div>
      </div>

      {atual.bullets && atual.bullets.length > 0 && (
        <div style={{ marginBottom: "16px" }}>
          <Rotulo>Destaques</Rotulo>
          <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "13px", color: "#d6dae2", lineHeight: 1.8 }}>
            {atual.bullets.map((b, i) => <li key={i}>{b}</li>)}
          </ul>
        </div>
      )}

      <div style={{ marginBottom: "16px" }}>
        <Rotulo>Descrição</Rotulo>
        <div style={{ fontSize: "13px", color: "#d6dae2", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{atual.descricao}</div>
      </div>

      {atual.especificacoes && atual.especificacoes.length > 0 && (
        <div style={{ marginBottom: "16px" }}>
          <Rotulo>Especificações</Rotulo>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "8px" }}>
            {atual.especificacoes.map((e, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: "10px", fontSize: "13px", padding: "8px 12px", background: "rgba(255,255,255,0.03)", borderRadius: "8px" }}>
                <span style={{ color: "#9099aa" }}>{e.nome}</span>
                <span style={{ color: "#fff", fontWeight: 600, textAlign: "right" }}>{e.valor}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {atual.cta && (
        <div>
          <Rotulo>Chamada</Rotulo>
          <div style={{ fontSize: "13px", color: "#FFB600", fontWeight: 700 }}>{atual.cta}</div>
        </div>
      )}
    </Cartao>
  );
}

// ────────────────────────────────────────────────────────────────────
// 5. Imagens
// ────────────────────────────────────────────────────────────────────
export function BlocoImagens({ imagens }: { imagens: ResultadoProjetoDTO["imagens"] }) {
  const [ampliada, setAmpliada] = useState<number | null>(null);
  if (imagens.length === 0) {
    return (
      <Cartao titulo="Imagens geradas">
        <Vazio>Resultado ainda não disponível.</Vazio>
      </Cartao>
    );
  }
  const idx = ampliada === null ? null : Math.max(0, Math.min(ampliada, imagens.length - 1));
  const atual = idx === null ? null : imagens[idx];

  return (
    <Cartao titulo="Imagens geradas" acao={<span style={{ fontSize: "11px", color: "#9099aa" }}>{imagens.length} imagem(ns)</span>}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "14px" }}>
        {imagens.map((img, i) => (
          <div key={img.id}>
            <button
              type="button"
              onClick={() => img.urlAssinada && setAmpliada(i)}
              style={{
                position: "relative", width: "100%", aspectRatio: "1 / 1", borderRadius: "12px", overflow: "hidden",
                background: "rgba(255,255,255,0.04)", border: img.principal ? "1px solid rgba(255,182,0,0.5)" : "1px solid rgba(255,255,255,0.08)",
                display: "grid", placeItems: "center", padding: 0, cursor: img.urlAssinada ? "zoom-in" : "default",
              }}
            >
              {img.urlAssinada ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={img.urlAssinada} alt={img.finalidadeRotulo} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
              ) : (
                <span style={{ fontSize: "11px", color: "#9099aa", padding: "8px", textAlign: "center" }}>Imagem indisponível</span>
              )}
              {img.principal && (
                <span style={{ position: "absolute", top: "8px", left: "8px", background: "#FFB600", color: "#000", fontSize: "9px", fontWeight: 800, padding: "3px 7px", borderRadius: "6px" }}>
                  PRINCIPAL
                </span>
              )}
            </button>
            <div style={{ fontSize: "12px", color: "#fff", fontWeight: 600, marginTop: "8px" }}>{img.finalidadeRotulo}</div>
            <div style={{ fontSize: "11px", color: "#9099aa" }}>
              {img.largura && img.altura ? `${img.largura}×${img.altura}` : "dimensões n/d"}
              {img.tamanhoBytes ? ` · ${(img.tamanhoBytes / 1024).toFixed(0)}KB` : ""}
            </div>
          </div>
        ))}
      </div>

      <DetalhesTecnicos titulo="Detalhes técnicos das imagens">
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#9099aa", textTransform: "uppercase", fontSize: "10px" }}>
                <th style={{ padding: "6px 8px" }}>Ordem</th>
                <th style={{ padding: "6px 8px" }}>Finalidade</th>
                <th style={{ padding: "6px 8px" }}>MIME</th>
                <th style={{ padding: "6px 8px" }}>Dimensões</th>
                <th style={{ padding: "6px 8px" }}>Provedor</th>
                <th style={{ padding: "6px 8px" }}>Modelo</th>
              </tr>
            </thead>
            <tbody>
              {imagens.map(img => (
                <tr key={img.id} style={{ borderTop: "1px solid rgba(255,255,255,0.06)", color: "#d6dae2" }}>
                  <td style={{ padding: "7px 8px" }}>{img.ordem ?? "—"}</td>
                  <td style={{ padding: "7px 8px" }}>{img.finalidade}</td>
                  <td style={{ padding: "7px 8px" }}>{img.mimeType ?? "—"}</td>
                  <td style={{ padding: "7px 8px" }}>{img.largura && img.altura ? `${img.largura}×${img.altura}` : "—"}</td>
                  <td style={{ padding: "7px 8px" }}>{img.provedor ?? "—"}</td>
                  <td style={{ padding: "7px 8px" }}>{img.modelo ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DetalhesTecnicos>

      {atual?.urlAssinada && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setAmpliada(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", display: "grid", placeItems: "center", zIndex: 50, padding: "24px" }}
        >
          <div onClick={e => e.stopPropagation()} style={{ maxWidth: "min(90vw, 900px)", width: "100%", textAlign: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={atual.urlAssinada} alt={atual.finalidadeRotulo} style={{ maxWidth: "100%", maxHeight: "72vh", borderRadius: "12px", objectFit: "contain" }} />
            <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "16px", marginTop: "16px", flexWrap: "wrap" }}>
              <button type="button" onClick={() => setAmpliada(i => (i === null ? null : (i - 1 + imagens.length) % imagens.length))}
                style={{ padding: "8px 16px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.06)", color: "#fff", fontWeight: 700, fontSize: "13px", cursor: "pointer" }}>
                ← Anterior
              </button>
              <span style={{ fontSize: "13px", color: "#fff", fontWeight: 600 }}>
                {atual.finalidadeRotulo}{atual.principal ? " · Principal" : ""} ({(idx ?? 0) + 1}/{imagens.length})
              </span>
              <button type="button" onClick={() => setAmpliada(i => (i === null ? null : (i + 1) % imagens.length))}
                style={{ padding: "8px 16px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.06)", color: "#fff", fontWeight: 700, fontSize: "13px", cursor: "pointer" }}>
                Próxima →
              </button>
            </div>
            <button type="button" onClick={() => setAmpliada(null)}
              style={{ marginTop: "12px", padding: "6px 14px", borderRadius: "8px", border: "none", background: "transparent", color: "#9099aa", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
              Fechar
            </button>
          </div>
        </div>
      )}
    </Cartao>
  );
}

// ────────────────────────────────────────────────────────────────────
// 6. Análise visual
// ────────────────────────────────────────────────────────────────────
export function BlocoAnaliseVisual({ analise }: { analise: ResultadoProjetoDTO["analiseVisual"] }) {
  if (!analise) {
    return (
      <Cartao titulo="O que a IA identificou nas fotos">
        <Vazio>Resultado ainda não disponível.</Vazio>
      </Cartao>
    );
  }
  const c = analise.confirmado;
  const n = analise.naoConfirmado;
  const temNaoConfirmado = n.itens.length + n.informacoesNaoConfirmadas.length + n.alertas.length + n.textosLegiveis.length > 0;

  return (
    <Cartao
      titulo="O que a IA identificou nas fotos"
      acao={
        analise.qualidadeFotos && (
          <span style={{ fontSize: "11px", color: "#9099aa" }}>
            qualidade das fotos: {analise.qualidadeFotos.nota}/100 · {analise.totalFotosAnalisadas} foto(s){analise.analiseParcial ? " · análise parcial" : ""}
          </span>
        )
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px", marginBottom: "20px" }}>
        <div><Rotulo>Produto</Rotulo><div style={{ fontSize: "14px", color: "#fff" }}>{analise.produtoIdentificado ?? "—"}</div></div>
        <div><Rotulo>Marca</Rotulo><div style={{ fontSize: "14px", color: analise.marca ? "#fff" : "#9099aa" }}>{analise.marca ?? "não identificada nas fotos"}</div></div>
        <div><Rotulo>Categoria</Rotulo><div style={{ fontSize: "14px", color: "#fff" }}>{analise.categoria.length ? analise.categoria.join(" › ") : "—"}</div></div>
      </div>

      <div style={{ background: "rgba(0,217,126,0.05)", border: "1px solid rgba(0,217,126,0.2)", borderRadius: "12px", padding: "16px", marginBottom: "14px" }}>
        <div style={{ fontSize: "12px", fontWeight: 800, color: "#00D97E", marginBottom: "12px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
          Confirmado visualmente no produto
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "14px" }}>
          <div><Rotulo>Cores</Rotulo><Chips itens={c.cores} cor="#00D97E" /></div>
          <div><Rotulo>Materiais</Rotulo><Chips itens={c.materiais} cor="#00D97E" /></div>
          <div><Rotulo>Componentes</Rotulo><Chips itens={c.componentes} cor="#00D97E" /></div>
          <div><Rotulo>Usos</Rotulo><Chips itens={c.usos} cor="#00D97E" /></div>
        </div>
        {c.caracteristicas.length > 0 && (
          <div style={{ marginTop: "14px" }}>
            <Rotulo>Características</Rotulo>
            <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "13px", color: "#d6dae2", lineHeight: 1.7 }}>
              {c.caracteristicas.map((x, i) => <li key={i}>{x}</li>)}
            </ul>
          </div>
        )}
      </div>

      {temNaoConfirmado && (
        <div style={{ background: "rgba(255,209,102,0.05)", border: "1px solid rgba(255,209,102,0.2)", borderRadius: "12px", padding: "16px" }}>
          <div style={{ fontSize: "12px", fontWeight: 800, color: "#FFD166", marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
            Não confirmado
          </div>
          <p style={{ fontSize: "12px", color: "#9099aa", margin: "0 0 12px" }}>
            Vem da embalagem, de material promocional ou não pôde ser verificado — não foi usado como fato no anúncio.
          </p>
          {n.itens.length > 0 && <div style={{ marginBottom: "10px" }}><Chips itens={n.itens.map(i => `${i.valor} (${i.origem})`)} cor="#FFD166" /></div>}
          {n.informacoesNaoConfirmadas.length > 0 && (
            <ul style={{ margin: "0 0 8px", paddingLeft: "18px", fontSize: "13px", color: "#d6dae2", lineHeight: 1.7 }}>
              {n.informacoesNaoConfirmadas.map((x, i) => <li key={i}>{x}</li>)}
            </ul>
          )}
          {n.alertas.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "13px", color: "#FFD166", lineHeight: 1.7 }}>
              {n.alertas.map((x, i) => <li key={i}>{x}</li>)}
            </ul>
          )}
          {n.textosLegiveis.length > 0 && (
            <DetalhesTecnicos titulo="Textos lidos nas fotos">
              <Chips itens={n.textosLegiveis} cor="#FFD166" />
            </DetalhesTecnicos>
          )}
        </div>
      )}

      {analise.qualidadeFotos && (analise.qualidadeFotos.problemas.length > 0 || analise.qualidadeFotos.sugestoes.length > 0) && (
        <DetalhesTecnicos titulo="Qualidade das fotos enviadas">
          {analise.qualidadeFotos.problemas.length > 0 && (
            <>
              <Rotulo>Problemas</Rotulo>
              <Chips itens={analise.qualidadeFotos.problemas} cor="#ff6b6b" />
            </>
          )}
          {analise.qualidadeFotos.sugestoes.length > 0 && (
            <div style={{ marginTop: "10px" }}>
              <Rotulo>Sugestões</Rotulo>
              <Chips itens={analise.qualidadeFotos.sugestoes} />
            </div>
          )}
        </DetalhesTecnicos>
      )}
    </Cartao>
  );
}

// ────────────────────────────────────────────────────────────────────
// 7. Custos
// ────────────────────────────────────────────────────────────────────
export function BlocoCustos({ custos }: { custos: ResultadoProjetoDTO["custos"] }) {
  if (custos.porEtapa.length === 0) {
    return (
      <Cartao titulo="Custo estimado de IA">
        <Vazio>Nenhum consumo de IA registrado para este projeto ainda.</Vazio>
      </Cartao>
    );
  }
  return (
    <Cartao
      titulo="Custo estimado de IA"
      acao={<span style={{ fontSize: "18px", fontWeight: 900, color: "#fff" }}>{formatarUsd(custos.totalEstimadoUsd)}</span>}
    >
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", minWidth: "460px" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#9099aa", textTransform: "uppercase", fontSize: "10px" }}>
              <th style={{ padding: "8px 10px" }}>Etapa</th>
              <th style={{ padding: "8px 10px" }}>Provedor</th>
              <th style={{ padding: "8px 10px" }}>Modelo</th>
              <th style={{ padding: "8px 10px", textAlign: "right" }}>Custo estimado</th>
            </tr>
          </thead>
          <tbody>
            {custos.porEtapa.map((e, i) => (
              <tr key={`${e.etapa}-${i}`} style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                <td style={{ padding: "9px 10px", color: "#fff" }}>{ROTULO_ETAPA[e.etapa] ?? e.etapa}</td>
                <td style={{ padding: "9px 10px", color: "#9099aa" }}>{e.provedor}</td>
                <td style={{ padding: "9px 10px", color: "#9099aa" }}>{e.modelo}</td>
                <td style={{ padding: "9px 10px", color: "#fff", textAlign: "right", fontWeight: 600 }}>{formatarUsd(e.custoEstimadoUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: "11px", color: "#9099aa", margin: "12px 0 0" }}>
        Valores em dólar, estimados a partir do consumo real de tokens e da tabela de preços oficial dos provedores.
        {custos.temModeloSemPreco && " Alguma etapa aparece com custo zero apesar de ter consumido tokens — modelo sem preço cadastrado, ou consumo registrado antes da instrumentação de custo."}
      </p>
    </Cartao>
  );
}
