/**
 * Shell da area CDS IA.
 *
 * ── O que este layout NAO faz ───────────────────────────────────────
 *
 * Nao cria sidebar, topbar, provider nem sessao. Tudo isso ja vem de
 * `app/(app)/layout.tsx`, que envolve esta area: Sidebar, TopBar e
 * `DateFieldProvider` continuam valendo, e o middleware ja exige sessao
 * por default deny — `/ia` nao esta em nenhuma lista publica, entao nao
 * foi preciso tocar em `middleware.ts` nem em `lib/middleware-rotas.ts`.
 *
 * Este layout acrescenta exatamente duas coisas: o titulo da area e a
 * subnavegacao das 6 secoes.
 *
 * ── A tarja de simulacao SAIU daqui ─────────────────────────────────
 *
 * Ela morava neste shell e valia para a area inteira, com a promessa
 * escrita de sair "quando a leitura real entrar". Entrou: `/ia/agentes`
 * e `/ia/agentes/[id]` leem agentes reais do dono, e existe agente
 * persistido de verdade. Um aviso global passou a AFIRMAR FALSO sobre
 * duas telas verdadeiras — e um aviso que mente para menos e tao ruim
 * quanto um que mente para mais: ensina a ignorar a tarja.
 *
 * O aviso desceu para cada tela que ainda exibe simulacao, e so para
 * elas. Nenhuma tarja global a substitui: nao existe mais uma frase
 * verdadeira sobre a CDS IA inteira.
 *
 * `maxWidth` e maior que os 1000px de `central-ia/page.tsx` porque o
 * escritorio e um mapa, nao um formulario — apertar o palco para caber
 * na largura de leitura de texto o tornaria ilegivel.
 */
import type { ReactNode } from "react";
import SubNavIA from "@/components/ia/SubNavIA";
import { CROMO, ESPACO, FONTE } from "@/lib/ia/design";

export default function LayoutCdsIa({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: ESPACO.xxl, maxWidth: 1280, margin: "0 auto" }}>
      <header style={{ marginBottom: ESPACO.lg }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 900, color: CROMO.texto }}>CDS IA</h1>

        <p
          style={{
            margin: `6px 0 0`,
            fontSize: 14,
            color: CROMO.textoFraco,
            font: `14px/1.6 ${FONTE.interface}`,
          }}
        >
          Onde seus agentes de IA trabalham, e onde você decide o que eles podem fazer.
        </p>
      </header>

      <SubNavIA />

      <main style={{ paddingTop: ESPACO.xl }}>{children}</main>
    </div>
  );
}
