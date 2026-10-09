// Smoke test: installs the template's packages (from the local checkout) and
// this project into a fresh DSH profile with `dsh plugin add`, boots `dsh web`
// with the editor on, and drives it in a real browser.
//
//   pnpm smoke                 build, then run
//   pnpm smoke --no-build      run against the current lib/ output
//   SMOKE_BROWSER=chromium     Playwright channel (default msedge)
//   SMOKE_KEEP=1               keep the temp directory even on success
//
// The DSH runtime is the one pinned by package.json#dshVersion: this checkout's
// .dev/, else the template checkout's (its smoke installs it), else installed here.
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const posix = path => path.split('\\').join('/')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const template = resolve(root, process.env.DSH_EDITOR_TEMPLATE ?? manifest.dshEditor.checkout)
const args = new Set(process.argv.slice(2))

// ---- helpers ----

function run(command, commandArgs, options = {}) {
  // npm and pnpm are .cmd shims on Windows, which need a shell; arguments here are fixed strings.
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', shell: process.platform === 'win32', ...options })
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} exited with ${result.status}`)
}

function killTree(child) {
  if (child.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGTERM')
}

const failures = []
function check(name, condition, detail) {
  console.log(`${condition ? '  ok  ' : '  FAIL'} ${name}${condition || detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`)
  if (!condition) failures.push(name)
}

async function eventually(probe, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value || Date.now() > deadline) return value
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

// ---- DSH runtime and builds ----

const runtimeDir = `dsh-${manifest.dshVersion}`
const binOf = dir => join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
let runtime = [join(root, '.dev', runtimeDir), join(template, '.dev', runtimeDir)].find(dir => existsSync(binOf(dir)))
if (runtime === undefined) {
  runtime = join(root, '.dev', runtimeDir)
  console.log(`installing @deepseek-ai/dsh@${manifest.dshVersion} into ${runtime}`)
  mkdirSync(runtime, { recursive: true })
  writeFileSync(join(runtime, 'package.json'), '{"private":true}\n')
  run('npm', ['install', '--no-audit', '--no-fund', `@deepseek-ai/dsh@${manifest.dshVersion}`], { cwd: runtime })
}
const dshBin = binOf(runtime)
if (!args.has('--no-build')) {
  run('pnpm', ['build'], { cwd: template })
  run('pnpm', ['build'], { cwd: root })
}

// ---- a fresh DSH home, workspace and profile ----

const temp = mkdtempSync(join(tmpdir(), 'dsh-document-smoke-'))
const home = join(temp, 'home')
const documents = join(temp, 'documents')
const workspace = join(documents, 'deepseek-harness', 'default-workspace')
mkdirSync(workspace, { recursive: true })
writeFileSync(join(workspace, 'notes.md'), '# Notes\n\nfirst line\n')
// Saved by LibreOffice; each holds the same text, Chinese included.
for (const extension of ['docx', 'doc', 'odt']) copyFileSync(join(root, 'smoke', 'fixtures', `sample.${extension}`), join(workspace, `sample.${extension}`))
const overlay = join(temp, 'smoke.patch.yml')
writeFileSync(overlay, [
  '- id: workspace-controller',
  '  config:',
  `    documentsDirectory: '${posix(documents)}'`,
  '- id: dsh-editor-core',
  '  config:',
  '    enabled: true',
  '',
].join('\n'))

const env = { ...process.env, DSH_HOME: home }
const dsh = (dshArgs, options = {}) => run(process.execPath, [dshBin, ...dshArgs], { cwd: temp, env, shell: false, ...options })
dsh(['--profile', 'smoke', '--from-default-profile', 'web', '--dump-config'], { stdio: 'ignore' })
// As a user installs it: the template's packages top level, then this project.
dsh(['plugin', '--profile', 'smoke', 'add',
  ...['core', 'text', 'layout-main', 'context'].map(dir => posix(join(template, 'packages', dir))),
  posix(root)])

let server
let browser
let page

async function boot() {
  const child = spawn(process.execPath, [dshBin, '--profile', 'smoke', '--patch', overlay, '--no-open', '--port', '0'], {
    cwd: temp,
    env: { ...env, DEEPSEEK_API_KEY: 'smoke-not-a-real-key' },
  })
  let log = ''
  const url = await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      log += chunk
      const match = /dsh web: (http:\/\/\S+)/.exec(log)
      if (match) resolve(match[1])
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', code => reject(new Error(`dsh exited (${code}) before serving:\n${log}`)))
    setTimeout(() => reject(new Error(`dsh did not start in time:\n${log}`)), 120_000)
  })
  check('dsh boots with the template and dsh-document installed, no inactive entries', !/did not activate/.test(log), log)
  return { child, url }
}

async function openPage(url) {
  await page.goto(url)
  await page.waitForLoadState('networkidle').catch(() => {})
  await eventually(async () => (await page.getByText(/^(新会话|New session)$/).count()) > 0, 30_000)
  for (const name of [/^(继续|Continue)$/, /^(稍后配置|Later|Configure later)$/]) {
    const button = page.getByRole('button', { name })
    if (await button.count()) await button.first().click()
  }
}

/** Open a workspace file from DSH's file tree (Ctrl+Alt+P opens and expands it). */
async function openFromFiles(name) {
  const entry = page.locator('[data-rightbar-col]').getByText(name, { exact: true }).filter({ hasNot: page.locator('[role=tab]') })
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.locator('body').click({ position: { x: 640, y: 200 } })
    await page.keyboard.press('Control+Alt+P')
    if (await eventually(async () => (await entry.count()) > 0, 2_000)) break
  }
  await entry.last().click()
}

try {
  browser = await chromium.launch({ channel: process.env.SMOKE_BROWSER ?? 'msedge', headless: true })
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1500, height: 900 } })
  page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))

  server = await boot()
  await openPage(server.url)
  await page.getByText(/^(新会话|New session)$/).first().click()
  const center = page.getByTestId('dsh-editor-center')
  check('the editor shows in the center for a new session', await eventually(async () => (await center.count()) > 0))

  const engine = center.getByTestId('dsh-document')
  const state = async () => (await engine.count()) > 0 ? engine.getAttribute('data-state') : undefined
  /** The open document's text, asked of the editor page over the engine's own protocol. */
  const documentText = () => page.evaluate(() => new Promise((resolve, reject) => {
    const frame = document.querySelector('[data-testid=dsh-document] iframe')
    const id = 1e9 + Math.floor(Math.random() * 1e6)
    const onMessage = (event) => {
      const data = event.data
      if (event.source !== frame.contentWindow || data?.channel !== 'dsh-document' || data.type !== 'reply' || data.id !== id) return
      removeEventListener('message', onMessage)
      if (data.ok) resolve(data.value)
      else reject(new Error(data.error))
    }
    addEventListener('message', onMessage)
    frame.contentWindow.postMessage({ channel: 'dsh-document', type: 'getText', id }, location.origin)
  }))
  const opensWithText = async (name) => {
    await openFromFiles(name)
    // The first open downloads LibreOffice (about 60 MB) unless the browser cached it.
    const ready = await eventually(async () => (await state()) === 'ready' || (await state()) === 'failed', 240_000)
    const text = (await state()) === 'ready' ? String(await documentText()) : await engine.innerText()
    check(`${name}: LibreOffice opens it in the center, Chinese included`, ready && /Hello from dsh_document\. 中文測試。/.test(text), text)
  }

  await opensWithText('sample.docx')
  check('the core leaves it alone (no status line)', (await center.getByTestId('dsh-editor-status').count()) === 0)
  check('the editor page is isolated (SharedArrayBuffer available)', await page.frame({ url: /dsh-document\/editor/ })?.evaluate(() => self.crossOriginIsolated) === true)
  await page.screenshot({ path: join(temp, 'docx.png') })
  await opensWithText('sample.doc')
  await opensWithText('sample.odt')

  await openFromFiles('notes.md')
  check('a text file still opens in the template\'s text editor', await eventually(async () => (await center.locator('.cm-line').count()) > 2))

  check('no uncaught page errors', errors.length === 0, errors)
} catch (error) {
  failures.push(String(error?.stack ?? error))
  console.error(error)
} finally {
  if (page !== undefined && failures.length > 0) await page.screenshot({ path: join(temp, 'failure.png') }).catch(() => {})
  await browser?.close().catch(() => {})
  if (server !== undefined) killTree(server.child)
}

if (failures.length > 0) {
  console.error(`\nsmoke FAILED (${failures.length}). Kept ${temp} (failure.png, DSH home).`)
  process.exit(1)
}
if (process.env.SMOKE_KEEP) console.log(`kept ${temp}`)
else rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
console.log('\nsmoke passed')
