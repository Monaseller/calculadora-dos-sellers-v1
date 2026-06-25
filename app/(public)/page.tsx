"use client";
import Link from "next/link";

function DashboardMockup() {
  const produtos = [
    { nome: "Escova Secadora Profissional", sku: "ESC-001", mp: "Mercado Livre Premium", lucro: "R$ 19,98", pct: "20,00%" },
    { nome: "Cabine UV LED 72W",            sku: "UV-005",  mp: "Shopee",               lucro: "R$ 24,31", pct: "21,30%" },
    { nome: "Lixa Elétrica Profissional",   sku: "LIX-010", mp: "Amazon",               lucro: "R$ 18,92", pct: "18,10%" },
    { nome: "Fone Bluetooth Premium",       sku: "FON-020", mp: "Mercado Livre",         lucro: "R$ 16,45", pct: "17,20%" },
    { nome: "Balança Digital Cozinha",      sku: "BAL-015", mp: "Magalu",               lucro: "R$ 21,56", pct: "19,80%" },
  ];
  return (
    <div style={{background:"#13151f",border:"1px solid rgba(255,255,255,0.1)",borderRadius:"16px",overflow:"hidden",boxShadow:"0 40px 100px rgba(0,0,0,0.7)",display:"flex",height:"520px",fontSize:"11px"}}>
      <div style={{width:"155px",background:"#0f111a",borderRight:"1px solid rgba(255,255,255,0.06)",display:"flex",flexDirection:"column",flexShrink:0}}>
        <div style={{padding:"14px 12px",borderBottom:"1px solid rgba(255,255,255,0.06)",display:"flex",alignItems:"center",gap:"8px"}}>
          <div style={{width:"26px",height:"26px",borderRadius:"7px",background:"linear-gradient(135deg,#FFB600,#FF6B00)",display:"grid",placeItems:"center",fontWeight:900,fontSize:"12px",color:"#000"}}>C</div>
          <div><div style={{fontWeight:800,fontSize:"10px",color:"#fff"}}>CDS</div><div style={{fontSize:"9px",color:"#9099aa"}}>dos Sellers</div></div>
        </div>
        {[{l:"Dashboard",a:true},{l:"Precificação"},{l:"Meus Produtos"},{l:"Histórico"},{l:"Comparativo"},{l:"Relatórios"},{l:"Configurações"},{l:"Suporte"}].map(i=>(
          <div key={i.l} style={{padding:"8px 12px",display:"flex",alignItems:"center",gap:"7px",background:i.a?"rgba(255,182,0,0.1)":"transparent",borderLeft:i.a?"2px solid #FFB600":"2px solid transparent",color:i.a?"#FFB600":"#9099aa"}}>
            <div style={{width:"4px",height:"4px",borderRadius:"50%",background:i.a?"#FFB600":"#444"}}/>
            <span style={{fontSize:"10px",fontWeight:i.a?700:400}}>{i.l}</span>
          </div>
        ))}
        <div style={{marginTop:"auto",padding:"10px 12px",borderTop:"1px solid rgba(255,255,255,0.06)"}}>
          <div style={{fontSize:"9px",color:"#FFB600",fontWeight:700}}>👑 Plano Vitalício</div>
          <div style={{marginTop:"4px",display:"inline-block",background:"rgba(0,217,126,0.12)",color:"#00D97E",borderRadius:"4px",padding:"1px 6px",fontSize:"9px",fontWeight:700}}>Ativo</div>
        </div>
      </div>
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
        <div style={{padding:"10px 14px",borderBottom:"1px solid rgba(255,255,255,0.06)",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div><div style={{fontWeight:800,fontSize:"13px",color:"#fff"}}>Dashboard</div><div style={{fontSize:"9px",color:"#9099aa"}}>Visão geral do seu negócio</div></div>
          <div style={{display:"flex",alignItems:"center",gap:"8px"}}>
            <span style={{fontSize:"10px",color:"#9099aa"}}>Olá, Seller!</span>
            <div style={{width:"24px",height:"24px",borderRadius:"50%",background:"linear-gradient(135deg,#ff6b00,#ffb800)",display:"grid",placeItems:"center",fontSize:"10px",fontWeight:900,color:"#000"}}>S</div>
          </div>
        </div>
        <div style={{flex:1,overflow:"hidden",padding:"10px",display:"flex",gap:"10px"}}>
          <div style={{flex:1,display:"flex",flexDirection:"column",gap:"8px",overflow:"hidden"}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"8px"}}>
              {[{label:"Produtos cadastrados",val:"24",sub:"↑ 12% vs mês anterior",cor:"#FF9500"},{label:"Cálculos realizados",val:"87",sub:"↑ 18% vs mês anterior",cor:"#A259FF"}].map(k=>(
                <div key={k.label} style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:"8px",padding:"9px"}}>
                  <div style={{fontSize:"9px",color:"#9099aa",marginBottom:"3px"}}>{k.label}</div>
                  <div style={{fontSize:"20px",fontWeight:900,color:k.cor}}>{k.val}</div>
                  <div style={{fontSize:"8px",color:"#00D97E",marginTop:"2px"}}>{k.sub}</div>
                </div>
              ))}
            </div>
            <div style={{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:"8px",flex:1,overflow:"hidden"}}>
              <div style={{padding:"7px 10px",borderBottom:"1px solid rgba(255,255,255,0.06)",fontWeight:700,color:"#fff",fontSize:"10px"}}>Últimos produtos analisados</div>
              <div style={{padding:"3px 0"}}>
                <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 0.7fr",padding:"3px 10px",fontSize:"8px",color:"#555",fontWeight:700}}><span>Produto</span><span>Marketplace</span><span style={{textAlign:"right"}}>Lucro</span></div>
                {produtos.map((p,i)=>(
                  <div key={i} style={{display:"grid",gridTemplateColumns:"2fr 1fr 0.7fr",padding:"4px 10px",alignItems:"center",background:i%2===0?"rgba(255,255,255,0.01)":"transparent"}}>
                    <div><div style={{color:"#fff",fontSize:"9px",fontWeight:600}}>{p.nome}</div><div style={{color:"#555",fontSize:"8px"}}>SKU: {p.sku}</div></div>
                    <div style={{color:"#9099aa",fontSize:"9px"}}>{p.mp}</div>
                    <div style={{textAlign:"right"}}><div style={{color:"#00D97E",fontSize:"9px",fontWeight:700}}>{p.lucro}</div><div style={{color:"#555",fontSize:"8px"}}>{p.pct}</div></div>
                  </div>
                ))}
              </div>
              <div style={{padding:"5px 10px",borderTop:"1px solid rgba(255,255,255,0.06)"}}><span style={{background:"rgba(255,182,0,0.12)",color:"#FFB600",borderRadius:"5px",padding:"2px 8px",fontSize:"9px",fontWeight:700}}>Ver todos os produtos</span></div>
            </div>
          </div>
          <div style={{width:"190px",display:"flex",flexDirection:"column",gap:"8px"}}>
            {[{label:"Lucro estimado",val:"R$ 8.247,50",sub:"↑ 34% vs mês anterior",cor:"#00D97E"},{label:"Margem média",val:"18,45%",sub:"↑ 2,6% vs mês anterior",cor:"#6fa3ff"}].map(k=>(
              <div key={k.label} style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:"8px",padding:"9px"}}>
                <div style={{fontSize:"9px",color:"#9099aa",marginBottom:"3px"}}>{k.label}</div>
                <div style={{fontSize:"15px",fontWeight:900,color:k.cor}}>{k.val}</div>
                <div style={{fontSize:"8px",color:"#00D97E",marginTop:"2px"}}>{k.sub}</div>
              </div>
            ))}
            <div style={{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:"8px",flex:1,overflow:"hidden"}}>
              <div style={{padding:"7px 10px",borderBottom:"1px solid rgba(255,255,255,0.06)",fontWeight:700,color:"#fff",fontSize:"10px"}}>Alertas importantes</div>
              {[{emoji:"⚠️",titulo:"Aumento de custo",desc:"ESC-001 teve aumento de 14%. Reveja a precificação.",cor:"#FFB600"},{emoji:"🔴",titulo:"Margem abaixo do ideal",desc:"UV-005 está abaixo de 15%. Ajuste recomendado.",cor:"#ff6b6b"},{emoji:"🟢",titulo:"Oportunidade de lucro",desc:"Na Shopee, margem pode aumentar 3,2%.",cor:"#00D97E"}].map((a,i)=>(
                <div key={i} style={{padding:"6px 10px",borderBottom:"1px solid rgba(255,255,255,0.04)"}}>
                  <div style={{display:"flex",gap:"5px",alignItems:"flex-start"}}>
                    <span style={{fontSize:"9px"}}>{a.emoji}</span>
                    <div><div style={{fontWeight:700,fontSize:"8px",color:a.cor,marginBottom:"1px"}}>{a.titulo}</div><div style={{fontSize:"8px",color:"#9099aa",lineHeight:1.4}}>{a.desc}</div></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LandingPage() {
  return (
    <div style={{minHeight:"100vh",background:"#0d0e12",color:"#fff",fontFamily:"system-ui,sans-serif"}}>
      <header style={{position:"sticky",top:0,zIndex:100,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 48px",height:"68px",background:"rgba(13,14,18,0.88)",backdropFilter:"blur(16px)",borderBottom:"1px solid rgba(255,255,255,0.06)"}}>
        <div style={{display:"flex",alignItems:"center",gap:"12px"}}>
          <div style={{width:"40px",height:"40px",borderRadius:"10px",background:"linear-gradient(135deg,#FFB600,#FF6B00)",display:"grid",placeItems:"center",fontSize:"18px",fontWeight:900,color:"#000"}}>C</div>
          <div><div style={{fontWeight:900,fontSize:"15px",color:"#fff",lineHeight:1.1}}>CDS</div><div style={{fontSize:"10px",color:"#9099aa",letterSpacing:"0.3px"}}>CALCULADORA DOS SELLERS</div></div>
        </div>
        <nav style={{display:"flex",gap:"32px"}}>
          {["Funcionalidades","Como Funciona","Para Quem é","Depoimentos","Perguntas"].map(n=>(
            <a key={n} href="#" style={{color:"#9099aa",textDecoration:"none",fontSize:"14px",fontWeight:500}} onMouseEnter={e=>(e.currentTarget.style.color="#fff")} onMouseLeave={e=>(e.currentTarget.style.color="#9099aa")}>{n}</a>
          ))}
        </nav>
        <div style={{display:"flex",gap:"10px",alignItems:"center"}}>
          <Link href="/login" style={{display:"flex",alignItems:"center",gap:"6px",padding:"9px 18px",borderRadius:"9px",border:"1px solid rgba(255,255,255,0.15)",background:"transparent",color:"#fff",textDecoration:"none",fontSize:"14px",fontWeight:600}}>↗ Entrar</Link>
          <Link href="/login" style={{padding:"9px 20px",borderRadius:"9px",background:"linear-gradient(135deg,#FFB600,#FF6B00)",color:"#000",textDecoration:"none",fontSize:"14px",fontWeight:800,boxShadow:"0 4px 20px rgba(255,182,0,0.35)"}}>ACESSAR O PAINEL</Link>
        </div>
      </header>

      <section style={{display:"flex",alignItems:"center",gap:"60px",padding:"80px 80px 60px",maxWidth:"1400px",margin:"0 auto"}}>
        <div style={{flex:1,maxWidth:"520px"}}>
          <div style={{display:"inline-flex",alignItems:"center",gap:"8px",background:"rgba(255,182,0,0.1)",border:"1px solid rgba(255,182,0,0.3)",borderRadius:"100px",padding:"6px 14px",marginBottom:"28px",fontSize:"12px",fontWeight:700,color:"#FFB600"}}>
            ⭐ A FERRAMENTA Nº1 PARA SELLERS
          </div>
          <h1 style={{fontSize:"58px",fontWeight:900,lineHeight:1.05,margin:"0 0 20px 0"}}>
            <span style={{color:"#fff"}}>Precifique certo.</span><br/>
            <span style={{background:"linear-gradient(90deg,#FFB600,#FF6B00)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>Lucre mais.</span>
          </h1>
          <p style={{fontSize:"17px",color:"#9099aa",lineHeight:1.7,margin:"0 0 36px 0"}}>
            Descubra em segundos o <span style={{color:"#FFB600",fontWeight:600}}>preço ideal</span> para vender no Mercado Livre, Shopee, Amazon e Magalu sem comprometer sua margem.
          </p>
          <div style={{display:"flex",gap:"14px",marginBottom:"36px",flexWrap:"wrap"}}>
            <Link href="/login" style={{display:"flex",alignItems:"center",gap:"8px",padding:"15px 28px",borderRadius:"12px",background:"linear-gradient(135deg,#FFB600,#FF6B00)",color:"#000",textDecoration:"none",fontSize:"15px",fontWeight:800,boxShadow:"0 6px 32px rgba(255,182,0,0.4)"}}>ACESSAR O PAINEL →</Link>
            <Link href="/login" style={{display:"flex",alignItems:"center",gap:"8px",padding:"15px 24px",borderRadius:"12px",border:"1px solid rgba(255,255,255,0.15)",background:"rgba(255,255,255,0.04)",color:"#fff",textDecoration:"none",fontSize:"15px",fontWeight:700}}>🛒 CRIAR CONTA GRÁTIS</Link>
          </div>
          <div style={{display:"flex",gap:"24px",marginBottom:"44px",flexWrap:"wrap"}}>
            {[{icon:"🔒",titulo:"Dados 100% seguros",sub:"Privacidade garantida"},{icon:"✅",titulo:"Fácil de usar",sub:"Sem complicação"},{icon:"🔄",titulo:"Sempre atualizado",sub:"Taxas em tempo real"}].map(b=>(
              <div key={b.titulo} style={{display:"flex",alignItems:"center",gap:"8px"}}>
                <span style={{fontSize:"18px"}}>{b.icon}</span>
                <div><div style={{fontSize:"12px",fontWeight:700,color:"#fff"}}>{b.titulo}</div><div style={{fontSize:"11px",color:"#9099aa"}}>{b.sub}</div></div>
              </div>
            ))}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:"20px",flexWrap:"wrap"}}>
            <div style={{fontSize:"11px",color:"#555",fontWeight:600}}>INTEGRADO COM</div>
            {[{label:"Mercado Livre",cor:"#FFE000",e:"🛒"},{label:"Shopee",cor:"#EE4D2D",e:"🛍️"},{label:"Amazon",cor:"#FF9900",e:"📦"},{label:"Magalu",cor:"#0088CC",e:"🏪"}].map(m=>(
              <div key={m.label} style={{display:"flex",alignItems:"center",gap:"5px",opacity:0.75,fontSize:"13px",fontWeight:700,color:m.cor}}>{m.e} {m.label}</div>
            ))}
          </div>
        </div>
        <div style={{flex:1.2,minWidth:0}}><DashboardMockup/></div>
      </section>

      <section style={{borderTop:"1px solid rgba(255,255,255,0.06)",borderBottom:"1px solid rgba(255,255,255,0.06)",padding:"40px 80px",display:"grid",gridTemplateColumns:"repeat(4,1fr)",maxWidth:"1400px",margin:"0 auto"}}>
        {[{icon:"💰",titulo:"Precificação automática",desc:"Calcule o preço certo considerando todos os custos e comissões de cada marketplace."},{icon:"📊",titulo:"Gestão de anúncios",desc:"Importe todos os seus produtos de ML e Shopee com um clique."},{icon:"📈",titulo:"Vendas em tempo real",desc:"Acompanhe faturamento, lucro e margem de contribuição de cada venda."},{icon:"🏪",titulo:"Multi-loja",desc:"Gerencie múltiplas contas de diferentes marketplaces em um único painel."}].map((f,i)=>(
          <div key={i} style={{padding:"28px 32px",borderRight:i<3?"1px solid rgba(255,255,255,0.06)":"none"}}>
            <div style={{fontSize:"28px",marginBottom:"12px"}}>{f.icon}</div>
            <div style={{fontWeight:800,fontSize:"15px",color:"#fff",marginBottom:"8px"}}>{f.titulo}</div>
            <div style={{fontSize:"13px",color:"#9099aa",lineHeight:1.6}}>{f.desc}</div>
          </div>
        ))}
      </section>

      <footer style={{padding:"32px 80px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div style={{fontSize:"13px",color:"#555"}}>Calculadora dos Sellers © {new Date().getFullYear()}</div>
        <Link href="/login" style={{padding:"10px 22px",borderRadius:"9px",background:"linear-gradient(135deg,#FFB600,#FF6B00)",color:"#000",textDecoration:"none",fontSize:"13px",fontWeight:800}}>Acessar o Painel →</Link>
      </footer>
    </div>
  );
}
