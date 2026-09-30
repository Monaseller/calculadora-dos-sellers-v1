/**
 * O que este agente sabe fazer, em linguagem de gente — F7b.4.5 §20/§21.
 *
 * ── O defeito que este modulo existe para corrigir ──────────────────
 *
 * O Rodrigo adicionou "Planilhas" ao agente e perguntou o que ele sabia
 * fazer. O agente respondeu que tinha `planilha_inspecionar`.
 *
 * Nao era alucinacao: era a verdade que o modelo tinha. As unicas
 * capacidades que ele conhecia eram os NOMES DAS FUNCTIONS declaradas, e
 * esses nomes sao `dominio.acao`. O usuario escolheu "Planilhas" numa
 * tela e recebeu de volta um identificador de implementacao.
 *
 * ── A regra ─────────────────────────────────────────────────────────
 *
 * Nome e descricao vem do CATALOGO DE PACKS — o mesmo `TOOL_PACKS` que a
 * tela usa. Um pack aparece quando o agente tem permissao DECIDIDA para
 * pelo menos uma Funcao dele; `bloqueado` conta, porque o agente
 * realmente tem a capacidade e apenas nao pode usa-la agora.
 *
 * Nunca listar capacidade que o agente nao tem: e o mesmo principio de
 * "nunca inventar dado", aplicado ao que o agente diz de si mesmo.
 *
 * ── Puro de proposito ───────────────────────────────────────────────
 *
 * Sem rede, sem banco, sem `server-only`. Recebe fatos e devolve frases,
 * para que a mesma funcao sirva ao runtime e a tela sem duplicar a
 * traducao em dois lugares.
 */
import { TOOL_PACKS, packDaFuncao } from "@/lib/agentes/factory/catalogo-ui";

export interface Capacidade {
  readonly nome: string;
  readonly descricao: string;
}

/** Os tres niveis que contam como decisao. Ausente nao e capacidade. */
const NIVEIS_DECIDIDOS = new Set(["automatico", "aprovacao", "bloqueado"]);

/**
 * Traduz o slug de um aplicativo externo em nome apresentavel.
 *
 * `googlesheets` -> `Google Sheets`. Deliberadamente simples: o catalogo
 * do Composio tem 1584 toolkits, e manter uma tabela de nomes aqui seria
 * uma segunda fonte de verdade que envelheceria sozinha.
 *
 * Os casos conhecidos ganham nome proprio; o resto recebe capitalizacao,
 * que e melhor que o slug cru e nunca inventa um nome errado.
 */
const NOMES_EXTERNOS: Readonly<Record<string, string>> = Object.freeze({
  googlesheets: "Google Sheets",
  gmail: "Gmail",
  googledrive: "Google Drive",
  googlecalendar: "Google Agenda",
  slack: "Slack",
  notion: "Notion",
  hackernews: "Hacker News",
});

export function nomeDoAplicativo(toolkit: string): string {
  const slug = toolkit.trim().toLowerCase();
  if (slug === "") return "";
  const conhecido = NOMES_EXTERNOS[slug];
  if (conhecido !== undefined) return conhecido;
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

/**
 * As capacidades deste agente.
 *
 * Memoria, arquivos e Skills entram como capacidades tambem: para quem
 * conversa, "eu lembro das nossas conversas" e tao capacidade quanto
 * "eu leio planilhas", e o agente precisa saber dizer as duas.
 */
export function capacidadesDoAgente(entrada: {
  readonly permissoes: readonly { readonly funcaoId: string; readonly nivel: string }[];
  readonly vinculosExternos: readonly { readonly toolkit: string }[];
  readonly memoriaAtiva: boolean;
  readonly temArquivos: boolean;
  readonly temSkills: boolean;
}): readonly Capacidade[] {
  const capacidades: Capacidade[] = [];

  // ── Packs internos ────────────────────────────────────────────────
  //
  // Um pack entra UMA vez, mesmo tendo varias Funcoes decididas: o
  // usuario escolheu "Planilhas", e nao tres linhas.
  const packsPresentes = new Set<string>();
  for (const p of entrada.permissoes) {
    if (!NIVEIS_DECIDIDOS.has(p.nivel)) continue;
    const pack = packDaFuncao(p.funcaoId);
    if (pack === undefined || pack === null) continue;
    packsPresentes.add(pack.id);
  }
  // A ordem segue o CATALOGO, e nao a ordem em que as permissoes vieram
  // do banco: assim a mesma configuracao produz sempre a mesma frase.
  for (const pack of TOOL_PACKS) {
    if (!packsPresentes.has(pack.id)) continue;
    capacidades.push({ nome: pack.nome, descricao: pack.descricao });
  }

  // ── Aplicativos externos ──────────────────────────────────────────
  const toolkits = new Set<string>();
  for (const v of entrada.vinculosExternos) {
    const nome = nomeDoAplicativo(v.toolkit);
    if (nome !== "") toolkits.add(nome);
  }
  for (const nome of [...toolkits].sort()) {
    capacidades.push({
      nome,
      descricao: `Acessar dados e ações do aplicativo ${nome} que você conectou.`,
    });
  }

  // ── Recursos que nao sao Tool, mas sao capacidade ─────────────────
  if (entrada.memoriaAtiva) {
    capacidades.push({
      nome: "Memória de longo prazo",
      descricao:
        "Lembrar de conversas anteriores com você, inclusive de outros chats.",
    });
  }
  if (entrada.temArquivos) {
    capacidades.push({
      nome: "Arquivos do agente",
      descricao: "Consultar os arquivos que você enviou para este agente.",
    });
  }
  if (entrada.temSkills) {
    capacidades.push({
      nome: "Instruções especializadas",
      descricao: "Seguir procedimentos que você configurou para tarefas específicas.",
    });
  }

  return Object.freeze(capacidades);
}
