import { defineConfig } from 'vite';
export default defineConfig({
  define: { global: 'globalThis' },          // hydra-synth expects node global
  build: { target: 'esnext' },               // top-level await + WebGPU
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
});
