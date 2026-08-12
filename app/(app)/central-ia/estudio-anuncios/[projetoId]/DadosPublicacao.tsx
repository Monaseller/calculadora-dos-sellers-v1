"use client";

/**
 * Formulário de DADOS DE PUBLICAÇÃO de um canal (2026-08-24).
 *
 * NÃO PUBLICA NADA e NÃO EDITA CONTEÚDO. Configuração de publicação e
 * edição de texto são coisas separadas: o conteúdo tem sua própria camada
 * editorial, com aprovação e versionamento — aqui só entram categoria,
 * preço, estoque, condição, tipo de anúncio e atributos.
 *
 * A categoria **nunca** é digitada livre: o usuário busca e escolhe uma
 * opção real, e o servidor confere de novo contra a API do Mercado Livre
 * antes de gravar. As condições oferecidas são as que a categoria
 * escolhida declara — não uma lista fixa no código.
 */
import { useState } from "react";

export interface PublicacaoCanalDTO {
  marketplace: string;
  /** Conta vinculada ao canal. **Nunca acompanha token.** */
  lojaId: string | null;
  lojaVinculadaEm: string | null;
  /** Tipos que a CONTA permite; `null` enquanto não verificado com OAuth. */
  tiposAnuncioDisponiveis: { id: string; nome: string }[] | null;
  categoryId: string | null;
  categoriaNome: string | null;
  categoriaCaminho: string | null;
  categoriaVerificadaEm: string | null;
  condicoesAceitas: string[];
  condicao: string | null;
  tipoAnuncioId: string | null;
  moeda: string | null;
  precoCentavos: number | null;
  estoque: number | null;
  atributos: { id: string; value_name: string }[];
  atributosObrigatorios: { id: string; nome: string; condicional: boolean }[];
  /** Modelo da conta e nome da família (User Products, 2026-08-26). */
  modeloPublicacao: "user_products" | "legacy" | null;
  familyName: string | null;
  /** Embalagem de ENVIO — cm e g, unidades do Mercado Livre. */
  embalagemPesoG: number | null;
  embalagemAlturaCm: number | null;
  embalagemLarguraCm: number | null;
  embalagemComprimentoCm: number | null;
  /** SUGESTÃO do servidor a partir do título aprovado — nunca gravada sozinha. */
  sugestaoFamilyName: string | null;
  /** Limite oficial da categoria — nunca um número fixo na UI. */
  maxTitleLength: number | null;
  atualizadoEm: string | null;
}

interface SugestaoCategoria {
  categoryId: string;
  categoriaNome: string;
  caminho: string;
  ehFolha: boolean | null;
  permitePublicar: boolean | null;
}

/** Rótulos amigáveis; o valor enviado é sempre o oficial da API. */
const ROTULO_CONDICAO: Record<string, string> = {
  new: "Novo",
  used: "Usado",
  not_specified: "Não especificado",
  refurbished: "Recondicionado",
};

const ROTULO_TIPO_ANUNCIO: Record<string, string> = {
  gold_pro: "Premium (gold_pro)",
  gold_special: "Clássico (gold_special)",
  silver: "Silver (silver)",
  bronze: "Bronze (bronze)",
};
const TIPOS_ANUNCIO = ["gold_special", "gold_pro", "silver", "bronze"];

/**
 * Atributos que o compliance cobra em praticamente todo anúncio, mesmo
 * quando a categoria não os devolve na lista de obrigatórios. Ficam
 * sempre visíveis porque a alternativa — só aparecer depois que o
 * Mercado Livre reclama — foi exatamente o que travou o fluxo antes.
 *
 * `nome` é rótulo de tela; o `id` enviado é sempre o oficial da API.
 */
const ATRIBUTOS_UNIVERSAIS: { id: string; nome: string; exemplo: string }[] = [
  { id: "BRAND", nome: "Marca", exemplo: "Ex.: Tramontina" },
  { id: "MODEL", nome: "Modelo", exemplo: "Ex.: 44320/108" },
  { id: "GTIN", nome: "Código de barras (EAN/GTIN)", exemplo: "Ex.: 7891234567895" },
  { id: "SELLER_SKU", nome: "SKU interno", exemplo: "Seu código de controle" },
];

/**
 * Exemplos por atributo conhecido. Sem entrada aqui, o campo fica sem
 * placeholder — melhor vazio do que um exemplo inventado, que a pessoa
 * poderia copiar como se fosse valor válido.
 */
