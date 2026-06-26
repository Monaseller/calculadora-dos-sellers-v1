import Link from "next/link";
import s from "./landing.module.css";

export default function LandingPage() {
  return (
    <main className={s.landing}>
      <header className={s.landingHeader}>
        <div className={s.landingLogo}>CDS</div>
        <nav>
          <a href="#">Início</a>
          <a href="#">Recursos</a>
          <a href="#">Como funciona</a>
          <a href="#">Planos</a>
          <a href="#">Depoimentos</a>
          <a href="#">FAQ</a>
        </nav>
        <div className={s.headerActions}>
          <Link href="/login" className={s.btnOutline}>Entrar</Link>
          <Link href="/login" className={s.btnPrimary}>Testar grátis</Link>
        </div>
      </header>

      <section className={s.hero}>
        <div className={s.heroLeft}>
          <div className={s.badge}>⭐ A Nº1 em precificação para Sellers</div>
          <h1>
            Precifique com <span>inteligência.</span>
            <br />
            Venda com lucro de verdade.
          </h1>
          <p>
            A Calculadora dos Sellers te mostra exatamente quanto você vai lucrar
            em cada venda nos marketplaces. Chega de achismos. É números,
            estratégia e resultado.
          </p>
          <div className={s.heroButtons}>
            <Link href="/login" className={s.btnPrimary}>⚡ Testar grátis por 1 dia</Link>
            <button className={s.btnOutline}>▶ Ver como funciona</button>
          </div>
          <div className={s.benefits}>
            <span>🎯 Cálculo automático</span>
            <span>🛡️ Dados seguros</span>
            <span>📈 Mais lucro</span>
          </div>
        </div>

        <div className={s.dashboardCard}>
          <h3>Resultado da precificação</h3>
          <div className={s.metrics}>
            <div>
              <small>Valor a receber</small>
              <strong>R$ 84,85</strong>
            </div>
            <div>
              <small>Lucro líquido</small>
              <strong>R$ 24,18</strong>
            </div>
            <div>
              <small>Margem</small>
              <strong>28,53%</strong>
            </div>
          </div>
          <div className={s.priceBox}>
            <div>
              <small>Preço original</small>
              <h2>R$ 116,90</h2>
            </div>
            <div>
              <small>Preço promocional</small>
              <h2>R$ 140,28</h2>
            </div>
          </div>
          <div className={s.health}>
            <span>Saúde da venda</span>
            <div className={s.bar}>
              <div className={s.barFill} />
            </div>
            <b>Muito boa 😊</b>
          </div>
          <div className={s.productPreview}>
            <div className={s.productImg}>📦</div>
            <div>
              <strong>Kit 3 Pinças Curva</strong>
              <small>Mercado Livre · Clássico</small>
              <small>Categoria: Pinças</small>
            </div>
          </div>
        </div>
      </section>

      <section className={s.videoSection}>
        <div className={s.videoBox}>
          <h2>
            Veja <span>como funciona</span> na prática
          </h2>
          <p>Assista ao vídeo e entenda como a CDS vai transformar seus resultados.</p>
          <div className={s.videoPlaceholder}>
            <button>▶</button>
          </div>
        </div>
        <div className={s.features}>
          <h2>
            Tudo que você precisa para <span>vender mais e lucrar melhor</span>
          </h2>
          <div className={s.featureGrid}>
            <div>🧮 Precificação automática</div>
            <div>📊 Análise de margem</div>
            <div>🕘 Histórico inteligente</div>
            <div>🔗 Integração com anúncios</div>
            <div>📈 Módulo Ads</div>
            <div>🎯 Estratégia de crescimento</div>
          </div>
        </div>
      </section>
    </main>
  );
}
