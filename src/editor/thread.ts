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

/** LibreOffice commands this plugin answers itself instead of LibreOffice. */
const INTERCEPTED: Readonly<Record<string, () => void>> = {
  // Saving goes to the workspace file through the engine, not to LibreOffice's in-memory copy.
  '.uno:Save': () => post({ event: 'saveRequested' }),
}

/**
 * A dispatch interceptor on the document's frame: commands in {@link INTERCEPTED}
 * (from menus, toolbars and shortcuts alike) run here; everything else goes on
 * to LibreOffice.
 */
function interceptCommands(frame: any): void {
  let slave: any = null
  let master: any = null
  const interceptor: any = zetajs.unoObject([css.frame.XDispatchProviderInterceptor, css.frame.XDispatch], {
    getSlaveDispatchProvider: () => slave,
    setSlaveDispatchProvider(provider: any) { slave = provider },
    getMasterDispatchProvider: () => master,
    setMasterDispatchProvider(provider: any) { master = provider },
    queryDispatch(url: any, target: string, flags: number) {
      if (INTERCEPTED[url.Complete] !== undefined) return interceptor
      return slave === null ? null : slave.queryDispatch(url, target, flags)
    },
    queryDispatches(requests: readonly any[]) {
      return requests.map(request => interceptor.queryDispatch(request.FeatureURL, request.FrameName, request.SearchFlags))
    },
    dispatch(url: any) {
      INTERCEPTED[url.Complete]?.()
    },
    addStatusListener(listener: any, url: any) {
      // Always available: the toolbar button and the shortcut stay enabled.
      listener.statusChanged(new css.frame.FeatureStateEvent({ FeatureURL: url, IsEnabled: true }))
    },
    removeStatusListener() {},
  })
  frame.registerDispatchProviderInterceptor(interceptor)
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
    // Also called when the flag is reset (after an export): only a change counts.
    modified() { if (loaded.isModified()) post({ event: 'modified' }) },
  }))
  const frame = model.getCurrentController().getFrame()
  interceptCommands(frame)
  // A full-screen window follows Qt's screen, which is the canvas: it fills it, tracks its size,
  // and has no title bar (whose close button would end LibreOffice).
  frame.getContainerWindow().FullScreen = true
}

/** Store a copy at `url` (the in-memory file system) with `filter`; the document then counts as saved. */
function exportTo(url: string, filter: string): void {
  if (model === undefined) throw new Error('no document is open')
  const property = (Name: string, Value: unknown): any => new css.beans.PropertyValue({ Name, Value })
  model.storeToURL(url, [property('Overwrite', true), property('FilterName', filter)])
  // The next change reports `modified` again.
  model.setModified(false)
}

port.onmessage = (event: MessageEvent<ThreadRequest>) => {
  const request = event.data
  try {
    let value: unknown
    if (request.cmd === 'open') open(request.url)
    else if (request.cmd === 'getText') value = model === undefined ? '' : model.getText().getString()
    else if (request.cmd === 'export') exportTo(request.url, request.filter)
    else if (request.cmd === 'isModified') value = model !== undefined && model.isModified() === true
    post({ id: request.id, ok: true, value })
  } catch (error) {
    post({ id: request.id, ok: false, error: describe(error) })
  }
}

post({ event: 'ready' })
