/**
 * `/ia/conexoes` — placeholder deliberado.
 *
 * NAO ha lista de conexoes aqui, e nao ha formulario de credencial. As
 * credenciais das lojas ainda estao em TEXTO PURO no banco; construir a
 * tela de "adicionar conexao" antes do armazenamento seguro criaria um
 * caminho novo e conveniente para gravar segredo em claro.
 *
 * A tela existe para que a subnav nao leve a 404 e para que a pendencia
 * fique escrita onde alguem vai ler.
 */
import EmBreve from "@/components/ia/EmBreve";

export default function PaginaConexoes() {
  return (
    <EmBreve
      titulo="Conexões"
      descricao="Aqui você verá as contas de marketplace ligadas à sua conta CDS e quais agentes podem usá-las. O agente nunca recebe nem enxerga a credencial: ele pede a ação, e o backend a executa em nome dele."
      pendencia="armazenamento seguro de credenciais. Hoje as credenciais das lojas ficam em texto puro no banco, e nenhuma tela nova vai cadastrar credencial antes disso mudar."
    />
  );
}
