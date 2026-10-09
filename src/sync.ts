/**
 * One open document kept in sync with its file; disk is the single source of
 * truth. Ported from dsh-editor-template's text DocumentSync, for bytes pulled
 * from LibreOffice:
 *
 * - The engine reports that the document changed (`touch`); the bytes are
 *   exported (`setSource`) only when saving, because exporting a whole
 *   document is costly. Saves run after a debounce, or now with `flush()`
 *   (blur, Ctrl+S, closing).
 * - Every save is guarded by the version last read, so a concurrent AI write
 *   is never overwritten: the host answers `stale` and we reconcile.
 * - An external change is read and compared by content, so our own write
 *   echoing back through the watcher is a no-op.
 * - Changed on disk while clean → reloaded; while changes are pending →
 *   conflict, resolved by the user (`resolveConflict`).
 *
 * Saves and reconciles run one at a time through a queue.
 */

export interface DiskBytes {
  readonly bytes: Uint8Array
  readonly version: string
}

export type WriteResult =
  | { readonly kind: 'ok'; readonly version: string }
  | { readonly kind: 'stale' }
  | { readonly kind: 'error'; readonly message: string }

/** File access for one document; the engine wires it to DSH and the save route. */
export interface FileIO {
  /** Read the file; undefined when it does not exist. */
  read(): Promise<DiskBytes | undefined>
  /** Write the whole file; `expectedVersion` guards against a concurrent change, undefined writes unconditionally. */
  write(bytes: Uint8Array, expectedVersion: string | undefined): Promise<WriteResult>
}

export type SyncStatus =
  | { readonly kind: 'loading' }
  | { readonly kind: 'clean' }
  | { readonly kind: 'dirty' }
  | { readonly kind: 'saving' }
  /** Disk and editor diverged; `disk` is what is on disk now. */
  | { readonly kind: 'conflict'; readonly disk: Uint8Array }
  /** The file was deleted on disk; the next save recreates it. */
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly message: string }

export interface SyncListener {
  status?(status: SyncStatus): void
  /** The file changed on disk and the editor should show `bytes`. */
  external?(bytes: Uint8Array): void
}

/** Timer seam so tests drive the debounce. */
export interface Scheduler {
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realScheduler: Scheduler = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

const EMPTY = new Uint8Array(0)

export class FileSync {
  /** The editor's bytes as of the last export. */
  private content: Uint8Array = EMPTY
  /** What we believe is on disk. */
  private base: Uint8Array = EMPTY
  /** Version of `base`; undefined when the file is missing. */
  private version: string | undefined
  /** The editor changed since `content` was last exported. */
  private touched = false
  private source: (() => Promise<Uint8Array>) | undefined
  private current: SyncStatus = { kind: 'loading' }
  private timer: unknown
  private queue: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<SyncListener>()
  private readonly debounceMs: number
  private readonly scheduler: Scheduler
  private disposed = false

  constructor(private readonly io: FileIO, options: { debounceMs?: number; scheduler?: Scheduler } = {}) {
    this.debounceMs = options.debounceMs ?? 2000
    this.scheduler = options.scheduler ?? realScheduler
  }

  get status(): SyncStatus {
    return this.current
  }

  /** The bytes as of the last load or export. */
  getBytes(): Uint8Array {
    return this.content
  }

