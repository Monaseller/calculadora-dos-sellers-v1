/**
 * O resolvedor REAL de arquivos — AGENT-FACTORY-F5.
 *
 * ── Ele fecha o contrato que o F3 deixou aberto ─────────────────────
 *
 * O F3 definiu `FonteDeArquivo` — id opaco entra, bytes saem, dono
 * obrigatorio — e deixou o default NEGANDO, porque a infraestrutura de
 * Sources nao existia. Ela existe agora, e este modulo e a
 * implementacao. O contrato nao mudou nem uma linha.
 *
 * ── O que o modelo PODE dizer, e o que ele nao pode ─────────────────
 *
 * Pode: o id de uma fonte que o runtime DECLAROU a ele.
 * Nao pode: dono, agente, caminho, bucket, nada.
 *
 * E o id que ele manda nao e crenca: `userId` e `agenteId` vem da
 * sessao, fechados por quem monta o resolvedor, e a consulta filtra por
 * eles SEMPRE. Um id valido de outro dono simplesmente nao encontra
 * linha — e "nao existe" e "nao e seu" respondem igual, senao a
 * resposta viraria um oraculo para descobrir ids alheios.
 *
 * ── Por que o agente e AMARRADO aqui ────────────────────────────────
 *
 * O resolvedor nasce preso a UM agente. Sem isso, dois agentes do mesmo
 * dono leriam as fontes um do outro — o isolamento pararia no tenant e
 * nao chegaria ao agente, que e onde o lojista espera que ele esteja.
 */
import "server-only";

import { fileIdValido } from "@/lib/agentes/planilhas/fonte";
import type { ArquivoResolvido, FonteDeArquivo } from "@/lib/agentes/planilhas/fonte";
import type { PortaDeFontes } from "@/lib/agentes/fontes/repositorio";
import type { Fonte, FonteParaModelo } from "@/lib/agentes/fontes/tipos";
import { paraModelo } from "@/lib/agentes/fontes/tipos";

/**
 * O `fileId` que o modelo usa e o UUID da fonte.
 *
 * ── Por que nao um apelido efemero de sessao ────────────────────────
 *
 * Um handle curto seria mais bonito no prompt, mas cria um mapa vivo
 * por sessao — mais estado para expirar, mais um lugar onde um handle
 * pode apontar para a fonte errada depois de um replace. O UUID ja e
 * opaco, ja e estavel e ja NAO carrega informacao: nao diz dono, nem
 * caminho, nem ordem.
 *
 * A gramatica de `fileId` do F3 (`[A-Za-z0-9_-]{1,64}`) nao aceita
 * ponto nem barra, e um UUID cabe nela — entao `../x`, `C:\x`,
 * `file://x` e UNC continuam morrendo antes de chegar aqui.
 */
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EntradaDoResolvedor {
  readonly porta: PortaDeFontes;
  /** Da SESSAO. Nunca do modelo. */
  readonly userId: string;
  /** Do runtime. Nunca do modelo. */
  readonly agenteId: string;
  /** Quando houver conversa, os anexos dela tambem resolvem. */
  readonly conversaId?: string;
}

export function criarFonteDeArquivoDasSources(entrada: EntradaDoResolvedor): FonteDeArquivo {
  return {
    async resolver(userId: string, fileId: string): Promise<ArquivoResolvido | null> {
      // Fail-closed na identidade: o `userId` que a Tool passou tem de
      // ser o mesmo que fechou este resolvedor. Divergir aqui e bug de
      // chamada, e devolver `null` calado esconderia.
      if (userId !== entrada.userId) return null;
      // Gramatica do F3 primeiro, forma de UUID depois. Redundante de
      // proposito: sao duas cercas baratas antes de qualquer I/O.
      if (!fileIdValido(fileId) || !RE_UUID.test(fileId)) return null;

      // Fonte do AGENTE. A consulta ja filtra dono, agente e `ativo`.
      const doAgente = await entrada.porta.obterAtiva(
        entrada.userId, fileId, { agenteId: entrada.agenteId });
      const achada = doAgente ?? (entrada.conversaId
        ? await entrada.porta.obterAtiva(
            entrada.userId, fileId, { conversaId: entrada.conversaId })
        : null);
      if (achada === null) return null;

      const bytes = await entrada.porta.lerBytes(achada.caminhoObjeto);
      return {
        fileId: achada.id,
        // Nome LOGICO. O caminho no bucket morre nesta funcao.
        nome: achada.nome,
        extensao: achada.tipo,
        bytes,
      };
    },
  };
}

