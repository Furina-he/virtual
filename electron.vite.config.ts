import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

const alias = {
  '@': resolve(import.meta.dirname, 'src/renderer'),
  '@shared': resolve(import.meta.dirname, 'src/shared'),
  '@domain': resolve(import.meta.dirname, 'src/domain'),
}

export default defineConfig({
  main: {
    resolve: { alias },
    // sim 为 utilityProcess 入口（技术设计 §4.1），与主进程同目录输出 sim.js
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          sim: resolve(import.meta.dirname, 'src/sim/index.ts'),
        },
      },
    },
  },
  preload: {
    resolve: { alias },
    // sandbox: true 下 preload 必须是 CommonJS，且只能 require electron，zod 须打进包内
    build: {
      externalizeDeps: { exclude: ['zod'] },
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias },
    plugins: [react(), tailwindcss()],
    build: { rollupOptions: { input: resolve(import.meta.dirname, 'src/renderer/index.html') } },
  },
})
