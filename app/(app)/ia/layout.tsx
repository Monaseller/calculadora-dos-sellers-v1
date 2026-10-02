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
 * subnavegacao principal (Escritorio e Agentes — F8.1-C1).
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
 * A area ocupa a largura toda depois da Sidebar (F8.1-B2): o escritorio
 * e um mapa, nao um formulario, e o antigo teto de 1280px deixava a cena
 * com ~900px e uma faixa vazia a direita. `maxWidth: 1840` so impede o
 * crescimento absurdo em monitores muito largos.
 */
import type { ReactNode } from "react";
import SubNavIA from "@/components/ia/SubNavIA";
import { CROMO, ESPACO, FONTE } from "@/lib/ia/design";

export default function LayoutCdsIa({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: `${ESPACO.lg}px ${ESPACO.xl}px ${ESPACO.xl}px`,
        width: "100%",
        maxWidth: 1840,
        margin: "0 auto",
        boxSizing: "border-box",
      }}
    >
      {/* F8.1-C1: titulo e navegacao numa linha so. A frase de apresentacao
          e o bloco proprio da subnav sairam: eram ~90px empurrando o
          escritorio para baixo da dobra. */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: ESPACO.xl,
          marginBottom: ESPACO.md,
          paddingBottom: ESPACO.sm,
          borderBottom: `1px solid ${CROMO.bordaSutil}`,
        }}
      >
        {/* F8.2-A: o titulo saiu da TELA (a Sidebar ja diz onde se esta), mas
            continua para leitor de tela — a pagina segue tendo um h1. */}
        <h1
          style={{
            position: "absolute", width: 1, height: 1, margin: -1, padding: 0,
            overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0,
            font: `900 20px/1.2 ${FONTE.interface}`,
          }}
        >
          CDS IA
        </h1>
        <SubNavIA />
      </header>

      <main>{children}</main>
    </div>
  );
}
