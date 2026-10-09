/**
 * The page side of the AI's document tools: listens on the host's agent
 * stream, and runs each call on the document mounted in this page. A call for
 * a document that is not open opens it in the center (as the user would from
 * the file tree) and waits for LibreOffice. A page that does not show the
 * call's session answers `unavailable`, so another page may serve it.
 */
import type { EditorService } from '@dsh-editor/core'
import type { DocumentRegistry, OpenDocument } from './engine.ts'
import { AGENT_REPLY_ROUTE, AGENT_ROUTE, type AgentReply, type AgentRequest } from './protocol.ts'

/** Opening a document may start LibreOffice first (a download the first time). */
const OPEN_TIMEOUT_MS = 150_000

interface Observable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

export interface BridgeDeps {
  readonly editor: EditorService
  /** DSH's selected session (`ctx.uiSession.adapter.current`). */
  readonly current: Observable<{ readonly key: string | undefined }>
  /** Session workspaces (`ctx.sessions.list`), for the editor's tab scope. */
  readonly sessions: Observable<{ readonly byId: Readonly<Record<string, { readonly cwd?: string } | undefined>> }>
}

const key = (sessionId: string, path: string): string => `${sessionId}\0${path}`

/** The documents mounted in this page, by session and path. */
export class Documents {
  private readonly open = new Map<string, OpenDocument>()
  private readonly waiters = new Set<() => void>()

  readonly register: DocumentRegistry = (document) => {
    const id = key(document.sessionId, document.path)
    this.open.set(id, document)
    for (const wake of this.waiters) wake()
    return () => {
      if (this.open.get(id) === document) this.open.delete(id)
    }
  }

  get(sessionId: string, path: string): OpenDocument | undefined {
    return this.open.get(key(sessionId, path))
  }

  /** The document once it mounts, or a rejection after `timeoutMs`. */
  waitFor(sessionId: string, path: string, timeoutMs: number): Promise<OpenDocument> {
    const found = this.get(sessionId, path)
    if (found !== undefined) return Promise.resolve(found)
    return new Promise((resolve, reject) => {
      const wake = (): void => {
        const document = this.get(sessionId, path)
        if (document === undefined) return
        done()
        resolve(document)
      }
      const timer = setTimeout(() => {
        done()
        reject(new Error(`${path} did not open in the editor in time`))
      }, timeoutMs)
      const done = (): void => {
        clearTimeout(timer)
        this.waiters.delete(wake)
      }
      this.waiters.add(wake)
    })
  }
}

export function startBridge(documents: Documents, deps: BridgeDeps): () => void {
  const { editor } = deps
  let page: string | undefined
  const events = new EventSource(AGENT_ROUTE.slice(1))

  const reply = (body: AgentReply): void => {
    void fetch(AGENT_REPLY_ROUTE.slice(1), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {
      // The host is gone; its call times out.
    })
  }

  /** The document for `request`, opened in the center when it is not. */
  const documentFor = async (request: AgentRequest): Promise<OpenDocument> => {
    const workspaceRoot = deps.sessions.getSnapshot().byId[request.sessionId]?.cwd
    const scopeKey = editor.scopeKey(request.sessionId, workspaceRoot)
    const mounted = documents.get(request.sessionId, request.path)
    // An edit shows: bring its tab forward (a kept tab may be hidden).
    if (scopeKey !== null && (mounted === undefined || request.operation.kind === 'edit')) editor.viewState.openTab(scopeKey, request.path)
    const document = mounted ?? await documents.waitFor(request.sessionId, request.path, OPEN_TIMEOUT_MS)
    await document.ready
    return document
  }

  const handle = async (request: AgentRequest, from: string): Promise<void> => {
    const shown = editor.settings.getSnapshot()?.enabled === true && deps.current.getSnapshot().key === request.sessionId
    if (!shown) {
      reply({ id: request.id, page: from, ok: false, unavailable: true, error: 'this page does not show the session' })
      return
    }
    try {
      const document = await documentFor(request)
      const { operation } = request
      const value = operation.kind === 'read' ? await document.read(operation.from, operation.to) : await document.edit(operation.operations)
      reply({ id: request.id, page: from, ok: true, value })
    } catch (error) {
      reply({ id: request.id, page: from, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  events.addEventListener('page', (event) => { page = (event as MessageEvent<string>).data })
  events.onmessage = (event: MessageEvent<string>) => {
    if (page === undefined) return
    let request: AgentRequest
    try {
      request = JSON.parse(event.data) as AgentRequest
    } catch {
      return
    }
    void handle(request, page)
  }
  return () => events.close()
}
