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

/**
 * The save route: POST the file's bytes (`application/octet-stream`) with the
 * target in the query string ({@link writeQuery}). Answers 200 `{ version }`,
 * 409 `{ error: 'stale' }` when the file changed since `version`, 4xx/5xx `{ error }` otherwise.
 */
export const WRITE_ROUTE = '/dsh-document/write'

/** Files above this are refused; matches workspaceFiles' default `maxFileBytes`. */
export const MAX_WRITE_BYTES = 32 * 1024 * 1024

export interface WriteTarget {
  readonly sessionId: string
  /** Workspace-relative or absolute path; it must resolve inside the session's workspace. */
  readonly path: string
  /** Version last read; omitted for an unconditional write (recreating a deleted file, keeping "mine"). */
  readonly version?: string | undefined
}

/** The query string carrying a write's target. */
export function writeQuery(target: WriteTarget): string {
  const query = new URLSearchParams({ sessionId: target.sessionId, path: target.path })
  if (target.version !== undefined) query.set('version', target.version)
  return query.toString()
}

/** The target of a write, or undefined when the query lacks one. */
export function parseWriteQuery(search: string): WriteTarget | undefined {
  const query = new URLSearchParams(search)
  const sessionId = query.get('sessionId')
  const path = query.get('path')
  const version = query.get('version')
  if (sessionId === null || sessionId === '' || path === null || path === '') return undefined
  return { sessionId, path, ...version === null ? {} : { version } }
}

/** LibreOffice's export filter for each format this plugin writes. */
export const EXPORT_FILTERS: Readonly<Record<string, string>> = {
  docx: 'MS Word 2007 XML',
  doc: 'MS Word 97',
  odt: 'writer8',
}

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
  /** Export the document in the file's format; the reply's value is an `ArrayBuffer` (transferred). */
  | { readonly type: 'save'; readonly id: number; readonly extension: string }
  /**
   * Whether the document has changes since it was opened or last exported. Answered after the
   * input LibreOffice already received, so keys typed just before count.
   */
  | { readonly type: 'isModified'; readonly id: number }
  /** Where the cursor and selection are; the reply's value is a {@link SelectionReport}. */
  | { readonly type: 'getSelection'; readonly id: number }

/**
 * Cursor and selection for the AI context, as the template's editor takes them
 * (`SelectionInfo`). Writer documents have no lines: paragraphs (1-based) stand for them.
 */
export interface SelectionReport {
  readonly cursorLine: number
  readonly fromLine: number
  readonly toLine: number
  /** Selected text, already cut to a bound; empty for a bare cursor. */
  readonly text: string
}

export type Reply =
  | { readonly type: 'reply'; readonly id: number; readonly ok: true; readonly value?: unknown }
  | { readonly type: 'reply'; readonly id: number; readonly ok: false; readonly error: string }

/** Events the editor page reports on its own. */
export type EditorEvent =
  /** LibreOffice started and takes requests. */
  | { readonly type: 'ready' }
  /** LibreOffice could not start. */
  | { readonly type: 'failed'; readonly message: string }
  /** The user changed the document (reported once per change after each save). */
  | { readonly type: 'modified' }
  /** Focus left the editor page (e.g. for the chat): save now, so the AI reads what is on screen. */
  | { readonly type: 'blur' }
  /** The user asked LibreOffice to save (Ctrl+S, the Save button): it is saved to the file. */
  | { readonly type: 'saveRequested' }
  /** The cursor or selection moved and came to rest. */
  | { readonly type: 'selection'; readonly selection: SelectionReport }

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
  /** Store a copy of the document at `url` with LibreOffice's `filter`, and mark it unmodified. */
  | { readonly cmd: 'export'; readonly id: number; readonly url: string; readonly filter: string }
  | { readonly cmd: 'isModified'; readonly id: number }
  | { readonly cmd: 'getSelection'; readonly id: number }

export type ThreadMessage =
  | { readonly id: number; readonly ok: true; readonly value?: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string }
  | { readonly event: 'ready' | 'modified' | 'saveRequested' }
  | { readonly event: 'selection'; readonly selection: SelectionReport }
