/**
 * O que tem dentro deste arquivo — AGENT-FACTORY-F7b.3.
 *
 * GET  abas, linhas, cabecalhos e avisos de UMA fonte do agente.
 *
 * ── Para que serve ──────────────────────────────────────────────────
 *
 * Depois de subir uma planilha, a Factory pergunta "o que este arquivo
 * representa?". Perguntar isso sem mostrar o que tem dentro e pedir para
 * a pessoa adivinhar — ela acabou de escolher um arquivo entre vinte, e
 * o nome nem sempre diz. Esta rota e o que faz a pergunta ser
 * respondivel: mostra as abas, quantas linhas e quais colunas.
 *
 * ── NAO passa pelo guard, e isso e deliberado ───────────────────────
 *
 * O guard de Funcoes existe para cercar o MODELO: ele decide se o agente
 * pode usar uma ferramenta. Aqui quem pergunta e o DONO, sobre o proprio
 * arquivo, pela propria tela — e ele ja atravessou `atravessarPorta`,
 * que provou sessao e propriedade do agente.
 *
 * Exigir permissao de `planilha.inspecionar` para o dono ver o proprio
 * upload inverteria o sentido da cerca: a pessoa teria de dar permissao
 * ao agente para poder configurar o agente. E pior — ela nao teria como
 * decidir a permissao sem antes ver o arquivo.
 *
 * Nenhuma linha de auditoria de Funcao e escrita aqui, pelo mesmo
 * motivo: `agente_funcao_chamadas` registra o que o AGENTE fez. Um
 * registro nosso ali diria que o agente leu a planilha quando foi o dono
 * quem abriu a tela.
 *
 * ── Reusa o executor da Tool, nao reimplementa ──────────────────────
 *
 * A forma da inspecao (abas, linhas, cabecalhos, aviso de formula, aviso
 * de texto que parece formula) sai de `executarInspecionar` — o MESMO
 * codigo que responde ao modelo. Duas inspecoes divergiriam, e o dia em
 * que divergissem a tela diria uma coisa e o agente veria outra.
 */
import {
  criarFonteDeArquivoDasSources,
} from "@/lib/agentes/fontes/resolvedor";
import { criarPortaDeFontes } from "@/lib/agentes/fontes/repositorio";
import { executarInspecionar, registrarFonteDeArquivo } from "@/lib/agentes/funcoes/planilha";
import { atravessarPorta, responder, UUID_REGEX } from "@/lib/agentes/api/porta";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

export const dynamic = "force-dynamic";

const FALHA = "Nao foi possivel ler este arquivo.";

/**
 * Tipos que a inspecao entende.
 *
 * Um dia pode entrar PDF ou imagem; hoje a inspecao e de planilha, e
 * dizer "nao sei inspecionar isto" e melhor que devolver uma estrutura
 * vazia que a tela leria como "planilha sem abas".
 */
const TIPOS_INSPECIONAVEIS = Object.freeze(["xlsx", "csv"] as const);

export async function GET(
  request: Request,
  { params }: { params: { agenteId: string; fonteId: string } }
) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;
    if (!UUID_REGEX.test(params.fonteId)) {
      return responder({ ok: false, erro: "fonteId inválido." }, 400);
    }

    const portaF = criarPortaDeFontes(getSupabaseServidor());

    // A fonte tem de ser DESTE agente. O resolvedor abaixo tambem escopa,
    // mas conferir aqui deixa a 404 honesta: "nao e sua" e "nao existe"
    // respondem igual, de proposito.
    const doAgente = await portaF.obterAtiva(
      porta.userId, params.fonteId, { agenteId: porta.agenteId });
    if (!doAgente) return responder({ ok: false, erro: "Arquivo não encontrado." }, 404);

    if (!(TIPOS_INSPECIONAVEIS as readonly string[]).includes(doAgente.tipo)) {
      return responder({
        ok: false,
        erro: "Este tipo de arquivo ainda não pode ser inspecionado.",
      }, 415);
    }

    // A MESMA porta de arquivo que o runtime registra, com o MESMO
    // escopo: dono da sessao e agente da rota. O `fileId` e o uuid da
    // fonte, e nao um caminho — caminho de storage nunca trafega.
    registrarFonteDeArquivo(criarFonteDeArquivoDasSources({
      porta: portaF,
      userId: porta.userId,
      agenteId: porta.agenteId,
    }));

    const saida = await executarInspecionar(
      { userId: porta.userId, conexao: null },
      { fileId: params.fonteId }
    );

    // O executor devolve `{ ok: false, codigo }` para recusa de dominio
    // (arquivo grande, zip invalido, etc). Repassar o codigo deixa a tela
    // explicar; inventar uma frase aqui esconderia a causa.
    if (typeof saida === "object" && saida !== null && "ok" in saida &&
        (saida as { ok: unknown }).ok !== true) {
      const codigo = (saida as { codigo?: unknown }).codigo;
      return responder({
        ok: false,
        erro: FALHA,
        codigo: typeof codigo === "string" ? codigo : null,
      }, 422);
    }

    return responder({
      ok: true,
      arquivo: {
        id: doAgente.id,
        nome: doAgente.nome,
        tipo: doAgente.tipo,
        tamanhoBytes: doAgente.tamanhoBytes,
        papel: doAgente.papel,
        descricao: doAgente.descricao,
      },
      inspecao: saida,
    }, 200);
  } catch {
    return responder({ ok: false, erro: FALHA }, 500);
  }
}
