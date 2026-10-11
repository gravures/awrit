import * as path from 'node:path';
import tailwind from '@tailwindcss/vite';
import type { UserConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { TOOLBAR_PORT } from './ports';

export default {
  plugins: [solid(), tailwind()],
  base: '',
  root: path.resolve(__dirname, '../toolbar'),
  server: {
    port: TOOLBAR_PORT,
  },
  build: {
    outDir: '../../dist/electron/app/toolbar',
    emptyOutDir: true,
    sourcemap: true,
    // Prevent `.node` being renamed to `[hash].node` in require('...')
    rollupOptions: {
      output: {
        chunkFileNames: (chunkInfo) => {
          const facadeModuleId = chunkInfo.facadeModuleId
            ? (chunkInfo.facadeModuleId.split('/').pop() ?? 'chunk')
            : 'chunk';
          return facadeModuleId.endsWith('.node') ? '[name].node' : '[name]-[hash].js';
        },
        entryFileNames: (chunkInfo) => {
          return chunkInfo.name.endsWith('.node') ? '[name].node' : '[name]-[hash].js';
        },
      },
    },
  },
  clearScreen: false,
} satisfies UserConfig;
