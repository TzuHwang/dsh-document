/**
 * Host plugin of dsh-document: serves the editor page the engine embeds, and
 * saves documents.
 *
 * The page is sent with `Document-Isolation-Policy: isolate-and-credentialless`,
 * which isolates that one document: LibreOffice (WebAssembly with threads)
 * gets `SharedArrayBuffer` while DSH's page stays unisolated. Routes follow
 * DSH's open-in-app pattern: registered on `ctx.webServer`, admitted only for
 * requests `ctx.connection` accepts. Saves are confined to the session's
 * workspace and guarded by the version the engine read (see write-bytes.ts).
 */
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import { AgentChannel } from './agent-channel.ts'
import {
  AGENT_REPLY_ROUTE,
  AGENT_ROUTE,
  EDITOR_ROUTE,
  EDITOR_SCRIPT_ROUTE,
  MAX_WRITE_BYTES,
  THREAD_SCRIPT_ROUTE,
  WRITE_ROUTE,
  parseWriteQuery,
  type AgentReply,
  type EditorConfig,
} from './protocol.ts'
import { registerTools, type FsTarget, type ToolsHost } from './tools.ts'
import { StaleVersionError, replaceBytes } from './write-bytes.ts'

export const name = 'dsh-document'
export const inject = ['webServer', 'connection', 'fs', 'sessions', 'sandboxPolicy', 'tools']

/**
 * Where the editor page loads LibreOffice and its helpers from (point them at
 * your own copies to pin or self-host), and whether the AI's edits ask first.
 */
export interface Config extends EditorConfig {
  /** Volatile: the settings page changes it while DSH runs; read with `.get()`. */
  confirmEdits: { get(): boolean | undefined }
}

export const Config = z.object({
  zetaofficeUrl: z.string().default('https://cdn.zetaoffice.net/zetaoffice_latest/')
    .description('Base URL of the ZetaOffice (LibreOffice WebAssembly) build, ending in /.'),
  zetajsUrl: z.string().default('https://cdn.jsdelivr.net/npm/zetajs@1.2.0/source/')
    .description('Base URL of zetajs\'s source/ directory, ending in /.'),
  cjkFontUrl: z.string().default('https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@Sans2.004/Sans/SubsetOTF/TC/NotoSansTC-Regular.otf')
    .description('A CJK font installed into LibreOffice before it starts; empty for none.'),
  confirmEdits: z.boolean().default(true)
    .description('Ask the user before each document edit by the AI.')
    .volatile(),
})

// Host services, typed locally.
interface HostContext extends ToolsHost {
  effect(factory: () => () => void, label?: string): () => void
  get(name: string): unknown
  webServer: { register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }): () => void }
  connection: { requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined }
  fs: {
    resolve(path: string, options?: { cwd?: string }): Promise<FsTarget>
    contains(parent: FsTarget, child: FsTarget): boolean
    stat(target: FsTarget): Promise<{ version: string; type: 'file' | 'directory' | 'other' } | undefined>
    processPath(target: FsTarget): string
  }
  sessions: { get(sessionId: string): { header?: { cwd?: string } } | undefined }
  sandboxPolicy: { workspaceRoot: string }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_WRITE_BYTES) throw new HttpError(413, 'too-large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** The session's workspace root, live or persisted; mirrors workspaceFiles' own lookup. */
async function workspaceRootOf(ctx: HostContext, sessionId: string): Promise<string> {
  const live = ctx.sessions.get(sessionId)?.header
  const stored = live === undefined
    ? await (ctx.get('sessionPersistence') as { stat(id: string): Promise<{ header?: { cwd?: string } } | undefined> } | undefined)?.stat(sessionId)
    : undefined
  const header = live ?? stored?.header
  if (header === undefined) throw new HttpError(404, 'session-not-found')
  return header.cwd ?? ctx.sandboxPolicy.workspaceRoot
}

/** POST the file's bytes: see WRITE_ROUTE in protocol.ts. */
async function save(ctx: HostContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST')
    sendJson(res, 405, { error: 'method-not-allowed' })
    return
  }
  try {
    const request = parseWriteQuery(new URL(req.url ?? '', 'http://host').search)
    if (request === undefined) throw new HttpError(400, 'bad-request')
    const data = await readBody(req)
    const workspaceRoot = await workspaceRootOf(ctx, request.sessionId)
    const root = await ctx.fs.resolve(workspaceRoot)
    const target = await ctx.fs.resolve(request.path, { cwd: workspaceRoot })
    if (!ctx.fs.contains(root, target)) throw new HttpError(403, 'outside-workspace')
    const info = await ctx.fs.stat(target)
    if (info !== undefined && info.type !== 'file') throw new HttpError(400, 'not-a-file')
    sendJson(res, 200, { version: await replaceBytes(ctx.fs, target, data, request.version) })
  } catch (error) {
    if (error instanceof HttpError) sendJson(res, error.status, { error: error.message })
    else if (error instanceof StaleVersionError) sendJson(res, 409, { error: 'stale' })
    else {
      const code = (error as { code?: unknown } | null)?.code
      sendJson(res, 500, { error: typeof code === 'string' ? code : 'write-failed' })
    }
  }
}

