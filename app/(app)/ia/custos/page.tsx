/**
 * `/ia/custos` — placeholder deliberado.
 *
 * Esta e a area mais perto de existir: `agentes_ia_chamadas` ja registra
 * provedor, modelo, tokens de entrada e saida, tempo e custo por chamada,
 * com `user_id` — ou seja, ja e somavel por dono, por periodo e por
 * modelo. Falta a camada de leitura, que e backend e nao entra na UI-1B.
 *
 * ── A regra que esta tela nao podera violar ─────────────────────────
 *
 * `custo_usd` e NULL quando o modelo nao tem preco cadastrado. NULL
 * significa "nao sei", nunca "zero". Somar NULL como zero produziria um
 * total menor que o real com cara de exato — foi exatamente para evitar
 * isso que a coluna nasceu nullable, e nao `NOT NULL DEFAULT 0`.
 *
 * Quando a leitura entrar, chamadas sem preco vao numa linha separada,
 * contadas e nunca somadas.
 *
 * ── Por que esta tela NAO ganhou aviso de simulacao ─────────────────
 *
 * A tarja global saiu do shell de `/ia` e desceu para cada tela que
 * ainda simula. Esta nao e uma delas: ela nao exibe numero nenhum, nem
 * verdadeiro nem inventado — e um `EmBreve`, e placeholder nao e
 * simulacao. Sao coisas diferentes e o produto precisa que continuem
 * diferentes: "isto ainda nao existe" e uma promessa honesta, "estes
 * dados sao simulados" e um alerta sobre o que esta na tela. Colar
 * "Dados simulados" aqui inventaria uma simulacao que nao ha.
 *
 * Mesma decisao de `/ia/conexoes`, tambem `EmBreve` e tambem sem tarja.
 */
import EmBreve from "@/components/ia/EmBreve";

export default function PaginaCustos() {
  return (
    <EmBreve
      titulo="Custos"
      descricao="Quanto sua operação de IA custou hoje, em 7 e em 30 dias — por agente, por modelo e por provedor, com tokens e latência. Chamadas cujo modelo não tem preço cadastrado aparecem contadas à parte, nunca somadas como zero."
      pendencia="camada de leitura dos dados. A tabela `agentes_ia_chamadas` já registra tudo que a tela precisa, mas ainda não existe rota autenticada que a leia filtrando por dono."
    />
  );
}
