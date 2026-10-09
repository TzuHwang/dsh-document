import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StaleVersionError, replaceBytes, type BytesFs } from '../src/write-bytes.ts'
import { parseWriteQuery, writeQuery } from '../src/protocol.ts'

/** DSH's local backend versions a file by its stat identity; the target here is the path itself. */
const localFs: BytesFs<string> = {
  async stat(path) {
    try {
      const info = statSync(path, { bigint: true })
      return { version: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`, type: info.isFile() ? 'file' : 'other' }
    } catch {
      return undefined
    }
  },
  processPath: path => path,
}

const dirs: string[] = []
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-editor-bytes-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('replaceBytes', () => {
  it('replaces the file with exactly the bytes, guarded by the version, and returns a new version', async () => {
    const file = join(workspace(), 'doc.bin')
    writeFileSync(file, new Uint8Array([1, 2, 3]))
    const before = (await localFs.stat(file))!.version
    const after = await replaceBytes(localFs, file, new Uint8Array([0, 255, 0, 10, 13]), before)
    expect([...readFileSync(file)]).toEqual([0, 255, 0, 10, 13])
    expect(after).not.toBe(before)
    expect(after).toBe((await localFs.stat(file))!.version)
  })

  it('refuses a stale version and leaves the file alone', async () => {
    const file = join(workspace(), 'doc.bin')
    writeFileSync(file, new Uint8Array([1]))
    const read = (await localFs.stat(file))!.version
    await replaceBytes(localFs, file, new Uint8Array([2]), read) // someone else saved first
    await expect(replaceBytes(localFs, file, new Uint8Array([3]), read)).rejects.toBeInstanceOf(StaleVersionError)
    expect([...readFileSync(file)]).toEqual([2])
  })

  it('refuses a guarded write to a file deleted since it was read', async () => {
    const dir = workspace()
    const file = join(dir, 'doc.bin')
    writeFileSync(file, new Uint8Array([1]))
    const read = (await localFs.stat(file))!.version
    rmSync(file)
    await expect(replaceBytes(localFs, file, new Uint8Array([2]), read)).rejects.toBeInstanceOf(StaleVersionError)
    expect(readdirSync(dir)).toEqual([])
  })

  it('creates the file when written unconditionally, leaving no temporary sibling', async () => {
    const dir = workspace()
    const file = join(dir, 'new.bin')
    await replaceBytes(localFs, file, new Uint8Array([7]), undefined)
    expect([...readFileSync(file)]).toEqual([7])
    expect(readdirSync(dir)).toEqual(['new.bin'])
  })
})

describe('write query', () => {
  it('round-trips the target, including paths that need encoding', () => {
    const target = { sessionId: 's 1', path: 'docs/報告 & notes.odt', version: '1:2:3' }
    expect(parseWriteQuery(`?${writeQuery(target)}`)).toEqual(target)
    expect(parseWriteQuery(writeQuery({ sessionId: 's', path: 'a.odt' }))).toEqual({ sessionId: 's', path: 'a.odt' })
  })

  it('rejects a query without a session or path', () => {
    expect(parseWriteQuery('path=a.odt')).toBeUndefined()
    expect(parseWriteQuery('sessionId=s&path=')).toBeUndefined()
  })
})
