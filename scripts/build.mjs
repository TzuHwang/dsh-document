// Builds one workspace package into the two faces DSH loads:
//   src/host.ts   -> lib/host.js    ESM, loaded by the host Loader (every dependency external)
//   src/client.ts -> lib/client.js  closure-factory bundle served under /plugins
// Copied from dsh-editor-template/scripts/build-package.mjs. Run: `pnpm build`.
import { build } from 'esbuild'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const cwd = process.cwd()
const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'))
const find = base => ['.ts', '.tsx'].map(ext => resolve(cwd, base + ext)).find(existsSync)
mkdirSync(resolve(cwd, 'lib'), { recursive: true })

const hostEntry = find('src/host')
if (hostEntry) {
  await build({
    entryPoints: [hostEntry],
    outfile: resolve(cwd, 'lib/host.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    packages: 'external',
    sourcemap: true,
  })
}

// The shell seeds React and Cordis into the module table; DSH packages resolve
// there too. Everything else (CodeMirror, marked, ...) is bundled privately.
const CLIENT_EXTERNAL = ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/*']

const clientEntry = find('src/client')
if (clientEntry) {
  const out = await build({
    entryPoints: [clientEntry],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: CLIENT_EXTERNAL,
    write: false,
    minify: process.env.NODE_ENV === 'production',
    loader: { '.css': 'text' },
  })
  const code = out.outputFiles[0].text
  writeFileSync(resolve(cwd, 'lib/client.js'), [
    `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`,
    'var module = { exports: {} }; var exports = module.exports;',
    code,
    'return module.exports; } });',
    '',
  ].join('\n'))
}

console.log(`built ${pkg.name}${hostEntry ? ' host' : ''}${clientEntry ? ' client' : ''}`)
