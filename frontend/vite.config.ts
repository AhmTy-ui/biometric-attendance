import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_API_TARGET || 'https://localhost:4000';
  const https =
    env.VITE_DEV_TLS_CERT && existsSync(env.VITE_DEV_TLS_CERT)
      ? { cert: readFileSync(env.VITE_DEV_TLS_CERT), key: readFileSync(env.VITE_DEV_TLS_KEY) }
      : undefined;
  return {
    plugins: [react()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: {
      port: 5173,
      https,
      proxy: {
        '/api': { target, changeOrigin: false, secure: false },
        '/ws': { target: target.replace(/^http/, 'ws'), ws: true, secure: false },
        '/health': { target, secure: false }
      }
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          manualChunks: { react: ['react', 'react-dom', 'react-router-dom'], charts: ['recharts'], query: ['@tanstack/react-query'] }
        }
      }
    }
  };
});
