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
    <div style={{background:"#13151f",border:"1px solid rgba(255,255,255,0.12)",borderRadius:"20px",overflow:"hidden",boxShadow:"0 60px 120px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,182,0,0.08)",display:"flex",height:"100%",minHeight:"480px",maxHeight:"calc(100vh - 180px)",fontSize:"11px"}}>
      {/* Sidebar */}
      <div style={{width:"170px",background:"#0f111a",borderRight:"1px solid rgba(255,255,255,0.06)",display:"flex",flexDirection:"column",flexShrink:0}}>
        <div style={{padding:"16px 14px",borderBottom:"1px solid rgba(255,255,255,0.06)",display:"flex",alignItems:"center",gap:"10px"}}>
          <div style={{width:"30px",height:"30px",borderRadius:"8px",background:"linear-gradient(135deg,#FFB600,#FF6B00)",display:"grid",placeItems:"center",fontWeight:900,fontSize:"13px",color:"#000",flexShrink:0}}>C</div>
          <div><div style={{fontWeight:800,fontSize:"11px",color:"#fff"}}>CDS</div><div style={{fontSize:"9px",color:"#9099aa"}}>dos Sellers</div></div>
        </div>
        {[{l:"Dashboard",a:true},{l:"Precificação"},{l:"Meus Produtos"},{l:"Histórico"},{l:"Comparativo"},{l:"Relatórios"},{l:"Configurações"},{l:"Suporte"}].map(i=>(
          <div key={i.l} style={{padding:"9px 14px",display:"flex",alignItems:"center",gap:"8px",background:i.a?"rgba(255,182,0,0.1)":"transparent",borderLeft:i.a?"2px solid #FFB600":"2px solid transparent",color:i.a?"#FFB600":"#9099aa"}}>
            <div style={{width:"5px",height:"5px",borderRadius:"50%",background:i.a?"#FFB600":"#444",flexShrink:0}}/>
            <span style={{fontSize:"11px",fontWeight:i.a?700:400}}>{i.l}</span>
          </div>
        ))}
        <div style={{marginTop:"auto",padding:"12px 14px",borderTop:"1px solid rgba(255,255,255,0.06)"}}>
          <div style={{fontSize:"10px",color:"#FFB600",fontWeight:700}}>👑 Plano Vitalício</div>
          <div style={{marginTop:"5px",display:"inline-block",background:"rgba(0,217,126,0.12)",color:"#00D97E",borderRadius:"4px",padding:"2px 7px",fontSize:"9px",fontWeight:700}}>Ativo</div>
        </div>
      </div>
      {/* Main */}
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
        <div style={{padding:"14px 18px",borderBottom:"1px solid rgba(255,255,255,0.06)",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div><div style={{fontWeight:800,fontSize:"15px",color:"#fff"}}>Dashboard</div><div style={{fontSize:"10px",color:"#9099aa"}}>Visão geral do seu negócio</div></div>
          <div style={{display:"flex",alignItems:"center",gap:"10px"}}>
            <span style={{fontSize:"11px",color:"#9099aa"}}>Olá, Seller!</span>
            <div style={{width:"28px",height:"28px",borderRadius:"50%",background:"linear-gradient(135deg,#ff6b00,#ffb800)",display:"grid",placeItems:"center",fontSize:"12px",fontWeight:900,color:"#000"}}>S</div>
          </div>
        </div>
        <div style={{flex:1,overflow:"hidden",padding:"14px",display:"flex",gap:"14px"}}>
          {/* Coluna principal */}
          <div style={{flex:1,display:"flex",flexDirection:"column",gap:"12px",overflow:"hidden"}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"10px"}}>
              {[{label:"Produtos cadastrados",val:"24",sub:"↑ 12% vs mês anterior",cor:"#FF9500"},{label:"Cálculos realizados",val:"87",sub:"↑ 18% vs mês anterior",cor:"#A259FF"}].map(k=>(
                <div key={k.label} style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:"12px",padding:"14px"}}>
                  <div style={{fontSize:"10px",color:"#9099aa",marginBottom:"6px"}}>{k.label}</div>
                  <div style={{fontSize:"26px",fontWeight:900,color:k.cor}}>{k.val}</div>
                  <div style={{fontSize:"9px",color:"#00D97E",marginTop:"4px"}}>{k.sub}</div>
                </div>
              ))}
            </div>
            <div style={{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:"12px",flex:1,overflow:"hidden"}}>
              <div style={{padding:"10px 14px",borderBottom:"1px solid rgba(255,255,255,0.06)",fontWeight:700,color:"#fff",fontSize:"11px"}}>Últimos produtos analisados</div>
              <div style={{padding:"4px 0"}}>
                <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 0.8fr",padding:"4px 14px",fontSize:"9px",color:"#555",fontWeight:700}}><span>Produto</span><span>Marketplace</span><span style={{textAlign:"right"}}>Lucro</span></div>
                {produtos.map((p,i)=>(
                  <div key={i} style={{display:"grid",gridTemplateColumns:"2fr 1fr 0.8fr",padding:"7px 14px",alignItems:"center",background:i%2===0?"rgba(255,255,255,0.015)":"transparent"}}>
                    <div><div style={{color:"#fff",fontSize:"10px",fontWeight:600}}>{p.nome}</div><div style={{color:"#555",fontSize:"9px"}}>SKU: {p.sku}</div></div>
                    <div style={{color:"#9099aa",fontSize:"10px"}}>{p.mp}</div>
                    <div style={{textAlign:"right"}}><div style={{color:"#00D97E",fontSize:"10px",fontWeight:700}}>{p.lucro}</div><div style={{color:"#555",fontSize:"9px"}}>{p.pct}</div></div>
                  </div>
                ))}
              </div>
              <div style={{padding:"8px 14px",borderTop:"1px solid rgba(255,255,255,0.06)"}}><span style={{background:"rgba(255,182,0,0.12)",color:"#FFB600",borderRadius:"6px",padding:"3px 10px",fontSize:"10px",fontWeight:700}}>Ver todos os produtos</span></div>
            </div>
          </div>
          {/* Coluna direita */}
          <div style={{width:"210px",display:"flex",flexDirection:"column",gap:"12px"}}>
            {[{label:"Lucro estimado",val:"R$ 8.247,50",sub:"↑ 34% vs mês anterior",cor:"#00D97E"},{label:"Margem média",val:"18,45%",sub:"↑ 2,6% vs mês anterior",cor:"#6fa3ff"}].map(k=>(
              <div key={k.label} style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:"12px",padding:"14px"}}>
                <div style={{fontSize:"10px",color:"#9099aa",marginBottom:"6px"}}>{k.label}</div>
                <div style={{fontSize:"18px",fontWeight:900,color:k.cor}}>{k.val}</div>
                <div style={{fontSize:"9px",color:"#00D97E",marginTop:"4px"}}>{k.sub}</div>
              </div>
            ))}
            <div style={{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:"12px",flex:1,overflow:"hidden"}}>
              <div style={{padding:"10px 12px",borderBottom:"1px solid rgba(255,255,255,0.06)",fontWeight:700,color:"#fff",fontSize:"11px"}}>Alertas importantes</div>
              {[{e:"⚠️",t:"Aumento de custo detectado",d:"ESC-001 teve aumento de 14%. Reveja a precificação.",c:"#FFB600"},{e:"🔴",t:"Margem abaixo do ideal",d:"UV-005 abaixo de 15%. Ajuste recomendado.",c:"#ff6b6b"},{e:"🟢",t:"Oportunidade de lucro",d:"Na Shopee, margem pode aumentar 3,2%.",c:"#00D97E"}].map((a,i)=>(
                <div key={i} style={{padding:"9px 12px",borderBottom:"1px solid rgba(255,255,255,0.04)"}}>
                  <div style={{display:"flex",gap:"6px",alignItems:"flex-start"}}>
                    <span style={{fontSize:"11px",flexShrink:0}}>{a.e}</span>
                    <div><div style={{fontWeight:700,fontSize:"10px",color:a.c,marginBottom:"2px"}}>{a.t}</div><div style={{fontSize:"9px",color:"#9099aa",lineHeight:1.4}}>{a.d}</div></div>
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
    <div style={{minHeight:"100vh",background:"#0d0e12",color:"#fff",fontFamily:"system-ui,sans-serif",overflowX:"hidden"}}>

      {/* Header */}
      <header style={{position:"sticky",top:0,zIndex:100,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 56px",height:"72px",background:"rgba(13,14,18,0.92)",backdropFilter:"blur(20px)",borderBottom:"1px solid rgba(255,255,255,0.06)"}}>
        <div style={{display:"flex",alignItems:"center",gap:"14px"}}>
          <div style={{width:"42px",height:"42px",borderRadius:"11px",background:"linear-gradient(135deg,#FFB600,#FF6B00)",display:"grid",placeItems:"center",fontSize:"20px",fontWeight:900,color:"#000"}}>C</div>
          <div><div style={{fontWeight:900,fontSize:"16px",color:"#fff",lineHeight:1.1}}>CDS</div><div style={{fontSize:"10px",color:"#9099aa",letterSpacing:"0.5px"}}>CALCULADORA DOS SELLERS</div></div>
        </div>
        <nav style={{display:"flex",gap:"36px"}}>
          {["Funcionalidades","Como Funciona","Para Quem é","Depoimentos","Perguntas"].map(n=>(
            <a key={n} href="#" style={{color:"#9099aa",textDecoration:"none",fontSize:"14px",fontWeight:500,transition:"color 0.15s"}} onMouseEnter={e=>(e.currentTarget.style.color="#fff")} onMouseLeave={e=>(e.currentTarget.style.color="#9099aa")}>{n}</a>
          ))}
        </nav>
        <div style={{display:"flex",gap:"12px",alignItems:"center"}}>
          <Link href="/login" style={{display:"flex",alignItems:"center",gap:"6px",padding:"10px 20px",borderRadius:"10px",border:"1px solid rgba(255,255,255,0.15)",background:"transparent",color:"#fff",textDecoration:"none",fontSize:"14px",fontWeight:600}}>↗ Entrar</Link>
          <Link href="/login" style={{padding:"10px 22px",borderRadius:"10px",background:"linear-gradient(135deg,#FFB600,#FF6B00)",color:"#000",textDecoration:"none",fontSize:"14px",fontWeight:800,boxShadow:"0 4px 24px rgba(255,182,0,0.4)"}}>ACESSAR O PAINEL</Link>
        </div>
      </header>

      {/* Hero */}
      <section style={{display:"flex",alignItems:"center",gap:"64px",padding:"60px 80px",height:"calc(100vh - 72px)",boxSizing:"border-box",width:"100%"}}>
        {/* Esquerda */}
        <div style={{flex:"0 0 44%",minWidth:0}}>
          <div style={{display:"inline-flex",alignItems:"center",gap:"8px",background:"rgba(255,182,0,0.1)",border:"1px solid rgba(255,182,0,0.3)",borderRadius:"100px",padding:"7px 16px",marginBottom:"32px",fontSize:"12px",fontWeight:700,color:"#FFB600",letterSpacing:"0.5px"}}>
            ⭐ A FERRAMENTA Nº1 PARA SELLERS
          </div>
          <h1 style={{fontSize:"clamp(52px,5.5vw,80px)",fontWeight:900,lineHeight:1.02,margin:"0 0 24px 0",letterSpacing:"-2px"}}>
            <span style={{color:"#fff",display:"block"}}>Precifique certo.</span>
            <span style={{background:"linear-gradient(90deg,#FFB600,#FF6B00)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",display:"block"}}>Lucre mais.</span>
          </h1>
          <p style={{fontSize:"clamp(15px,1.4vw,19px)",color:"#9099aa",lineHeight:1.75,margin:"0 0 36px 0"}}>
            Descubra em segundos o <span style={{color:"#FFB600",fontWeight:600}}>preço ideal</span> para vender no Mercado Livre, Shopee, Amazon e Magalu sem comprometer sua margem.
          </p>
          <div style={{display:"flex",gap:"14px",marginBottom:"40px"}}>
            <Link href="/login" style={{display:"flex",alignItems:"center",gap:"10px",padding:"17px 32px",borderRadius:"13px",background:"linear-gradient(135deg,#FFB600,#FF6B00)",color:"#000",textDecoration:"none",fontSize:"16px",fontWeight:800,boxShadow:"0 8px 36px rgba(255,182,0,0.45)",letterSpacing:"0.3px"}}>ACESSAR O PAINEL →</Link>
            <Link href="/login" style={{display:"flex",alignItems:"center",gap:"10px",padding:"17px 28px",borderRadius:"13px",border:"1px solid rgba(255,255,255,0.15)",background:"rgba(255,255,255,0.05)",color:"#fff",textDecoration:"none",fontSize:"16px",fontWeight:700}}>🛒 CRIAR CONTA GRÁTIS</Link>
          </div>
          <div style={{display:"flex",gap:"28px",marginBottom:"48px",flexWrap:"wrap"}}>
            {[{icon:"🔒",t:"Dados 100% seguros",s:"Privacidade garantida"},{icon:"✅",t:"Fácil de usar",s:"Sem complicação"},{icon:"🔄",t:"Sempre atualizado",s:"Taxas em tempo real"}].map(b=>(
              <div key={b.t} style={{display:"flex",alignItems:"center",gap:"10px"}}>
                <span style={{fontSize:"20px"}}>{b.icon}</span>
                <div><div style={{fontSize:"13px",fontWeight:700,color:"#fff"}}>{b.t}</div><div style={{fontSize:"12px",color:"#9099aa"}}>{b.s}</div></div>
              </div>
            ))}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:"20px",flexWrap:"wrap"}}>
            <span style={{fontSize:"11px",color:"#555",fontWeight:700,letterSpacing:"0.5px"}}>INTEGRADO COM</span>
            {[{l:"Mercado Livre",c:"#FFE000",e:"🛒"},{l:"Shopee",c:"#EE4D2D",e:"🛍️"},{l:"Amazon",c:"#FF9900",e:"📦"},{l:"Magalu",c:"#0088CC",e:"🏪"}].map(m=>(
              <div key={m.l} style={{display:"flex",alignItems:"center",gap:"6px",fontSize:"14px",fontWeight:700,color:m.c,opacity:0.85}}>{m.e} {m.l}</div>
            ))}
          </div>
        </div>
        {/* Dashboard mockup */}
        <div style={{flex:1,minWidth:0}}><DashboardMockup/></div>
      </section>

      {/* Features */}
      <section style={{borderTop:"1px solid rgba(255,255,255,0.06)",borderBottom:"1px solid rgba(255,255,255,0.06)",padding:"56px 80px"}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:"0"}}>
          {[{icon:"💰",titulo:"Precificação automática",desc:"Calcule o preço certo considerando todos os custos e comissões de cada marketplace."},{icon:"📊",titulo:"Gestão de anúncios",desc:"Importe todos os seus produtos de ML e Shopee com um clique."},{icon:"📈",titulo:"Vendas em tempo real",desc:"Acompanhe faturamento, lucro e margem de contribuição de cada venda."},{icon:"🏪",titulo:"Multi-loja",desc:"Gerencie múltiplas contas de diferentes marketplaces em um único painel."}].map((f,i)=>(
            <div key={i} style={{padding:"36px 40px",borderRight:i<3?"1px solid rgba(255,255,255,0.06)":"none"}}>
              <div style={{fontSize:"36px",marginBottom:"16px"}}>{f.icon}</div>
              <div style={{fontWeight:800,fontSize:"17px",color:"#fff",marginBottom:"10px"}}>{f.titulo}</div>
              <div style={{fontSize:"14px",color:"#9099aa",lineHeight:1.65}}>{f.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer style={{padding:"36px 80px",display:"flex",justifyContent:"space-between",alignItems:"center",maxWidth:"1440px",margin:"0 auto"}}>
        <div style={{fontSize:"13px",color:"#555"}}>Calculadora dos Sellers © {new Date().getFullYear()}</div>
        <Link href="/login" style={{padding:"12px 26px",borderRadius:"10px",background:"linear-gradient(135deg,#FFB600,#FF6B00)",color:"#000",textDecoration:"none",fontSize:"14px",fontWeight:800,boxShadow:"0 4px 20px rgba(255,182,0,0.35)"}}>Acessar o Painel →</Link>
      </footer>
    </div>
  );
}
