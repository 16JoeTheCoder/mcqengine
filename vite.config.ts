/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * Generates sw.js after the bundle is written: a precache list of every emitted file and a
 * cache name derived from their content, so each deploy gets a fresh, versioned cache.
 */
function serviceWorker(): Plugin {
  return {
    name: 'dmc-sw',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'sw.js');
      const hash = createHash('sha256');
      for (const f of files.sort()) {
        const item = bundle[f]!;
        hash.update(f);
        hash.update(item.type === 'chunk' ? item.code : typeof item.source === 'string' ? item.source : Buffer.from(item.source));
      }
      const version = hash.digest('hex').slice(0, 12);
      const src = readFileSync(new URL('./src/sw-template.js', import.meta.url), 'utf8')
        .replace('__VERSION__', version)
        .replace('__PRECACHE__', JSON.stringify(['./', ...files.filter((f) => f !== 'index.html')]));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_ID__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  build: { target: 'es2022', sourcemap: false, assetsInlineLimit: 0, chunkSizeWarningLimit: 200 },
  plugins: [serviceWorker()],
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'happy-dom',
    setupFiles: ['tests/unit/setup.ts'],
  },
});
