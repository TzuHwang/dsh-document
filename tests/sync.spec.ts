import { describe, expect, it } from 'vitest'
import { FileSync, type DiskBytes, type FileIO, type Scheduler, type WriteResult } from '../src/sync.ts'

/** Manual timers: `fire()` runs the pending debounce. */
class ManualScheduler implements Scheduler {
  pending: (() => void) | undefined
  set(callback: () => void): unknown {
    this.pending = callback
    return callback
  }
  clear(handle: unknown): void {
    if (this.pending === handle) this.pending = undefined
  }
  fire(): void {
    const callback = this.pending
    this.pending = undefined
    callback?.()
  }
}

/** An in-memory file with version guarding, standing in for the host. */
class FakeDisk implements FileIO {
  version = 0
  writes: { bytes: number[]; expected: string | undefined }[] = []

  constructor(public bytes: Uint8Array | undefined) {}

  externalWrite(bytes: Uint8Array): string {
    this.bytes = bytes
    this.version++
    return String(this.version)
  }

  async read(): Promise<DiskBytes | undefined> {
    return this.bytes === undefined ? undefined : { bytes: this.bytes, version: String(this.version) }
  }

  async write(bytes: Uint8Array, expected: string | undefined): Promise<WriteResult> {
    this.writes.push({ bytes: [...bytes], expected })
    if (expected !== undefined && expected !== String(this.version)) return { kind: 'stale' }
    this.bytes = bytes
    this.version++
    return { kind: 'ok', version: String(this.version) }
  }
}

/** A document whose editor holds `engine.bytes`; `pulls` counts serializations. */
async function openBinary(initial: Uint8Array | undefined) {
  const disk = new FakeDisk(initial)
  const scheduler = new ManualScheduler()
  const doc = new FileSync(disk, { scheduler })
  const engine = { bytes: initial ?? new Uint8Array(0), pulls: 0 }
  const externals: number[][] = []
  doc.subscribe({ external: bytes => { externals.push([...bytes]) } })
  await doc.load()
  const detach = doc.setSource(async () => { engine.pulls++; return engine.bytes })
  /** The user edits in the engine. */
  const change = (bytes: number[]): void => { engine.bytes = new Uint8Array(bytes); doc.touch() }
  return { disk, scheduler, doc, engine, externals, change, detach }
}

const bytes = (...values: number[]) => new Uint8Array(values)

describe('FileSync', () => {
  it('loads the bytes and pulls them from the engine only when saving', async () => {
    const { disk, scheduler, doc, engine, change } = await openBinary(bytes(0, 255))
    expect([...doc.getBytes()]).toEqual([0, 255])
    change([0, 255, 1])
    expect(doc.status.kind).toBe('dirty')
    expect(engine.pulls).toBe(0)
    scheduler.fire()
    await doc.flush()
    expect(engine.pulls).toBe(1)
    expect(disk.writes).toEqual([{ bytes: [0, 255, 1], expected: '0' }])
    expect(doc.status.kind).toBe('clean')
  })

  it('does not write when the pulled bytes equal the disk (the user undid the change)', async () => {
    const { disk, doc, change } = await openBinary(bytes(1, 2))
    change([1, 2])
    await doc.flush()
    expect(disk.writes).toHaveLength(0)
    expect(doc.status.kind).toBe('clean')
  })

  it('keeps a change unsaved while no engine is attached to pull from', async () => {
    const { disk, doc, change, detach } = await openBinary(bytes(1))
    detach()
    change([2])
    await doc.flush()
    expect(disk.writes).toHaveLength(0)
    expect(doc.status.kind).toBe('dirty')
  })

  it('reloads the engine with disk bytes when clean, and ignores its own write echoing back', async () => {
    const { disk, doc, externals, change } = await openBinary(bytes(1))
    change([1, 2])
    await doc.flush()
    await doc.externalChange(String(disk.version))
    await doc.externalChange('touched')
    expect(externals).toEqual([])
    await doc.externalChange(disk.externalWrite(bytes(9, 9)))
    expect(externals).toEqual([[9, 9]])
    expect([...doc.getBytes()]).toEqual([9, 9])
    expect(doc.status.kind).toBe('clean')
  })

  it('enters conflict when disk changes before a pending change was pulled; keeping mine pulls and overwrites', async () => {
    const { disk, doc, engine, change } = await openBinary(bytes(1))
    change([1, 7])
    const version = disk.externalWrite(bytes(5))
    await doc.externalChange(version)
    expect(doc.status).toEqual({ kind: 'conflict', disk: bytes(5) })
    expect(engine.pulls).toBe(0)
    await doc.resolveConflict('mine')
    expect(disk.writes.at(-1)).toEqual({ bytes: [1, 7], expected: version })
    expect(doc.status.kind).toBe('clean')
  })

  it('resolves a conflict with the disk bytes without writing', async () => {
    const { disk, doc, externals, change } = await openBinary(bytes(1))
    change([2])
    await doc.externalChange(disk.externalWrite(bytes(3)))
    await doc.resolveConflict('disk')
    expect(externals).toEqual([[3]])
    expect(disk.writes).toHaveLength(0)
    expect(doc.status.kind).toBe('clean')
    // The engine was reloaded, so nothing is pending.
    await doc.flush()
    expect(disk.writes).toHaveLength(0)
  })

  it('keeps a change pending when the engine fails to hand over its bytes, so a retry pulls again', async () => {
    const { disk, doc, engine, change, detach } = await openBinary(bytes(1))
    detach()
    let fail = true
    doc.setSource(async () => {
      engine.pulls++
      if (fail) throw new Error('the editor did not hand over its content in time')
      return engine.bytes
    })
    change([1, 2])
    await doc.flush()
    expect(doc.status).toEqual({ kind: 'error', message: 'the editor did not hand over its content in time' })
    expect(disk.writes).toHaveLength(0)
    fail = false
    await doc.flush()
    expect(engine.pulls).toBe(2)
    expect(disk.writes).toEqual([{ bytes: [1, 2], expected: '0' }])
    expect(doc.status.kind).toBe('clean')
  })

  it('saves again when the engine changes while its bytes are being written', async () => {
    const { disk, scheduler, doc, engine, change } = await openBinary(bytes(1))
    const write = disk.write.bind(disk)
    let changed = false
    disk.write = async (content, expected) => {
      if (!changed) { changed = true; change([1, 2, 3]) }
      return write(content, expected)
    }
    change([1, 2])
    await doc.flush()
    expect(doc.status.kind).toBe('dirty')
    scheduler.fire()
    await doc.flush()
    expect(disk.writes.map(w => w.bytes)).toEqual([[1, 2], [1, 2, 3]])
    expect(engine.pulls).toBe(2)
    expect(doc.status.kind).toBe('clean')
  })
})