const EXEMPLO_ATRIBUTO: Record<string, string> = {
  ...Object.fromEntries(ATRIBUTOS_UNIVERSAIS.map(a => [a.id, a.exemplo])),
  EAN: "Ex.: 7891234567895",
  COLOR: "Ex.: Vermelho",
  MATERIAL: "Ex.: Aço inox",
  LENGTH: "Ex.: 20 cm",
  ITEM_CONDITION: "Ex.: Novo",
};

const rotulo: React.CSSProperties = {
  display: "block", fontSize: "11px", fontWeight: 700, color: "#9099aa",
  textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "6px",
};
const campo: React.CSSProperties = {
  width: "100%", padding: "9px 11px", borderRadius: "8px", fontSize: "13px",
  background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.14)",
  color: "#fff", boxSizing: "border-box",
};

/** Centavos → "199,90" para exibição; a conversão de volta é exata. */
function centavosParaTexto(c: number | null): string {
  if (c == null) return "";
  return (c / 100).toFixed(2).replace(".", ",");
}

/**
 * "199,90" → 19990. Feito com string, nunca `parseFloat * 100`, que
 * produz 19989.999... e perde centavo.
 */
export function textoParaCentavos(texto: string): number | null {
  const limpo = texto.trim().replace(/\s|R\$/g, "").replace(/\./g, "").replace(",", ".");
  if (!/^\d+(\.\d{0,2})?$/.test(limpo)) return null;
  const [inteira, decimal = ""] = limpo.split(".");
  return Number(inteira) * 100 + Number(decimal.padEnd(2, "0"));
}

