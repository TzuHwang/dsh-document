/**
 * Host-side bytes write behind the save route (`WRITE_ROUTE` in protocol.ts).
 *
 * DSH 0.2's `FileSystem` writes only text (`writeText`), so bytes are written
 * with Node's fs, guarded like a `replaceIfVersion` text write: the version is
 * checked through DSH's fs right before an atomic replace (a fresh sibling
 * renamed over the target), and the new version is read back through DSH's fs,
 * so it matches what the workspace watcher reports. The local backend's version
 * includes the inode, so every replace yields a new version.
 *
 * Unlike `writeText`, the check and the replace are two steps: a write landing
 * between them is overwritten. The window is the time one rename takes.
 */
import { randomBytes } from 'node:crypto'
import { rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** The part of DSH's host `FileSystem` this needs; `target` is an `FsTarget`. */
export interface BytesFs<Target> {
  stat(target: Target): Promise<{ readonly version: string; readonly type: string } | undefined>
  processPath(target: Target): string
}

/** The file changed since the version the editor read. */
export class StaleVersionError extends Error {
  override readonly name = 'StaleVersionError'
}

/** Windows refuses a rename over a file another process holds open; such holds are usually brief. */
const RENAME_RETRIES = 10
const RENAME_RETRY_MS = 100

/**
 * Replace `target` with `data`. With `expectedVersion`, refuse with
 * {@link StaleVersionError} unless the file is still at that version.
 * @returns the file's version after the write.
 */
export async function replaceBytes<Target>(fs: BytesFs<Target>, target: Target, data: Uint8Array, expectedVersion: string | undefined): Promise<string> {
  if (expectedVersion !== undefined) {
    const current = await fs.stat(target)
    if (current === undefined || current.version !== expectedVersion) throw new StaleVersionError('the file changed since it was read')
  }
  const path = fs.processPath(target)
  // Keep the file's permission bits; a new file gets the default.
  const mode = await stat(path).then(info => info.mode & 0o7777, () => undefined)
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString('hex')}.dsh-editor-tmp`)
  await writeFile(temp, data, { flag: 'wx', ...mode === undefined ? {} : { mode } })
  try {
    await renameWithRetry(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
  const written = await fs.stat(target)
  if (written === undefined) throw new Error('the written file disappeared')
  return written.version
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (attempt >= RENAME_RETRIES || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error
      await new Promise(resolve => setTimeout(resolve, RENAME_RETRY_MS))
    }
  }
}
