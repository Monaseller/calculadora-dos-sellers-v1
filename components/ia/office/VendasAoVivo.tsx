"use client";

/**
 * Painel "Vendas ao vivo" do Escritorio — F8.2-A, ampliado no F8.2-B.
 *
 * GLOBAL do Escritorio: montado fora do `key` do agente, entao trocar de
 * agente nao refaz a leitura. Os dados sao a camada deterministica de
 * vendas do ML (`/api/ia/vendas-ao-vivo`) — sem chat, sem LLM, sem
 * mensagem. Aqui so ha FORMATACAO e desenho: KPIs, cortes e variacoes
 * chegam prontos do servidor.
 *
 * ── Hierarquia (F8.2-B2) ────────────────────────────────────────────
 *
 *   1. HOJE      os 4 KPIs, sozinhos, no topo — o foco do painel.
 *   2. rotulos   o nome de cada KPI.
 *   3. ONTEM     secao SEPARADA embaixo, "Comparativo com ontem": valor
 *                de ontem, delta absoluto, delta % (seta + sinal, nunca
 *                so cor) e um par de barras hoje x ontem por KPI, cada
 *                par na PROPRIA escala — reais e unidades nao dividem
 *                eixo. Ela ocupa o espaco livre do fim da coluna.
 *   4. metadados status, horario de corte, "atualizado ha".
 *
 * Numero NUNCA quebra linha: os valores sao `nowrap` e a fonte encolhe
 * com a largura do card (container query), em vez de partir no meio.
 *
 * Atualiza a cada 10 min (`lib/ia/vendas-ao-vivo.ts`), tem botao manual
 * e nunca apaga o ultimo retrato bom por causa de uma falha.
 *
 * Shopee nao esta configurada e nao e simulada.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import {
  lerVendasAoVivo,
  type ComparativoAoVivoUI, type KpisAoVivoUI, type LojaAoVivoUI,
  type MarketplaceAoVivoUI, type VariacaoAoVivoUI,
} from "@/lib/ia/agentes-http";
import {
  MEMORIA_INICIAL, aplicarResposta, criarCicloAoVivo, estadoAoVivo, haQuantoTempo,
  type CicloAoVivo, type EstadoAoVivo, type MemoriaAoVivo,
} from "@/lib/ia/vendas-ao-vivo";
import { CORES_DASHBOARD, estiloDeCard, type CorDeDashboard } from "@/lib/ia/cores-dashboard";
import { iconeDoMarketplace } from "@/lib/ia/icones-ferramentas";
import estilos from "@/components/ia/office/office-v1.module.css";

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const NUMERO = new Intl.NumberFormat("pt-BR");
const PCT = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
/** So FORMATA o instante que o servidor mandou, no fuso da CDS. */
const HORA_SP = new Intl.DateTimeFormat("pt-BR", {
  hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo",
});

const NOME_DO_MARKETPLACE: Record<MarketplaceAoVivoUI, string> = {
  mercadolivre: "Mercado Livre",
  shopee: "Shopee",
};

const ROTULO_DO_ESTADO: Record<EstadoAoVivo, string> = {
  LOADING: "Carregando",
  OK: "Ao vivo",
  STALE: "Desatualizado",
  ERROR: "Erro",
  NOT_CONFIGURED: "Não configurado",
};

const COR_DO_ESTADO: Record<EstadoAoVivo, string> = {
  LOADING: "#98a2b3",
  OK: "#22c55e",
  STALE: "#f0b429",
  ERROR: "#f06a6a",
  NOT_CONFIGURED: "#98a2b3",
};

type ChaveKpi = keyof KpisAoVivoUI;

