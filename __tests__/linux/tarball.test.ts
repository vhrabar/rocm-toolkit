import { jest } from '@jest/globals'
import { EventEmitter } from 'node:events'

const core = { warning: jest.fn(), info: jest.fn() }
const which = jest.fn<(tool: string, check?: boolean) => Promise<string>>()
const installTarball =
  jest.fn<(target: unknown, fetcher: unknown) => Promise<void>>()
const spawnMock = jest.fn()
jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('@actions/io', () => ({ which }))
jest.unstable_mockModule('../../src/tarball/install.js', () => ({
  installTarball
}))
jest.unstable_mockModule('node:child_process', () => ({
  spawn: spawnMock,
  default: { spawn: spawnMock }
}))

const tarball = await import('../../src/linux/tarball.js')

const inputs = {
  version: '10.1.0',
  gfx: ['gfx1200'],
  components: ['dev' as const],
  useCache: true,
  logFileSuffix: 'log.txt'
}

describe('linuxFamily', () => {
  it.each([
    [['gfx1200'], 'gfx120X-all'],
    [['gfx1100', 'gfx1101'], 'gfx110X-all'],
    [['gfx90a'], 'gfx90a'],
    [['gfx942'], 'gfx94X-dcgpu'],
    [['gfx950'], 'gfx950-dcgpu'],
    [['gfx1250'], 'gfx125X-dcgpu'],
    [[], 'multiarch'],
    [['gfx1200', 'gfx942'], 'multiarch']
  ])('%j -> %s', (gfx, family) => {
    expect(tarball.linuxFamily(gfx)).toBe(family)
  })

  it('rejects a target without a Linux build', () => {
    expect(() => tarball.linuxFamily(['gfx803'])).toThrow(
      /no Linux build for GPU target "gfx803"\. Supported targets: .*gfx942/
    )
  })
})

describe('linuxTarballUrl', () => {
  it('uses the linux tarball name', () => {
    expect(tarball.linuxTarballUrl('10.1.0', 'gfx120X-all')).toBe(
      'https://stable.repo.amd.com/rocm/core/tarball/therock-dist-linux-gfx120X-all-10.1.0.tar.gz'
    )
  })
})

describe('tarballPrefix', () => {
  it('uses the package-flow prefix as root', () => {
    expect(tarball.tarballPrefix('10.1.0', true, '/opt/hostedtoolcache')).toBe(
      '/opt/rocm/core-10.1'
    )
  })

  it('uses the tool cache without root', () => {
    expect(tarball.tarballPrefix('10.1.0', false, '/opt/hostedtoolcache')).toBe(
      '/opt/hostedtoolcache/rocm/core-10.1'
    )
  })

  it('fails clearly without root and without a tool cache', () => {
    expect(() => tarball.tarballPrefix('10.1.0', false, undefined)).toThrow(
      /without root needs RUNNER_TOOL_CACHE/
    )
  })
})

describe('hostToolWarnings', () => {
  it('is quiet when c++ and python3 are on PATH', async () => {
    which.mockImplementation(async (tool) => `/usr/bin/${tool}`)
    await expect(tarball.hostToolWarnings()).resolves.toEqual([])
  })

  it('names what is missing', async () => {
    which.mockResolvedValue('')
    const warnings = await tarball.hostToolWarnings()
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toMatch(
      /No C\+\+ compiler.*gcc-c\+\+ on Fedora, gcc on Arch/
    )
    expect(warnings[1]).toMatch(/python3 not found/)
  })
})

describe('installLinuxTarball', () => {
  const getuid = jest.spyOn(process, 'getuid')

  beforeEach(() => {
    which.mockImplementation(async (tool) => `/usr/bin/${tool}`)
    installTarball.mockResolvedValue()
    process.env['RUNNER_TOOL_CACHE'] = '/opt/hostedtoolcache'
  })

  afterAll(() => {
    getuid.mockRestore()
  })

  it('installs into /opt/rocm/core-X.Y as root', async () => {
    getuid.mockReturnValue(0)
    await expect(tarball.installLinuxTarball(inputs)).resolves.toEqual({
      root: '/opt/rocm/core-10.1',
      cacheHit: false
    })
    expect(installTarball).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://stable.repo.amd.com/rocm/core/tarball/therock-dist-linux-gfx120X-all-10.1.0.tar.gz',
        prefix: '/opt/rocm/core-10.1',
        hipcc: '/opt/rocm/core-10.1/bin/hipcc',
        stamp: 'gfx120X-all 10.1.0'
      }),
      tarball.linuxFetcher
    )
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('installs into the tool cache without root', async () => {
    getuid.mockReturnValue(1001)
    await expect(tarball.installLinuxTarball(inputs)).resolves.toEqual({
      root: '/opt/hostedtoolcache/rocm/core-10.1',
      cacheHit: false
    })
  })

  it('warns about ignored components and missing host tools, then installs', async () => {
    getuid.mockReturnValue(0)
    which.mockResolvedValue('')
    await tarball.installLinuxTarball({
      ...inputs,
      components: ['runtime', 'dev']
    })
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringMatching(/"components" has no effect with the tarball/)
    )
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringMatching(/No C\+\+ compiler/)
    )
    expect(installTarball).toHaveBeenCalled()
  })

  it('rejects an unsupported GPU target before downloading', async () => {
    await expect(
      tarball.installLinuxTarball({ ...inputs, gfx: ['gfx803'] })
    ).rejects.toThrow(/no Linux build/)
    expect(installTarball).not.toHaveBeenCalled()
  })
})

describe('linuxFetcher.spawnTar', () => {
  it('runs /usr/bin/tar, not whatever is first on PATH', () => {
    const child = Object.assign(new EventEmitter(), { stdin: {} })
    spawnMock.mockReturnValue(child)
    tarball.linuxFetcher.spawnTar(['-xzf', '-', '-C', '/x'])
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/tar',
      ['-xzf', '-', '-C', '/x'],
      expect.anything()
    )
  })
})
