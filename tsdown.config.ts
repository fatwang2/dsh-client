import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'lib',
  clean: true,
  outExtensions: () => ({ js: '.js' }),
  external: ['electron', 'electron-updater'],
})
