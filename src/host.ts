/**
 * Host plugin of dsh-document: serves the editor page the engine embeds.
 *
 * The page is sent with `Document-Isolation-Policy: isolate-and-credentialless`,
 * which isolates that one document: LibreOffice (WebAssembly with threads)
 * gets `SharedArrayBuffer` while DSH's page stays unisolated. Routes follow
 * DSH's open-in-app pattern: registered on `ctx.webServer`, admitted only for
 * requests `ctx.connection` accepts.
 */
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import { EDITOR_ROUTE, EDITOR_SCRIPT_ROUTE, THREAD_SCRIPT_ROUTE, type EditorConfig } from './protocol.ts'

export const name = 'dsh-document'
export const inject = ['webServer', 'connection']

/** Where the editor page loads LibreOffice and its helpers from; point them at your own copies to pin or self-host. */
export interface Config extends EditorConfig {}

export const Config = z.object({
  zetaofficeUrl: z.string().default('https://cdn.zetaoffice.net/zetaoffice_latest/')
    .description('Base URL of the ZetaOffice (LibreOffice WebAssembly) build, ending in /.'),
  zetajsUrl: z.string().default('https://cdn.jsdelivr.net/npm/zetajs@1.2.0/source/')
    .description('Base URL of zetajs\'s source/ directory, ending in /.'),
  cjkFontUrl: z.string().default('https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@Sans2.004/Sans/SubsetOTF/TC/NotoSansTC-Regular.otf')
    .description('A CJK font installed into LibreOffice before it starts; empty for none.'),
})

// Host services, typed locally.
interface HostContext {
  effect(factory: () => () => void, label?: string): () => void
  webServer: { register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }): () => void }
  connection: { requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined }
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
  // Built next to this file by scripts/build.mjs.
  const asset = (file: string): string => readFileSync(new URL(`./editor/${file}`, import.meta.url), 'utf8')
  const routes: readonly (readonly [string, string, Record<string, string>])[] = [
    [EDITOR_ROUTE, editorPage(config), {
      'content-type': 'text/html; charset=utf-8',
      'document-isolation-policy': 'isolate-and-credentialless',
    }],
    [EDITOR_SCRIPT_ROUTE, asset('page.js'), { 'content-type': 'text/javascript; charset=utf-8' }],
    [THREAD_SCRIPT_ROUTE, asset('thread.js'), { 'content-type': 'text/javascript; charset=utf-8' }],
  ]
  for (const [path, body, headers] of routes) {
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
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405
          res.setHeader('allow', 'GET, HEAD')
          res.end()
          return
        }
        for (const [header, value] of Object.entries(headers)) res.setHeader(header, value)
        res.setHeader('cache-control', 'no-cache')
        res.end(req.method === 'HEAD' ? undefined : body)
      },
    }), `dsh-document: GET ${path}`)
  }
}
