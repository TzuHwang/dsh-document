/**
 * The document engine: LibreOffice in an isolated iframe (the editor page the
 * host serves), mounted by the template's editor as a self-managed engine.
 *
 * It keeps the document in sync with its file itself ({@link FileSync}):
 * reads and watches it through DSH's workspaceFiles, has LibreOffice export
 * the document when saving (after a pause in editing, when focus leaves the
 * editor, on Ctrl+S, when the view closes), and writes through the plugin's
 * save route. A change on disk reloads a clean document, and is a conflict
 * prompt while changes are pending.
 */
import type { SelfManagedEngine, Translate } from '@dsh-editor/core'
import { fileIO, watchFile, type WorkspaceFiles } from './file-io.ts'
import { CHANNEL, EDITOR_ROUTE, isEnvelope, type DocumentRead, type EditOperation, type EditResult, type Envelope, type FromEditor, type Request, type SelectionReport, type WithoutId } from './protocol.ts'
import { FileSync, type SyncStatus } from './sync.ts'

/** A mounted document as the AI's tools reach it (see bridge.ts). */
export interface OpenDocument {
  readonly sessionId: string
  /** Workspace-relative, as the session's file addresses carry it. */
  readonly path: string
  /** Settles when LibreOffice shows the document; rejects when it cannot. */
  readonly ready: Promise<void>
  read(from: number | undefined, to: number | undefined): Promise<DocumentRead>
  /** Edit as one undo step, then save; `saved` says whether the file now has it. */
  edit(operations: readonly EditOperation[]): Promise<EditResult & { readonly saved: boolean; readonly status: string }>
}

/** Where mounted documents announce themselves; returns the function that withdraws one. */
export type DocumentRegistry = (document: OpenDocument) => () => void

/** Formats LibreOffice Writer opens and saves. */
export const EXTENSIONS = ['doc', 'docx', 'odt'] as const

/** How long LibreOffice may take to start (download included) before the engine gives up. */
const START_TIMEOUT_MS = 180_000
/** Pause in editing before an autosave; exporting a document is costly. */
const AUTOSAVE_MS = 2_000
/** How long an export may take before the save fails (and stays pending for a retry). */
const EXPORT_TIMEOUT_MS = 30_000
/** How long a quick question to LibreOffice may take; closing must not hang on it. */
const ASK_TIMEOUT_MS = 10_000

/** The engine's state, on its root element as `data-state`; the sync status is `data-sync`. */
type State = 'starting' | 'opening' | 'ready' | 'failed'

const STYLE = `
.dsh-document { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.dsh-document__banner { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; padding: 6px 10px; background: color-mix(in srgb, #f5a623 18%, transparent); }
.dsh-document__banner[hidden] { display: none; }
.dsh-document__banner button { font: inherit; padding: 1px 8px; border-radius: 4px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); background: transparent; color: inherit; cursor: pointer; }
.dsh-document__body { position: relative; flex: 1; min-height: 0; }
.dsh-document__frame { display: block; width: 100%; height: 100%; border: 0; }
.dsh-document__notice { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; font-size: 13px; background: var(--dsw-alias-bg-l1, Canvas); }
.dsh-document__notice[hidden] { display: none; }
.dsh-document[data-state="failed"] .dsh-document__notice { color: #d0453d; }
`

function ensureStyle(document: Document): void {
  if (document.querySelector('style[data-dsh-document]') !== null) return
  const style = document.createElement('style')
  style.dataset.dshDocument = ''
  style.textContent = STYLE
  document.head.appendChild(style)
}

