/**
 * Messages between the engine (in DSH's page) and the editor page (the
 * isolated iframe running LibreOffice). Both are same-origin documents in
 * different agent clusters, so they talk only through `postMessage`; every
 * message carries {@link CHANNEL} so unrelated messages are ignored.
 */

export const CHANNEL = 'dsh-document'

/** Paths of the host routes, relative to DSH's page (the editor page's own assets are relative to it). */
export const EDITOR_ROUTE = '/dsh-document/editor'
export const EDITOR_SCRIPT_ROUTE = '/dsh-document/editor.js'
export const THREAD_SCRIPT_ROUTE = '/dsh-document/thread.js'

/** What the host tells the editor page; embedded in its HTML. */
export interface EditorConfig {
  /** Base URL of the ZetaOffice build (`soffice.js`, `.wasm`, `.data`), ending in `/`. */
  readonly zetaofficeUrl: string
  /** Base URL of zetajs's `source/` directory (`zetaHelper.js`, `zeta.js`), ending in `/`. */
  readonly zetajsUrl: string
  /** A CJK font installed into LibreOffice before it starts; empty for none. */
  readonly cjkFontUrl: string
}

/** Requests from the engine; each is answered by one {@link Reply} with the same `id`. */
export type Request =
  /** Load a document; `bytes` undefined (missing or empty file) starts a new one. */
  | { readonly type: 'open'; readonly id: number; readonly bytes: ArrayBuffer | undefined; readonly extension: string }
  /** The document's plain text. */
  | { readonly type: 'getText'; readonly id: number }

export type Reply =
  | { readonly type: 'reply'; readonly id: number; readonly ok: true; readonly value?: unknown }
  | { readonly type: 'reply'; readonly id: number; readonly ok: false; readonly error: string }

/** Events the editor page reports on its own. */
export type EditorEvent =
  /** LibreOffice started and takes requests. */
  | { readonly type: 'ready' }
  /** LibreOffice could not start. */
  | { readonly type: 'failed'; readonly message: string }
  /** The user changed the document. */
  | { readonly type: 'modified' }

export type FromEditor = Reply | EditorEvent

export type Envelope<T> = T & { readonly channel: typeof CHANNEL }

/** A request before its id is assigned (distributes over the union). */
export type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never

export function isEnvelope(data: unknown): data is Envelope<{ type: string }> {
  return typeof data === 'object' && data !== null && (data as { channel?: unknown }).channel === CHANNEL
}

/** Requests the editor page forwards to the office thread, and its answers. */
export type ThreadRequest =
  | { readonly cmd: 'open'; readonly id: number; readonly url: string | undefined }
  | { readonly cmd: 'getText'; readonly id: number }

export type ThreadMessage =
  | { readonly id: number; readonly ok: true; readonly value?: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string }
  | { readonly event: 'ready' | 'modified' }