const KPIS: readonly {
  chave: ChaveKpi; rotulo: string; cor: CorDeDashboard; monetario: boolean;
}[] = [
  { chave: "valor", rotulo: "Vendas brutas", cor: CORES_DASHBOARD.laranja, monetario: true },
  { chave: "vendas", rotulo: "Pedidos", cor: CORES_DASHBOARD.azul, monetario: false },
  { chave: "unidades", rotulo: "Unidades", cor: CORES_DASHBOARD.violeta, monetario: false },
  { chave: "ticketMedio", rotulo: "Ticket médio", cor: CORES_DASHBOARD.verde, monetario: true },
];

function formatar(v: number, monetario: boolean): string {
  return monetario ? BRL.format(v) : NUMERO.format(v);
}

function horaDe(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : HORA_SP.format(t);
}

/** Seta + sinal + texto: a direcao nunca depende so da cor. */
function Variacao({ v, monetario }: { v: VariacaoAoVivoUI; monetario: boolean }) {
  const direcao = v.delta > 0 ? "sobe" : v.delta < 0 ? "desce" : "igual";
  const seta = direcao === "sobe" ? "▲" : direcao === "desce" ? "▼" : "=";
  const sinal = v.delta > 0 ? "+" : v.delta < 0 ? "−" : "";
  const absoluto = formatar(Math.abs(v.delta), monetario);
  const pct = v.pct === null ? null : `${v.pct > 0 ? "+" : v.pct < 0 ? "−" : ""}${PCT.format(Math.abs(v.pct))}%`;
  const classe = direcao === "sobe" ? estilos.aoVivoSobe : direcao === "desce" ? estilos.aoVivoDesce : estilos.aoVivoIgual;
  return (
    <span className={`${estilos.aoVivoVariacao} ${classe}`}>
      <span aria-hidden="true">{seta}</span>
      <span>{sinal}{absoluto}</span>
      {pct !== null && <span className={estilos.aoVivoPct}>({pct})</span>}
      <span className={estilos.somenteLeitor}>
        {direcao === "sobe" ? "acima de ontem" : direcao === "desce" ? "abaixo de ontem" : "igual a ontem"}
      </span>
    </span>
  );
}

/** Um KPI de HOJE: rotulo pequeno, valor grande e numa linha so. */
function CardHoje({
  rotulo, valor, cor,
}: { rotulo: string; valor: string; cor: CorDeDashboard }) {
  const c = estiloDeCard(cor);
  return (
    <div className={estilos.aoVivoKpi} style={{ border: c.borda, background: `${c.fundo}, #0e131d` }}>
      <dt className={estilos.aoVivoKpiRotulo}>
        <span aria-hidden="true" className={estilos.aoVivoPonto} style={{ background: c.indicador }} />
        {rotulo}
      </dt>
      <dd className={estilos.aoVivoKpiValor} style={{ color: c.numero }}>{valor}</dd>
    </div>
  );
}

/** Par de barras hoje x ontem, na escala do PROPRIO par. So geometria. */
function BarrasPareadas({
  hoje, ontem, cor,
}: { hoje: number; ontem: number; cor: CorDeDashboard }) {
  const max = Math.max(hoje, ontem);
  const largura = (v: number) => (max > 0 ? `${Math.max((v / max) * 100, v > 0 ? 2 : 0)}%` : "0%");
  return (
    <div className={estilos.aoVivoBarras} aria-hidden="true">
      <span className={estilos.aoVivoBarraTrilho}>
        <span className={estilos.aoVivoBarra} style={{ width: largura(hoje), background: `rgb(${cor.rgb})` }} />
      </span>
      <span className={estilos.aoVivoBarraTrilho}>
        <span className={estilos.aoVivoBarra} style={{ width: largura(ontem), background: `rgb(${cor.rgb} / 0.38)` }} />
      </span>
    </div>
  );
}