export function FormularioPublicacao({
  projetoId, canal, tituloAprovado, onSalvo,
}: {
  projetoId: string;
  canal: PublicacaoCanalDTO;
  /** Só para SUGERIR o nome da família — nunca é gravado sozinho. */
  tituloAprovado?: string | null;
  onSalvo: () => void | Promise<void>;
}) {
  const [preco, setPreco] = useState(centavosParaTexto(canal.precoCentavos));
  const [estoque, setEstoque] = useState(canal.estoque == null ? "" : String(canal.estoque));
  const [condicao, setCondicao] = useState(canal.condicao ?? "");
  const [tipo, setTipo] = useState(canal.tipoAnuncioId ?? "");
  // Sugestão inicial a partir do título aprovado, marcada como sugestão
  // e editável. Nunca vira dado confirmado sozinho: só é gravada quando a
  // pessoa clica em salvar.
  const [familia, setFamilia] = useState(canal.familyName ?? canal.sugestaoFamilyName ?? "");
  const [familiaSugerida, setFamiliaSugerida] = useState(!canal.familyName && !!canal.sugestaoFamilyName);
  const num = (v: number | null) => (v == null ? "" : String(v));
  const [pesoEmb, setPesoEmb] = useState(num(canal.embalagemPesoG));
  const [alturaEmb, setAlturaEmb] = useState(num(canal.embalagemAlturaCm));
  const [larguraEmb, setLarguraEmb] = useState(num(canal.embalagemLarguraCm));
  const [comprimentoEmb, setComprimentoEmb] = useState(num(canal.embalagemComprimentoCm));
  // Atributos gravados, indexados por id oficial do Mercado Livre. Vem do
  // que já foi salvo — nunca de valor inventado pela tela.
  const [atributos, setAtributos] = useState<Record<string, string>>(() =>
    Object.fromEntries(canal.atributos.map(a => [a.id, a.value_name]))
  );
  const [busca, setBusca] = useState("");
  const [sugestoes, setSugestoes] = useState<SugestaoCategoria[] | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const base = `/api/estudio-anuncios/projetos/${projetoId}/marketplaces/mercado-livre`;

  /**
   * Campos de atributo mostrados na tela, nesta ordem:
   * 1. os exigidos pela categoria escolhida (fonte: API do Mercado Livre);
   * 2. os universais que ainda não apareceram em (1);
   * 3. os já gravados que não estão em nenhum dos anteriores — sem isto,
   *    trocar de categoria esconderia um valor salvo sem apagá-lo, e a
   *    pessoa não teria como editar o que continuaria sendo enviado.
   */
  const camposAtributos: { id: string; nome: string; obrigatorio: boolean; exemplo: string }[] = (() => {
    const vistos = new Set<string>();
    const lista: { id: string; nome: string; obrigatorio: boolean; exemplo: string }[] = [];

    for (const a of canal.atributosObrigatorios) {
      vistos.add(a.id);
      lista.push({
        id: a.id,
        nome: a.nome + (a.condicional ? " (condicional)" : ""),
        // Condicional não é obrigatório sempre — marcar com * seria
        // pedir como certo o que o Mercado Livre trata como "depende".
        obrigatorio: !a.condicional,
        exemplo: EXEMPLO_ATRIBUTO[a.id] ?? "",
      });
    }
    for (const a of ATRIBUTOS_UNIVERSAIS) {
      if (vistos.has(a.id)) continue;
      vistos.add(a.id);
      lista.push({ id: a.id, nome: a.nome, obrigatorio: false, exemplo: a.exemplo });
    }
    for (const a of canal.atributos) {
      if (vistos.has(a.id)) continue;
      vistos.add(a.id);
      lista.push({ id: a.id, nome: a.id, obrigatorio: false, exemplo: EXEMPLO_ATRIBUTO[a.id] ?? "" });
    }
    return lista;
  })();

  async function buscarCategorias() {
    setBuscando(true);
    setErro(null);
    setSugestoes(null);
    try {
      const res = await fetch(`${base}/categorias?q=${encodeURIComponent(busca)}`);
      const data = await res.json();
      if (!res.ok || !data.ok) setErro(data.erro || "Não foi possível buscar categorias.");
      else setSugestoes(data.sugestoes ?? []);
    } catch {
      setErro("Falha de conexão ao buscar categorias.");
    } finally {
      setBuscando(false);
    }
  }

  async function enviar(corpo: Record<string, unknown>, mensagem?: string) {
    setSalvando(true);
    setErro(null);
    setAviso(null);
    try {
      const res = await fetch(base, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(corpo),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErro(data.erro || "Não foi possível salvar.");
        return false;
      }
      if (mensagem) setAviso(mensagem);
      await onSalvo();
      return true;
    } catch {
      setErro("Falha de conexão ao salvar.");
      return false;
    } finally {
      setSalvando(false);
    }
  }

  async function selecionarCategoria(s: SugestaoCategoria) {
    const ok = await enviar({ categoryId: s.categoryId }, `Categoria "${s.categoriaNome}" salva e verificada no Mercado Livre.`);
    if (ok) {
      setSugestoes(null);
      setBusca("");
      // A condição salva pode não valer na categoria nova.
      setCondicao("");
    }
  }

  async function salvarDados() {
    const corpo: Record<string, unknown> = {};

    if (preco.trim() !== "") {
      const centavos = textoParaCentavos(preco);
      if (centavos == null || centavos <= 0) {
        setErro("Preço inválido. Use o formato 199,90.");
        return;
      }
      corpo.precoCentavos = centavos;
    }
    if (estoque.trim() !== "") {
      if (!/^\d+$/.test(estoque.trim())) {
        setErro("Estoque deve ser um número inteiro.");
        return;
      }
      corpo.estoque = Number(estoque.trim());
    }
    if (condicao) corpo.condicao = condicao;
    if (canal.modeloPublicacao === "user_products" && familia.trim() !== "" && familia.trim() !== canal.familyName) {
      corpo.familyName = familia.trim();
    }
    if (tipo) corpo.tipoAnuncioId = tipo;

    // Embalagem: INTEIRO, nas unidades do ML (g e cm). Digitou "13,5"?
    // A UI reclama — não arredonda. O Mercado Livre só aceita inteiro
    // aqui, e transformar 13,5 em 13 ou 14 publicaria uma caixa que
    // ninguém mediu.
    const medida = (texto: string, rotuloCampo: string): number | null | "erro" => {
      const t = texto.trim().replace(",", ".");
      if (t === "") return null;
      if (/^\d+[.,]\d+$/.test(t)) {
        setErro(`${rotuloCampo} deve ser um número inteiro — o Mercado Livre não aceita casas decimais aqui. Informe o valor arredondado por você, não pelo sistema.`);
        return "erro";
      }
      if (!/^\d+$/.test(t) || Number(t) <= 0) {
        setErro(`${rotuloCampo} deve ser um número inteiro maior que zero.`);
        return "erro";
      }
      return Number(t);
    };
    const mapa: [string, string, string][] = [
      [pesoEmb, "embalagemPesoG", "O peso da embalagem"],
      [alturaEmb, "embalagemAlturaCm", "A altura da embalagem"],
      [larguraEmb, "embalagemLarguraCm", "A largura da embalagem"],
      [comprimentoEmb, "embalagemComprimentoCm", "O comprimento da embalagem"],
    ];
    for (const [texto, chave, rotuloCampo] of mapa) {
      const v = medida(texto, rotuloCampo);
      if (v === "erro") return;
      if (v != null) corpo[chave] = v;
    }

    // Atributos: só entram no corpo se mudaram. Campo em branco significa
    // "não informado" e some da lista — apagar é uma edição legítima, não
    // um valor vazio para o Mercado Livre.
    const atributosLimpos = Object.entries(atributos)
      .map(([id, valor]) => ({ id, value_name: valor.trim() }))
      .filter(a => a.value_name !== "")
      .sort((a, b) => a.id.localeCompare(b.id));
    const atributosAtuais = [...canal.atributos]
      .map(a => ({ id: a.id, value_name: a.value_name }))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (JSON.stringify(atributosLimpos) !== JSON.stringify(atributosAtuais)) {
      corpo.atributos = atributosLimpos;
    }

    if (Object.keys(corpo).length === 0) {
      setErro("Nada para salvar.");
      return;
    }
    await enviar(corpo, "Dados de publicação salvos. Valide novamente para atualizar o parecer.");
  }

  return (
    <div style={{ marginTop: "14px", paddingTop: "14px", borderTop: "1px solid rgba(255,255,255,0.07)" }}>
      <h3 style={{ fontSize: "13px", fontWeight: 800, color: "#fff", margin: "0 0 4px" }}>Dados de publicação</h3>
      <p style={{ fontSize: "11.5px", color: "#9099aa", margin: "0 0 14px", lineHeight: 1.5 }}>
        Configuração do canal — não altera o conteúdo aprovado. Nada é publicado aqui.
      </p>

      {erro && (
        <div style={{ background: "rgba(255,80,80,0.08)", border: "1px solid rgba(255,80,80,0.3)", borderRadius: "8px", padding: "8px 12px", color: "#ff6b6b", fontSize: "12px", fontWeight: 600, marginBottom: "12px" }}>
          {erro}
        </div>
      )}
      {aviso && (
        <div style={{ background: "rgba(0,217,126,0.08)", border: "1px solid rgba(0,217,126,0.3)", borderRadius: "8px", padding: "8px 12px", color: "#00D97E", fontSize: "12px", fontWeight: 600, marginBottom: "12px" }}>
          {aviso}
        </div>
      )}

      {/* ── Categoria ─────────────────────────────────────────────── */}
      <div style={{ marginBottom: "16px" }}>
        <label style={rotulo}>Categoria do Mercado Livre</label>
        {canal.categoryId ? (
          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: "13px", color: "#fff", overflowWrap: "anywhere", minWidth: 0 }}>
              {canal.categoriaCaminho ?? canal.categoriaNome}{" "}
              <code style={{ fontFamily: "monospace", color: "#9099aa" }}>({canal.categoryId})</code>
            </span>
            <button
              type="button"
              onClick={() => enviar({ categoryId: null }, "Categoria removida.")}
              disabled={salvando}
              style={{ padding: "4px 10px", borderRadius: "6px", border: "1px solid rgba(255,255,255,0.18)", background: "transparent", color: "#9099aa", fontSize: "11px", fontWeight: 600, cursor: "pointer" }}
            >
              Trocar
            </button>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <input
                style={{ ...campo, flex: "1 1 200px" }}
                value={busca}
                onChange={e => setBusca(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && busca.trim().length >= 3) buscarCategorias(); }}
                placeholder="Descreva o produto ou cole um MLB..."
              />
              <button
                type="button"
                onClick={buscarCategorias}
                disabled={buscando || busca.trim().length < 3}
                style={{ padding: "9px 16px", borderRadius: "8px", border: "none", fontSize: "12px", fontWeight: 800, background: "rgba(255,255,255,0.12)", color: "#fff", cursor: buscando ? "not-allowed" : "pointer" }}
              >
                {buscando ? "Buscando..." : "Buscar"}
              </button>
            </div>
            {sugestoes && (
              <div style={{ marginTop: "10px", display: "grid", gap: "6px" }}>
                {sugestoes.length === 0 ? (
                  <p style={{ fontSize: "12px", color: "#9099aa", margin: 0 }}>
                    Nenhuma categoria encontrada. Tente outras palavras.
                  </p>
                ) : (
                  sugestoes.map(s => (
                    <button
                      key={s.categoryId}
                      type="button"
                      onClick={() => selecionarCategoria(s)}
                      disabled={salvando}
                      style={{ textAlign: "left", padding: "9px 12px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.03)", color: "#fff", fontSize: "12.5px", cursor: "pointer", overflowWrap: "anywhere" }}
                    >
                      {s.caminho}{" "}
                      <code style={{ fontFamily: "monospace", color: "#9099aa" }}>({s.categoryId})</code>
                      {s.permitePublicar === false && (
                        <span style={{ color: "#FFD166", display: "block", fontSize: "11px", marginTop: "2px" }}>
                          Esta categoria não aceita publicação direta.
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Preço, estoque, condição, tipo ────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "12px" }}>
        <div>
          <label style={rotulo}>Preço {canal.moeda ? `(${canal.moeda})` : ""}</label>
          <input style={campo} value={preco} onChange={e => setPreco(e.target.value)} placeholder="199,90" inputMode="decimal" />
        </div>
        <div>
          <label style={rotulo}>Estoque</label>
          <input style={campo} value={estoque} onChange={e => setEstoque(e.target.value)} placeholder="0" inputMode="numeric" />
        </div>
        <div>
          <label style={rotulo}>Condição</label>
          <select style={campo} value={condicao} onChange={e => setCondicao(e.target.value)} disabled={canal.condicoesAceitas.length === 0}>
            <option value="">
              {canal.condicoesAceitas.length === 0 ? "Escolha a categoria primeiro" : "Selecione..."}
            </option>
            {/* As opções são as que a categoria declara — nunca uma lista fixa. */}
            {canal.condicoesAceitas.map(c => (
              <option key={c} value={c}>{ROTULO_CONDICAO[c] ?? c}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={rotulo}>Tipo de anúncio</label>
          <select style={campo} value={tipo} onChange={e => setTipo(e.target.value)}>
            <option value="">Selecione...</option>
            {TIPOS_ANUNCIO.map(t => (
              <option key={t} value={t}>{ROTULO_TIPO_ANUNCIO[t] ?? t}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Nome da família (só no modelo User Products) ──────────── */}
      {canal.modeloPublicacao === "user_products" && (
        <div style={{ marginTop: "14px" }}>
          <label style={rotulo}>
            Nome da família no Mercado Livre
            {canal.maxTitleLength != null && (
              <span style={{ float: "right", color: familia.length > canal.maxTitleLength ? "#ff6b6b" : "#9099aa", fontWeight: 600 }}>
                {familia.length} / {canal.maxTitleLength}
              </span>
            )}
          </label>
          <input
            style={{
              ...campo,
              borderColor: canal.maxTitleLength != null && familia.length > canal.maxTitleLength
                ? "rgba(255,80,80,0.5)" : "rgba(255,255,255,0.14)",
            }}
            value={familia}
            onChange={e => { setFamilia(e.target.value); setFamiliaSugerida(false); }}
            placeholder="Nome genérico do produto"
          />
          <p style={{ fontSize: "11px", color: "#9099aa", margin: "6px 0 0", lineHeight: 1.5 }}>
            Nesta conta o Mercado Livre usa o modelo <strong style={{ color: "#cdd3dd" }}>User Products</strong>:
            o <strong style={{ color: "#cdd3dd" }}>título final do anúncio será gerado pelo Mercado Livre</strong> a
            partir dos dados do produto. Este campo é o nome <em>genérico</em> da família — é ele que agrupa as
            variações, e não substitui o título do seu conteúdo aprovado.
            {familiaSugerida && (
              <span style={{ color: "#FFD166", display: "block", marginTop: "4px" }}>
                Sugestão a partir do título aprovado — revise antes de salvar.
              </span>
            )}
          </p>
        </div>
      )}

      {/* ── Dados logísticos da EMBALAGEM ─────────────────────────── */}
      <div style={{ marginTop: "16px", paddingTop: "14px", borderTop: "1px solid rgba(255,255,255,0.07)" }}>
        <h4 style={{ fontSize: "12px", fontWeight: 800, color: "#fff", margin: "0 0 4px" }}>Dados logísticos</h4>
        <p style={{ fontSize: "11px", color: "#9099aa", margin: "0 0 10px", lineHeight: 1.5 }}>
          Medidas da <strong style={{ color: "#cdd3dd" }}>embalagem utilizada no envio</strong> — a caixa já fechada,
          com enchimento e fita. Não são as medidas do produto.
          <br />
          O Mercado Livre aceita <strong style={{ color: "#cdd3dd" }}>apenas números inteiros</strong> nestes
          quatro campos. Nada é arredondado para você: se a caixa tem 13,5 cm, quem decide entre 13 e 14 é você.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "12px" }}>
          <div>
            <label style={rotulo}>Peso da embalagem (g)</label>
            <input style={campo} value={pesoEmb} onChange={e => setPesoEmb(e.target.value)}
              placeholder="420" type="number" step={1} min={1} inputMode="numeric" />
          </div>
          <div>
            <label style={rotulo}>Altura da embalagem (cm)</label>
            <input style={campo} value={alturaEmb} onChange={e => setAlturaEmb(e.target.value)}
              placeholder="8" type="number" step={1} min={1} inputMode="numeric" />
          </div>
          <div>
            <label style={rotulo}>Largura da embalagem (cm)</label>
            <input style={campo} value={larguraEmb} onChange={e => setLarguraEmb(e.target.value)}
              placeholder="13" type="number" step={1} min={1} inputMode="numeric" />
          </div>
          <div>
            <label style={rotulo}>Comprimento da embalagem (cm)</label>
            <input style={campo} value={comprimentoEmb} onChange={e => setComprimentoEmb(e.target.value)}
              placeholder="23" type="number" step={1} min={1} inputMode="numeric" />
          </div>
        </div>
      </div>

      {/* ── Atributos do produto ────────────────────────────────────
          Até 2026-09-04 este bloco era um parágrafo que apenas LISTAVA
          o que a categoria exige — a tela dizia o que faltava e não
          dava onde escrever. Como `ml_atributo_obrigatorio_ausente` e
          GTIN/marca/modelo são cobrados pelo compliance, o fluxo travava
          num requisito que a interface não permitia atender. Agora cada
          atributo tem campo próprio. */}
      <div style={{ marginTop: "16px", paddingTop: "14px", borderTop: "1px solid rgba(255,255,255,0.07)" }}>
        <h4 style={{ fontSize: "12px", fontWeight: 800, color: "#fff", margin: "0 0 4px" }}>Atributos do produto</h4>
        <p style={{ fontSize: "11px", color: "#9099aa", margin: "0 0 10px", lineHeight: 1.5 }}>
          Preencha o que você sabe do produto. Os marcados com{" "}
          <strong style={{ color: "#ff6b6b" }}>*</strong> são exigidos pela categoria escolhida —
          sem eles o Mercado Livre recusa o anúncio. Campo em branco não é enviado.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "12px" }}>
          {camposAtributos.map(atr => (
            <div key={atr.id}>
              <label style={rotulo}>
                {atr.nome}
                {atr.obrigatorio && <span style={{ color: "#ff6b6b" }}> *</span>}
              </label>
              <input
                style={atr.obrigatorio && !(atributos[atr.id] ?? "").trim()
                  ? { ...campo, borderColor: "rgba(255,107,107,0.45)" }
                  : campo}
                value={atributos[atr.id] ?? ""}
                onChange={e => setAtributos(a => ({ ...a, [atr.id]: e.target.value }))}
                placeholder={atr.exemplo}
                maxLength={255}
              />
            </div>
          ))}
        </div>
        {canal.atributosObrigatorios.some(a => a.condicional) && (
          <p style={{ fontSize: "11px", color: "#9099aa", margin: "10px 0 0", lineHeight: 1.5 }}>
            Atributos marcados como <em>condicional</em> pelo Mercado Livre podem ser exigidos
            dependendo dos outros valores informados.
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={salvarDados}
        disabled={salvando}
        style={{
          marginTop: "14px", padding: "9px 18px", borderRadius: "9px", border: "none", fontSize: "13px", fontWeight: 800,
          background: salvando ? "rgba(255,182,0,0.3)" : "linear-gradient(135deg, #FFB600 0%, #FF6B00 100%)",
          color: "#000", cursor: salvando ? "not-allowed" : "pointer",
        }}
      >
        {salvando ? "Salvando..." : "Salvar dados de publicação"}
      </button>
    </div>
  );
}
