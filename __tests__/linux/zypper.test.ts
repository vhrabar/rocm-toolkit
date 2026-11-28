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

const { buildRepoFile, zypper } = await import('../../src/linux/zypper.js')
const { installMultiArch } = await import('../../src/linux/index.js')
const { KEY_FINGERPRINT } = await import('../../src/linux/key.js')

const GOOD_KEY = `fpr:::::::::${KEY_FINGERPRINT}:\n`
const ZYPPER_INSTALL = [
  'zypper',
  '--non-interactive',
  'install',
  '--no-recommends'
]

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
  it('points at the x86_64 directory with every signature check on and no gpgkey', () => {
    expect(buildRepoFile('sles15')).toBe(
      [
        '[amdrocm]',
        'name=AMD ROCm',
        'enabled=1',
        'autorefresh=1',
        'baseurl=https://stable.repo.amd.com/rocm/core/packages/sles15/x86_64/',
        'type=rpm-md',
        'gpgcheck=1',
        'repo_gpgcheck=1',
        'pkg_gpgcheck=1',
        ''
      ].join('\n')
    )
  })
})

describe('zypper.ensurePrereqs', () => {
  it('makes no zypper call when everything is installed', async () => {
    await zypper.ensurePrereqs()
    expect(execMock.exec).not.toHaveBeenCalled()
  })

  it('installs only the missing packages', async () => {
    notInstalled = ['gpg2']
    await zypper.ensurePrereqs()
    expect(calls()).toEqual([[...ZYPPER_INSTALL, 'gpg2']])
  })
})

describe('zypper.addRepo / zypper.install', () => {
  it('imports the checked key and writes the repo file', async () => {
    await zypper.addRepo('sles16', '/tmp/key.gpg')
    expect(calls()).toEqual([
      ['rpm', '--import', '/tmp/key.gpg'],
      [
        'install',
        '-m',
        '0644',
        '/tmp/amdrocm.repo',
        '/etc/zypp/repos.d/amdrocm.repo'
      ]
    ])
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(
      '/tmp/amdrocm.repo',
      buildRepoFile('sles16')
    )
  })

  it('verifies the metadata, then installs ROCm and gcc-c++', async () => {
    await zypper.install(['amdrocm-core-devel10.1-gfx1200'])
    expect(calls()).toEqual([
      ['zypper', '--non-interactive', 'refresh', 'amdrocm'],
      [...ZYPPER_INSTALL, 'amdrocm-core-devel10.1-gfx1200', 'gcc-c++']
    ])
  })

  it('never auto-imports keys or prompts', async () => {
    notInstalled = ['gpg2']
    await zypper.ensurePrereqs()
    await zypper.addRepo('sles15', '/tmp/key.gpg')
    await zypper.install(['x'])
    const zypperCalls = calls().filter(([cmd]) => cmd === 'zypper')
    expect(zypperCalls).toHaveLength(3)
    for (const call of zypperCalls) {
      expect(call[1]).toBe('--non-interactive')
      expect(call).not.toContain('--gpg-auto-import-keys')
    }
  })
})

describe('installMultiArch with zypper', () => {
  const inputs = {
    version: '10.1.0',
    gfx: ['gfx1200'],
    components: ['dev' as const],
    useCache: true,
    logFileSuffix: 'log.txt'
  }

  it('runs the whole flow as root, with RPM package names', async () => {
    const result = await installMultiArch(inputs, 'sles15', zypper)
    expect(result).toEqual({ root: '/opt/rocm/core-10.1', cacheHit: false })
    expect(calls()).toEqual([
      ['rpm', '--import', '/tmp/key.gpg'],
      [
        'install',
        '-m',
        '0644',
        '/tmp/amdrocm.repo',
        '/etc/zypp/repos.d/amdrocm.repo'
      ],
      ['zypper', '--non-interactive', 'refresh', 'amdrocm'],
      [...ZYPPER_INSTALL, 'amdrocm-core-devel10.1-gfx1200', 'gcc-c++']
    ])
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(
      '/tmp/amdrocm.repo',
      expect.stringContaining('/sles15/x86_64/')
    )
  })

  it('refuses a key with the wrong fingerprint before touching rpm', async () => {
    execMock.getExecOutput.mockImplementation(async (cmd) =>
      cmd === 'gpg'
        ? { exitCode: 0, stdout: 'fpr:::::::::AAAA:\n' }
        : { exitCode: 0, stdout: '' }
    )
    await expect(installMultiArch(inputs, 'sles15', zypper)).rejects.toThrow(
      /does not match the expected fingerprint/
    )
    expect(calls().flat()).not.toContain('rpm')
  })
})
