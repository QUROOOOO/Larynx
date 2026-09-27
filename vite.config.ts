import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    viteStaticCopy({
      targets: [
        { src: 'public/manifest.json', dest: '' },
        { src: 'src/offscreen/index.html', dest: 'offscreen' },
        { src: 'src/options/options.html', dest: '' },
        { src: 'public/icons', dest: '' },
      ],
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/index.ts'),
        options: resolve(__dirname, 'src/options/index.tsx'),
        offscreen: resolve(__dirname, 'src/offscreen/offscreen.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'offscreen') {
            return 'offscreen/[name].js';
          }
          return '[name].js';
        },
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
