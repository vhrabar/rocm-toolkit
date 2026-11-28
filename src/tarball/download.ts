import * as core from '@actions/core'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as https from 'node:https'
import type { IncomingMessage } from 'node:http'
import * as path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'

export const TARBALL_BASE = 'https://stable.repo.amd.com/rocm/core/tarball'
export const MARKER_FILE = '.setup-rocm'

export interface Fetcher {
  get(url: string): Promise<Readable>
  spawnTar(args: string[]): { stdin: Writable; done: Promise<void> }
}

export function httpGet(url: string, redirects = 3): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        if (redirects === 0) {
          reject(new Error(`Too many redirects downloading ${url}`))
          return
        }
        resolve(
          httpGet(new URL(res.headers.location, url).toString(), redirects - 1)
        )
        return
      }
      if (status !== 200) {
        res.resume()
        reject(new Error(`Download failed: HTTP ${status} for ${url}`))
        return
      }
      res.setTimeout(120_000, () =>
        res.destroy(new Error(`Download stalled: no data for 120 s (${url})`))
      )
      resolve(res)
    })
    request.on('error', reject)
  })
}

/** Start `tar` at an absolute path with its stdin open for the archive. */
export function spawnTar(
  tar: string,
  args: string[]
): { stdin: Writable; done: Promise<void> } {
  const child = spawn(tar, args, { stdio: ['pipe', 'inherit', 'inherit'] })
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}`))
    )
  })
  return { stdin: child.stdin, done }
}

interface ArchiveCopy {
  /** Pipeline stage: writes each chunk to the file and passes it on. */
  tee(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer>
  /** Close the file; true if it holds the whole download. */
  finish(): Promise<boolean>
  /** Drop the file after the download or tar failed. */
  discard(): void
}

/**
 * A copy of the download written to `file` as it passes through. Writing
 * the copy is only for the cache, so a write error is a warning: the
 * download still goes on into tar, and the partial file is removed.
 */
function copyToFile(file: string): ArchiveCopy {
  let error: unknown
  let out: fs.WriteStream | undefined
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.rmSync(file, { force: true })
    out = fs.createWriteStream(file)
    out.on('error', (e) => (error ??= e))
  } catch (e) {
    error = e
  }

  const remove = (): void => {
    out?.destroy()
    try {
      fs.rmSync(file, { force: true })
    } catch {
      // Best effort; nothing restores a file that was never saved.
    }
  }

  return {
    async *tee(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
      for await (const chunk of source) {
        if (out && error === undefined && !out.write(chunk)) {
          // Rejects on 'error'; the listener above has recorded it.
          await once(out, 'drain').catch(() => {})
        }
        yield chunk
      }
    },

    async finish(): Promise<boolean> {
      if (out && error === undefined) {
        out.end()
        await finished(out).catch((e: unknown) => (error ??= e))
      }
      if (error === undefined) return true
      const reason = error instanceof Error ? error.message : String(error)
      core.warning(
        `Could not keep a copy of the download for the cache: ${reason}`
      )
      remove()
      return false
    },

    discard: remove
  }
}

/**
 * Stream the download straight into tar. With `archive`, also write a copy
 * of the download there, for the cache. Returns true if `archive` now holds
 * the whole download.
 */
export async function downloadAndExtract(
  url: string,
  dest: string,
  fetcher: Fetcher,
  archive?: string
): Promise<boolean> {
  const body = await fetcher.get(url)
  const tar = fetcher.spawnTar(['-xzf', '-', '-C', dest])
  if (!archive) {
    await Promise.all([pipeline(body, tar.stdin), tar.done])
    return false
  }

  const copy = copyToFile(archive)
  try {
    await Promise.all([pipeline(body, copy.tee, tar.stdin), tar.done])
  } catch (error) {
    copy.discard()
    throw error
  }
  return copy.finish()
}

/** Extract a tarball already on disk, e.g. one restored from the cache. */
export async function extractFile(
  archive: string,
  dest: string,
  fetcher: Fetcher
): Promise<void> {
  const tar = fetcher.spawnTar(['-xzf', '-', '-C', dest])
  await Promise.all([
    pipeline(fs.createReadStream(archive), tar.stdin),
    tar.done
  ])
}
