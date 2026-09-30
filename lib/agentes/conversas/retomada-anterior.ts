import "server-only";

/**
 * A linha de retomada de uma conversa NOVA — F7b.4.8 Parte C.
 *
 * ── A autoridade e a conversa ANTERIOR, local — §18 ────────────────
 *
 * O Zep leva ~15–20 s para indexar (medido no F7b.4.5). Se a retomada
 * dependesse dele, clicar "Nova conversa" logo depois de um turno daria
 * uma saudacao sem assunto — justamente no caso mais comum, que e voltar
 * ao trabalho que acabou de parar.
 *
 * A conversa anterior esta no banco da CDS, gravada no turno, sem
 * latencia e sem indexacao. Ela e autoridade suficiente para dizer onde
 * pararam, e e a unica fonte desta linha.
 *
 * ── E a memoria, entao? ────────────────────────────────────────────
 *
 * Ela participa — no TURNO, e nao na saudacao. `montarContextoDoAgente`
 * ja injeta `MEMORIA_DO_DONO` na primeira resposta de verdade, com as
 * cercas que o F7b.4.5 construiu (distingue desligada, ligada-e-vazia e
 * indisponivel, e proibe inventar lembranca).
 *
 * Misturar memoria na saudacao exigiria um modelo para combinar as duas
 * fontes num paragrafo — e um paragrafo gerado sobre o passado do dono e
 * exatamente o que o §16 proibe. A saudacao CITA; o turno interpreta.
 */
import { criarPortaDeConversas } from "@/lib/agentes/conversas/repositorio";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { frasesDeRetomada } from "@/lib/agentes/conversas/retomada-resumo";
import { lerPerfilDaSessao } from "@/lib/perfil/credenciais";

/** O primeiro nome, ou `null`. Nome completo numa saudacao soa formulario. */
function primeiroNome(nomeCompleto: unknown): string | null {
  if (typeof nomeCompleto !== "string") return null;
  const primeiro = nomeCompleto.trim().split(/\s+/)[0] ?? "";
  // Duas letras e o piso: "A" nao e nome, e um inicial sozinho fica pior
  // que nenhum nome.
  return primeiro.length >= 2 ? primeiro : null;
}

/**
 * A retomada para a conversa `conversaAtualId`, ou `null`.
 *
 * `null` e o caso normal e frequente:
 *
 *   - primeira conversa deste agente
 *   - a conversa anterior nunca recebeu mensagem (sem assunto)
 *   - a conversa atual JA tem mensagens — §19: voltar a mesma conversa
 *     nao gera saudacao nenhuma, so carrega o historico
 *
 * O ultimo caso e conferido por quem chama, que ja tem as mensagens em
 * maos: buscar de novo aqui seria uma segunda leitura do mesmo dado.
 */
export async function retomadaDaConversaAnterior(entrada: {
  readonly userId: string;
  readonly agenteId: string;
  readonly conversaAtualId: string;
}): Promise<string | null> {
  const { userId, agenteId, conversaAtualId } = entrada;
  if (!userId || !agenteId || !conversaAtualId) return null;

  let anteriorComAssunto: string | null = null;
  try {
    // `listarConversas` ja devolve por `atualizado_em` decrescente. A
    // primeira que nao e a atual e tem assunto e a conversa anterior.
    const conversas = await criarPortaDeConversas(getSupabaseServidor())
      .listarConversas(userId, agenteId);
    for (const c of conversas) {
      if (c.id === conversaAtualId) continue;
      if (c.titulo === null || c.titulo.trim() === "") continue;
      anteriorComAssunto = c.titulo;
      break;
    }
  } catch {
    // A retomada e conforto. Falhar em le-la nao pode impedir a pessoa
    // de abrir uma conversa.
    return null;
  }
  if (anteriorComAssunto === null) return null;

  let nome: string | null = null;
  try {
    const { perfil } = await lerPerfilDaSessao(userId);
    nome = primeiroNome(perfil?.nome_completo);
  } catch {
    // Sem nome a frase funciona: "Oi." em vez de "Oi, Rodrigo.".
    nome = null;
  }

  return frasesDeRetomada({ assuntoAnterior: anteriorComAssunto, primeiroNome: nome });
}
