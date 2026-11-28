import { jest } from '@jest/globals'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { fakeFetcher } from './helpers/fake-fetcher.js'

const core = {
  startGroup: jest.fn(),
  endGroup: jest.fn(),
  info: jest.fn(),
  warning: jest.fn()
}
const fsMock = {
  existsSync: jest.fn<(p: string) => boolean>(),
  readFileSync: jest.fn<(p: string, enc: string) => string>(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  rmSync: jest.fn()
}
const spawnMock = jest.fn()
jest.unstable_mockModule('node:child_process', () => ({
  spawn: spawnMock,
  default: { spawn: spawnMock }
}))
jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('node:fs', () => ({ ...fsMock, default: fsMock }))

const windows = await import('../src/windows.js')

const PREFIX = 'C:\\rocm\\core-10.1'
const HIPCC = `${PREFIX}\\bin\\hipcc.exe`
const MARKER = `${PREFIX}\\.setup-rocm`

describe('windowsFamily', () => {
  it.each([
    [['gfx1200'], 'gfx120X-all'],
    [['gfx1201'], 'gfx120X-all'],
    [['gfx1200', 'gfx1201'], 'gfx120X-all'],
    [['gfx1100'], 'gfx110X-all'],
    [['gfx1031'], 'gfx103X-all'],
    [['gfx1010'], 'gfx101X-dgpu'],
    [['gfx1151'], 'gfx1151'],
    [['gfx90a'], 'gfx90a'],
    [['gfx908'], 'gfx908']
  ])('%j -> %s', (gfx, family) => {
    expect(windows.windowsFamily(gfx)).toBe(family)
  })

  it('uses multiarch for "all" (no targets)', () => {
    expect(windows.windowsFamily([])).toBe('multiarch')
  })

  it('uses multiarch when the targets span families', () => {
    expect(windows.windowsFamily(['gfx1100', 'gfx1200'])).toBe('multiarch')
  })

  it.each(['gfx942', 'gfx950', 'gfx1250', 'gfx9999'])(
    'rejects %s, which has no Windows build',
    (target) => {
      expect(() => windows.windowsFamily([target])).toThrow(/no Windows build/)
    }
  )
})

describe('tarballUrl / windowsPrefix', () => {
  it('builds the URL from version and family', () => {
    expect(windows.tarballUrl('10.1.0', 'gfx120X-all')).toBe(
      'https://stable.repo.amd.com/rocm/core/tarball/' +
        'therock-dist-windows-gfx120X-all-10.1.0.tar.gz'
    )
  })

  it('uses MAJOR.MINOR in the install directory', () => {
    expect(windows.windowsPrefix('10.1.0')).toBe(PREFIX)
    expect(windows.windowsPrefix('10.0.0', 'D:')).toBe('D:\\rocm\\core-10.0')
  })
})

describe('installWindows', () => {
  const inputs = {
    version: '10.1.0',
    gfx: ['gfx1200'],
    components: ['dev' as const],
    useCache: true,
    logFileSuffix: 'log.txt'
  }

  beforeEach(() => {
    process.env['SystemDrive'] = 'C:'
    fsMock.existsSync.mockReset()
    fsMock.readFileSync.mockReset()
  })

  it('downloads, extracts and writes a marker on a fresh runner', async () => {
    // Nothing exists until the extraction "creates" hipcc.exe.
    let extracted = false
    fsMock.existsSync.mockImplementation((p) => extracted && p === HIPCC)
    const { fetcher, calls } = fakeFetcher({})
    fetcher.spawnTar.mockImplementationOnce((args: string[]) => {
      calls.args = args
      extracted = true
      const stdin = new PassThrough()
      stdin.resume()
      return { stdin, done: new Promise<void>((r) => stdin.on('end', r)) }
    })
    const result = await windows.installWindows(inputs, fetcher)
    expect(result).toEqual({ root: PREFIX, cacheHit: false })
    expect(calls.url).toBe(
      'https://stable.repo.amd.com/rocm/core/tarball/' +
        'therock-dist-windows-gfx120X-all-10.1.0.tar.gz'
    )
    expect(fsMock.mkdirSync).toHaveBeenCalledWith(PREFIX, { recursive: true })
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(
      MARKER,
      'gfx120X-all 10.1.0\n'
    )
    expect(fsMock.rmSync).not.toHaveBeenCalled()
  })

  it('does nothing when the same family and version are installed', async () => {
    fsMock.existsSync.mockReturnValue(true)
    fsMock.readFileSync.mockReturnValue('gfx120X-all 10.1.0\n')
    const { fetcher } = fakeFetcher({})
    expect((await windows.installWindows(inputs, fetcher)).root).toBe(PREFIX)
    expect(fetcher.get).not.toHaveBeenCalled()
    expect(fsMock.rmSync).not.toHaveBeenCalled()
  })

  it('replaces an install of a different family', async () => {
    fsMock.existsSync.mockReturnValue(true)
    fsMock.readFileSync.mockReturnValue('gfx110X-all 10.1.0\n')
    const { fetcher } = fakeFetcher({})
    fetcher.spawnTar.mockImplementationOnce(() => {
      const stdin = new PassThrough()
      stdin.resume()
      return { stdin, done: new Promise<void>((r) => stdin.on('end', r)) }
    })
    await windows.installWindows(inputs, fetcher)
    expect(fsMock.rmSync).toHaveBeenCalledWith(PREFIX, {
      recursive: true,
      force: true
    })
    expect(fetcher.get).toHaveBeenCalledTimes(1)
  })

  it('fails when hipcc.exe is missing after extraction', async () => {
    fsMock.existsSync.mockReturnValue(false)
    const { fetcher } = fakeFetcher({})
    await expect(windows.installWindows(inputs, fetcher)).rejects.toThrow(
      /hipcc\.exe does not exist/
    )
    expect(fsMock.writeFileSync).not.toHaveBeenCalled()
  })

  it('rejects an unsupported GPU target before touching the disk', async () => {
    const { fetcher } = fakeFetcher({})
    await expect(
      windows.installWindows({ ...inputs, gfx: ['gfx942'] }, fetcher)
    ).rejects.toThrow(/no Windows build/)
    expect(fsMock.mkdirSync).not.toHaveBeenCalled()
    expect(fetcher.get).not.toHaveBeenCalled()
  })

  it('warns that components has no effect', async () => {
    fsMock.existsSync.mockReturnValue(true)
    fsMock.readFileSync.mockReturnValue('gfx120X-all 10.1.0\n')
    const { fetcher } = fakeFetcher({})
    await windows.installWindows(
      { ...inputs, components: ['sdk' as const] },
      fetcher
    )
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringMatching(/components/)
    )
  })
})

