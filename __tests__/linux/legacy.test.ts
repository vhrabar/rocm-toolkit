import { jest } from '@jest/globals'

const core = {
  startGroup: jest.fn(),
  endGroup: jest.fn(),
  info: jest.fn(),
  warning: jest.fn()
}
const execMock = {
  exec: jest.fn<(cmd: string, args?: string[]) => Promise<number>>(),
  getExecOutput:
    jest.fn<
      (
        cmd: string,
        args?: string[],
        opts?: unknown
      ) => Promise<{ exitCode: number; stdout: string }>
    >()
}
const tc = {
  downloadTool: jest.fn<(url: string, dest?: string) => Promise<string>>()
}
const fsMock = {
  readFileSync: jest.fn<(p: string, enc: string) => string>(),
  existsSync: jest.fn<(p: string) => boolean>(),
  rmSync: jest.fn<(p: string, opts?: unknown) => void>()
}
jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('@actions/exec', () => execMock)
// Hosted-runner path: not root, sudo available.
jest.unstable_mockModule('@actions/io', () => ({
  which: jest.fn(async () => '/usr/bin/sudo')
}))
jest.spyOn(process, 'getuid').mockReturnValue(1001)
jest.unstable_mockModule('@actions/tool-cache', () => tc)
jest.unstable_mockModule('node:fs', () => ({ ...fsMock, default: fsMock }))

const legacy = await import('../../src/linux/legacy.js')

const LISTING = `<html><body>
<a href="https://rocm.docs.amd.com/en/latest/">docs</a>
<a href="../">../</a>
<a href="amdgpu-install_7.2.4.70204-1_all.deb">amdgpu-install_7.2.4.70204-1_all.deb</a>
</body></html>`

describe('installerDir', () => {
  it.each([
    ['7.2.0', '7.2'],
    ['7.2.4', '7.2.4'],
    ['7.0.1', '7.0.1'],
    ['6.2.2', '6.2.2'],
    ['6.2.0', '6.2']
  ])('%s -> %s', (version, dir) => {
    expect(legacy.installerDir(version)).toBe(dir)
  })
})

describe('legacyPrefix', () => {
  it('uses the full version', () => {
    expect(legacy.legacyPrefix('7.2.4')).toBe('/opt/rocm-7.2.4')
    expect(legacy.legacyPrefix('7.2.0')).toBe('/opt/rocm-7.2.0')
  })
})

describe('codenameFor', () => {
  it('maps supported Ubuntu releases', () => {
    expect(legacy.codenameFor('ubuntu2204')).toBe('jammy')
    expect(legacy.codenameFor('ubuntu2404')).toBe('noble')
  })

  it.each(['ubuntu2604', 'debian12', ''])('rejects %j', (distro) => {
    expect(() => legacy.codenameFor(distro)).toThrow(/22.04 and 24.04 only/)
  })
})

describe('listingUrl', () => {
  it('builds the directory URL', () => {
    expect(legacy.listingUrl('7.2.4', 'noble')).toBe(
      'https://repo.radeon.com/amdgpu-install/7.2.4/ubuntu/noble/'
    )
    expect(legacy.listingUrl('7.2.0', 'jammy')).toBe(
      'https://repo.radeon.com/amdgpu-install/7.2/ubuntu/jammy/'
    )
  })
})

describe('findInstallerDeb', () => {
  it('reads the file name from a listing', () => {
    expect(legacy.findInstallerDeb(LISTING)).toBe(
      'amdgpu-install_7.2.4.70204-1_all.deb'
    )
  })

  it.each([
    ['6.2.60202-1', 'amdgpu-install_6.2.60202-1_all.deb'],
    ['7.0.1.70001-1', 'amdgpu-install_7.0.1.70001-1_all.deb'],
    ['7.2.70200-1', 'amdgpu-install_7.2.70200-1_all.deb']
  ])('handles the %s naming style', (_style, name) => {
    expect(legacy.findInstallerDeb(`<a href="${name}">x</a>`)).toBe(name)
  })

  it('fails when the listing has no installer', () => {
    expect(() => legacy.findInstallerDeb('<html></html>')).toThrow(
      /Could not find an amdgpu-install package/
    )
  })
})

