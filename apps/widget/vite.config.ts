import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { resolve } from 'path';

export default defineConfig({
  plugins: [preact()],
  resolve: {
    alias: {
      react: 'preact/compat',
      'react-dom': 'preact/compat',
      'react/jsx-runtime': 'preact/jsx-runtime',
    },
  },
  build: {
    lib: {
      entry: resolve(import.meta.dirname, 'src/embed.tsx'),
      name: 'WolffWidget',
      formats: ['iife', 'es'],
      fileName: (format) => `widget.${format}.js`,
    },
    rollupOptions: {
      output: {
        assetFileNames: 'widget.[ext]',
      },
    },
    minify: 'esbuild',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
