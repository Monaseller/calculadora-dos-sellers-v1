/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    // Erros de tipo não bloqueiam o build no Vercel
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },

  experimental: {
    // PERFIL-SENHA1b — `@node-rs/argon2` é um addon NATIVO: o pacote
    // resolve para um `.node`, binário compilado. O webpack do Next tenta
    // parseá-lo como JavaScript e o build quebra com
    // "Module parse failed: Unexpected character".
    //
    // Externalizar tira o pacote do bundling e o deixa ser carregado por
    // `require` normal do Node em tempo de execução — que é como um
    // addon nativo precisa ser carregado. As rotas que o usam rodam no
    // runtime Node (nenhuma declara `runtime = "edge"`), então isso é
    // seguro; num Edge Runtime o pacote não funcionaria de forma alguma.
    //
    // O nome da opção é o do Next 14. Nas versões novas ela estabilizou
    // como `serverExternalPackages` — ao atualizar o Next, renomear.
    serverComponentsExternalPackages: ["@node-rs/argon2"],
  },
};

module.exports = nextConfig;
