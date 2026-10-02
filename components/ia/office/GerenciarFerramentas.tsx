"use client";

/**
 * "Gerenciar ferramentas" no Escritorio — F8.2-A.
 *
 * ── Nada aqui e regra nova ──────────────────────────────────────────
 *
 * O drawer e o `PainelLateral` que o chat ja usa. O conteudo e o MESMO
 * `BuscaDeFerramentas` da etapa 4 do Wizard: lista os packs internos e
 * as acoes externas, adiciona, e remove acao externa pelo contrato dela.
 * Adicionar um pack interno passa por `adicionarPackAoAgente`, a mesma
 * funcao que o Wizard chama — o nivel sugerido pelo efeito continua
 * vindo de um lugar so. Remover um pack (F8.2-B) passa por
 * `removerPackDoAgente`, tambem compartilhada com o Wizard.
 */
import { useState } from "react";
import { PainelLateral, Aviso } from "@/components/ui/Primitivas";
import { BuscaDeFerramentas } from "@/components/ia/factory/BuscaDeFerramentas";
import { adicionarPackAoAgente, removerPackDoAgente } from "@/lib/ia/ferramentas-do-agente";

export default function GerenciarFerramentas({
  agenteId,
  aberto,
  aoFechar,
  packSelecionado,
  aoMudar,
}: {
  agenteId: string;
  aberto: boolean;
  aoFechar: () => void;
  packSelecionado: (chave: string) => boolean;
  /** Releitura das ferramentas do agente no painel. */
  aoMudar: () => void;
}) {
  const [erro, setErro] = useState<string | null>(null);

  async function adicionarPack(chave: string) {
    setErro(null);
    const r = await adicionarPackAoAgente(agenteId, chave, null);
    if (r.estado === "recusado") {
      setErro(r.resposta.estado === "dados_invalidos"
        ? r.resposta.mensagem
        : "Não foi possível adicionar esta ferramenta agora.");
    }
    aoMudar();
  }

  /** F8.2-B: volta o pack ao "nao selecionado" — mesmo contrato do Wizard. */
  async function removerPack(chave: string) {
    setErro(null);
    const r = await removerPackDoAgente(agenteId, chave);
    if (r.estado === "recusado") setErro("Não foi possível remover esta ferramenta agora.");
    aoMudar();
  }

  return (
    <PainelLateral aberto={aberto} titulo="Gerenciar ferramentas" aoFechar={aoFechar}>
      {erro !== null && <Aviso tom="atencao">{erro}</Aviso>}
      <BuscaDeFerramentas
        agenteId={agenteId}
        aoMudar={aoMudar}
        packSelecionado={packSelecionado}
        aoAdicionarPack={(chave) => void adicionarPack(chave)}
        aoRemoverPack={(chave) => void removerPack(chave)}
      />
    </PainelLateral>
  );
}
