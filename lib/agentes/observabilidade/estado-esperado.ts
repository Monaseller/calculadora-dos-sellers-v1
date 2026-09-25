/**
 * OBS-1 — a intencao declarada sobre o agendador de ingestao.
 *
 * Esta camada responde UMA pergunta, e so ela: "era para haver varredura
 * agora?". Ela nao observa nada, nao alerta, nao chama provider, nao
 * toca cursor e nao sabe o que e um bucket. Os detectores que virao
 * depois (OBS-2 gap, OBS-3 progresso) e que confrontam esta intencao com
 * o que o ledger registrou.
 *
 * ── TRES ESTADOS, E NAO UM BOOLEANO ─────────────────────────────────
 *
 * A leitura devolve `configuracao_ausente` como estado proprio, distinto
 * de `configurado_inativo`. A distincao existe por um acidente concreto
 * que ela impede: alguem ativa o agendador em producao, ninguem criou a
 * configuracao, um vigia que traduzisse "sem linha" para "nao esperado"
 * ficaria calado, e a operacao rodaria desatendida acreditando ter
 * watchdog. Ausencia de configuracao e uma condicao a resolver antes do
 * go-live, nao um "desligado" silencioso.
 *
 * `falhou_leitura` tambem e estado proprio, pela mesma disciplina que
 * `lerEstadoDaAcaoPorIdempotencia` segue: um erro de banco lido como
 * "ausente" transformaria indisponibilidade em decisao.
 *
 * ── A ESCRITA NAO ACEITA AUTORIDADE ────────────────────────────────
 *
 * `user_id` existe na tabela para sustentar a FK composta, nao para vir
 * de quem chama. Aqui ele e DERIVADO do agente, pela mesma leitura que a
 * ponte interna usa. Um chamador que pudesse informa-lo escolheria em
 * nome de quem a configuracao passa a valer.
 */
import "server-only";

import { lerAgenteParaAcaoInterna } from "@/lib/agentes/capability-worker";
import { CONEXAO_PERGUNTAS_ML } from "@/lib/agentes/funcoes/mercadolivre-perguntas";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

import { alinhadoAoBucket, CADENCIA_MS } from "./fronteira-bucket";

export { alinhadoAoBucket, CADENCIA_MS };

const TABELA = "agente_ingestao_estado_esperado";
const PLATAFORMA = CONEXAO_PERGUNTAS_ML.plataforma;
const RECURSO = CONEXAO_PERGUNTAS_ML.recurso;
const COLUNAS = "agente_id,user_id,plataforma,recurso,esperado_ativo,esperado_desde";

export type EstadoEsperadoDaIngestao =
  | {
      readonly estado: "configurado_ativo";
      /** A fronteira a partir da qual cobrar varredura. ISO 8601, UTC. */
      readonly esperadoDesde: string;
    }
  | { readonly estado: "configurado_inativo" }
  /** NAO e "desligado". E "ninguem declarou", e isso precisa ser resolvido. */
  | { readonly estado: "configuracao_ausente" }
  | { readonly estado: "falhou_leitura" };

export type EscritaDoEstadoEsperado =
  | { readonly estado: "aplicada" }
  /** `esperado_ativo` sem fronteira, ou fronteira fora da grade de bucket. */
  | { readonly estado: "entrada_invalida"; readonly motivo: string }
  | { readonly estado: "agente_desconhecido" }
  | { readonly estado: "falhou" };

function lerLinha(bruta: unknown): EstadoEsperadoDaIngestao {
  if (typeof bruta !== "object" || bruta === null) return { estado: "falhou_leitura" };
  const o = bruta as Record<string, unknown>;
  const ativo = o.esperado_ativo;
  if (typeof ativo !== "boolean") return { estado: "falhou_leitura" };
  if (!ativo) return { estado: "configurado_inativo" };

  // Ativo sem fronteira e recusado pelo CHECK do banco. Chegar aqui
  // significa que a linha veio de um contrato que nao e este — devolver
  // `configurado_ativo` sem fronteira faria o detector inventar uma.
  const desde = o.esperado_desde;
  if (typeof desde !== "string" || desde.length === 0) return { estado: "falhou_leitura" };
  return { estado: "configurado_ativo", esperadoDesde: desde };
}

