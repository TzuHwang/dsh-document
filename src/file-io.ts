/**
 * A document's file, as the engine reaches it from DSH's page: reads and the
 * change feed through DSH's `workspaceFiles` Remote, writes through this
 * plugin's save route.
 */
import { WRITE_ROUTE, writeQuery } from './protocol.ts'
import type { FileIO, WriteResult } from './sync.ts'

/** One frame of `workspaceFiles.changes`. */
type WatchFrame =
  | { readonly kind: 'ready' }
  | { readonly kind: 'change'; readonly change: { readonly version: string } | { readonly absent: true } }

/** DSH's `ctx.remote.workspaceFiles`, Client face: the part used here. Calls resolve to results, never throw. */
export interface WorkspaceFiles {
  readBytes(sessionId: string, path: string, options: object): Promise<
    | { readonly ok: true; readonly value: { readonly data: Uint8Array; readonly version: string } }
    | { readonly ok: false; readonly error: { readonly code: string } }
  >
  changes(sessionId: string, path: string, signal?: AbortSignal): AsyncIterable<WatchFrame>
}

export interface FileAddress {
  readonly sessionId: string
  readonly path: string
}

export function fileIO(files: WorkspaceFiles, file: FileAddress): FileIO {
  return {
    async read() {
      const result = await files.readBytes(file.sessionId, file.path, {})
      if (!result.ok) {
        if (result.error.code === 'workspace-file/not-found') return undefined
        throw new Error(result.error.code)
      }
      // A copy: the remote's array may view a larger buffer.
      return { bytes: result.value.data.slice(), version: result.value.version }
    },
    async write(bytes, expectedVersion): Promise<WriteResult> {
      let response: Response
      try {
        response = await fetch(`${WRITE_ROUTE.slice(1)}?${writeQuery({ ...file, version: expectedVersion })}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: bytes as Uint8Array<ArrayBuffer>,
        })
      } catch (error) {
        return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
      }
      const body = await response.json().catch(() => ({})) as { version?: string; error?: string }
      if (response.status === 200 && typeof body.version === 'string') return { kind: 'ok', version: body.version }
      if (response.status === 409) return { kind: 'stale' }
      return { kind: 'error', message: body.error ?? `HTTP ${response.status}` }
    },
  }
}

/** A version no file has: forces a content comparison after the watcher reconnects. */
export const RESYNC = '\0resync'

/**
 * Follow the file's change feed until `signal` aborts, reconnecting after
 * failures. `onChange` receives the new version, `undefined` when the file
 * disappeared, or {@link RESYNC} after a reconnect (compare by content).
 */
export function watchFile(files: WorkspaceFiles, file: FileAddress, onChange: (version: string | undefined) => void, signal: AbortSignal): void {
  void (async () => {
    let attempt = 0
    while (!signal.aborted) {
      try {
        for await (const frame of files.changes(file.sessionId, file.path, signal)) {
          if (frame.kind === 'ready') {
            // Anything that changed while we were not watching.
            if (attempt > 0) onChange(RESYNC)
            attempt = 0
            continue
          }
          onChange('version' in frame.change ? frame.change.version : undefined)
        }
      } catch {
        // Stream failed (reconnect, host restart): retry below.
      }
      if (signal.aborted) return
      attempt++
      await new Promise(resolve => setTimeout(resolve, Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5))))
    }
  })()
}
