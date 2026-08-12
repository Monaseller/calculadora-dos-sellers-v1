/**
 * Erro classificado de provedor de IA — neutro em relação a provedor.
 *
 * CORREÇÃO ESTRUTURAL (2026-08-14, Constituição §37.2). Até aqui esta
 * classe vivia dentro de `lib/ai-gateway/provedores/google.ts`, e era
 * importada por 8 arquivos — incluindo o executor central
 * (`executar-job.ts`) e o domínio de 3 etapas. Introduzir um segundo
 * provedor real (Anthropic) significaria o cliente da Anthropic importar
 * sua classe de erro do arquivo do Google, ou duplicá-la. As duas opções
 * são piores do que mover a classe para onde ela sempre pertenceu.
 *
 * `provedores/google.ts` reexporta `ErroProvedorIA` daqui, então nenhum
 * dos importadores existentes precisou mudar — a correção é aditiva e
 * não quebra nada. Código novo deve importar deste arquivo.
 */
import type { TipoErroIA } from "./tipos";

export class ErroProvedorIA extends Error {
  tipo: TipoErroIA;
  constructor(tipo: TipoErroIA, mensagem: string) {
    super(mensagem);
    this.name = "ErroProvedorIA";
    this.tipo = tipo;
  }
}
