import { jest } from '@jest/globals'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { fakeFetcher } from '../helpers/fake-fetcher.js'

const httpsGet =
  jest.fn<(url: string, cb: (res: unknown) => void) => EventEmitter>()
jest.unstable_mockModule('node:https', () => ({
  get: httpsGet,
  default: { get: httpsGet }
}))
const core = { warning: jest.fn() }
jest.unstable_mockModule('@actions/core', () => core)

const download = await import('../../src/tarball/download.js')

describe('downloadAndExtract', () => {
  it('streams the body into tar with the right arguments', async () => {
    const { fetcher, received, calls } = fakeFetcher({})
    await download.downloadAndExtract('https://x/y.tar.gz', 'C:\\dest', fetcher)
    expect(calls.url).toBe('https://x/y.tar.gz')
    expect(calls.args).toEqual(['-xzf', '-', '-C', 'C:\\dest'])
    expect(Buffer.concat(received).toString()).toBe('tar-bytes')
  })

  it('fails when tar fails', async () => {
    const { fetcher } = fakeFetcher({ tarExit: 'fail' })
    await expect(
      download.downloadAndExtract('https://x/y.tar.gz', 'C:\\dest', fetcher)
    ).rejects.toThrow(/tar exited with code 1/)
  })

  it('fails when the download breaks halfway', async () => {
    const body = new Readable({
      read(): void {
        this.destroy(new Error('connection reset'))
      }
    })
    const { fetcher } = fakeFetcher({ body })
    await expect(
      download.downloadAndExtract('https://x/y.tar.gz', 'C:\\dest', fetcher)
    ).rejects.toThrow(/connection reset/)
  })
})

describe('downloadAndExtract with an archive copy', () => {
  let dir: string
  let archive: string
  // Several chunks, so the copy has to keep them in order.
  const chunks = Array.from({ length: 64 }, (_, i) =>
    Buffer.alloc(16 * 1024, i)
  )
  const whole = Buffer.concat(chunks)

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-rocm-test-'))
    archive = path.join(dir, 'cache', 'rocm.tar.gz')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('writes the same bytes to tar and to the archive', async () => {
    const { fetcher, received } = fakeFetcher({ body: Readable.from(chunks) })
    await expect(
      download.downloadAndExtract(
        'https://x/y.tar.gz',
        '/dest',
        fetcher,
        archive
      )
    ).resolves.toBe(true)
    expect(Buffer.concat(received).equals(whole)).toBe(true)
    expect(fs.readFileSync(archive).equals(whole)).toBe(true)
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('replaces an archive left by an earlier run', async () => {
    fs.mkdirSync(path.dirname(archive), { recursive: true })
    fs.writeFileSync(archive, 'stale bytes from an earlier, longer download')
    const { fetcher } = fakeFetcher({})
    await download.downloadAndExtract(
      'https://x/y.tar.gz',
      '/d',
      fetcher,
      archive
    )
    expect(fs.readFileSync(archive, 'utf8')).toBe('tar-bytes')
  })

  it('returns false and writes nothing without an archive path', async () => {
    const { fetcher } = fakeFetcher({})
    await expect(
      download.downloadAndExtract('https://x/y.tar.gz', '/dest', fetcher)
    ).resolves.toBe(false)
    expect(fs.existsSync(archive)).toBe(false)
  })

  it('removes the partial archive when the download breaks', async () => {
    let sent = false
    const body = new Readable({
      read(): void {
        if (sent) {
          this.destroy(new Error('connection reset'))
          return
        }
        sent = true
        this.push(Buffer.from('half a tarball'))
      }
    })
    const { fetcher } = fakeFetcher({ body })
    await expect(
      download.downloadAndExtract('https://x/y.tar.gz', '/d', fetcher, archive)
    ).rejects.toThrow(/connection reset/)
    expect(fs.existsSync(archive)).toBe(false)
  })

  it('removes the archive when tar fails', async () => {
    const { fetcher } = fakeFetcher({ tarExit: 'fail' })
    await expect(
      download.downloadAndExtract('https://x/y.tar.gz', '/d', fetcher, archive)
    ).rejects.toThrow(/tar exited with code 1/)
    expect(fs.existsSync(archive)).toBe(false)
  })

  it('still extracts, with a warning, when the archive cannot be written', async () => {
    // A directory where the file should go: opening it fails with EISDIR.
    fs.mkdirSync(archive, { recursive: true })
    const { fetcher, received } = fakeFetcher({ body: Readable.from(chunks) })
    await expect(
      download.downloadAndExtract('https://x/y.tar.gz', '/d', fetcher, archive)
    ).resolves.toBe(false)
    expect(Buffer.concat(received).equals(whole)).toBe(true)
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Could not keep a copy of the download')
    )
  })
})

describe('extractFile', () => {
  it('streams the file on disk into tar', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-rocm-test-'))
    try {
      const archive = path.join(dir, 'rocm.tar.gz')
      fs.writeFileSync(archive, 'cached-tar-bytes')
      const { fetcher, received, calls } = fakeFetcher({})
      await download.extractFile(archive, '/dest', fetcher)
      expect(calls.args).toEqual(['-xzf', '-', '-C', '/dest'])
      expect(Buffer.concat(received).toString()).toBe('cached-tar-bytes')
      expect(fetcher.get).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails when the file is missing', async () => {
    const { fetcher } = fakeFetcher({})
    await expect(
      download.extractFile('/nonexistent/rocm.tar.gz', '/dest', fetcher)
    ).rejects.toThrow(/ENOENT/)
  })
})

function fakeResponse(status: number, location?: string): Readable {
  const res = Readable.from([]) as Readable & {
    statusCode: number
    headers: Record<string, string>
    setTimeout: jest.Mock
  }
  res.statusCode = status
  res.headers = location ? { location } : {}
  res.setTimeout = jest.fn()
  return res
}

function respondWith(...responses: Readable[]): void {
  httpsGet.mockReset()
  for (const res of responses) {
    httpsGet.mockImplementationOnce((_url, cb) => {
      queueMicrotask(() => cb(res))
      return new EventEmitter()
    })
  }
}

describe('httpGet', () => {
  it('resolves with the response on 200', async () => {
    const ok = fakeResponse(200)
    respondWith(ok)
    await expect(download.httpGet('https://x/a')).resolves.toBe(ok)
  })

  it('fails with the status code on 404', async () => {
    respondWith(fakeResponse(404))
    await expect(download.httpGet('https://x/a')).rejects.toThrow(/HTTP 404/)
  })

  it('follows a relative redirect', async () => {
    const ok = fakeResponse(200)
    respondWith(fakeResponse(302, '/b/file.tar.gz'), ok)
    await expect(download.httpGet('https://x/a')).resolves.toBe(ok)
    expect(httpsGet.mock.calls[1]?.[0]).toBe('https://x/b/file.tar.gz')
  })

  it('gives up after too many redirects', async () => {
    respondWith(
      fakeResponse(302, '/1'),
      fakeResponse(302, '/2'),
      fakeResponse(302, '/3'),
      fakeResponse(302, '/4')
    )
    await expect(download.httpGet('https://x/a')).rejects.toThrow(
      /Too many redirects/
    )
  })

  it('rejects on a connection error', async () => {
    httpsGet.mockReset()
    httpsGet.mockImplementationOnce(() => {
      const req = new EventEmitter()
      queueMicrotask(() => req.emit('error', new Error('ENOTFOUND')))
      return req
    })
    await expect(download.httpGet('https://x/a')).rejects.toThrow(/ENOTFOUND/)
  })
})
