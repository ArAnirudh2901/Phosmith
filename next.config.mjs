import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactCompiler: true,
  reactStrictMode: false,
  // Full-res extend composites can exceed the default 10MB proxy buffer.
  experimental: {
    proxyClientMaxBodySize: '32mb',
  },
  turbopack: {
    root: projectRoot,
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': path.join(projectRoot, 'src'),
    };
    return config;
  },
};

export default nextConfig;