  subscribe(listener: SyncListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Read the file; resolves with its bytes (empty when missing). Rejects when it cannot be read. */
  async load(): Promise<Uint8Array> {
    const disk = await this.io.read()
    if (disk === undefined) {
      this.version = undefined
      this.setStatus({ kind: 'missing' })
      return this.content
    }
    this.content = this.base = disk.bytes
    this.version = disk.version
    this.setStatus({ kind: 'clean' })
    return disk.bytes
  }

  /** Where the bytes come from when saving (the editor's export); returns the function that detaches it. */
  setSource(source: () => Promise<Uint8Array>): () => void {
    this.source = source
    return () => {
      if (this.source === source) this.source = undefined
    }
  }

  /** The editor's document changed; it is exported when saving. */
  touch(): void {
    if (this.disposed) return
    this.touched = true
    // A conflict stays until the user resolves it; never autosave over disk.
    if (this.current.kind === 'conflict') return
    if (this.current.kind !== 'saving') this.setStatus({ kind: 'dirty' })
    this.schedule()
  }

  /** Save now if there is anything to save; resolves when all queued work settled. */
  flush(): Promise<void> {
    this.cancelTimer()
    this.enqueue(() => this.save())
    return this.queue
  }

  /** The watcher saw the file change (`version`) or disappear (`undefined`). */
  externalChange(version: string | undefined): Promise<void> {
    this.enqueue(async () => {
      if (version !== undefined && version === this.version) return
      await this.reconcile()
    })
    return this.queue
  }

  /** Settle a conflict: take what is on disk, or keep the editor's document and overwrite. */
  resolveConflict(choice: 'disk' | 'mine'): Promise<void> {
    const status = this.current
    if (status.kind !== 'conflict') return this.queue
    if (choice === 'disk') {
      this.content = this.base = status.disk
      this.touched = false
      this.emitExternal(this.content)
      this.setStatus({ kind: 'clean' })
      return this.queue
    }
    this.setStatus({ kind: 'dirty' })
    return this.flush()
  }

  dispose(): void {
    this.disposed = true
    this.cancelTimer()
    this.listeners.clear()
    this.source = undefined
  }

  /** The editor holds something disk does not. */
  private unsaved(): boolean {
    return this.touched || !sameBytes(this.content, this.base)
  }

  private schedule(): void {
    this.cancelTimer()
    this.timer = this.scheduler.set(() => {
      this.timer = undefined
      this.enqueue(() => this.save())
    }, this.debounceMs)
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.scheduler.clear(this.timer)
    this.timer = undefined
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(() => this.disposed ? undefined : task()).catch((error: unknown) => {
      this.setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    })
  }

  private async save(): Promise<void> {
    if (this.current.kind === 'conflict' || this.current.kind === 'loading') return
    if (this.touched) {
      // Nothing to export from (the editor is gone): writing the last export would lose the change.
      if (this.source === undefined) return
      // Cleared before the export: a change made while it runs marks the document again.
      this.touched = false
      try {
        this.content = await this.source()
      } catch (error) {
        // The change is still only in the editor: a retry must export again.
        this.touched = true
        throw error
      }
    }
    if (!this.unsaved()) {
      // Nothing to write. A deleted file stays deleted until the user edits it.
      if (this.current.kind !== 'clean' && this.current.kind !== 'missing') this.setStatus({ kind: 'clean' })
      return
    }
    const snapshot = this.content
    this.setStatus({ kind: 'saving' })
    const result = await this.io.write(snapshot, this.version)
    if (result.kind === 'ok') {
      this.base = snapshot
      this.version = result.version
      if (!this.unsaved()) {
        this.setStatus({ kind: 'clean' })
      } else {
        // Changed while the write was in flight.
        this.setStatus({ kind: 'dirty' })
        this.schedule()
      }
      return
    }
    if (result.kind === 'stale') {
      await this.reconcile()
      return
    }
    this.setStatus({ kind: 'error', message: result.message })
  }

  /** Compare disk with what we have and act; see the module comment. */
  private async reconcile(): Promise<void> {
    const disk = await this.io.read()
    if (disk === undefined) {
      this.version = undefined
      this.setStatus({ kind: 'missing' })
      return
    }
    this.version = disk.version
    const unsaved = this.unsaved()
    if (sameBytes(disk.bytes, this.base)) {
      // Only metadata moved (or our own write echoed back).
      if (unsaved && this.current.kind === 'saving') this.setStatus({ kind: 'dirty' })
      if (unsaved && this.current.kind === 'dirty') this.schedule()
      return
    }
    if (!this.touched && sameBytes(disk.bytes, this.content)) {
      // Disk caught up with the editor.
      this.base = disk.bytes
      this.setStatus({ kind: 'clean' })
      return
    }
    if (!unsaved) {
      this.content = this.base = disk.bytes
      this.emitExternal(this.content)
      this.setStatus({ kind: 'clean' })
      return
    }
    this.cancelTimer()
    this.setStatus({ kind: 'conflict', disk: disk.bytes })
  }

  private setStatus(status: SyncStatus): void {
    this.current = status
    for (const listener of this.listeners) listener.status?.(status)
  }

  private emitExternal(bytes: Uint8Array): void {
    for (const listener of this.listeners) listener.external?.(bytes)
  }
}
