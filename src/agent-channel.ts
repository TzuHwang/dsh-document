/**
 * Host → page calls for the AI's tools. DSH offers plugins no way to call into
 * the browser, so open DSH pages hold a server-sent-events stream on
 * `AGENT_ROUTE`; a call goes to every page, and each answers on
 * `AGENT_REPLY_ROUTE`. The first real answer wins; a page that does not show
 * the session answers `unavailable`, and when all have, the call fails.
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentOperation, AgentReply, AgentRequest } from './protocol.ts'

/** Thrown when no open DSH page can serve the call. */
export class NoPageError extends Error {
  override readonly name = 'NoPageError'
}

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  /** Pages that were sent the call and have not answered `unavailable` (by page id). */
  readonly waiting: Set<string>
  readonly timer: ReturnType<typeof setTimeout>
}

/** Comment lines keep proxies and the browser from closing an idle stream. */
const KEEPALIVE_MS = 20_000

export class AgentChannel {
  /** Open streams by page id; a page learns its id from the stream's first event. */
  private readonly pages = new Map<string, ServerResponse>()
  private readonly pending = new Map<string, Pending>()
  private readonly keepalive = setInterval(() => {
    for (const page of this.pages.values()) page.write(': keepalive\n\n')
  }, KEEPALIVE_MS)

  /** `GET`: hold the stream open for one page. */
  connect(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    const page = randomUUID()
    res.write(`event: page\ndata: ${page}\n\n`)
    this.pages.set(page, res)
    req.on('close', () => {
      this.pages.delete(page)
      // A page gone mid-call does not serve it.
      for (const [id, call] of this.pending) this.unavailable(id, call, page)
    })
  }

  /** `POST`: one page's answer. */
  reply(reply: AgentReply): void {
    const call = this.pending.get(reply.id)
    if (call === undefined) return
    if (reply.ok) this.settle(reply.id, call, () => call.resolve(reply.value))
    else if (reply.unavailable === true) this.unavailable(reply.id, call, reply.page)
    else this.settle(reply.id, call, () => call.reject(new Error(reply.error)))
  }

  /**
   * Run `operation` on the document at `path` of `sessionId` in an open DSH page.
   * Rejects with {@link NoPageError} when no page can, and after `timeoutMs` without an answer.
   */
  call(sessionId: string, path: string, operation: AgentOperation, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.pages.size === 0) return Promise.reject(new NoPageError('no DSH page is open'))
    const request: AgentRequest = { id: randomUUID(), sessionId, path, operation }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const call = this.pending.get(request.id)
        if (call !== undefined) this.settle(request.id, call, () => reject(new Error('the DSH page did not answer in time')))
      }, timeoutMs)
      this.pending.set(request.id, { resolve, reject, waiting: new Set(this.pages.keys()), timer })
      signal?.addEventListener('abort', () => {
        const call = this.pending.get(request.id)
        if (call !== undefined) this.settle(request.id, call, () => reject(signal.reason instanceof Error ? signal.reason : new Error('cancelled')))
      }, { once: true })
      const event = `data: ${JSON.stringify(request)}\n\n`
      for (const page of this.pages.values()) page.write(event)
    })
  }

  dispose(): void {
    clearInterval(this.keepalive)
    for (const [id, call] of this.pending) this.settle(id, call, () => call.reject(new Error('the plugin stopped')))
    for (const page of this.pages.values()) page.end()
    this.pages.clear()
  }

  private unavailable(id: string, call: Pending, page: string): void {
    if (!call.waiting.delete(page)) return
    if (call.waiting.size === 0) this.settle(id, call, () => call.reject(new NoPageError('no open DSH page shows this session')))
  }

  private settle(id: string, call: Pending, finish: () => void): void {
    this.pending.delete(id)
    clearTimeout(call.timer)
    finish()
  }
}
