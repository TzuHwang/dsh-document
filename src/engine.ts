/**
 * The document engine: LibreOffice in an isolated iframe (the editor page the
 * host serves), mounted by the template's editor as a self-managed engine.
 *
 * It reads the file's bytes itself (DSH's workspaceFiles), waits for the
 * editor page to report LibreOffice ready, and hands them over to open.
 * Saving comes next (M2); until then edits stay in the editor.
 */
import type { SelfManagedEngine, Translate } from '@dsh-editor/core'
import { CHANNEL, EDITOR_ROUTE, isEnvelope, type Envelope, type FromEditor, type Request, type WithoutId } from './protocol.ts'

/** Formats LibreOffice Writer opens and saves. */
export const EXTENSIONS = ['doc', 'docx', 'odt'] as const

/** How long LibreOffice may take to start (download included) before the engine gives up. */
const START_TIMEOUT_MS = 180_000

/** DSH's `ctx.remote.workspaceFiles`, Client face: the part used here. */
export interface WorkspaceFiles {
  readBytes(sessionId: string, path: string, options: object): Promise<
    | { readonly ok: true; readonly value: { readonly data: Uint8Array } }
    | { readonly ok: false; readonly error: { readonly code: string } }
  >
}

/** The engine's state, on its root element as `data-state` (and for the smoke test). */
type State = 'starting' | 'opening' | 'ready' | 'failed'

const STYLE = `
.dsh-document { position: relative; height: 100%; min-height: 0; }
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

/** The file's bytes, or undefined when it is missing or empty (LibreOffice then starts a new document). */
async function readFile(files: WorkspaceFiles, sessionId: string, path: string): Promise<ArrayBuffer | undefined> {
  const result = await files.readBytes(sessionId, path, {})
  if (!result.ok) {
    if (result.error.code === 'workspace-file/not-found') return undefined
    throw new Error(result.error.code)
  }
  // A copy: the remote's array may view a larger buffer, and this one is transferred.
  return result.value.data.byteLength === 0 ? undefined : result.value.data.slice().buffer
}

export function createDocumentEngine(files: WorkspaceFiles, t: Translate): SelfManagedEngine {
  return {
    id: 'dsh-document',
    extensions: EXTENSIONS,
    selfManaged: true,
    mount(host, binding) {
      const document = host.ownerDocument
      const window = document.defaultView!
      ensureStyle(document)
      const root = document.createElement('div')
      root.className = 'dsh-document'
      root.dataset.testid = 'dsh-document'
      const frame = document.createElement('iframe')
      frame.className = 'dsh-document__frame'
      frame.title = t('frameTitle')
      frame.src = EDITOR_ROUTE.slice(1)
      const notice = document.createElement('div')
      notice.className = 'dsh-document__notice'
      root.append(frame, notice)
      host.append(root)

      let destroyed = false
      const setState = (state: State, text?: string): void => {
        root.dataset.state = state
        notice.hidden = text === undefined
        notice.textContent = text ?? ''
      }
      setState('starting', t('loading'))

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

      const fail = (text: string): void => {
        if (destroyed || root.dataset.state === 'failed') return
        clearTimeout(timer)
        setState('failed', text)
      }
      const timer = setTimeout(() => fail(t('error.timeout')), START_TIMEOUT_MS)

      const open = async (): Promise<void> => {
        clearTimeout(timer)
        setState('opening', t('opening'))
        try {
          const bytes = await readFile(files, binding.sessionId, binding.path)
          await request({ type: 'open', bytes, extension: binding.extension }, bytes === undefined ? [] : [bytes])
          if (!destroyed) setState('ready')
        } catch (error) {
          fail(t('error.open', { reason: error instanceof Error ? error.message : String(error) }))
        }
      }

      const onMessage = (event: MessageEvent): void => {
        if (event.source !== frame.contentWindow || !isEnvelope(event.data)) return
        const message = event.data as unknown as FromEditor
        if (message.type === 'ready') void open()
        else if (message.type === 'failed') fail(t('error.start', { reason: message.message }))
        else if (message.type === 'reply') {
          const waiting = pending.get(message.id)
          pending.delete(message.id)
          if (message.ok) waiting?.resolve(message.value)
          else waiting?.reject(new Error(message.error))
        }
      }
      window.addEventListener('message', onMessage)

      return {
        // Saving comes in M2.
        flush: async () => {},
        focus() { frame.focus() },
        destroy() {
          destroyed = true
          clearTimeout(timer)
          window.removeEventListener('message', onMessage)
          for (const waiting of pending.values()) waiting.reject(new Error('the editor closed'))
          pending.clear()
          root.remove()
        },
      }
    },
  }
}
