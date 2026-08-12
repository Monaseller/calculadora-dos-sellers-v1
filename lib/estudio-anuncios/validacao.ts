/**
 * Validação de entrada do CRUD do Projeto Mestre. Só validação de
 * formato/domínio (o que o CHECK do banco também garante, mas checado
 * aqui antes para devolver 400 com mensagem clara em vez de estourar
 * erro cru do Postgres). Nenhuma consulta ao banco acontece aqui.
 */
import type { CriarProjetoInput, EditarProjetoInput, ModoGeracao, EstiloProjeto, Marketplace } from "./tipos";

export const MARKETPLACES_VALIDOS: Marketplace[] = ["ML", "Shopee", "Amazon", "TikTok Shop"];

export const ESTILOS_VALIDOS: EstiloProjeto[] = [
  "minimalista", "premium", "tecnologico", "luxo", "clean", "infantil", "marketplace",
];

const QUANTIDADES_MODO_RAPIDO = [4, 6, 8, 10];

type ResultadoValidacao<T> = { valido: true; dados: T } | { valido: false; erro: string };

function validarModo(valor: unknown): { ok: true; modo: ModoGeracao } | { ok: false; erro: string } {
  if (valor === undefined) return { ok: true, modo: "rapido" };
  if (valor !== "rapido" && valor !== "profissional") {
    return { ok: false, erro: 'modo deve ser "rapido" ou "profissional".' };
  }
  return { ok: true, modo: valor };
}

function validarQuantidadeImagens(
  valor: unknown,
  modo: ModoGeracao
): { ok: true; quantidade: number } | { ok: false; erro: string } {
  if (valor === undefined || valor === null) {
    return { ok: false, erro: "quantidade_imagens é obrigatório." };
  }
  if (typeof valor !== "number" || !Number.isInteger(valor) || valor <= 0) {
    return { ok: false, erro: "quantidade_imagens deve ser um número inteiro positivo." };
  }
  if (modo === "rapido" && !QUANTIDADES_MODO_RAPIDO.includes(valor)) {
    return { ok: false, erro: `No modo rápido, quantidade_imagens deve ser um de: ${QUANTIDADES_MODO_RAPIDO.join(", ")}.` };
  }
  return { ok: true, quantidade: valor };
}

function validarEstilo(valor: unknown): { ok: true; estilo: EstiloProjeto | null } | { ok: false; erro: string } {
  if (valor === undefined || valor === null) return { ok: true, estilo: null };
  if (typeof valor !== "string" || !ESTILOS_VALIDOS.includes(valor as EstiloProjeto)) {
    return { ok: false, erro: `estilo deve ser um de: ${ESTILOS_VALIDOS.join(", ")} (ou omitido).` };
  }
  return { ok: true, estilo: valor as EstiloProjeto };
}

function validarPermitirBuscaExterna(valor: unknown): { ok: true; valor: boolean } | { ok: false; erro: string } {
  if (valor === undefined) return { ok: true, valor: false };
  if (typeof valor !== "boolean") {
    return { ok: false, erro: "permitir_busca_externa deve ser um booleano (true/false)." };
  }
  return { ok: true, valor };
}

function validarNomeProduto(valor: unknown): { ok: true; nome: string } | { ok: false; erro: string } {
  if (typeof valor !== "string") return { ok: false, erro: "nome_produto é obrigatório." };
  const nome = valor.trim().replace(/\s+/g, " ");
  if (!nome) return { ok: false, erro: "nome_produto não pode ser vazio." };
  return { ok: true, nome };
}

function validarMarketplaces(valor: unknown): { ok: true; marketplaces: Marketplace[] } | { ok: false; erro: string } {
  if (!Array.isArray(valor) || valor.length === 0) {
    return { ok: false, erro: "marketplaces é obrigatório e deve ser uma lista não vazia." };
  }
  for (const m of valor) {
    if (typeof m !== "string" || !MARKETPLACES_VALIDOS.includes(m as Marketplace)) {
      return { ok: false, erro: `marketplaces só aceita: ${MARKETPLACES_VALIDOS.join(", ")}.` };
    }
  }
  const semDuplicatas = Array.from(new Set(valor as Marketplace[]));
  if (semDuplicatas.length === 0) {
    return { ok: false, erro: "É necessário pelo menos um marketplace." };
  }
  return { ok: true, marketplaces: semDuplicatas };
}

