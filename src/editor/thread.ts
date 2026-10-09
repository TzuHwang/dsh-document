/**
 * The office thread: runs inside LibreOffice's worker (loaded by zetajs with
 * `importScripts`) and drives the document through UNO. It answers the editor
 * page over zetajs's `mainPort`.
 *
 * zetajs hands over UNO objects as dynamic proxies, so they are typed loosely here.
 */
import type { ThreadMessage, ThreadRequest } from '../protocol.ts'

/* eslint-disable @typescript-eslint/no-explicit-any -- UNO proxies */
interface ZetaJs {
  readonly mainPort: MessagePort
  readonly uno: any
  getUnoComponentContext(): any
  unoObject(interfaces: readonly unknown[], implementation: object): any
  catchUnoException(error: unknown): any
  fromAny(value: unknown): any
}

/** Set by zetajs (`zetaHelperWrapThread`) before this script runs. */
const { zetajs } = (globalThis as unknown as { zetajsStore: { zetajs: ZetaJs } }).zetajsStore
const css = zetajs.uno.com.sun.star
const desktop = css.frame.Desktop.create(zetajs.getUnoComponentContext())
const port = zetajs.mainPort

let model: any

function post(message: ThreadMessage): void {
  port.postMessage(message)
}

/** A readable message for a JavaScript error or a UNO exception. */
function describe(error: unknown): string {
  try {
    const exception = zetajs.fromAny(zetajs.catchUnoException(error))
    if (typeof exception?.Message === 'string' && exception.Message !== '') return exception.Message
  } catch {
    // Not a UNO exception.
  }
  return error instanceof Error ? error.message : String(error)
}

/** Load `url` (a file in LibreOffice's in-memory file system), or a new Writer document. */
function open(url: string | undefined): void {
  if (model !== undefined) {
    try { model.close(true) } catch { /* already gone */ }
    model = undefined
  }
  const loaded = desktop.loadComponentFromURL(url ?? 'private:factory/swriter', '_default', 0, [])
  if (loaded === null || loaded === undefined) throw new Error('LibreOffice could not load the document')
  model = loaded
  model.addModifyListener(zetajs.unoObject([css.util.XModifyListener], {
    disposing() {},
    modified() { post({ event: 'modified' }) },
  }))
  // A full-screen window follows Qt's screen, which is the canvas: it fills it, tracks its size,
  // and has no title bar (whose close button would end LibreOffice).
  model.getCurrentController().getFrame().getContainerWindow().FullScreen = true
}

port.onmessage = (event: MessageEvent<ThreadRequest>) => {
  const request = event.data
  try {
    let value: unknown
    if (request.cmd === 'open') open(request.url)
    else if (request.cmd === 'getText') value = model === undefined ? '' : model.getText().getString()
    post({ id: request.id, ok: true, value })
  } catch (error) {
    post({ id: request.id, ok: false, error: describe(error) })
  }
}

post({ event: 'ready' })
