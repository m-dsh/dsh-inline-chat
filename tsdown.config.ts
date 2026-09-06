import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    outDir: 'lib',
    clean: true,
  },
  {
    entry: ['src/client/index.ts'],
    format: ['cjs'],
    outDir: 'lib',
    outExtensions: () => ({ dts: '.d.ts', js: '.js' }),
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-inline-chat", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module={exports:{}}; var exports=module.exports;',
    },
  },
])
