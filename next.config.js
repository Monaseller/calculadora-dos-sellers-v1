/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    // Erros de tipo não bloqueiam o build no Vercel
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
