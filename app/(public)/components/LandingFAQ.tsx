"use client";
import { useState } from "react";
import s from "../landing.module.css";

const FAQS = [
  {
    q: "Como funciona o período gratuito?",
    a: "Você tem acesso completo a todas as funcionalidades por 1 dia sem precisar inserir cartão de crédito. Após o período, escolha o plano que melhor se adapta ao seu negócio e continue vendendo com lucro.",
  },
  {
    q: "Quais marketplaces são suportados?",
    a: "Atualmente suportamos Mercado Livre, Shopee, Amazon e Magalu — com TikTok Shop chegando em breve. Estamos constantemente expandindo para novos canais de venda.",
  },
  {
    q: "Preciso integrar minha conta do Mercado Livre?",
    a: "Para funcionalidades avançadas como importação automática de anúncios e sincronização de vendas em tempo real, sim. Para a calculadora básica, basta colar o link do produto — zero configuração.",
  },
  {
    q: "O plano Lifetime realmente vale a pena?",
    a: "Para sellers que usam a plataforma regularmente, o Lifetime se paga em poucos meses e você nunca mais paga mensalidade. É um investimento único com retorno infinito.",
  },
  {
    q: "Os dados dos meus anúncios ficam seguros?",
    a: "Absolutamente. Usamos criptografia de ponta a ponta e nunca compartilhamos seus dados com terceiros. Sua operação é sua — nós apenas ajudamos a torná-la mais lucrativa.",
  },
  {
    q: "Posso cancelar a qualquer momento?",
    a: "Sim, sem burocracia. Planos mensais podem ser cancelados a qualquer momento pelo painel, sem multas ou taxas. Seu acesso continua ativo até o fim do período já pago.",
  },
  {
    q: "A CDS funciona para dropshipping?",
    a: "Sim! Você pode informar o custo do produto, frete, insumos e qualquer outro custo variável. A CDS calcula a margem real e o preço ideal levando tudo em conta.",
  },
];

export default function LandingFAQ() {
  const [open, setOpen] = useState<number | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px", maxWidth: "780px", margin: "0 auto" }}>
      {FAQS.map((faq, i) => (
        <div
          key={i}
          className={s.faqItem}
          onClick={() => setOpen(open === i ? null : i)}
          style={{
            background: "#0F172A",
            border: `1px solid ${open === i ? "rgba(255,122,0,0.35)" : "#1E293B"}`,
            borderRadius: "14px",
            overflow: "hidden",
            boxShadow: open === i ? "0 0 30px rgba(255,122,0,0.06)" : "none",
          }}
        >
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "20px 24px",
          }}>
            <span style={{ fontWeight: 600, fontSize: "15px", color: "#fff", paddingRight: "16px" }}>{faq.q}</span>
            <span style={{
              color: open === i ? "#FF7A00" : "#475569",
              fontSize: "22px", fontWeight: 300,
              transition: "transform 0.3s ease, color 0.2s ease",
              transform: open === i ? "rotate(45deg)" : "rotate(0deg)",
              display: "inline-block", flexShrink: 0, lineHeight: 1,
            }}>+</span>
          </div>
          <div style={{
            maxHeight: open === i ? "300px" : "0",
            overflow: "hidden",
            transition: "max-height 0.35s cubic-bezier(0.4,0,0.2,1)",
          }}>
            <div style={{ padding: "0 24px 20px", color: "#94A3B8", fontSize: "14px", lineHeight: 1.75 }}>
              {faq.a}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
