/**
 * CDS IA — F8.3-C2: Criar agente em 6 etapas, sobre contratos reais.
 *
 * Cobre: identidade, modelo de IA, APIs, Tools, memoria, revisao/criar,
 * navegacao (6 passos, sem Skills/Arquivos/Rotinas/Testar, sem Wizard
 * antigo) e areas congeladas (Office e Agentes nao importam nada daqui).
 *
 * Regras puras + render (SSR) dos componentes reais com dados de teste +
 * guardas de fonte. Nenhum backend e tocado.
 *
 * Rodar: npx tsx scripts/testar-criar-agente-v2.ts
 */
import "./_env-inerte";
import "./_server-only-inerte";

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsx usa o JSX classico: os componentes precisam de `React` global.
(globalThis as unknown as { React: typeof React }).React = React;
require.extensions[".css"] = (m: NodeJS.Module) => {
  // Nao se declara modulo ES: o interop entrega o proxy como `default`.
  (m as unknown as { exports: unknown }).exports = new Proxy({}, {
    get: (_t, k) => (k === "__esModule" || typeof k === "symbol" ? undefined : String(k)),
  });
};

import {
  CAPACIDADES_MERCADO_LIVRE, ETAPAS_DE_CRIACAO, ETAPA_ANTIGA_PARA_NOVA, FUNCOES_DE_CRIACAO,
  destinosDoAgenteCriado, enderecoDoRascunho, etapaDoImpedimento, etapaValida, resumoDoAgente,
} from "@/lib/ia/criar-agente";
import { TIPOS_AGENTE } from "@/lib/agentes/tipos";
import { TOOL_PACKS, packPorId } from "@/lib/agentes/factory/catalogo-ui";
import { INTEGRACOES_CDS, PACK_API_MERCADO_LIVRE } from "@/lib/ia/agentes-gestao";
import type { AtivacaoDoAgenteUI, MemoriaDoAgenteUI } from "@/lib/ia/agentes-http";

