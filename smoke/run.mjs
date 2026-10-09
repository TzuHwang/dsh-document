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
import { startMockLlm, userTurns } from './mock-llm.mjs'

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
// DSH ships LibreOffice for conversions (host side): it reads what the editor wrote, independently.
const officeCli = join(runtime, 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js')
let conversions = 0
/** The text of a workspace document as it is on disk ('' when it cannot be read). */
function diskText(name) {
  const output = join(temp, `extract-${++conversions}.txt`)
  spawnSync(process.execPath, [officeCli, 'convert', '--input', join(workspace, name), '--output', output], { stdio: 'ignore' })
  return existsSync(output) ? readFileSync(output, 'utf8') : ''
}
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
// Paragraphs, a line break inside one, and a table: blocks P1, P2, the table, P4, P5.
copyFileSync(join(root, 'smoke', 'fixtures', 'blocks.docx'), join(workspace, 'blocks.docx'))
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

// A local stand-in for the model API: records what the AI is sent, calls the document tools on cue.
const llm = await startMockLlm()
let server
let browser
let page

async function boot() {
  const child = spawn(process.execPath, [dshBin, '--profile', 'smoke', '--patch', overlay, '--no-open', '--port', '0'], {
    cwd: temp,
    env: { ...env, DEEPSEEK_BASE_URL: llm.url, DEEPSEEK_API_KEY: 'smoke-not-a-real-key' },
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
    // DSH's page, not an editor (LibreOffice's iframe would take the shortcut): the empty left sidebar.
    await page.mouse.click(140, 600)
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

  // The visible one: a closing view stays in the page, hidden, until it saved.
  const engine = center.locator('[data-testid=dsh-document]:visible')
  const state = async () => (await engine.count()) > 0 ? engine.getAttribute('data-state') : undefined
  /** The open document's text, asked of the editor page over the engine's own protocol. */
  const documentText = () => page.evaluate(() => new Promise((resolve, reject) => {
    const frame = [...document.querySelectorAll('[data-testid=dsh-document] iframe')].find(element => element.getClientRects().length > 0)
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

  /** Type at the end of the document (a click below the text puts the cursor there). */
  const typeInDocument = async (text) => {
    const box = await engine.locator('iframe').boundingBox()
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.6)
    await page.keyboard.type(text)
  }
  /** Focus leaves the editor: a click on the empty left sidebar. */
  const clickOutside = () => page.mouse.click(140, 600)
  const diskBytes = name => readFileSync(join(workspace, name))
  const sync = () => engine.getAttribute('data-sync')

  await opensWithText('sample.docx')
  check('the core leaves it alone (no status line)', (await center.getByTestId('dsh-editor-status').count()) === 0)
  check('the editor page is isolated (SharedArrayBuffer available)', await page.frame({ url: /dsh-document\/editor/ })?.evaluate(() => self.crossOriginIsolated) === true)
  await page.screenshot({ path: join(temp, 'docx.png') })

  // ---- the AI context follows LibreOffice's cursor and selection (M3) ----
  const docBox = await engine.locator('iframe').boundingBox()
  await page.mouse.click(docBox.x + docBox.width * 0.4, docBox.y + docBox.height * 0.6)
  // The third paragraph, "Second paragraph.", selected with the keyboard.
  for (const key of ['Control+Home', 'ArrowDown', 'ArrowDown', 'Home', 'Shift+End']) await page.keyboard.press(key)
  await page.getByTestId('dsh-editor-open-chat').click()
  const chat = page.locator('[data-testid=dsh-chat]:visible')
  const chatInput = chat.locator('[role=textbox][contenteditable=true]')
  // As the user does: the chip shows the selection (paragraph 3) once LibreOffice reported it.
  const chip = chat.getByTestId('dsh-editor-context-chip')
  check('context: the chat shows the selection in the document as the editor context', await eventually(async () =>
    (await chip.count()) > 0 && (await chip.innerText()).includes('sample.docx:3')), await chip.innerText().catch(() => ''))
  await chatInput.click()
  await page.keyboard.type('what did I select?')
  await page.keyboard.press('Enter')
  check('context: the AI is told the document, the paragraph and the selected text', await eventually(() =>
    userTurns(llm.requests).some(parts => parts.includes('what did I select?')
      && parts.some(part => part.includes('`sample.docx` open') && part.includes('line 3') && part.includes('Second paragraph.')))),
  userTurns(llm.requests).find(parts => parts.includes('what did I select?')))

  // ---- saving (M2) ----
  await typeInDocument(' saved-on-blur')
  await clickOutside()
  check('docx: leaving the editor saves the document to its file', await eventually(() => diskText('sample.docx').includes('saved-on-blur'), 20_000), diskText('sample.docx'))
  check('docx: it is still a .docx (a zip) with its text', diskBytes('sample.docx').subarray(0, 4).toString('hex') === '504b0304' && diskText('sample.docx').includes('中文測試'))
  await typeInDocument(' saved-by-ctrl-s')
  await page.keyboard.press('Control+s')
  check('docx: Ctrl+S in LibreOffice saves to the file', await eventually(() => diskText('sample.docx').includes('saved-by-ctrl-s'), 20_000), diskText('sample.docx'))
  await typeInDocument(' autosaved')
  check('docx: a pause in editing autosaves', await eventually(() => diskText('sample.docx').includes('autosaved'), 20_000), diskText('sample.docx'))
  check('docx: then it is clean', await eventually(async () => (await sync()) === 'clean'))
  const edited = diskBytes('sample.docx')

  copyFileSync(join(root, 'smoke', 'fixtures', 'sample.docx'), join(workspace, 'sample.docx'))
  check('docx: a change on disk reloads a clean document', await eventually(async () =>
    !String(await documentText()).includes('autosaved') && (await sync()) === 'clean', 20_000))

  await typeInDocument(' mine')
  writeFileSync(join(workspace, 'sample.docx'), edited)
  const banner = engine.getByTestId('dsh-document-banner')
  check('docx: a change on disk while edits are pending is a conflict', await eventually(async () => (await sync()) === 'conflict' && await banner.isVisible(), 20_000))
  await banner.getByRole('button', { name: /^(保留我的版本|Keep my version)$/ }).click()
  check('docx: keeping mine writes the editor\'s document over it', await eventually(() =>
    diskText('sample.docx').includes(' mine') && !diskText('sample.docx').includes('autosaved'), 20_000), diskText('sample.docx'))

  await opensWithText('sample.doc')
  await typeInDocument(' doc-edit')
  await clickOutside()
  check('doc: saving keeps the Word 97 format, with the edit', await eventually(() =>
    diskBytes('sample.doc').subarray(0, 4).toString('hex') === 'd0cf11e0' && diskText('sample.doc').includes('doc-edit'), 20_000), diskText('sample.doc'))

  await opensWithText('sample.odt')
  await typeInDocument(' closing')
  // Straight to the tab's close button: the pending change is saved before the editor goes.
  await center.locator('[role=tab]').filter({ hasText: 'sample.odt' }).getByRole('button').click()
  check('odt: closing its tab saves a pending change first', await eventually(() => diskText('sample.odt').includes('closing'), 20_000), diskText('sample.odt'))
  check('odt: it is still an OpenDocument (a zip)', diskBytes('sample.odt').subarray(0, 4).toString('hex') === '504b0304')

  // ---- the AI's document tools (M4) ----
  await openFromFiles('sample.docx')
  check('tools: back on sample.docx', await eventually(async () => (await state()) === 'ready' && String(await documentText()).includes('Hello from dsh_document')))
  await page.getByTestId('dsh-editor-open-chat').click()
  const sendFromChat = async (text) => {
    await chatInput.click()
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
  }
  const toolResult = needle => userTurns(llm.requests).some(parts => parts.some(part => part.startsWith('[tool_result]') && part.includes(needle)))
  const declared = () => llm.requests.some(request => (request.body.tools ?? []).some(tool => tool.name === 'document_edit'))
  check('tools: the AI is offered document_read and document_edit', declared())
  await sendFromChat('TRIGGER_DOC_READ')
  check('tools: document_read gives the AI the numbered blocks with their styles', await eventually(() =>
    toolResult('[2] (Standard) Hello from dsh_document'), 30_000), userTurns(llm.requests).at(-1))

  await sendFromChat('TRIGGER_DOC_EDIT')
  const allow = chat.getByRole('button', { name: /^(允许一次|Allow once)$/ })
  check('tools: an edit asks the user first (the default)', await eventually(async () => (await allow.count()) > 0, 30_000))
  await allow.first().click()
  check('tools: the edit shows in the editor', await eventually(async () => String(await documentText()).includes('Rewritten by the AI'), 30_000))
  check('tools: it is saved to the file', await eventually(() => diskText('sample.docx').includes('Rewritten by the AI'), 20_000), diskText('sample.docx'))
  check('tools: the AI is told what changed', await eventually(() => toolResult('Edited sample.docx as one undo step')), userTurns(llm.requests).at(-1))
  const undoBox = await engine.locator('iframe').boundingBox()
  await page.mouse.click(undoBox.x + undoBox.width * 0.4, undoBox.y + undoBox.height * 0.6)
  await page.keyboard.press('Control+z')
  check('tools: one Ctrl+Z undoes the whole edit', await eventually(async () => {
    const text = String(await documentText())
    return text.includes('Second paragraph') && !text.includes('Rewritten by the AI')
  }))

  await page.getByText(/^(设置|Settings)$/).last().click()
  await page.getByText(/^(文档编辑器|Document editor)$/).first().click()
  const confirmSwitch = page.getByTestId('dsh-document-settings-confirm').getByRole('switch')
  check('settings: a Document editor page asks before AI edits by default', await eventually(async () => (await confirmSwitch.getAttribute('aria-checked')) === 'true'))
  await confirmSwitch.click()
  check('settings: turning it off saves to the profile', await eventually(() =>
    /confirmEdits: false/.test(readFileSync(join(home, 'profiles', 'smoke', 'cordis.patch.yml'), 'utf8'))))
  await page.keyboard.press('Escape')
  await sendFromChat('TRIGGER_DOC_EDIT_CLOSED')
  check('tools: editing a document that is not open opens it in the center', await eventually(async () =>
    (await center.locator('[role=tab]').allInnerTexts()).some(text => text.includes('sample.odt')), 30_000))
  check('tools: and edits and saves it, without asking once the setting is off', await eventually(() =>
    diskText('sample.odt').includes('Added by the AI'), 60_000) && (await allow.count()) === 0, diskText('sample.odt'))

  // ---- block numbers: the AI context and the tools count the same blocks ----
  await openFromFiles('blocks.docx')
  check('blocks: a document with a table opens', await eventually(async () => (await state()) === 'ready', 60_000))
  const blocksBox = await engine.locator('iframe').boundingBox()
  await page.mouse.click(blocksBox.x + blocksBox.width * 0.4, blocksBox.y + blocksBox.height * 0.6)
  // P1, the two lines of P2, then the table's first row.
  for (const key of ['Control+Home', 'ArrowDown', 'ArrowDown', 'ArrowDown']) await page.keyboard.press(key)
  await page.getByTestId('dsh-editor-open-chat').click()
  check('blocks: a cursor in the table is in block 3, the table, as document_read numbers it', await eventually(async () =>
    (await chip.innerText()).includes('blocks.docx:3')), await chip.innerText().catch(() => ''))

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
  await llm.close()
}

if (failures.length > 0) {
  console.error(`\nsmoke FAILED (${failures.length}). Kept ${temp} (failure.png, DSH home).`)
  process.exit(1)
}
if (process.env.SMOKE_KEEP) console.log(`kept ${temp}`)
else rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
console.log('\nsmoke passed')
