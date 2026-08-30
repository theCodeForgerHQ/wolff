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
  preview: {
    // WIDGET_PORT lets the E2E run use another port when 5173 is taken.
    port: Number(process.env.WIDGET_PORT ?? 5173),
    strictPort: true,
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
