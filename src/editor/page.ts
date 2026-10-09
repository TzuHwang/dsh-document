/**
 * The editor page: the isolated iframe's main thread. It starts LibreOffice
 * (ZetaOffice, through zetajs's helper) on the page's canvas, installs a CJK
 * font first, and relays requests from the engine (DSH's page, the parent) to
 * the office thread and its answers back.
 *
 * Files reach LibreOffice through Emscripten's in-memory file system (`FS`).
 */
import {
  CHANNEL,
  isEnvelope,
  type EditorConfig,
  type Envelope,
  type FromEditor,
  type Request,
  type ThreadMessage,
  type ThreadRequest,
  type WithoutId,
} from '../protocol.ts'

/** The part of zetajs's `ZetaHelperMain` used here. */
interface ZetaHelperMain {
  readonly Module: { preRun?: (() => void)[] }
  thrPort: MessagePort
  start(onStarted: () => void): void
}
type ZetaHelperMainClass = new (threadJs: string, options: { threadJsType: 'classic'; wasmPkg: string }) => ZetaHelperMain

/** Emscripten's file system, a global once `soffice.js` ran. Never `Module.FS`: that aborts. */
interface EmscriptenFs {
  mkdirTree(path: string): void
  writeFile(path: string, data: Uint8Array): void
}
const fs = (): EmscriptenFs => (globalThis as unknown as { FS: EmscriptenFs }).FS

const FONT_DIR = '/instdir/share/fonts/truetype'

const config = (window as unknown as { __DSH_DOCUMENT__: EditorConfig }).__DSH_DOCUMENT__

function send(message: FromEditor): void {
  const envelope: Envelope<FromEditor> = { ...message, channel: CHANNEL }
  window.parent.postMessage(envelope, location.origin)
}

/** Requests waiting for the office thread, by thread id. */
const pending = new Map<number, (message: ThreadMessage) => void>()
let nextId = 0
let thread: MessagePort | undefined

function toThread(request: WithoutId<ThreadRequest>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, message => {
      if ('ok' in message && message.ok) resolve(message.value)
      else reject(new Error('error' in message ? message.error : 'unknown error'))
    })
    thread!.postMessage({ ...request, id })
  })
}

function onThread(event: MessageEvent<ThreadMessage>): void {
  const message = event.data
  if ('event' in message) {
    send({ type: message.event })
    return
  }
  const settle = pending.get(message.id)
  pending.delete(message.id)
  settle?.(message)
}

async function handle(request: Request): Promise<unknown> {
  if (request.type === 'open') {
    let url: string | undefined
    if (request.bytes !== undefined) {
      // LibreOffice detects the format by content; the extension keeps its filter choice unsurprising.
      const extension = /^[a-z0-9]{1,8}$/.test(request.extension) ? request.extension : 'bin'
      const path = `/tmp/document.${extension}`
      fs().writeFile(path, new Uint8Array(request.bytes))
      url = `file://${path}`
    }
    await toThread({ cmd: 'open', url })
    // Have Qt fit the new document window to the canvas and repaint now.
    window.dispatchEvent(new Event('resize'))
    return undefined
  }
  return toThread({ cmd: 'getText' })
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent || !isEnvelope(event.data)) return
  const request = event.data as unknown as Envelope<Request>
  if (thread === undefined) {
    send({ type: 'reply', id: request.id, ok: false, error: 'LibreOffice has not started yet' })
    return
  }
  handle(request).then(
    value => send({ type: 'reply', id: request.id, ok: true, value }),
    (error: unknown) => send({ type: 'reply', id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
  )
})

/** The CJK font, or undefined when it cannot be fetched (documents then show boxes for CJK text). */
async function fetchFont(): Promise<Uint8Array | undefined> {
  if (config.cjkFontUrl === '') return undefined
  try {
    const response = await fetch(config.cjkFontUrl)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    console.warn('dsh-document: no CJK font', error)
    return undefined
  }
}

async function start(): Promise<void> {
  const [{ ZetaHelperMain }, font] = await Promise.all([
    import(/* @vite-ignore */ `${config.zetajsUrl}zetaHelper.js`) as Promise<{ ZetaHelperMain: ZetaHelperMainClass }>,
    fetchFont(),
  ])
  // `thread.js` resolves against this page: the host serves it next to it.
  const helper = new ZetaHelperMain('thread.js', { threadJsType: 'classic', wasmPkg: `url:${config.zetaofficeUrl}` })
  if (font !== undefined) {
    // Before LibreOffice starts, so its font scan sees it.
    helper.Module.preRun = [() => {
      fs().mkdirTree(FONT_DIR)
      fs().writeFile(`${FONT_DIR}/dsh-document-cjk.otf`, font)
    }]
  }
  helper.start(() => {
    thread = helper.thrPort
    thread.onmessage = onThread
  })
}

start().catch((error: unknown) => {
  send({ type: 'failed', message: error instanceof Error ? error.message : String(error) })
})