/** `promise`, or a rejection after `ms`: a stuck export must not stall the save queue. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)

export function createDocumentEngine(files: WorkspaceFiles, t: Translate, register: DocumentRegistry): SelfManagedEngine {
  return {
    id: 'dsh-document',
    extensions: EXTENSIONS,
    selfManaged: true,
    mount(host, binding) {
      const document = host.ownerDocument
      const window = document.defaultView!
      ensureStyle(document)
      const el = (tag: string, className: string): HTMLElement => {
        const node = document.createElement(tag)
        node.className = className
        return node
      }
      const root = el('div', 'dsh-document')
      root.dataset.testid = 'dsh-document'
      const banner = el('div', 'dsh-document__banner')
      banner.dataset.testid = 'dsh-document-banner'
      banner.hidden = true
      const body = el('div', 'dsh-document__body')
      const frame = el('iframe', 'dsh-document__frame') as HTMLIFrameElement
      frame.title = t('frameTitle')
      frame.src = EDITOR_ROUTE.slice(1)
      const notice = el('div', 'dsh-document__notice')
      body.append(frame, notice)
      root.append(banner, body)
      host.append(root)

      let destroyed = false
      const setState = (state: State, text?: string): void => {
        root.dataset.state = state
        notice.hidden = text === undefined
        notice.textContent = text ?? ''
      }
      setState('starting', t('loading'))

      // ---- talking to the editor page ----

      /** Requests waiting for the editor page, by id. */
      const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
      let nextId = 0
      const request = (message: WithoutId<Request>, transfer: Transferable[] = []): Promise<unknown> =>
        new Promise((resolve, reject) => {
          const id = ++nextId
          pending.set(id, { resolve, reject })
          const envelope = { ...message, id, channel: CHANNEL } as Envelope<Request>
          frame.contentWindow?.postMessage(envelope, window.location.origin, transfer)
        })
      /** Open `bytes` in LibreOffice (a copy is transferred); empty bytes start a new document. */
      const openInEditor = (bytes: Uint8Array): Promise<unknown> => {
        if (bytes.length === 0) return request({ type: 'open', bytes: undefined, extension: binding.extension })
        const copy = bytes.slice().buffer
        return request({ type: 'open', bytes: copy, extension: binding.extension }, [copy])
      }

      // ---- the file ----

      const file = { sessionId: binding.sessionId, path: binding.path }
      const sync = new FileSync(fileIO(files, file), { debounceMs: AUTOSAVE_MS })
      const watcher = new AbortController()
      const loaded = sync.load()

      /**
       * `modified` events trail the input LibreOffice is still processing; before deciding
       * anything on "no changes" (saving, taking a change from disk), ask it. The answer comes
       * after keys typed just before, so those count.
       */
      const markIfModified = async (): Promise<void> => {
        if (root.dataset.state !== 'ready') return
        try {
          const modified = await withTimeout(request({ type: 'isModified' }), ASK_TIMEOUT_MS, 'LibreOffice did not answer')
          if (modified === true) sync.touch()
        } catch {
          // The editor is gone; go by what is known.
        }
      }
      void loaded.then(() => {
        if (destroyed) return
        // Never reload over typing that has not been reported yet: that would be a conflict.
        watchFile(files, file, version => { void markIfModified().then(() => sync.externalChange(version)) }, watcher.signal)
      }, () => {})

      const button = (label: string, onClick: () => void): HTMLElement => {
        const node = document.createElement('button')
        node.type = 'button'
        node.textContent = label
        node.addEventListener('click', onClick)
        return node
      }
      const text = (content: string): HTMLElement => {
        const node = document.createElement('span')
        node.textContent = content
        return node
      }
      let previous: SyncStatus['kind'] = 'loading'
      const renderStatus = (status: SyncStatus): void => {
        root.dataset.sync = status.kind
        banner.replaceChildren()
        if (status.kind === 'conflict') {
          banner.append(
            text(t('conflict.message')),
            button(t('conflict.useDisk'), () => { void sync.resolveConflict('disk') }),
            button(t('conflict.keepMine'), () => { void sync.resolveConflict('mine') }),
          )
        } else if (status.kind === 'error') {
          banner.append(text(t('error.save', { reason: status.message })), button(t('retry'), () => { void sync.flush() }))
        } else if (status.kind === 'missing' && previous !== 'loading') {
          // Missing when opened is a new file, not a deleted one.
          banner.append(text(t('missing')))
        }
        banner.hidden = banner.childElementCount === 0
        previous = status.kind
      }
      /**
       * Tell the AI where the user is. `passive`: the move was not the user's (the file
       * reloaded), so the context refreshes without this view taking over the session.
       */
      const reportSelection = async (passive: boolean): Promise<void> => {
        try {
          const selection = await request({ type: 'getSelection' }) as SelectionReport | undefined
          if (selection !== undefined && !destroyed) binding.onSelection(selection, passive)
        } catch {
          // No document (yet): nothing to report.
        }
      }

      const unsubscribe = sync.subscribe({
        status: renderStatus,
        external: (bytes) => {
          // The file changed on disk while the document was clean: show the new version.
          openInEditor(bytes).then(() => reportSelection(true), (error: unknown) => {
            banner.replaceChildren(text(t('error.reload', { reason: reason(error) })))
            banner.hidden = false
          })
        },
      })
      renderStatus(sync.status)

      // ---- startup ----

      let settleReady!: (opened: boolean, reason?: string) => void
      const ready = new Promise<void>((resolve, reject) => {
        settleReady = (opened, why) => opened ? resolve() : reject(new Error(why))
      })
      // A failed start is reported to a waiting tool call, not left unhandled.
      ready.catch(() => {})

      const fail = (message: string): void => {
        if (destroyed || root.dataset.state === 'failed') return
        clearTimeout(timer)
        setState('failed', message)
        settleReady(false, message)
      }
      const timer = setTimeout(() => fail(t('error.timeout')), START_TIMEOUT_MS)

      let detachSource: (() => void) | undefined
      const open = async (): Promise<void> => {
        clearTimeout(timer)
        setState('opening', t('opening'))
        try {
          await openInEditor(await loaded)
          if (destroyed) return
          detachSource = sync.setSource(async () => new Uint8Array(await withTimeout(
            request({ type: 'save', extension: binding.extension }) as Promise<ArrayBuffer>,
            EXPORT_TIMEOUT_MS,
            'LibreOffice did not export the document in time',
          )))
          setState('ready')
          settleReady(true)
          // A freshly opened file is what the user is looking at: tell the AI right away.
          void reportSelection(false)
        } catch (error) {
          fail(t('error.open', { reason: reason(error) }))
        }
      }

      /** Save now, keys typed just before (e.g. right before closing) included. */
      const saveNow = async (): Promise<void> => {
        await markIfModified()
        await sync.flush()
      }

      const onMessage = (event: MessageEvent): void => {
        if (event.source !== frame.contentWindow || !isEnvelope(event.data)) return
        const message = event.data as unknown as FromEditor
        switch (message.type) {
          case 'ready': void open(); break
          case 'failed': fail(t('error.start', { reason: message.message })); break
          case 'modified': if (root.dataset.state === 'ready') sync.touch(); break
          case 'selection': if (!destroyed) binding.onSelection(message.selection, false); break
          // Leaving the editor (e.g. to message the AI) saves now, and tells the AI where the
          // user was: while typing, the block numbers of selection reports are not kept current.
          case 'blur':
            void saveNow()
            void reportSelection(false)
            break
          case 'saveRequested': void saveNow(); break
          case 'reply': {
            const waiting = pending.get(message.id)
            pending.delete(message.id)
            if (message.ok) waiting?.resolve(message.value)
            else waiting?.reject(new Error(message.error))
          }
        }
      }
      window.addEventListener('message', onMessage)

      const withdraw = register({
        sessionId: binding.sessionId,
        path: binding.path,
        ready,
        read: async (from, to) => request({ type: 'read', from, to }) as Promise<DocumentRead>,
        edit: async (operations) => {
          const result = await request({ type: 'edit', operations }) as EditResult
          // The AI reads files from disk too: the edit goes there now, not after the autosave pause.
          await saveNow()
          return { ...result, saved: sync.status.kind === 'clean', status: sync.status.kind }
        },
      })

      const cleanup = (): void => {
        withdraw()
        destroyed = true
        clearTimeout(timer)
        watcher.abort()
        detachSource?.()
        unsubscribe()
        sync.dispose()
        window.removeEventListener('message', onMessage)
        for (const waiting of pending.values()) waiting.reject(new Error('the editor closed'))
        pending.clear()
        settleReady(false, 'the editor closed')
        root.remove()
      }

      return {
        flush: saveNow,
        focus() { frame.focus() },
        // Save what is pending first: only the live LibreOffice can export it. The core keeps
        // this view in the page, hidden, until it settles.
        destroy: () => saveNow().finally(cleanup),
      }
    },
  }
}