/**
 * Le a intencao declarada para um agente neste recurso.
 *
 * Sem `maybeSingle()`: a chave primaria ja garante no maximo uma linha, e
 * um `.limit(2)` denuncia um schema que deixou de garanti-la em vez de
 * escolher a primeira em silencio.
 */
export async function lerEstadoEsperadoDaIngestao(
  agenteId: string,
  signal?: AbortSignal
): Promise<EstadoEsperadoDaIngestao> {
  if (typeof agenteId !== "string" || agenteId.length === 0) {
    return { estado: "falhou_leitura" };
  }

  let consulta = getSupabaseServidor()
    .from(TABELA)
    .select(COLUNAS)
    .eq("agente_id", agenteId)
    .eq("plataforma", PLATAFORMA)
    .eq("recurso", RECURSO)
    .limit(2);
  if (signal !== undefined) consulta = consulta.abortSignal(signal);

  const { data, error } = await consulta;
  if (error) {
    // Sem `error.message`: mensagem de driver vaza nome de coluna.
    console.error("[observabilidade] falha ao ler o estado esperado da ingestao");
    return { estado: "falhou_leitura" };
  }
  if (!Array.isArray(data)) return { estado: "falhou_leitura" };
  if (data.length === 0) return { estado: "configuracao_ausente" };
  if (data.length > 1) {
    console.error("[observabilidade] mais de uma configuracao para o mesmo escopo");
    return { estado: "falhou_leitura" };
  }
  return lerLinha(data[0]);
}

/**
 * Declara a intencao. NAO ha rota HTTP para isto, de proposito: ligar a
 * observacao e um ato deliberado de operacao, e o gate que o autorizar
 * decide como ele e disparado.
 */
export async function definirEstadoEsperadoDaIngestao(entrada: {
  readonly agenteId: string;
  readonly esperadoAtivo: boolean;
  /** Obrigatorio quando `esperadoAtivo`. ISO 8601 na fronteira de bucket. */
  readonly esperadoDesde?: string | null;
  readonly signal?: AbortSignal;
}): Promise<EscritaDoEstadoEsperado> {
  const { agenteId, esperadoAtivo } = entrada;
  if (typeof agenteId !== "string" || agenteId.length === 0) {
    return { estado: "entrada_invalida", motivo: "agente_id_ausente" };
  }

  const desde = entrada.esperadoDesde ?? null;
  if (esperadoAtivo) {
    if (typeof desde !== "string" || desde.length === 0) {
      return { estado: "entrada_invalida", motivo: "esperado_desde_ausente" };
    }
    if (!alinhadoAoBucket(desde)) {
      return { estado: "entrada_invalida", motivo: "esperado_desde_fora_da_fronteira" };
    }
  }

  // O dono vem do BANCO, nunca do chamador.
  const { agente, erro } = await lerAgenteParaAcaoInterna(agenteId, entrada.signal);
  if (erro !== null) return { estado: "falhou" };
  if (agente === null) return { estado: "agente_desconhecido" };

  const agora = new Date().toISOString();
  const { error } = await getSupabaseServidor()
    .from(TABELA)
    .upsert(
      {
        agente_id: agente.agenteId,
        user_id: agente.userId,
        plataforma: PLATAFORMA,
        recurso: RECURSO,
        esperado_ativo: esperadoAtivo,
        // Desligar NAO apaga a fronteira anterior: ela e o rastro de ate
        // quando se esperava observar, e reescreve-la com `null` perderia
        // essa informacao sem ganhar nada.
        ...(esperadoAtivo ? { esperado_desde: desde } : {}),
        alterado_em: agora,
      },
      { onConflict: "agente_id,plataforma,recurso" }
    );

  if (error) {
    console.error("[observabilidade] falha ao gravar o estado esperado da ingestao");
    return { estado: "falhou" };
  }
  return { estado: "aplicada" };
}