describe('legacyPackages', () => {
  it('maps components and always adds libxml2', () => {
    expect(legacy.legacyPackages(['dev'])).toEqual([
      'rocm-hip-runtime-dev',
      'libxml2'
    ])
    expect(legacy.legacyPackages(['runtime', 'sdk', 'opencl'])).toEqual([
      'rocm-hip-runtime',
      'rocm-hip-sdk',
      'rocm-opencl',
      'libxml2'
    ])
  })
})

describe('installLegacy', () => {
  const inputs = {
    version: '7.2.4',
    gfx: [] as string[],
    components: ['dev' as const],
    useCache: true,
    logFileSuffix: 'log.txt'
  }

  let caCertsInstalled: boolean

  beforeEach(() => {
    caCertsInstalled = true
    execMock.getExecOutput.mockImplementation(async () =>
      caCertsInstalled
        ? { exitCode: 0, stdout: 'install ok installed' }
        : { exitCode: 1, stdout: '' }
    )
    process.env['RUNNER_TEMP'] = '/tmp'
    tc.downloadTool.mockImplementation(async (url, dest) =>
      url.endsWith('.deb') ? (dest as string) : '/tmp/listing.html'
    )
    fsMock.readFileSync.mockReturnValue(LISTING)
    execMock.exec.mockResolvedValue(0)
    fsMock.existsSync.mockReturnValue(true)
  })

  it('installs the repo package, then the ROCm packages', async () => {
    const result = await legacy.installLegacy(inputs, 'ubuntu2404')
    expect(result).toEqual({ root: '/opt/rocm-7.2.4', cacheHit: false })
    const debPath = '/tmp/amdgpu-install_7.2.4.70204-1_all.deb'
    expect(tc.downloadTool).toHaveBeenCalledWith(
      'https://repo.radeon.com/amdgpu-install/7.2.4/ubuntu/noble/' +
        'amdgpu-install_7.2.4.70204-1_all.deb',
      debPath
    )
    const calls = execMock.exec.mock.calls.map(([c, a]) => [c, ...(a ?? [])])
    const apt = ['sudo', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get']
    expect(calls).toEqual([
      [...apt, 'install', '-y', debPath],
      [...apt, 'update'],
      [
        ...apt,
        'install',
        '-y',
        '--no-install-recommends',
        'rocm-hip-runtime-dev',
        'libxml2'
      ]
    ])
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('installs ca-certificates first when it is missing', async () => {
    caCertsInstalled = false
    await legacy.installLegacy(inputs, 'ubuntu2404')
    expect(execMock.getExecOutput).toHaveBeenCalledWith(
      'dpkg-query',
      ['-W', '-f=${Status}', 'ca-certificates'],
      expect.anything()
    )
    const calls = execMock.exec.mock.calls.map(([c, a]) => [c, ...(a ?? [])])
    const apt = ['sudo', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get']
    expect(calls.slice(0, 3)).toEqual([
      [...apt, 'update'],
      [...apt, 'install', '-y', '--no-install-recommends', 'ca-certificates'],
      [...apt, 'install', '-y', '/tmp/amdgpu-install_7.2.4.70204-1_all.deb']
    ])
  })

  it('removes a .deb left by an earlier run before downloading it', async () => {
    await legacy.installLegacy(inputs, 'ubuntu2404')
    const debPath = '/tmp/amdgpu-install_7.2.4.70204-1_all.deb'
    expect(fsMock.rmSync).toHaveBeenCalledWith(debPath, { force: true })
    const debDownload = tc.downloadTool.mock.calls.findIndex(([url]) =>
      url.endsWith('.deb')
    )
    expect(fsMock.rmSync.mock.invocationCallOrder[0]).toBeLessThan(
      tc.downloadTool.mock.invocationCallOrder[debDownload] ?? 0
    )
  })

  it('warns that gfx is ignored', async () => {
    await legacy.installLegacy({ ...inputs, gfx: ['gfx1200'] }, 'ubuntu2404')
    expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/gfx/))
  })

  it('rejects an unsupported distro before any download', async () => {
    await expect(legacy.installLegacy(inputs, 'debian12')).rejects.toThrow(
      /22.04 and 24.04 only/
    )
    expect(tc.downloadTool).not.toHaveBeenCalled()
  })

  it('fails when hipcc is missing after install', async () => {
    fsMock.existsSync.mockReturnValue(false)
    await expect(legacy.installLegacy(inputs, 'ubuntu2404')).rejects.toThrow(
      /bin\/hipcc does not exist/
    )
  })
})
