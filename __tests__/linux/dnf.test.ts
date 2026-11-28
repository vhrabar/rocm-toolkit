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
// Container path: root, no sudo.
jest.unstable_mockModule('@actions/io', () => ({
  which: jest.fn(async () => '')
}))
jest.spyOn(process, 'getuid').mockReturnValue(0)
jest.unstable_mockModule('@actions/tool-cache', () => tc)
jest.unstable_mockModule('node:fs', () => ({ ...fsMock, default: fsMock }))

const { buildRepoFile, dnf, ensureRpmPackages } =
  await import('../../src/linux/dnf.js')
const { isRpmInstalled, missingRpms } = await import('../../src/linux/rpm.js')
const { installMultiArch } = await import('../../src/linux/index.js')
const { KEY_FINGERPRINT } = await import('../../src/linux/key.js')

const GOOD_KEY = `fpr:::::::::${KEY_FINGERPRINT}:\n`
const DNF_INSTALL = ['dnf', '-y', 'install', '--setopt=install_weak_deps=False']
const HOST = ['gcc-c++']

/** RPMs `rpm -q` reports as not installed. */
let notInstalled: string[]

beforeEach(() => {
  notInstalled = []
  process.env['RUNNER_TEMP'] = '/tmp'
  tc.downloadTool.mockResolvedValue('/tmp/key.gpg')
  execMock.exec.mockResolvedValue(0)
  execMock.getExecOutput.mockImplementation(async (cmd, args = []) => {
    if (cmd === 'gpg') return { exitCode: 0, stdout: GOOD_KEY }
    const pkg = args[args.length - 1] ?? ''
    return { exitCode: notInstalled.includes(pkg) ? 1 : 0, stdout: '' }
  })
  fsMock.existsSync.mockReturnValue(true)
})

const calls = (): string[][] =>
  execMock.exec.mock.calls.map(([cmd, args]) => [cmd, ...(args ?? [])])

describe('buildRepoFile', () => {
  it('points at the x86_64 directory with both signature checks on', () => {
    expect(buildRepoFile('rhel9')).toBe(
      [
        '[amdrocm]',
        'name=AMD ROCm',
        'baseurl=https://stable.repo.amd.com/rocm/core/packages/rhel9/x86_64/',
        'enabled=1',
        'gpgcheck=1',
        'repo_gpgcheck=1',
        'gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-amdrocm',
        ''
      ].join('\n')
    )
  })
})

describe('rpm helpers / ensureRpmPackages', () => {
  it('asks rpm without root', async () => {
    notInstalled = ['gnupg2']
    await expect(isRpmInstalled('gnupg2')).resolves.toBe(false)
    await expect(isRpmInstalled('ca-certificates')).resolves.toBe(true)
    expect(execMock.getExecOutput).toHaveBeenCalledWith(
      'rpm',
      ['-q', '--quiet', 'gnupg2'],
      expect.objectContaining({ ignoreReturnCode: true })
    )
  })

  it('lists the missing packages in order', async () => {
    notInstalled = ['gnupg2', 'gcc-c++']
    await expect(
      missingRpms(['gcc-c++', 'ca-certificates', 'gnupg2'])
    ).resolves.toEqual(['gcc-c++', 'gnupg2'])
  })

  it('makes no dnf call when everything is installed', async () => {
    await ensureRpmPackages(['ca-certificates', 'gnupg2'])
    expect(execMock.exec).not.toHaveBeenCalled()
  })

  it('installs only the missing packages', async () => {
    notInstalled = ['gnupg2']
    await ensureRpmPackages(['ca-certificates', 'gnupg2'])
    expect(calls()).toEqual([[...DNF_INSTALL, 'gnupg2']])
  })
})

describe('dnf.addRepo / dnf.install', () => {
  it('imports the checked key and writes the repo file', async () => {
    await dnf.addRepo('rhel8', '/tmp/key.gpg')
    expect(calls()).toEqual([
      [
        'install',
        '-D',
        '-m',
        '0644',
        '/tmp/key.gpg',
        '/etc/pki/rpm-gpg/RPM-GPG-KEY-amdrocm'
      ],
      ['rpm', '--import', '/etc/pki/rpm-gpg/RPM-GPG-KEY-amdrocm'],
      [
        'install',
        '-m',
        '0644',
        '/tmp/amdrocm.repo',
        '/etc/yum.repos.d/amdrocm.repo'
      ]
    ])
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(
      '/tmp/amdrocm.repo',
      buildRepoFile('rhel8')
    )
  })

  it('verifies the metadata, then installs ROCm and the host compiler bits', async () => {
    await dnf.install(['amdrocm-core-devel10.1-gfx1200'])
    expect(calls()).toEqual([
      ['dnf', '-y', 'makecache', '--repo', 'amdrocm'],
      [...DNF_INSTALL, 'amdrocm-core-devel10.1-gfx1200', ...HOST]
    ])
  })

  it('passes -y to every dnf call', async () => {
    notInstalled = ['gnupg2']
    await dnf.ensurePrereqs()
    await dnf.install(['x'])
    for (const call of calls().filter(([cmd]) => cmd === 'dnf'))
      expect(call[1]).toBe('-y')
  })
})

describe('installMultiArch with dnf', () => {
  const inputs = {
    version: '10.1.0',
    gfx: ['gfx1200'],
    components: ['dev' as const],
    useCache: true,
    logFileSuffix: 'log.txt'
  }

  it('runs the whole flow as root, with RPM package names', async () => {
    notInstalled = ['gnupg2'] // as on almalinux:10
    const result = await installMultiArch(inputs, 'rhel10', dnf)
    expect(result).toEqual({ root: '/opt/rocm/core-10.1', cacheHit: false })
    expect(calls()).toEqual([
      [...DNF_INSTALL, 'gnupg2'],
      [
        'install',
        '-D',
        '-m',
        '0644',
        '/tmp/key.gpg',
        '/etc/pki/rpm-gpg/RPM-GPG-KEY-amdrocm'
      ],
      ['rpm', '--import', '/etc/pki/rpm-gpg/RPM-GPG-KEY-amdrocm'],
      [
        'install',
        '-m',
        '0644',
        '/tmp/amdrocm.repo',
        '/etc/yum.repos.d/amdrocm.repo'
      ],
      ['dnf', '-y', 'makecache', '--repo', 'amdrocm'],
      [...DNF_INSTALL, 'amdrocm-core-devel10.1-gfx1200', ...HOST]
    ])
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(
      '/tmp/amdrocm.repo',
      expect.stringContaining('/rhel10/x86_64/')
    )
  })

  it('checks the key only after gnupg2 is installed', async () => {
    notInstalled = ['gnupg2']
    await installMultiArch(inputs, 'rhel10', dnf)
    const gnupgInstall = execMock.exec.mock.invocationCallOrder[0] ?? 0
    const keyCheck = execMock.getExecOutput.mock.calls.findIndex(
      ([cmd]) => cmd === 'gpg'
    )
    expect(
      execMock.getExecOutput.mock.invocationCallOrder[keyCheck]
    ).toBeGreaterThan(gnupgInstall)
  })

  it('refuses a key with the wrong fingerprint before touching rpm', async () => {
    execMock.getExecOutput.mockImplementation(async (cmd) =>
      cmd === 'gpg'
        ? { exitCode: 0, stdout: 'fpr:::::::::AAAA:\n' }
        : { exitCode: 0, stdout: '' }
    )
    await expect(installMultiArch(inputs, 'rhel9', dnf)).rejects.toThrow(
      /does not match the expected fingerprint/
    )
    expect(calls().flat()).not.toContain('rpm')
  })
})