/** The editor page; `config` is embedded for its script. */
function editorPage(config: EditorConfig): string {
  // `<` escaped so no value can close the script element.
  const json = JSON.stringify(config).replace(/</g, '\\u003c')
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>dsh-document</title>
<style>html, body { margin: 0; height: 100%; overflow: hidden; background: #fff; } #qtcanvas { display: block; width: 100%; height: 100%; border: 0; outline: none; }</style>
<script>window.__DSH_DOCUMENT__ = ${json}</script>
</head>
<body>
<canvas id="qtcanvas" tabindex="-1" oncontextmenu="event.preventDefault()"></canvas>
<script type="module" src="editor.js"></script>
</body>
</html>
`
}

export function apply(ctx: HostContext, config: Config): void {
  /** A route admitted only for requests DSH's connection accepts. */
  const register = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): void => {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        const rejection = ctx.connection.requestRejection(req)
        if (rejection !== undefined) {
          res.statusCode = rejection
          res.end()
          return
        }
        await handler(req, res)
      },
    }), `dsh-document: ${path}`)
  }

  // Built next to this file by scripts/build.mjs.
  const asset = (file: string): string => readFileSync(new URL(`./editor/${file}`, import.meta.url), 'utf8')
  const pages: readonly (readonly [string, string, Record<string, string>])[] = [
    [EDITOR_ROUTE, editorPage(config), {
      'content-type': 'text/html; charset=utf-8',
      'document-isolation-policy': 'isolate-and-credentialless',
    }],
    [EDITOR_SCRIPT_ROUTE, asset('page.js'), { 'content-type': 'text/javascript; charset=utf-8' }],
    [THREAD_SCRIPT_ROUTE, asset('thread.js'), { 'content-type': 'text/javascript; charset=utf-8' }],
  ]
  for (const [path, body, headers] of pages) {
    register(path, async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405
        res.setHeader('allow', 'GET, HEAD')
        res.end()
        return
      }
      for (const [header, value] of Object.entries(headers)) res.setHeader(header, value)
      res.setHeader('cache-control', 'no-cache')
      res.end(req.method === 'HEAD' ? undefined : body)
    })
  }

  register(WRITE_ROUTE, (req, res) => save(ctx, req, res))

  // The AI's tools run in the user's open DSH page; this channel reaches it.
  const channel = new AgentChannel()
  ctx.effect(() => () => channel.dispose(), 'dsh-document: agent channel')
  register(AGENT_ROUTE, async (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('allow', 'GET')
      res.end()
      return
    }
    channel.connect(req, res)
  })
  register(AGENT_REPLY_ROUTE, async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { error: 'method-not-allowed' })
      return
    }
    try {
      channel.reply(JSON.parse((await readBody(req)).toString('utf8')) as AgentReply)
      res.statusCode = 204
      res.end()
    } catch {
      sendJson(res, 400, { error: 'bad-request' })
    }
  })
  registerTools(ctx, channel, () => config.confirmEdits.get() !== false)
}
