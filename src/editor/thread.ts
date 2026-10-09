/**
 * The office thread: runs inside LibreOffice's worker (loaded by zetajs with
 * `importScripts`) and drives the document through UNO. It answers the editor
 * page over zetajs's `mainPort`.
 *
 * zetajs hands over UNO objects as dynamic proxies, so they are typed loosely here.
 */
import type { ThreadMessage, ThreadRequest } from '../protocol.ts'
import { DocumentOperations } from './operations.ts'

/* eslint-disable @typescript-eslint/no-explicit-any -- UNO proxies */
interface ZetaJs {
  readonly mainPort: MessagePort
  readonly uno: any
  readonly type: { interface(type: unknown): unknown; readonly float: unknown; readonly short: unknown }
  readonly Any: new (type: unknown, value: unknown) => unknown
  sameUnoObject(a: unknown, b: unknown): boolean
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
 * Commands that make no sense here, disabled (greyed out in menus and toolbars): they act on
 * LibreOffice's in-memory files, other windows, printers or mail, none of which the user can
 * reach from DSH. Opening and closing documents is DSH's file tree and tabs; the file is saved
 * in its own format.
 */
const DISABLED: ReadonlySet<string> = new Set([
  '.uno:Open', '.uno:OpenFromWriter', '.uno:OpenRemote', '.uno:RecentFileList', '.uno:AddDirect', '.uno:NewDoc',
  '.uno:CloseDoc', '.uno:CloseWin', '.uno:Quit', '.uno:NewWindow', '.uno:Reload', '.uno:EditDoc', '.uno:VersionDialog',
  '.uno:SaveAs', '.uno:SaveACopy', '.uno:SaveAll', '.uno:SaveAsTemplate', '.uno:SaveAsRemote',
  '.uno:ExportTo', '.uno:ExportToPDF', '.uno:ExportDirectToPDF', '.uno:ExportToEPUB', '.uno:ExportDirectToEPUB',
  '.uno:Print', '.uno:PrintDefault', '.uno:PrinterSetup', '.uno:PrintPreview',
  '.uno:SendToMenu', '.uno:SendMail', '.uno:SendMailDocAsPDF', '.uno:SendMailDocAsMS', '.uno:SendMailDocAsOOo',
  '.uno:AutoPilotMenu', '.uno:TemplateMenu', '.uno:TemplateManager', '.uno:WebHtml',
  '.uno:DigitalSignaturesMenu', '.uno:Signature', '.uno:SignPDF',
])

/** URL patterns disabled the same way: File → New's entries create documents in other windows. */
const DISABLED_PATTERNS: readonly string[] = ['private:factory/*']

const disabled = (command: string): boolean =>
  DISABLED.has(command) || DISABLED_PATTERNS.some(pattern => command.startsWith(pattern.slice(0, -1)))

/**
 * A dispatch interceptor on the document's frame: commands in {@link INTERCEPTED}
 * (from menus, toolbars and shortcuts alike) run here, those in {@link DISABLED}
 * and {@link DISABLED_PATTERNS} are greyed out and do nothing; everything else goes on to LibreOffice.
 */
function interceptCommands(frame: any): void {
  let slave: any = null
  let master: any = null
  const handled = (command: string): boolean => INTERCEPTED[command] !== undefined || disabled(command)
  const commands = [...Object.keys(INTERCEPTED), ...DISABLED, ...DISABLED_PATTERNS]
  const interceptor: any = zetajs.unoObject([css.frame.XDispatchProviderInterceptor, css.frame.XInterceptorInfo, css.frame.XDispatch], {
    // Only these reach this interceptor. Without the list LibreOffice asks it about every
    // toolbar and menu command on each cursor move, a JavaScript round trip each: seconds.
    getInterceptedURLs: () => commands,
    getSlaveDispatchProvider: () => slave,
    setSlaveDispatchProvider(provider: any) { slave = provider },
    getMasterDispatchProvider: () => master,
    setMasterDispatchProvider(provider: any) { master = provider },
    queryDispatch(url: any, target: string, flags: number) {
      if (handled(url.Complete)) return interceptor
      return slave === null ? null : slave.queryDispatch(url, target, flags)
    },
    queryDispatches(requests: readonly any[]) {
      return requests.map(request => interceptor.queryDispatch(request.FeatureURL, request.FrameName, request.SearchFlags))
    },
    dispatch(url: any) {
      INTERCEPTED[url.Complete]?.()
    },
    addStatusListener(listener: any, url: any) {
      // Some callers hand over their listener as a plain interface: ask it for XStatusListener.
      // A failure here must not reach LibreOffice: the command then shows its default state.
      try {
        const target = typeof listener.statusChanged === 'function'
          ? listener
          : listener.queryInterface(zetajs.type.interface(css.frame.XStatusListener))
        target?.statusChanged(new css.frame.FeatureStateEvent({ FeatureURL: url, IsEnabled: !disabled(url.Complete) }))
      } catch {
        // Left in its default state.
      }
    },
    removeStatusListener() {},
  })
  frame.registerDispatchProviderInterceptor(interceptor)
}

/** Selection reports wait for the cursor to rest. */
const SELECTION_DEBOUNCE_MS = 250

/** The open document's reads, edits and block numbering; one per document, it keeps the block list. */
let operations: DocumentOperations | undefined
/** The open document's modify listener, taken off while the AI edits (see `edit`). */
let modifyListener: any

/** Report the selection whenever it changes and comes to rest. */
function watchSelection(controller: any): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  controller.addSelectionChangeListener(zetajs.unoObject([css.view.XSelectionChangeListener], {
    disposing() {},
    selectionChanged() {
      clearTimeout(timer)
      timer = setTimeout(() => {
        try {
          // Only while the block list is current: after a change (typing) the report waits for
          // a forced one (getSelection, e.g. when focus leaves the editor for the chat).
          const report = operations?.selection(false)
          if (report !== undefined) post({ event: 'selection', selection: report })
        } catch {
          // The document closed meanwhile.
        }
      }, SELECTION_DEBOUNCE_MS)
    },
  }))
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
  const opened = new DocumentOperations(zetajs, css, loaded)
  operations = opened
  modifyListener = zetajs.unoObject([css.util.XModifyListener], {
    disposing() {},
    modified() {
      // Every change may move block numbers.
      opened.invalidate()
      // Also called when the flag is reset (after an export): only a change counts.
      if (loaded.isModified()) post({ event: 'modified' })
    },
  })
  model.addModifyListener(modifyListener)
  const controller = model.getCurrentController()
  // The first selection read is slow (zetajs resolves the UNO types it touches, seconds), and
  // lists the blocks: pay it now, while the engine still shows "opening".
  opened.selection(true)
  watchSelection(controller)
  const frame = controller.getFrame()
  interceptCommands(frame)
  // A full-screen window follows Qt's screen, which is the canvas: it fills it, tracks its size,
  // and has no title bar (whose close button would end LibreOffice).
  frame.getContainerWindow().FullScreen = true
}

/**
 * The AI's edit. LibreOffice notifies modify listeners once or twice per paragraph it
 * touches, and each notification is a round trip into JavaScript (tens of milliseconds
 * in all): the listener is off while the edit runs, and the change is reported once after.
 */
function edit(request: Extract<ThreadRequest, { cmd: 'edit' }>): unknown {
  if (operations === undefined) throw new Error('no document is open')
  model.removeModifyListener(modifyListener)
  try {
    return operations.edit(request.operations)
  } finally {
    model.addModifyListener(modifyListener)
    operations.invalidate()
    if (model.isModified()) post({ event: 'modified' })
  }
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
    else if (request.cmd === 'getSelection') value = operations?.selection(true)
    else if (request.cmd === 'read') {
      if (operations === undefined) throw new Error('no document is open')
      value = operations.read(request.from, request.to)
    } else if (request.cmd === 'edit') value = edit(request)
    post({ id: request.id, ok: true, value })
  } catch (error) {
    post({ id: request.id, ok: false, error: describe(error) })
  }
}

post({ event: 'ready' })
