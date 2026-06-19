# Calculadora dos Sellers V1

Primeira versão funcional da tabela de precificação.

## Como rodar

1. Instale o Node.js.
2. Abra a pasta do projeto no terminal.
3. Rode:

```bash
npm install
npm run dev
```

4. Acesse:

```bash
http://localhost:3000
```

## Fórmula oficial da V1

Margem de contribuição CDS:

```text
(valor líquido recebido - imposto - custo do produto) / valor anunciado * 100
```

## Saúde do produto

- Verde: margem >= 20%
- Amarelo: margem entre 10% e 19,99%
- Vermelho: margem < 10%

## Próximo passo

Integrar com a API do Mercado Livre para buscar automaticamente:
- preço anunciado
- valor líquido recebido
- comissão
- taxa fixa ou frete
- categoria
- tipo de anúncio