// ─── O que o modelo recebe sobre as fontes ────────────────────────────

// ─── Quais fontes um TURNO enxerga — F9.1 ─────────────────────────────

/**
 * As fontes do agente seguidas dos anexos da conversa, sem repetir fonte.
 *
 * A identidade e o `id` (uuid da linha), nunca o nome: dois arquivos
 * diferentes podem se chamar "vendas.xlsx", e o mesmo arquivo nao muda de
 * id. O CHECK `agente_fontes_vinculo_coerente` ja impede uma linha de ter
 * os dois escopos; a deduplicacao e a cerca barata para o caso de algum
 * dia uma mesma fonte chegar pelas duas listas. Na repeticao vence a
 * primeira ocorrencia — a do agente, que e a permanente.
 */
export function unirFontesDoTurno(
  doAgente: readonly Fonte[],
  daConversa: readonly Fonte[]
): readonly Fonte[] {
  const vistas = new Set<string>();
  const saida: Fonte[] = [];
  for (const f of [...doAgente, ...daConversa]) {
    if (vistas.has(f.id)) continue;
    vistas.add(f.id);
    saida.push(f);
  }
  return saida;
}

/**
 * Lista o que o modelo pode usar NESTE turno: fontes permanentes do
 * agente e anexos SO desta conversa.
 *
 * Ate o F9.1 o runtime listava apenas `listarDoAgente`. O resolvedor ja
 * abria o anexo da conversa, mas o modelo nunca recebia o id dele — o
 * arquivo aparecia na tela e era invisivel para o agente.
 *
 * `conversaId` PRECISA ter sido conferido pelo chamador como conversa
 * deste dono E deste agente (`obterConversa(userId, ...)` +
 * `conversa.agenteId === agenteId`). A linha de anexo nao guarda
 * `agente_id` — o vinculo dela e a conversa —, entao e essa conferencia
 * que impede um anexo de atravessar para outro agente. As duas consultas
 * filtram `user_id`, escopo e `ativo`.
 */
export async function listarFontesDoTurno(
  porta: PortaDeFontes,
  userId: string,
  agenteId: string,
  conversaId: string
): Promise<readonly Fonte[]> {
  const [doAgente, daConversa] = await Promise.all([
    porta.listarDoAgente(userId, agenteId),
    porta.listarDaConversa(userId, conversaId),
  ]);
  return unirFontesDoTurno(doAgente, daConversa);
}

export interface ContextoDeFontes {
  readonly fontes: readonly FonteParaModelo[];
  readonly texto: string;
}

/**
 * Monta o bloco de fontes para a instrucao do agente.
 *
 * Manda METADADO, nunca bytes: nome, papel, descricao e id. Despejar o
 * conteudo de uma planilha no prompt seria caro, truncaria sozinho e —
 * o pior — devolveria ao modelo o papel de somar, que e exatamente o
 * que `planilha.agregar` existe para tirar dele.
 *
 * Sem fontes, devolve texto VAZIO em vez de "nenhuma fonte": uma frase
 * negativa no prompt convida o modelo a comentar a ausencia, e o
 * silencio e mais honesto.
 */
export function montarContextoDeFontes(fontes: readonly Fonte[]): ContextoDeFontes {
  const paraLLM = fontes.map(paraModelo);
  if (paraLLM.length === 0) return { fontes: [], texto: "" };

  const linhas = paraLLM.map((f) => {
    const partes = [`- ${f.nome} (id: ${f.id}, tipo: ${f.tipo}`];
    if (f.papel) partes.push(`, papel: ${f.papel}`);
    partes.push(")");
    if (f.descricao) partes.push(`\n  ${f.descricao}`);
    return partes.join("");
  });

  return {
    fontes: paraLLM,
    texto:
      "Fontes disponiveis para este agente. Para usar qualquer uma, chame as " +
      "ferramentas de planilha passando o `id` abaixo como `fileId`. Voce NAO " +
      "tem acesso ao conteudo delas sem chamar a ferramenta.\n" +
      linhas.join("\n"),
  };
}