export function validarCriarProjeto(body: unknown): ResultadoValidacao<CriarProjetoInput> {
  if (typeof body !== "object" || body === null) {
    return { valido: false, erro: "Corpo da requisição inválido." };
  }
  const b = body as Record<string, unknown>;

  const nome = validarNomeProduto(b.nome_produto);
  if (!nome.ok) return { valido: false, erro: nome.erro };

  const marketplaces = validarMarketplaces(b.marketplaces);
  if (!marketplaces.ok) return { valido: false, erro: marketplaces.erro };

  const modo = validarModo(b.modo);
  if (!modo.ok) return { valido: false, erro: modo.erro };

  const quantidade = validarQuantidadeImagens(b.quantidade_imagens, modo.modo);
  if (!quantidade.ok) return { valido: false, erro: quantidade.erro };

  const estilo = validarEstilo(b.estilo);
  if (!estilo.ok) return { valido: false, erro: estilo.erro };

  const buscaExterna = validarPermitirBuscaExterna(b.permitir_busca_externa);
  if (!buscaExterna.ok) return { valido: false, erro: buscaExterna.erro };

  return {
    valido: true,
    dados: {
      nome_produto: nome.nome,
      marketplaces: marketplaces.marketplaces,
      quantidade_imagens: quantidade.quantidade,
      modo: modo.modo,
      permitir_busca_externa: buscaExterna.valor,
      estilo: estilo.estilo,
    },
  };
}

const CAMPOS_EDITAVEIS = new Set([
  "nome_produto",
  "quantidade_imagens_solicitada",
  "modo",
  "estilo",
  "permitir_busca_externa",
]);

/**
 * Valida o corpo do PATCH. `modoAtual` é o modo já salvo no projeto —
 * usado para validar quantidade_imagens_solicitada quando o corpo não
 * está trocando o modo junto (ver lib/estudio-anuncios/projetos.ts).
 */
export function validarEditarProjeto(
  body: unknown,
  modoAtual: ModoGeracao
): ResultadoValidacao<EditarProjetoInput> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { valido: false, erro: "Corpo da requisição inválido." };
  }
  const b = body as Record<string, unknown>;
  const chaves = Object.keys(b);

  if (chaves.length === 0) {
    return { valido: false, erro: "Corpo da requisição não pode ser vazio." };
  }

  const chaveProibida = chaves.find(k => !CAMPOS_EDITAVEIS.has(k));
  if (chaveProibida) {
    return { valido: false, erro: `Campo "${chaveProibida}" não pode ser editado por esta rota.` };
  }

  const dados: EditarProjetoInput = {};

  let modoEfetivo = modoAtual;
  if ("modo" in b) {
    const modo = validarModo(b.modo);
    if (!modo.ok) return { valido: false, erro: modo.erro };
    dados.modo = modo.modo;
    modoEfetivo = modo.modo;
  }

  if ("nome_produto" in b) {
    const nome = validarNomeProduto(b.nome_produto);
    if (!nome.ok) return { valido: false, erro: nome.erro };
    dados.nome_produto = nome.nome;
  }

  if ("quantidade_imagens_solicitada" in b) {
    const quantidade = validarQuantidadeImagens(b.quantidade_imagens_solicitada, modoEfetivo);
    if (!quantidade.ok) return { valido: false, erro: quantidade.erro };
    dados.quantidade_imagens_solicitada = quantidade.quantidade;
  }

  if ("estilo" in b) {
    const estilo = validarEstilo(b.estilo);
    if (!estilo.ok) return { valido: false, erro: estilo.erro };
    dados.estilo = estilo.estilo;
  }

  if ("permitir_busca_externa" in b) {
    if (typeof b.permitir_busca_externa !== "boolean") {
      return { valido: false, erro: "permitir_busca_externa deve ser um booleano (true/false)." };
    }
    dados.permitir_busca_externa = b.permitir_busca_externa;
  }

  return { valido: true, dados };
}
