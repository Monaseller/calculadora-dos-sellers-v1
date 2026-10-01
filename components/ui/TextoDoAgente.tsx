"use client";

/**
 * O texto do agente, formatado — F7b.4.8.5-R1.
 *
 * ── O bug ───────────────────────────────────────────────────────────
 *
 * O chat mostrava `{m.conteudo}` como no de texto puro. O modelo escreve
 * Markdown — e escreve bem: ele destaca o numero, separa em lista, monta
 * tabela de comparacao. O Rodrigo leu, na tela:
 *
 *   **Vendas brutas (produtos): R$ 393.838,47**
 *
 * com os asteriscos visiveis. O numero estava certo e a leitura estava
 * quebrada.
 *
 * ── Por que React, e nunca HTML ─────────────────────────────────────
 *
 * Este texto vem de um modelo de linguagem, e parte dele vem de dados do
 * Mercado Livre — titulo de anuncio, nome de comprador, mensagem de erro
 * de terceiro. Nada disso e confiavel.
 *
 * `dangerouslySetInnerHTML` com Markdown convertido seria XSS por
 * construcao: bastaria o conteudo conter `<img onerror=...>` para
 * executar. Entao aqui NAO se gera HTML. Gera-se ARVORE REACT: os
 * unicos elementos que existem sao os que este arquivo escreve
 * (`<strong>`, `<em>`, `<code>`, `<li>`, `<table>`...), e todo o texto
 * entra como CHILD, que o React escapa sempre. Nao existe caminho pelo
 * qual o conteudo se torne marcacao.
 *
 * Nenhuma dependencia nova: um `marked` + `DOMPurify` resolveria o
 * problema e traria duas bibliotecas para a superficie de ataque que este
 * arquivo existe para fechar. O subconjunto aqui e o que o modelo
 * realmente emite, medido nas respostas reais do gate.
 *
 * ── Link e o unico caso com decisao de seguranca ────────────────────
 *
 * `[texto](url)` so vira `<a>` quando a URL comeca com `http://` ou
 * `https://`. `javascript:`, `data:` e `vbscript:` nao viram link — o
 * texto aparece, o endereco nao e clicavel. Default NEGA.
 */
// O namespace entra porque `tsconfig` usa `jsx: "preserve"`: o Next
// compila com o runtime automatico, mas `tsx` — que roda a suite — usa o
// transform classico e precisa de `React` em escopo. Mesmo padrao de
// `app/(app)/dashboard/page.tsx`.
import * as React from "react";
import type { ReactNode } from "react";

import { CROMO, ESPACO } from "@/lib/ia/design";
import { TAMANHO } from "@/components/ui/Primitivas";

/** Os unicos esquemas que podem virar link. Lista fechada. */
const ESQUEMAS_PERMITIDOS = ["http://", "https://"];

function linkSeguro(url: string): string | null {
  const limpo = url.trim();
  return ESQUEMAS_PERMITIDOS.some((e) => limpo.toLowerCase().startsWith(e))
    ? limpo : null;
}

/**
 * O trecho de UMA linha: negrito, italico, codigo e link.
 *
 * Varre caractere a caractere em vez de usar uma cascata de `replace`
 * com regex: a cascata reprocessa o resultado da anterior, e ai um
 * asterisco que veio DENTRO de um bloco de codigo vira negrito. Varrer
 * uma vez mantem a precedencia explicita.
 */
