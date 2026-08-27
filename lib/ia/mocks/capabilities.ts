/**
 * CDS IA — mocks: capabilities
 *
 * O catalogo de funcoes e o nivel de autonomia de cada uma. A
 * `procedencia` separa o que o sistema sabe fazer do que ainda nao
 * sabe — e ela nao e opiniao. *
 * Regras da pasta `lib/ia/mocks/` (ver `index.ts`): todo export usa o
 * prefixo `MOCK_`, todo id e obviamente ficticio, e nao existe dado real
 * de cliente, credencial ou identificador externo.
 */
import type { FuncaoUI, PermissaoUI } from "@/lib/ia/conceitos";

/**
 * O catalogo. A `procedencia` de cada funcao e o que separa o que o
 * sistema SABE fazer do que ele ainda nao sabe — e ela nao e opiniao:
 *
 *   vendas.consultar  -> handler `analise_vendas` existe no runtime,
 *                        com janela limitada e dono fechado por closure.
 *   anuncio.consultar -> ha infraestrutura reutilizavel (leitura de
 *                        anuncio ML e rotas de importacao), mas nao ha
 *                        capability montada. Fica `em_breve`: meio
 *                        caminho nao e caminho.
 *   o resto           -> nao existe. ADS foi verificado e nao ha
 *                        integracao alguma.
 */
export const MOCK_FUNCOES: readonly FuncaoUI[] = [
  {
    id: "vendas.consultar", rotulo: "Consultar vendas",
    descricao: "Consulta pedidos e métricas de vendas das conexões autorizadas deste agente.",
    conexaoNecessaria: null, acesso: "leitura", risco: "baixo",
    procedencia: "disponivel",
  },
  {
    id: "anuncio.consultar", rotulo: "Consultar anúncio",
    descricao: "Lê título, preço e ficha dos anúncios publicados na conta conectada.",
    conexaoNecessaria: "cx-ml", acesso: "leitura", risco: "baixo",
    procedencia: "em_breve",
  },
  {
    id: "mensagens.responder", rotulo: "Responder mensagens",
    descricao: "Envia respostas às perguntas dos compradores na conta conectada.",
    conexaoNecessaria: "cx-ml", acesso: "escrita", risco: "medio",
    procedencia: "em_breve",
  },
  {
    id: "ads.campanha.pausar", rotulo: "Pausar campanha",
    descricao: "Interrompe a veiculação de uma campanha de anúncios ativa.",
    conexaoNecessaria: "cx-ml", acesso: "escrita", risco: "alto",
    procedencia: "em_breve",
  },
];

/**
 * Um nivel por funcao, cobrindo os tres: automatico, exige aprovacao e
 * bloqueado. NAO existe campo `concedida` — "permitida" e derivada de
 * `nivel !== "bloqueado"` por `permitida()`.
 *
 * `mensagens.responder` aparece com "exige aprovacao" mesmo sendo uma
 * funcao `em_breve`: e assim que a tela mostra os dois eixos ao mesmo
 * tempo sem mentir — o sistema ainda nao sabe fazer, E o nivel que
 * estaria configurado seria esse.
 */
export const MOCK_PERMISSOES: readonly PermissaoUI[] = [
  { funcaoId: "vendas.consultar", nivel: "automatico", procedencia: "simulado" },
  { funcaoId: "anuncio.consultar", nivel: "bloqueado", procedencia: "simulado" },
  { funcaoId: "mensagens.responder", nivel: "aprovacao", procedencia: "em_breve" },
  { funcaoId: "ads.campanha.pausar", nivel: "bloqueado", procedencia: "em_breve" },
];

/** O nivel configurado para uma funcao. Ausente = bloqueado: o padrao
 *  seguro e "nao pode", nunca "pode". */
export function MOCK_NIVEL_DA_FUNCAO(funcaoId: string): PermissaoUI["nivel"] {
  return MOCK_PERMISSOES.find((p) => p.funcaoId === funcaoId)?.nivel ?? "bloqueado";
}
