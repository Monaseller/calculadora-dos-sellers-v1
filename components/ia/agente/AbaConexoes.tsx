"use client";

/**
 * Aba Conexoes do agente.
 *
 * ── Uma pergunta, nao duas ──────────────────────────────────────────
 *
 * Esta aba responde "a que este AGENTE esta conectado". O inventario da
 * conta inteira — conectar, reconectar, desconectar — mora em
 * `/ia/conexoes`, e o link daqui e navegacao, nao acao.
 *
 * A separacao importa porque as duas telas terao donos diferentes: a
 * global mexe em credencial (e por isso esta bloqueada pela divida de
 * texto puro); esta aqui so atribui uma conexao ja existente a um
 * agente.
 *
 * ── Nada nesta tela veio do banco ───────────────────────────────────
 *
 * O vinculo agente↔conexao NAO existe no schema. Tudo o que aparece
 * aqui e mock, e a tela diz isso em vez de deixar parecer configuracao
 * salva.
 */
import Link from "next/link";
import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import { DIVIDA_CREDENCIAIS } from "@/lib/ia/conceitos";
import { MOCK_AVISO, MOCK_CONEXOES, MOCK_FUNCOES_DA_CONEXAO } from "@/lib/ia/mocks";
import CardConexao from "@/components/ia/conexoes/CardConexao";
import EstadoVazio from "@/components/ia/EstadoVazio";

export default function AbaConexoes() {
  if (MOCK_CONEXOES.length === 0) {
    return (
      <EstadoVazio
        titulo="Nenhuma conexão"
        descricao="Quando houver contas conectadas na sua conta CDS, elas aparecerão aqui para serem atribuídas a este agente."
        acao={{ href: "/ia/conexoes", rotulo: "Ver conexões da conta" }}
      />
    );
  }

  const atribuidas = MOCK_CONEXOES.filter((c) => c.atribuida).length;

  return (
    <section aria-label="Conexões deste agente">
      <style>{css}</style>

      <header className="cds-ia-ac-topo">
        <div>
          <h3 className="cds-ia-ac-titulo">Conexões deste agente</h3>
          <p className="cds-ia-ac-sub">
            {atribuidas} de {MOCK_CONEXOES.length} contas da sua conta CDS estão atribuídas a
            este agente. O agente sabe que a conexão existe e o que ela permite — nunca recebe
            a credencial.
          </p>
        </div>
        <span className="cds-ia-ac-simulado">{MOCK_AVISO}</span>
      </header>

      <div className="cds-ia-ac-grade">
        {MOCK_CONEXOES.map((c) => (
          <CardConexao key={c.id} conexao={c} funcoesQueUsam={MOCK_FUNCOES_DA_CONEXAO(c.id)} />
        ))}
      </div>

      <p className="cds-ia-ac-divida">{DIVIDA_CREDENCIAIS}</p>

      <p className="cds-ia-ac-link">
        <Link href="/ia/conexoes">Gerenciar conexões da conta →</Link>
      </p>
    </section>
  );
}

const css = `
  .cds-ia-ac-topo {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 12px; flex-wrap: wrap; margin-bottom: ${ESPACO.lg}px;
  }
  .cds-ia-ac-titulo { margin: 0; font: 800 15px/1.3 ${FONTE.interface}; color: ${CROMO.texto}; }
  .cds-ia-ac-sub {
    margin: 6px 0 0; max-width: 62ch;
    font: 13px/1.6 ${FONTE.interface}; color: ${CROMO.textoFraco};
  }
  .cds-ia-ac-simulado {
    flex-shrink: 0;
    padding: 3px 10px; border-radius: 999px;
    border: 1px solid ${CROMO.acentoBorda}; background: ${CROMO.acentoFundo};
    color: ${CROMO.acento}; font: 700 11px/1.6 ${FONTE.interface};
  }
  .cds-ia-ac-grade {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 12px;
    align-items: start;
  }
  .cds-ia-ac-divida {
    margin: ${ESPACO.lg}px 0 0; padding: 12px 14px;
    border: 1px solid ${CROMO.borda}; border-radius: ${RAIO.controle}px;
    font: 12px/1.6 ${FONTE.interface}; color: ${CROMO.textoFraco};
    max-width: 72ch;
  }
  .cds-ia-ac-link { margin: ${ESPACO.md}px 0 0; font: 13px/1.5 ${FONTE.interface}; }
  .cds-ia-ac-link a { color: ${CROMO.acento}; text-decoration: none; }
  .cds-ia-ac-link a:hover { text-decoration: underline; }
  .cds-ia-ac-link a:focus-visible { outline: 2px solid ${CROMO.acento}; outline-offset: 3px; }
`;
