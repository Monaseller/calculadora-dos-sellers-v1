/**
 * P1 (filtros) — regras do seletor de lojas do Dashboard (puro, sem I/O; a pagina importa daqui).
 *
 *   estado real   a selecao e um conjunto de `loja_id`; vazio so existe antes de /api/lojas responder e vale "todas"
 *                 (a mesma regra da consulta canonica). Cada quadradinho mostra esse estado — tambem com todas marcadas.
 *   todas         "todas" com todas marcadas; "parcial" com uma parte. Clicar marca todas; com todas marcadas, nao muda.
 *   alternar      marca/desmarca SO a loja clicada; a ultima marcada nao desmarca (nunca selecao vazia).
 *   somente       seleciona exclusivamente a loja.
 *   rotulo        nome real quando o marketplace confirmou; senao marketplace + id externo. Nenhum nome de cliente fixo.
 */

export interface LojaDoSeletor {
  id: string; nome: string; marketplace: string; nickname: string | null;
  seller_id?: string | null; nome_exibicao?: string | null;
}

/** As lojas efetivamente marcadas (vazio = todas), so entre as lojas conhecidas. */
export function marcadasDe(lojas: LojaDoSeletor[], selecionadas: Set<string>): Set<string> {
  if (selecionadas.size === 0) return new Set(lojas.map((l) => l.id));
  return new Set(lojas.filter((l) => selecionadas.has(l.id)).map((l) => l.id));
}

export function estadoTodas(lojas: LojaDoSeletor[], selecionadas: Set<string>): "todas" | "parcial" {
  return lojas.length > 0 && marcadasDe(lojas, selecionadas).size === lojas.length ? "todas" : "parcial";
}

/** Nova selecao ao clicar na loja (null = nada muda). */
export function alternarLoja(lojas: LojaDoSeletor[], selecionadas: Set<string>, id: string): Set<string> | null {
  const atual = marcadasDe(lojas, selecionadas);
  if (!lojas.some((l) => l.id === id)) return null;
  if (atual.has(id)) { if (atual.size === 1) return null; atual.delete(id); }
  else atual.add(id);
  return atual;
}

/** Nova selecao ao clicar em "Todas" (null = ja estao todas: nada muda, nunca esvazia). */
export function selecionarTodas(lojas: LojaDoSeletor[], selecionadas: Set<string>): Set<string> | null {
  if (estadoTodas(lojas, selecionadas) === "todas") return null;
  return new Set(lojas.map((l) => l.id));
}

/** Nova selecao em "Somente esta" (null = ja e a unica marcada). */
export function somenteEsta(lojas: LojaDoSeletor[], selecionadas: Set<string>, id: string): Set<string> | null {
  if (!lojas.some((l) => l.id === id)) return null;
  const atual = marcadasDe(lojas, selecionadas);
  if (atual.size === 1 && atual.has(id)) return null;
  return new Set([id]);
}

const MARKETPLACE: Record<string, string> = { ML: "Mercado Livre", Shopee: "Shopee" };

/** Rotulo inequivoco: nome real + "marketplace · id"; sem nome real, "marketplace · id" + aviso de apelido ausente. */
export function rotuloLoja(l: LojaDoSeletor): { principal: string; secundario: string; temNomeReal: boolean } {
  const mkt = MARKETPLACE[l.marketplace] ?? l.marketplace;
  const id = l.seller_id ? String(l.seller_id).trim() : "";
  const comId = id ? `${mkt} · ${id}` : mkt;
  const exib = (l.nome_exibicao ?? l.nickname ?? l.nome ?? "").trim();
  // fallback tecnico gravado pelo sistema ("<Marketplace> <id>", com o rotulo da identidade ou o codigo do marketplace)
  const tecnicos = new Set([`${mkt}${id ? ` ${id}` : ""}`, `${l.marketplace}${id ? ` ${id}` : ""}`, "Minha Loja"]);
  const temNomeReal = !!exib && !tecnicos.has(exib);
  return temNomeReal
    ? { principal: exib, secundario: comId, temNomeReal }
    : { principal: comId, secundario: "sem apelido cadastrado", temNomeReal };
}

/** Texto do botao do seletor. */
export function rotuloSeletor(lojas: LojaDoSeletor[], selecionadas: Set<string>): string {
  if (lojas.length === 0) return "Minhas lojas";
  const m = marcadasDe(lojas, selecionadas);
  if (m.size === lojas.length) return `Todas as lojas · ${m.size} de ${lojas.length}`;
  if (m.size === 1) { const u = lojas.find((l) => m.has(l.id))!; return `${rotuloLoja(u).principal} · 1 de ${lojas.length}`; }
  return `${m.size} de ${lojas.length} lojas`;
}
