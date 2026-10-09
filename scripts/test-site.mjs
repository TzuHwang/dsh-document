// A local test site: DSH with the template's packages and this project, in a
// home of its own (.dev/test-site), the editor on, and sample documents in its
// workspace. Kept between runs (sign-in, settings, workspace files); rebuild
// and restart to try changes.
//
//   pnpm test-site                 build both checkouts, then serve
//   pnpm test-site --no-build      serve the current lib/ output
//   pnpm test-site --reset         start over from a fresh home and workspace
//   TEST_SITE_PORT=7790            listen port (default 7790)
//
// Open the printed URL in Chrome or Edge (Document-Isolation-Policy is Chromium-only).
// Your own DSH home is not touched: DSH_HOME points into .dev/test-site.
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const template = resolve(root, process.env.DSH_EDITOR_TEMPLATE ?? manifest.dshEditor.checkout)
const args = new Set(process.argv.slice(2))
const port = process.env.TEST_SITE_PORT ?? '7790'
const posix = path => path.split('\\').join('/')

function run(command, commandArgs, options = {}) {
  // npm and pnpm are .cmd shims on Windows, which need a shell; arguments here are fixed strings.
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', shell: process.platform === 'win32', ...options })
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} exited with ${result.status}`)
}

// The DSH runtime pinned by package.json#dshVersion, as the smoke test finds it.
const runtimeDir = `dsh-${manifest.dshVersion}`
const binOf = dir => join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
let runtime = [join(root, '.dev', runtimeDir), join(template, '.dev', runtimeDir)].find(dir => existsSync(binOf(dir)))
if (runtime === undefined) {
  runtime = join(root, '.dev', runtimeDir)
  mkdirSync(runtime, { recursive: true })
  writeFileSync(join(runtime, 'package.json'), '{"private":true}\n')
  run('npm', ['install', '--no-audit', '--no-fund', `@deepseek-ai/dsh@${manifest.dshVersion}`], { cwd: runtime })
}
const dshBin = binOf(runtime)

if (!args.has('--no-build')) {
  run('pnpm', ['build'], { cwd: template })
  run('pnpm', ['build'], { cwd: root })
}

const site = join(root, '.dev', 'test-site')
if (args.has('--reset')) rmSync(site, { recursive: true, force: true })
const home = join(site, 'home')
const documents = join(site, 'documents')
const workspace = join(documents, 'deepseek-harness', 'default-workspace')
const overlay = join(site, 'site.patch.yml')
const env = { ...process.env, DSH_HOME: home }
const dsh = dshArgs => run(process.execPath, [dshBin, ...dshArgs], { cwd: site, env, shell: false })

if (!existsSync(join(home, 'profiles', 'site'))) {
  console.log(`setting up the test site in ${site}`)
  mkdirSync(workspace, { recursive: true })
  for (const name of ['sample.docx', 'sample.doc', 'sample.odt', 'blocks.docx']) copyFileSync(join(root, 'smoke', 'fixtures', name), join(workspace, name))
  writeFileSync(join(workspace, 'notes.md'), '# Notes\n\nA text file opens in the template\'s text editor.\n')
  // Editor mode stays on here: the site exists to try the editor.
  writeFileSync(overlay, [
    '- id: workspace-controller',
    '  config:',
    `    documentsDirectory: '${posix(documents)}'`,
    '- id: dsh-editor-core',
    '  config:',
    '    enabled: true',
    '',
  ].join('\n'))
  dsh(['--profile', 'site', '--from-default-profile', 'web', '--dump-config'])
  dsh(['plugin', '--profile', 'site', 'add',
    ...['core', 'text', 'layout-main', 'context'].map(dir => posix(join(template, 'packages', dir))),
    posix(root)])
}

// A clear message instead of DSH's startup failure when the port is taken (most often:
// the site is already running in another terminal).
const free = await new Promise((resolve) => {
  const probe = createServer()
  probe.once('error', () => resolve(false))
  probe.listen(Number(port), '127.0.0.1', () => probe.close(() => resolve(true)))
})
if (!free) {
  console.error(`\nPort ${port} is in use: the test site may already be running (open the URL it printed),`)
  console.error('or another program holds the port. Stop it, or choose another port: set TEST_SITE_PORT.')
  process.exit(1)
}

console.log(`\ntest site: DSH ${manifest.dshVersion}, workspace ${workspace}`)
console.log('Open the URL below in Chrome or Edge. Ctrl+C stops the site.\n')
const child = spawn(process.execPath, [dshBin, '--profile', 'site', '--patch', overlay, '--no-open', '--port', port], {
  cwd: site,
  env,
  stdio: 'inherit',
})
const stop = () => child.kill()
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
child.on('exit', code => process.exit(code ?? 0))
