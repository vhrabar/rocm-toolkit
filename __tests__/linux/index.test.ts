import { jest } from '@jest/globals'

const core = { startGroup: jest.fn(), endGroup: jest.fn(), info: jest.fn() }
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
const tc = { downloadTool: jest.fn<(url: string) => Promise<string>>() }
const fsMock = {
  writeFileSync: jest.fn(),
  existsSync: jest.fn<(p: string) => boolean>()
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

const { installMultiArch } = await import('../../src/linux/index.js')
const { apt, buildSources, isInstalled } =
  await import('../../src/linux/apt.js')
const { KEY_FINGERPRINT, parseFingerprints } =
  await import('../../src/linux/key.js')
const { packageNames } = await import('../../src/linux/packages.js')
const { installPrefix, majorMinor } = await import('../../src/linux/prefix.js')

const GOOD_KEY = `pub:-:4096:1:0701EAC4D5E02107:::::scESC:::::::
fpr:::::::::${KEY_FINGERPRINT}:
sub:-:4096:1:FA296B056C5BB456::::::s:::::::
fpr:::::::::C367239A86C9B62AF49C921EFA296B056C5BB456:
`

describe('installPrefix / majorMinor', () => {
  it('uses MAJOR.MINOR only', () => {
    expect(majorMinor('10.1.0')).toBe('10.1')
    expect(installPrefix('10.1.0')).toBe('/opt/rocm/core-10.1')
    expect(installPrefix('10.2.0')).toBe('/opt/rocm/core-10.2')
    expect(installPrefix('10.0.0')).toBe('/opt/rocm/core-10.0')
  })
})

describe('buildSources', () => {
  it('writes a deb822 stanza for the distro', () => {
    expect(buildSources('ubuntu2404')).toBe(
      [
        'Types: deb',
        'URIs: https://stable.repo.amd.com/rocm/core/packages/ubuntu2404',
        'Suites: stable',
        'Components: main',
        'Architectures: amd64',
        'Signed-By: /etc/apt/keyrings/amdrocm.gpg',
        ''
      ].join('\n')
    )
  })
})

describe('isInstalled', () => {
  it.each([
    [0, 'install ok installed', true],
    [0, 'deinstall ok config-files', false],
    [1, '', false]
  ])('exit %i, status %j -> %s', async (exitCode, stdout, expected) => {
    execMock.getExecOutput.mockResolvedValueOnce({ exitCode, stdout })
    await expect(isInstalled('gpg')).resolves.toBe(expected)
  })
})

describe('packageNames', () => {
  it('builds per-gfx names for dev', () => {
    expect(packageNames('10.1.0', ['gfx1200'], ['dev'], 'apt')).toEqual([
      'amdrocm-core-dev10.1-gfx1200'
    ])
  })

  it('expands components x gfx', () => {
    expect(
      packageNames('10.1.0', ['gfx1200', 'gfx90a'], ['runtime', 'sdk'], 'apt')
    ).toEqual([
      'amdrocm10.1-gfx1200',
      'amdrocm10.1-gfx90a',
      'amdrocm-core-sdk10.1-gfx1200',
      'amdrocm-core-sdk10.1-gfx90a'
    ])
  })

  it('uses version-only names for all architectures', () => {
    expect(packageNames('10.1.0', [], ['dev'], 'apt')).toEqual([
      'amdrocm-core-dev10.1'
    ])
  })

  it('adds arch-independent extras once', () => {
    expect(
      packageNames(
        '10.1.0',
        ['gfx1200', 'gfx1201'],
        ['developer-tools', 'opencl'],
        'apt'
      )
    ).toEqual(['amdrocm-developer-tools10.1', 'amdrocm-opencl10.1'])
  })

  it('follows the same pattern for 10.2', () => {
    expect(packageNames('10.2.0', ['gfx1200'], ['dev'], 'apt')).toEqual([
      'amdrocm-core-dev10.2-gfx1200'
    ])
    expect(packageNames('10.2.0', ['gfx1200'], ['dev'], 'dnf')).toEqual([
      'amdrocm-core-devel10.2-gfx1200'
    ])
  })

  // Names as listed under rocm/core/packages/{rhel9,sles16}/x86_64/.
  it.each(['dnf' as const, 'zypper' as const])(
    'uses RPM names (-devel) for %s',
    (kind) => {
      expect(
        packageNames(
          '10.1.0',
          ['gfx1200'],
          ['runtime', 'dev', 'sdk', 'developer-tools', 'opencl'],
          kind
        )
      ).toEqual([
        'amdrocm10.1-gfx1200',
        'amdrocm-core-devel10.1-gfx1200',
        'amdrocm-core-sdk10.1-gfx1200',
        'amdrocm-developer-tools10.1',
        'amdrocm-opencl10.1'
      ])
      expect(packageNames('10.1.0', [], ['dev'], kind)).toEqual([
        'amdrocm-core-devel10.1'
      ])
    }
  )
})

describe('parseFingerprints', () => {
  it('reads every fpr record', () => {
    expect(parseFingerprints(GOOD_KEY)).toEqual([
      KEY_FINGERPRINT,
      'C367239A86C9B62AF49C921EFA296B056C5BB456'
    ])
  })
})

describe('installMultiArch', () => {
  const inputs = {
    version: '10.1.0',
    gfx: ['gfx1200'],
    components: ['dev' as const],
    useCache: true,
    logFileSuffix: 'log.txt'
  }

  /** Packages dpkg-query reports as not installed. */
  let notInstalled: string[]
  let keyListing: string

  beforeEach(() => {
    notInstalled = []
    keyListing = GOOD_KEY
    tc.downloadTool.mockResolvedValue('/tmp/key.gpg')
    execMock.getExecOutput.mockImplementation(async (cmd, args = []) => {
      if (cmd !== 'dpkg-query') return { exitCode: 0, stdout: keyListing }
      const pkg = args[args.length - 1] ?? ''
      return notInstalled.includes(pkg)
        ? { exitCode: 1, stdout: '' }
        : { exitCode: 0, stdout: 'install ok installed' }
    })
    execMock.exec.mockResolvedValue(0)
    fsMock.existsSync.mockReturnValue(true)
  })

  it('configures apt, installs packages and returns the prefix', async () => {
    const result = await installMultiArch(inputs, 'ubuntu2404', apt)
    expect(result).toEqual({ root: '/opt/rocm/core-10.1', cacheHit: false })
    const calls = execMock.exec.mock.calls.map(([cmd, args]) => [
      cmd,
      ...(args ?? [])
    ])
    expect(calls).toContainEqual([
      'sudo',
      'gpg',
      '--batch',
      '--yes',
      '--dearmor',
      '-o',
      '/etc/apt/keyrings/amdrocm.gpg',
      '/tmp/key.gpg'
    ])
    expect(calls).toContainEqual([
      'sudo',
      'env',
      'DEBIAN_FRONTEND=noninteractive',
      'apt-get',
      'install',
      '-y',
      '--no-install-recommends',
      'amdrocm-core-dev10.1-gfx1200'
    ])
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('amdrocm.sources'),
      expect.stringContaining('ubuntu2404')
    )
  })

  it('makes no prerequisite apt calls when everything is installed', async () => {
    await installMultiArch(inputs, 'ubuntu2404', apt)
    const calls = execMock.exec.mock.calls.map(([cmd, args]) => [
      cmd,
      ...(args ?? [])
    ])
    expect(calls.filter((c) => c.includes('update'))).toHaveLength(1)
    expect(calls.flat()).not.toContain('ca-certificates')
  })

  it('installs only the missing prerequisites before checking the key', async () => {
    notInstalled = ['gpg']
    await installMultiArch(inputs, 'ubuntu2404', apt)
    const aptGet = ['sudo', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get']
    const calls = execMock.exec.mock.calls.map(([cmd, args]) => [
      cmd,
      ...(args ?? [])
    ])
    expect(calls.slice(0, 2)).toEqual([
      [...aptGet, 'update'],
      [...aptGet, 'install', '-y', '--no-install-recommends', 'gpg']
    ])
    const prereqInstall = execMock.exec.mock.invocationCallOrder[1] ?? 0
    const keyCheck = execMock.getExecOutput.mock.calls.findIndex(
      ([cmd]) => cmd === 'gpg'
    )
    expect(
      execMock.getExecOutput.mock.invocationCallOrder[keyCheck]
    ).toBeGreaterThan(prereqInstall)
  })

  it('refuses a key with an unexpected fingerprint', async () => {
    keyListing = 'fpr:::::::::AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:\n'
    await expect(installMultiArch(inputs, 'ubuntu2404', apt)).rejects.toThrow(
      /does not match the expected fingerprint/
    )
    expect(execMock.exec).not.toHaveBeenCalled()
  })

  it('fails when hipcc is missing after install', async () => {
    fsMock.existsSync.mockReturnValue(false)
    await expect(installMultiArch(inputs, 'ubuntu2404', apt)).rejects.toThrow(
      /bin\/hipcc does not exist/
    )
  })

  it('stops on a failing apt command', async () => {
    execMock.exec.mockRejectedValueOnce(new Error('sudo failed'))
    await expect(installMultiArch(inputs, 'ubuntu2404', apt)).rejects.toThrow(
      /sudo failed/
    )
  })
})