function formatarLinha(texto: string, chave: string): ReactNode[] {
  const saida: ReactNode[] = [];
  let acumulado = "";
  let i = 0;
  let n = 0;

  const descarregar = (): void => {
    if (acumulado !== "") { saida.push(acumulado); acumulado = ""; }
  };
  const proxima = (): string => `${chave}-${n++}`;

  while (i < texto.length) {
    const resto = texto.slice(i);

    // Codigo primeiro: dentro dele nada mais e marcacao.
    const codigo = /^`([^`]+)`/.exec(resto);
    if (codigo !== null) {
      descarregar();
      saida.push(
        <code key={proxima()} style={{
          background: CROMO.fundo, border: `1px solid ${CROMO.borda}`,
          borderRadius: 4, padding: "1px 4px", fontSize: TAMANHO.miudo,
        }}>{codigo[1]}</code>);
      i += codigo[0].length;
      continue;
    }

    // Negrito antes de italico: `**x**` tem de ganhar de `*x*`.
    const negrito = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(resto);
    if (negrito !== null) {
      descarregar();
      saida.push(
        <strong key={proxima()} style={{ fontWeight: 600 }}>
          {formatarLinha(negrito[2], proxima())}
        </strong>);
      i += negrito[0].length;
      continue;
    }

    const italico = /^(\*|_)(?=\S)([^*_]*?\S)\1/.exec(resto);
    if (italico !== null) {
      descarregar();
      saida.push(
        <em key={proxima()}>{formatarLinha(italico[2], proxima())}</em>);
      i += italico[0].length;
      continue;
    }

    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(resto);
    if (link !== null) {
      descarregar();
      const endereco = linkSeguro(link[2]);
      if (endereco === null) {
        // Esquema recusado: o TEXTO aparece, o endereco nao vira clique.
        saida.push(link[1]);
      } else {
        saida.push(
          <a key={proxima()} href={endereco} target="_blank" rel="noopener noreferrer"
            style={{ color: CROMO.acento }}>{link[1]}</a>);
      }
      i += link[0].length;
      continue;
    }

    acumulado += texto[i];
    i += 1;
  }
  descarregar();
  return saida;
}

type Bloco =
  | { readonly tipo: "paragrafo"; readonly linhas: string[] }
  | { readonly tipo: "titulo"; readonly nivel: number; readonly texto: string }
  | { readonly tipo: "lista"; readonly ordenada: boolean; readonly itens: string[] }
  | { readonly tipo: "tabela"; readonly cabecalho: string[]; readonly linhas: string[][] };

/** `| a | b |` -> ["a", "b"]. */
function celulasDaLinha(linha: string): string[] {
  return linha.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|")
    .map((c) => c.trim());
}
const ehSeparadorDeTabela = (linha: string): boolean =>
  /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(linha) && linha.includes("-");

/**
 * Agrupa as linhas em blocos.
 *
 * Um parser de linha a linha, e nao um de Markdown completo: o que entra
 * aqui e saida de chat, nao documento. Citacao, imagem e HTML embutido
 * ficam como TEXTO de proposito — o que nao se entende nao se interpreta.
 */
function emBlocos(texto: string): Bloco[] {
  const linhas = texto.replace(/\r\n/g, "\n").split("\n");
  const blocos: Bloco[] = [];
  let i = 0;

  while (i < linhas.length) {
    const linha = linhas[i];

    if (linha.trim() === "") { i += 1; continue; }

    const titulo = /^(#{1,4})\s+(.*)$/.exec(linha);
    if (titulo !== null) {
      blocos.push({ tipo: "titulo", nivel: titulo[1].length, texto: titulo[2] });
      i += 1;
      continue;
    }

    // Tabela: uma linha com barras seguida da linha de separacao.
    if (linha.includes("|") && i + 1 < linhas.length && ehSeparadorDeTabela(linhas[i + 1])) {
      const cabecalho = celulasDaLinha(linha);
      const corpo: string[][] = [];
      i += 2;
      while (i < linhas.length && linhas[i].includes("|") && linhas[i].trim() !== "") {
        corpo.push(celulasDaLinha(linhas[i]));
        i += 1;
      }
      blocos.push({ tipo: "tabela", cabecalho, linhas: corpo });
      continue;
    }

    const itemLista = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(linha);
    if (itemLista !== null) {
      const ordenada = /\d/.test(itemLista[1]);
      const itens: string[] = [];
      while (i < linhas.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(linhas[i]);
        if (m === null || /\d/.test(m[1]) !== ordenada) break;
        itens.push(m[2]);
        i += 1;
      }
      blocos.push({ tipo: "lista", ordenada, itens });
      continue;
    }

    // Paragrafo: tudo ate a proxima linha vazia ou inicio de outro bloco.
    const doParagrafo: string[] = [];
    while (i < linhas.length && linhas[i].trim() !== "" &&
      !/^(#{1,4})\s+/.test(linhas[i]) &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(linhas[i]) &&
      !(linhas[i].includes("|") && i + 1 < linhas.length && ehSeparadorDeTabela(linhas[i + 1]))) {
      doParagrafo.push(linhas[i]);
      i += 1;
    }
    if (doParagrafo.length > 0) blocos.push({ tipo: "paragrafo", linhas: doParagrafo });
    else i += 1;
  }

  return blocos;
}

/**
 * Converte o texto em blocos React. Exportada para a suite poder medir.
 */
export function blocosDoTexto(texto: string): Bloco[] {
  return emBlocos(texto);
}

export function TextoDoAgente({ texto }: { readonly texto: string }) {
  const blocos = emBlocos(texto);

  return (
    <div style={{ fontSize: TAMANHO.corpo, color: CROMO.texto, lineHeight: 1.55 }}>
      {blocos.map((b, indice) => {
        const chave = `b${indice}`;
        const primeiro = indice === 0;

        if (b.tipo === "titulo") {
          return (
            <div key={chave} style={{
              fontWeight: 600,
              fontSize: b.nivel <= 2 ? TAMANHO.titulo : TAMANHO.corpo,
              marginTop: primeiro ? 0 : ESPACO.sm, marginBottom: 4,
            }}>
              {formatarLinha(b.texto, chave)}
            </div>
          );
        }

        if (b.tipo === "lista") {
          const Marca = b.ordenada ? "ol" : "ul";
          return (
            <Marca key={chave} style={{
              margin: `${primeiro ? 0 : ESPACO.xs}px 0 0 0`,
              paddingLeft: 20,
            }}>
              {b.itens.map((item, j) => (
                <li key={`${chave}-${j}`} style={{ marginBottom: 2 }}>
                  {formatarLinha(item, `${chave}-${j}`)}
                </li>
              ))}
            </Marca>
          );
        }

        if (b.tipo === "tabela") {
          return (
            <div key={chave} style={{ marginTop: primeiro ? 0 : ESPACO.sm, overflowX: "auto" }}>
              <table style={{
                borderCollapse: "collapse", fontSize: TAMANHO.miudo, minWidth: "100%",
              }}>
                <thead>
                  <tr>
                    {b.cabecalho.map((c, j) => (
                      <th key={`${chave}-h${j}`} style={{
                        textAlign: "left", padding: "4px 8px",
                        borderBottom: `1px solid ${CROMO.borda}`,
                        color: CROMO.textoFraco, fontWeight: 600, whiteSpace: "nowrap",
                      }}>{formatarLinha(c, `${chave}-h${j}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.linhas.map((linha, j) => (
                    <tr key={`${chave}-r${j}`}>
                      {linha.map((c, k) => (
                        <td key={`${chave}-r${j}c${k}`} style={{
                          padding: "4px 8px",
                          borderBottom: `1px solid ${CROMO.borda}`,
                          whiteSpace: "nowrap",
                        }}>{formatarLinha(c, `${chave}-r${j}c${k}`)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        // Paragrafo. `pre-wrap` nas linhas internas preserva a quebra
        // simples que o modelo usa dentro do mesmo paragrafo.
        return (
          <div key={chave} style={{
            marginTop: primeiro ? 0 : ESPACO.sm, whiteSpace: "pre-wrap",
          }}>
            {b.linhas.map((l, j) => (
              <span key={`${chave}-l${j}`}>
                {j > 0 ? "\n" : null}
                {formatarLinha(l, `${chave}-l${j}`)}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}