let passou = 0;
let falhou = 0;
const ok = (nome: string, cond: boolean, det = ""): void => {
  if (cond) { passou += 1; console.log(`  PASS  ${nome}`); }
  else { falhou += 1; console.log(`  FAIL  ${nome}${det ? `  — ${det}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(2, 58 - t.length))}`);
const ler = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const semComentario = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const CRIAR = semComentario(ler("components/ia/criar/CriarAgente.tsx"));
const APIS = semComentario(ler("components/ia/criar/EtapaApis.tsx"));
const TOOLS = semComentario(ler("components/ia/criar/EtapaTools.tsx"));
const MEMORIA = semComentario(ler("components/ia/criar/EtapaMemoria.tsx"));
const COMUM = semComentario(ler("components/ia/criar/comum.tsx"));
const CSS = ler("components/ia/criar/criar.module.css");
const PAGINA = semComentario(ler("app/(app)/ia/agentes/novo/page.tsx"));
const AREA = CRIAR + APIS + TOOLS + MEMORIA + COMUM + PAGINA;

const ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ML = { id: PACK_API_MERCADO_LIVRE, nome: "Mercado Livre", completo: true, nivel: "automatico", faltando: 0 };
const PLANILHAS = { id: "planilhas", nome: "Planilhas", completo: true, nivel: "automatico", faltando: 0 };
const CALENDARIO = { id: "calendario", nome: "Calendário", completo: false, nivel: null, faltando: 1 };

function ativacao(p: Partial<AtivacaoDoAgenteUI> = {}): AtivacaoDoAgenteUI {
  return {
    nome: "Agente de Mensagens", ativo: false, temInstrucoes: true, modelo: "gpt-x", provedor: "openai",
    provedorEscolhido: "openai", nivelDeTrabalho: "avancado", iaDesfecho: "ok", memoriaAtiva: true,
    ferramentas: [ML, PLANILHAS], ferramentasExternas: [],
    modelos: [
      { provedor: "openai", nome: "OpenAI", descricao: "", modeloId: "gpt-x", ferramentas: true, niveis: ["rapido", "equilibrado", "avancado"] },
      { provedor: "anthropic", nome: "Claude", descricao: "", modeloId: "claude-x", ferramentas: true, niveis: ["padrao"] },
    ],
    integracoes: [], conexoesSemLoja: [], dependenciasDeSkill: [], podeAtivar: true, impedimentos: [],
    ...p,
  } as AtivacaoDoAgenteUI;
}
const MEMORIAS: MemoriaDoAgenteUI[] = [
  { id: "m1", conteudo: "Mostre o saldo primeiro.", tipo: null, ordem: 1, ativo: true },
  { id: "m2", conteudo: "Antiga.", tipo: null, ordem: 2, ativo: false },
];

async function main(): Promise<void> {
  console.log("\n══ CDS IA — F8.3-C2: Criar agente (6 etapas) ══");
  const escrever = async () => true;

  // =====================================================================
  secao("A. Navegacao: 6 etapas, nada do que saiu");
  ok("A1  exatamente 6 etapas, na ordem do v0",
    ETAPAS_DE_CRIACAO.map((e) => e.titulo).join("|") === "Identidade|Modelo de IA|APIs|Tools|Memória|Criar");
  ok("A2  subtitulos da spec", ETAPAS_DE_CRIACAO.map((e) => e.subtitulo).join("|") ===
    "Nome e função do agente|Escolha o modelo e parâmetros|Conecte as integrações|Configure ferramentas|Defina o contexto|Revise e finalize");
  ok("A3  sem Skills, Arquivos, Rotinas ou Testar no stepper",
    !ETAPAS_DE_CRIACAO.some((e) => /Skill|Arquivo|Rotina|Testar|Permiss/.test(e.titulo)));
  ok("A4  mapa das 11 etapas antigas: Skills/Arquivos/Rotinas/Testar fora (null)",
    [5, 7, 9, 10].every((n) => ETAPA_ANTIGA_PARA_NOVA[n] === null) &&
      ETAPA_ANTIGA_PARA_NOVA[1] === 1 && ETAPA_ANTIGA_PARA_NOVA[2] === 1 && ETAPA_ANTIGA_PARA_NOVA[3] === 2 &&
      ETAPA_ANTIGA_PARA_NOVA[6] === 5 && ETAPA_ANTIGA_PARA_NOVA[11] === 6 && Object.keys(ETAPA_ANTIGA_PARA_NOVA).length === 11);
  ok("A5  etapa da URL validada (1..6)", etapaValida("3") === 3 && etapaValida("7") === null && etapaValida("x") === null && etapaValida(null) === null);
  ok("A6  sem navegacao para o Wizard antigo", !/\/configurar[`"'/]|router\.(push|replace)|<Wizard|factory\/Wizard/.test(AREA));
  ok("A7  sem chat de teste nem modoTeste no fluxo", !/ChatDoAgente|modoTeste/.test(AREA));
  ok("A8  sem Skills/Arquivos/Rotinas como componente do fluxo",
    !/ArquivosDoAgente|vincularSkillNoAgente|criarSkillDoDono|listarSkills|Rotinas/.test(AREA));
  ok("A9  rascunho do fluxo fica NESTE fluxo", enderecoDoRascunho(ID, 3) === `/ia/agentes/novo?agente=${ID}&etapa=3`);
  ok("A10 a rota /ia/agentes/novo renderiza o fluxo novo", /<CriarAgente \/>/.test(PAGINA) && !/Wizard/.test(PAGINA));
  ok("A11 rascunho nao salvo: trocar etapa / voltar do navegador / fechar pedem confirmacao",
    /const confirmarSaida = \(\) => !temRascunho\(\) \|\| window\.confirm\(AVISO_RASCUNHO\)/.test(CRIAR) &&
      /addEventListener\("popstate", aoVoltar\)/.test(CRIAR) && /addEventListener\("beforeunload", aoSair\)/.test(CRIAR));
  ok("A12 escrita imediata nao vira prompt (Continuar so confirma com rascunho)",
    /irPara\(\(etapa \+ 1\) as NumeroDaEtapa, \{ semConfirmar: !temRascunho\(\) \}\)/.test(CRIAR));
  ok("A13 voltar/continuar no rodape; Criar agente na ultima", />\s*Voltar\s*</.test(CRIAR.replace(/<Icone\w+[^>]*\/>/g, "")) &&
    /"Continuar"/.test(CRIAR) && /"Criar agente"/.test(CRIAR));

  // =====================================================================
  secao("B. Identidade (nome, funcao, instrucoes, persistencia)");
  ok("B1  funcoes = os tipos REAIS do CHECK (nenhum inventado, todos presentes)",
    FUNCOES_DE_CRIACAO.length === TIPOS_AGENTE.length &&
      FUNCOES_DE_CRIACAO.every((f) => (TIPOS_AGENTE as readonly string[]).includes(f.tipo)));
  ok("B2  rotulos da spec", FUNCOES_DE_CRIACAO.map((f) => f.rotulo).join(",") ===
    "Mensagens,Financeiro,ADS,Anúncios,Fotos,Gerente,Personalizado");
  ok("B3  cria o agente INATIVO com nome, funcao e instrucoes (contrato real)",
    /criarAgenteViaApi\(\{\s*nome: nome\.trim\(\), tipo, instrucoes: instrucoes\.trim\(\) === "" \? null : instrucoes,/.test(CRIAR));
  ok("B4  depois de criado: PATCH so nome/instrucoes (funcao nao e editavel)",
    /atualizarAgenteViaApi\(agenteId, \{ nome: nome\.trim\(\), instrucoes \}\)/.test(CRIAR) &&
      /disabled=\{agenteId !== null \|\| ocupado\}/.test(CRIAR));
  ok("B5  nome obrigatorio, limite 120 (o mesmo do Wizard)", /if \(nome\.trim\(\) === ""\) \{ setErro\("Dê um nome ao agente\."\)/.test(CRIAR) &&
    /maxLength=\{120\}/.test(CRIAR));
  ok("B6  instrucoes com contador real (sem limite inventado)", /\{instrucoes\.length\} caracteres/.test(CRIAR) && !/maxLength=\{\d{4}/.test(CRIAR));
  ok("B7  persistencia: refresh retoma o rascunho pelo id (lista real)",
    /const r = await listarAgentes\(\);/.test(CRIAR) && /replaceState\(null, "", enderecoDoRascunho\(r\.agente\.id, 2\)\)/.test(CRIAR));

  // =====================================================================
  secao("C. Modelo de IA (catalogo real)");
  ok("C1  provedor = catalogo do servidor (`ativacao.modelos`) + provedores conhecidos",
    /\[\.\.\.new Set\(\[\.\.\.PROVEDORES, \.\.\.ofertas\.map\(\(m\) => m\.provedor\)\]\)\]/.test(CRIAR));
  ok("C2  provedor sem oferta = desabilitado e 'Indisponível'", /disabled=\{oferta === null \|\| ocupado\}/.test(CRIAR) &&
    /oferta === null \? "Indisponível"/.test(CRIAR));
  ok("C3  escolha grava pelo contrato (sem modeloId do cliente)",
    /definirIaDoAgente\(agenteId as string, \{\s*provedor: oferta\.provedor, nivel:/.test(CRIAR) && !/modeloId:/.test(CRIAR));
  ok("C4  modelo = o do ambiente (exibido, nao escolhido)", /\{escolhido\.modeloId\}/.test(CRIAR) && !/<select[^>]*modelo/i.test(CRIAR));
  ok("C5  nivel SO quando o provedor oferece mais de um",
    /escolhido !== null && escolhido\.niveis\.length > 1 && atualNivel !== null/.test(CRIAR));
  const r1 = resumoDoAgente({ nome: "Agente de Mensagens", tipo: "mensagens", ativacao: ativacao(), memorias: MEMORIAS });
  const linha = (r: string) => r1.find((l) => l.rotulo === r)?.valor;
  ok("C6  resumo: 'OpenAI · Avançado' (provedor escolhido + nivel real)", linha("Modelo de IA") === "OpenAI · Avançado", String(linha("Modelo de IA")));
  const r2 = resumoDoAgente({ nome: "X", tipo: "mensagens",
    ativacao: ativacao({ provedorEscolhido: "anthropic", nivelDeTrabalho: null }), memorias: [] });
  ok("C7  provedor de nivel unico: so o nome", r2.find((l) => l.rotulo === "Modelo de IA")?.valor === "Claude");
  const r3 = resumoDoAgente({ nome: "X", tipo: "mensagens", ativacao: ativacao({ provedorEscolhido: null }), memorias: [] });
  ok("C8  nada escolhido: resumo nao inventa modelo", r3.find((l) => l.rotulo === "Modelo de IA")?.valor === null);

  // =====================================================================
  secao("D. APIs (projecao visual, sem capacidade falsa)");
  const { default: EtapaApis } = await import("@/components/ia/criar/EtapaApis");
  const htmlApis = renderToStaticMarkup(React.createElement(EtapaApis, {
    agenteId: ID, ativacao: ativacao(), ocupado: false, escrever, avisar: () => {}, aoMudarConexao: () => {},
  }));
  ok("D1  Mercado Livre aparece como API", /Mercado Livre[\s\S]{0,200}>API</.test(htmlApis));
  ok("D2  Shopee aparece como API, 'Ainda não disponível para agentes'",
    /Shopee[\s\S]{0,200}>API<[\s\S]{0,200}Ainda não disponível para agentes/.test(htmlApis) &&
      INTEGRACOES_CDS.find((i) => i.chave === "shopee")?.packId === null);
  const funcoesMl = packPorId(PACK_API_MERCADO_LIVRE)?.funcoes ?? [];
  const reais = CAPACIDADES_MERCADO_LIVRE.filter((c) => c.funcao !== null);
  ok("D3  capacidades 'reais' sao Funcoes REAIS do pack", reais.length === 2 && reais.every((c) => funcoesMl.includes(c.funcao as string)));
  ok("D4  'Ler/Responder mensagens' NAO existem: desabilitadas, 'Ainda não disponível'",
    CAPACIDADES_MERCADO_LIVRE.filter((c) => /mensagens/i.test(c.rotulo)).every((c) => c.funcao === null) &&
      /Responder mensagens<span[^>]*>Ainda não disponível/.test(htmlApis) && /aria-disabled="true"[^>]*>[\s\S]{0,300}Responder mensagens/.test(htmlApis));
  ok("D5  nenhuma capacidade e selecionavel (sem checkbox sem efeito)", !/type="checkbox"/.test(htmlApis) && !/type="checkbox"/.test(APIS));
  ok("D6  usar/remover o ML pelos contratos de pack", /adicionarPackAoAgente\(agenteId, integracao\.packId as string, null\)/.test(APIS) &&
    /removerPackDoAgente\(agenteId, pack\.id\)/.test(APIS));
  // F9.2-A2: contas do dono e troca pelo contrato de APIs, UMA por provider.
  ok("D7  conta real e troca de conta pelo contrato de APIs (sem recurso)",
    /buscarApisDoAgente\(agenteId, c\.signal\)/.test(APIS) && /definirContaDaApi\(agenteId, provedor, lojaId\)/.test(APIS) &&
      !/recurso/.test(APIS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "")) &&
      /Trocar conta/.test(APIS));
  ok("D8  nivel do ML (Automático / Exige aprovação / Bloqueado)",
    /Quando o agente pode usar o Mercado Livre/.test(htmlApis) && /Exige aprovação/.test(htmlApis));
  const trechoApi = htmlApis.slice(Math.max(0, htmlApis.indexOf("Adicionar API") - 700), htmlApis.indexOf("Adicionar API") + 20);
  ok("D9  '+ Adicionar API' existe mas nao abre fluxo (desabilitado)",
    /<button type="button"[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Adicionar API$/.test(trechoApi.slice(0, trechoApi.indexOf("Adicionar API") + 13)),
    trechoApi.slice(-260));
  const htmlSemMl = renderToStaticMarkup(React.createElement(EtapaApis, {
    agenteId: ID, ativacao: ativacao({ ferramentas: [PLANILHAS] }), ocupado: false, escrever, avisar: () => {}, aoMudarConexao: () => {},
  }));
  ok("D10 sem o ML no agente: capacidades nao aparecem", !/Consultar vendas/.test(htmlSemMl));
  ok("D11 sem rede propria e sem endereco de API no fluxo", !/fetch\(|["'`]\/api\//.test(AREA));

  // =====================================================================
  secao("E. Tools (busca, adicionar, remover, nivel)");
  const { default: EtapaTools } = await import("@/components/ia/criar/EtapaTools");
  const htmlTools = renderToStaticMarkup(React.createElement(EtapaTools, {
    agenteId: ID, ativacao: ativacao({ ferramentas: [ML, PLANILHAS, CALENDARIO] }), ocupado: false, escrever,
  }));
  ok("E1  campo 'Buscar Tools...'", /placeholder="Buscar Tools\.\.\."/.test(htmlTools));
  ok("E2  'Neste agente' e 'Disponíveis'", /Neste agente \(/.test(htmlTools) && /Disponíveis \(/.test(htmlTools));
  ok("E3  ML NAO aparece em Tools", !/Mercado Livre/.test(htmlTools));
  const internas = TOOL_PACKS.filter((p) => p.id !== PACK_API_MERCADO_LIVRE).length;
  ok("E4  contagens reais (2 no agente; o resto disponivel)", /Neste agente \(2\)/.test(htmlTools) &&
    new RegExp(`Disponíveis \\(${internas - 2}\\)`).test(htmlTools), htmlTools.match(/(Neste agente|Disponíveis) \(\d+\)/g)?.join(" "));
  ok("E5  Tool com permissao incompleta e dita", /Falta definir a permissão/.test(htmlTools));
  ok("E6  adicionar / remover / nivel pelos contratos", /adicionarPackAoAgente\(agenteId, p\.id, null\)/.test(TOOLS) &&
    /removerPackDoAgente\(agenteId, f\.id\)/.test(TOOLS) && /adicionarPackAoAgente\(agenteId, f\.id, n\)/.test(TOOLS));
  ok("E7  selecionada = contorno laranja", /itemAtivo/.test(TOOLS) && /\.itemAtivo,\s*\.itemAtivo:hover \{\s*border-color: var\(--cr-acento-borda\);/.test(CSS));
  ok("E8  busca usa o filtro comum (sem acento; exclui packs de API)", /filtrarTools\(termo, TOOL_PACKS\)/.test(TOOLS));

  // =====================================================================
  secao("F. Memoria");
  const { default: EtapaMemoria } = await import("@/components/ia/criar/EtapaMemoria");
  const htmlMem = renderToStaticMarkup(React.createElement(EtapaMemoria, {
    agenteId: ID, ativacao: ativacao(), motor: { memoriaAtiva: true, motorConfigurado: true, desfecho: "ok", contexto: null },
    memorias: MEMORIAS, falhaMemorias: false, ocupado: false, escrever, avisar: () => {}, aoAlterarRascunho: () => {},
  }));
  ok("F1  automatica: interruptor + estado do motor", /role="switch" aria-checked="true" aria-label="Memória automática"/.test(htmlMem) &&
    /Disponível neste ambiente/.test(htmlMem) && /definirMemoriaDoAgente\(agenteId, v\)/.test(MEMORIA));
  ok("F2  lista as fixadas (ativa e desativada)", /Mostre o saldo primeiro\./.test(htmlMem) && /Antiga\./.test(htmlMem) && /\(1 ativa\)/.test(htmlMem));
  ok("F3  criar", /criarMemoriaDoAgente\(agenteId, \{ conteudo: texto, ordem:/.test(MEMORIA));
  ok("F4  editar texto (PATCH conteudo)", /alterarMemoriaDoAgente\(agenteId, editando\.id, \{ conteudo: texto \}\)/.test(MEMORIA));
  ok("F5  ativar/desativar (PATCH ativo)", /alterarMemoriaDoAgente\(agenteId, m\.id, \{ ativo: !m\.ativo \}\)/.test(MEMORIA) &&
    />Desativar</.test(htmlMem) && />Ativar</.test(htmlMem));
  ok("F6  excluir com confirmacao", /Confirmar exclusão/.test(MEMORIA) && /removerMemoriaDoAgente\(agenteId, m\.id\)/.test(MEMORIA));
  ok("F7  limite do dominio", /maxLength=\{MAX_CONTEUDO_DA_MEMORIA\}/.test(MEMORIA) && !/2000/.test(MEMORIA));
  ok("F8  texto nao salvo vira rascunho do fluxo", /aoAlterarRascunho\(temRascunho\)/.test(MEMORIA));

  // =====================================================================
  secao("G. Revisao, criar e sucesso");
  ok("G1  revisao: Identidade, Modelo, APIs, Tools, Memória com Editar", /\[1, "Identidade"/.test(CRIAR) && /\[2, "Modelo"/.test(CRIAR) &&
    /\[3, "APIs"/.test(CRIAR) && /\[4, "Tools"/.test(CRIAR) && /\[5, "Memória"/.test(CRIAR) &&
    /onClick=\{\(\) => irPara\(n\)\}>Editar</.test(CRIAR));
  const imp = (codigo: string, etapa: number) => etapaDoImpedimento({ codigo, etapa }, ativacao());
  ok("G2  impedimento REAL -> etapa certa (por codigo)",
    imp("nome_ausente", 1) === 1 && imp("instrucoes_ausentes", 2) === 1 && imp("modelo_ausente", 3) === 2 &&
      imp("ia_escolhida_indisponivel", 3) === 2 && imp("conexao_sem_loja", 4) === 3 && imp("skill_sem_ferramenta", 4) === 4 &&
      imp("ferramenta_externa_sem_permissao", 8) === 3);
  ok("G3  permissao incompleta: do ML -> APIs; interna -> Tools",
    etapaDoImpedimento({ codigo: "permissao_incompleta", etapa: 8 }, { ferramentas: [{ ...ML, completo: false }] } as never) === 3 &&
      etapaDoImpedimento({ codigo: "permissao_incompleta", etapa: 8 }, { ferramentas: [CALENDARIO] } as never) === 4);
  const codigos = [...new Set(ler("lib/agentes/factory/ativacao.ts").match(/codigo: "[a-z_]+"/g) ?? [])].map((c) => c.slice(9, -1));
  ok("G4  todo codigo do servidor tem etapa no fluxo", codigos.length >= 9 &&
    codigos.every((c) => etapaDoImpedimento({ codigo: c, etapa: 1 }, { ferramentas: [CALENDARIO] } as never) !== null), codigos.join(","));
  ok("G5  codigo desconhecido: cai no numero do servidor traduzido",
    etapaDoImpedimento({ codigo: "novo_codigo", etapa: 6 }, ativacao()) === 5 &&
      etapaDoImpedimento({ codigo: "novo_codigo", etapa: 5 }, ativacao()) === null);
  ok("G6  'Resolver em <etapa>' sem sair do fluxo", /Resolver em \{ETAPAS_DE_CRIACAO\[destino - 1\]\.titulo\}/.test(CRIAR) &&
    /onClick=\{\(\) => irPara\(destino\)\}/.test(CRIAR));
  ok("G7  sem validacao inventada: Criar so com `podeAtivar` do servidor",
    /const prontoParaCriar = ativacao !== null && ativacao\.podeAtivar;/.test(CRIAR) && /disabled=\{ocupado \|\| !prontoParaCriar\}/.test(CRIAR));
  ok("G8  Criar agente = ativacao real", /const r = await definirAtivacaoDoAgente\(agenteId, true\);/.test(CRIAR));
  ok("G9  sucesso so depois do 'ok' do servidor", /if \(r\.estado !== "ok"\) \{[\s\S]{0,160}return;\s*\}\s*await reler\(agenteId\);\s*setCriado\(true\);/.test(CRIAR));
  const d = destinosDoAgenteCriado(ID);
  ok("G10 sucesso: Agentes e Escritorio com o ID real", d.agentes === `/ia/agentes?agente=${ID}` && d.escritorio === `/ia?agente=${ID}` &&
    /href=\{destino\.agentes\}/.test(CRIAR) && /href=\{destino\.escritorio\}/.test(CRIAR) &&
    /Agente criado com sucesso/.test(CRIAR) && /Seu agente foi criado e já está pronto para trabalhar\./.test(CRIAR) &&
    /Ir para Agentes/.test(CRIAR) && /Abrir no Escritório/.test(CRIAR));

  // =====================================================================
  secao("H. Resumo do agente (so dados reais)");
  ok("H1  seis blocos, na ordem", r1.map((l) => l.rotulo).join(",") === "Nome,Função,Modelo de IA,APIs,Tools,Memória");
  ok("H2  APIs = Mercado Livre; Tools = internas", linha("APIs") === "Mercado Livre" && linha("Tools") === "Planilhas");
  ok("H3  memoria: 'Ativada · 1 fixada'", linha("Memória") === "Ativada · 1 fixada", String(linha("Memória")));
  ok("H4  funcao pelo rotulo da spec", linha("Função") === "Mensagens");
  const vazio = resumoDoAgente({ nome: "", tipo: "personalizado", ativacao: null, memorias: null });
  ok("H5  antes de criar: nada inventado (so a funcao escolhida)",
    vazio.filter((l) => l.valor !== null).map((l) => l.rotulo).join() === "Função");

  // =====================================================================
  secao("I. Visual CDS (tokens) e responsividade");
  ok("I1  laranja CDS = acento; foco laranja", /--cr-acento: #f97316;/.test(CSS) && /\.raiz :focus-visible \{\s*outline: 2px solid var\(--cr-acento\);/.test(CSS));
  ok("I2  passo atual laranja; concluido verde com check", /\.passoAtual \.passoBotao \{\s*border-color: var\(--cr-acento\);/.test(CSS) &&
    /\.passoConcluido \.passoNumero \{\s*border-color: var\(--cr-ok\);/.test(CSS) && /concluido \? <IconeCheck/.test(CRIAR));
  ok("I3  linha vertical ligando as etapas", /\.passo:not\(:last-child\)::after \{/.test(CSS));
  ok("I4  3 colunas so com area util >= 1040px (container query)", /@container \(min-width: 1040px\) \{\s*\.grade \{\s*grid-template-columns: 248px minmax\(0, 1fr\) 296px;/.test(CSS));
  ok("I5  abaixo disso: stepper no topo, em linha que quebra (sem rolagem horizontal)",
    /@container \(max-width: 1039px\) \{\s*\.passos \{\s*flex-direction: row;\s*flex-wrap: wrap;/.test(CSS) && !/overflow-x: auto/.test(CSS));
  ok("I8  'concluida' = passou por ela E sem pendencia do servidor nela",
    /const concluido = !atual && e\.numero < maxEtapa && !etapasPendentes\.has\(e\.numero\);/.test(CRIAR));
  ok("I6  sem Tailwind / lucide", !/className="[^"]*\b(flex|grid|p-\d|text-sm|rounded-)\b|lucide-react/.test(AREA));
  ok("I7  nenhuma cor de texto escura", !/(^|[^-])color:\s*(#0|#1|#2|black)/m.test(CSS.replace(/\/\*[\s\S]*?\*\//g, "")));

  // =====================================================================
  secao("J. Areas congeladas e contratos preservados");
  const arquivos = (dir: string) => readdirSync(join(__dirname, "..", dir)).map((f) => `${dir}/${f}`);
  const OFFICE = arquivos("components/ia/office").filter((f) => /\.(tsx|ts)$/.test(f));
  const AGENTES = arquivos("components/ia/agentes").filter((f) => /\.(tsx|ts)$/.test(f));
  ok("J1  Office nao importa o fluxo novo", OFFICE.every((f) => !/components\/ia\/criar\//.test(ler(f))));
  ok("J2  Agentes nao importa o fluxo novo", AGENTES.every((f) => !/components\/ia\/criar\//.test(ler(f))) &&
    !/components\/ia\/criar\//.test(ler("app/(app)/ia/agentes/page.tsx")));
  ok("J3  o fluxo nao importa o CSS de Agentes", !/agentes\.module\.css/.test(AREA));
  const CONF = semComentario(ler("app/(app)/ia/agentes/[id]/configurar/page.tsx"));
  ok("J4  assistente existente preservado (Skills e Arquivos)", /<Wizard agenteIdInicial=\{params\.id\} \/>/.test(CONF) &&
    /vincularSkillNoAgente/.test(ler("components/ia/factory/Wizard.tsx")) && /<ArquivosDoAgente/.test(ler("components/ia/factory/Wizard.tsx")));
  ok("J5  e ainda alcancavel pelas superficies existentes (Escritorio)",
    /\/configurar`/.test(ler("components/ia/office/OfficeAgentPanelV1.tsx")));

  console.log(`\n── placar ${"─".repeat(50)}\n  PASS ${passou}   FAIL ${falhou}\n`);
  if (falhou > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