/** Uma linha do comparativo: KPI, variacao, barras e os dois valores. */
function LinhaComparativo({
  rotulo, cor, monetario, hoje, ontem, v,
}: {
  rotulo: string; cor: CorDeDashboard; monetario: boolean;
  hoje: number; ontem: number; v: VariacaoAoVivoUI;
}) {
  return (
    <li className={estilos.aoVivoCmpLinha}>
      <div className={estilos.aoVivoCmpTopo}>
        <span className={estilos.aoVivoCmpRotulo}>
          <span aria-hidden="true" className={estilos.aoVivoPonto} style={{ background: `rgb(${cor.rgb})` }} />
          {rotulo}
        </span>
        <Variacao v={v} monetario={monetario} />
      </div>
      <BarrasPareadas hoje={hoje} ontem={ontem} cor={cor} />
      <div className={estilos.aoVivoCmpValores}>
        <span><span className={estilos.aoVivoCmpChave}>hoje</span> {formatar(hoje, monetario)}</span>
        <span><span className={estilos.aoVivoCmpChave}>ontem</span> {formatar(ontem, monetario)}</span>
      </div>
    </li>
  );
}

/** A secao de baixo, SEPARADA do bloco de hoje. */
function ComparativoComOntem({
  hoje, cmp, horaHoje, horaOntem,
}: {
  hoje: KpisAoVivoUI; cmp: ComparativoAoVivoUI | null; horaHoje: string; horaOntem: string;
}) {
  return (
    <section className={estilos.aoVivoCmp} aria-label="Comparativo com ontem">
      <div className={estilos.aoVivoCmpCabecalho}>
        <h3 className={estilos.aoVivoCmpTitulo}>Comparativo com ontem</h3>
        {horaHoje !== "" && (
          <p className={estilos.aoVivoCmpSub}>Hoje até {horaHoje} × Ontem até {horaOntem}</p>
        )}
      </div>
      {cmp === null ? (
        <p className={estilos.textoFraco}>
          A leitura de ontem até este horário não completou — sem comparativo agora.
        </p>
      ) : (
        <ul className={estilos.aoVivoCmpLista}>
          {KPIS.map((k) => (
            <LinhaComparativo
              key={k.chave} rotulo={k.rotulo} cor={k.cor} monetario={k.monetario}
              hoje={hoje[k.chave]} ontem={cmp.ontem[k.chave]} v={cmp.variacao[k.chave]}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function BlocoDaLoja({
  loja, mostrarNome, horaHoje, horaOntem,
}: { loja: LojaAoVivoUI; mostrarNome: boolean; horaHoje: string; horaOntem: string }) {
  if (loja.estado !== "ok") {
    return (
      <div className={estilos.aoVivoLoja}>
        {mostrarNome && <p className={estilos.aoVivoLojaNome}>{loja.nome}</p>}
        <p className={estilos.textoFraco}>
          {loja.estado === "incompleto"
            ? "A leitura de hoje não completou — sem total para mostrar."
            : "Esta loja não respondeu agora."}
        </p>
      </div>
    );
  }
  return (
    <div className={estilos.aoVivoLoja}>
      {mostrarNome && <p className={estilos.aoVivoLojaNome}>{loja.nome}</p>}
      {/* 1. HOJE — o foco. Nada de ontem aqui. */}
      <div className={estilos.aoVivoHoje}>
        <p className={estilos.aoVivoHojeRotulo}>
          Hoje{horaHoje !== "" ? ` até ${horaHoje}` : ""}
        </p>
        <dl className={estilos.aoVivoGrade}>
          {KPIS.map((k) => (
            <CardHoje
              key={k.chave} rotulo={k.rotulo} cor={k.cor}
              valor={formatar(loja.kpis[k.chave], k.monetario)}
            />
          ))}
        </dl>
      </div>
      {/* 2. ONTEM — secao separada, embaixo. */}
      <ComparativoComOntem
        hoje={loja.kpis} cmp={loja.comparativo} horaHoje={horaHoje} horaOntem={horaOntem}
      />
    </div>
  );
}

export default function VendasAoVivo() {
  const [memoria, setMemoria] = useState<MemoriaAoVivo>(MEMORIA_INICIAL);
  // Relogio so para "atualizado ha X min" e para o STALE por idade. Nao
  // dispara leitura nenhuma.
  const [agoraMs, setAgoraMs] = useState<number | null>(null);
  const ciclo = useRef<CicloAoVivo | null>(null);

  useEffect(() => {
    const c = criarCicloAoVivo({
      ler: (signal) => lerVendasAoVivo(signal),
      aoComecar: () => setMemoria((m) => ({ ...m, carregando: true })),
      aoResponder: (r) => {
        const agora = Date.now();
        setMemoria((m) => aplicarResposta(m, r, agora));
        setAgoraMs(agora);
      },
    });
    ciclo.current = c;
    c.iniciar();
    setAgoraMs(Date.now());
    const relogio = window.setInterval(() => setAgoraMs(Date.now()), 30_000);
    return () => {
      c.parar();
      ciclo.current = null;
      window.clearInterval(relogio);
    };
  }, []);

  const estado = agoraMs === null ? "LOADING" : estadoAoVivo(memoria, agoraMs);
  const marketplaces = useMemo(
    () => (memoria.retrato?.marketplaces ?? []).filter((m) => m.configurado),
    [memoria.retrato]
  );
  const horaHoje = memoria.retrato ? horaDe(memoria.retrato.corteHoje) : "";
  const horaOntem = memoria.retrato ? horaDe(memoria.retrato.corteOntem) : "";

  return (
    <section aria-labelledby="ov1-ao-vivo" className={estilos.aoVivo}>
      <div className={estilos.aoVivoCabecalho}>
        <h2 id="ov1-ao-vivo" className={estilos.aoVivoTitulo}>Vendas ao vivo</h2>
        <button
          type="button"
          className={`${estilos.botao} ${estilos.botaoQuadrado}`}
          onClick={() => ciclo.current?.atualizarAgora()}
          disabled={memoria.carregando}
          aria-label="Atualizar vendas agora"
          title="Atualizar agora"
        >
          <span aria-hidden="true" className={memoria.carregando ? estilos.aoVivoGirando : undefined}>↻</span>
        </button>
      </div>

      <p className={estilos.aoVivoStatus} role="status">
        <span
          aria-hidden="true"
          className={estilos.aoVivoPonto}
          style={{ background: COR_DO_ESTADO[estado] } as CSSProperties}
        />
        {ROTULO_DO_ESTADO[estado]}
        {memoria.obtidoEmMs !== null && agoraMs !== null && (
          <> · atualizado {haQuantoTempo(memoria.obtidoEmMs, agoraMs)}</>
        )}
        {estado === "STALE" && memoria.ultimaFalhou && <> · a última tentativa falhou</>}
      </p>

      {estado === "LOADING" && <p className={estilos.textoFraco}>Lendo as vendas de hoje…</p>}
      {estado === "ERROR" && (
        <p className={estilos.erro} role="alert">
          Não foi possível ler as vendas agora. Nova tentativa em 10 minutos.
        </p>
      )}
      {estado === "NOT_CONFIGURED" && (
        <p className={estilos.textoFraco}>
          Nenhuma loja do Mercado Livre conectada.{" "}
          <Link href="/ia/conexoes" className={estilos.aoVivoLink}>Conectar</Link>
        </p>
      )}

      {(estado === "OK" || estado === "STALE") && marketplaces.map((m) => (
        <div key={m.marketplace} className={estilos.aoVivoMarketplace}>
          <div className={estilos.aoVivoMarca}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={iconeDoMarketplace(m.marketplace)} alt="" width={40} height={16} />
            <span>{NOME_DO_MARKETPLACE[m.marketplace]}</span>
          </div>
          {m.lojas.map((l, i) => (
            <BlocoDaLoja
              key={`${m.marketplace}:${i}`} loja={l} mostrarNome={m.lojas.length > 1}
              horaHoje={horaHoje} horaOntem={horaOntem}
            />
          ))}
        </div>
      ))}
    </section>
  );
}
