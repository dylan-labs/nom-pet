import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const assetsDir = path.resolve(process.cwd(), 'assets');

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: 'src/main/index.ts',
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: 'src/preload/index.ts',
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@assets': assetsDir,
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: 'src/renderer/index.html',
          settings: 'src/renderer/settings.html',
        },
      },
    },
    plugins: [react()],
  },
});