describe('defaultFetcher.spawnTar', () => {
  function fakeChild(): EventEmitter & { stdin: PassThrough } {
    return Object.assign(new EventEmitter(), { stdin: new PassThrough() })
  }

  it('runs the Windows system tar, not whatever is first on PATH', () => {
    process.env['SystemRoot'] = 'C:\\Windows'
    const child = fakeChild()
    spawnMock.mockReturnValueOnce(child)
    windows.defaultFetcher.spawnTar(['-xzf', '-', '-C', 'C:\\dest'])
    expect(spawnMock).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\tar.exe',
      ['-xzf', '-', '-C', 'C:\\dest'],
      expect.objectContaining({ stdio: ['pipe', 'inherit', 'inherit'] })
    )
  })

  it('resolves when tar exits 0 and rejects otherwise', async () => {
    const ok = fakeChild()
    spawnMock.mockReturnValueOnce(ok)
    const first = windows.defaultFetcher.spawnTar([])
    ok.emit('close', 0)
    await expect(first.done).resolves.toBeUndefined()

    const bad = fakeChild()
    spawnMock.mockReturnValueOnce(bad)
    const second = windows.defaultFetcher.spawnTar([])
    bad.emit('close', 2)
    await expect(second.done).rejects.toThrow(/tar exited with code 2/)
  })

  it('rejects when tar cannot be started', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValueOnce(child)
    const run = windows.defaultFetcher.spawnTar([])
    child.emit('error', new Error('ENOENT'))
    await expect(run.done).rejects.toThrow(/ENOENT/)
  })
})
