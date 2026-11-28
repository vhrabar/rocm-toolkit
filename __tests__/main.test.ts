import { jest } from '@jest/globals'
import type { InstallResult } from '../src/cache.js'
import type { Platform } from '../src/platform.js'

const core = {
  getInput: jest.fn<(name: string) => string>(),
  info: jest.fn(),
  warning: jest.fn(),
  setFailed: jest.fn(),
  exportVariable: jest.fn(),
  addPath: jest.fn(),
  setOutput: jest.fn()
}
jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('../src/windows.js', () => ({
  installWindows: jest.fn()
}))
jest.unstable_mockModule('../src/linux/legacy.js', () => ({
  installLegacy: jest.fn()
}))
const installMultiArch =
  jest.fn<(...args: unknown[]) => Promise<InstallResult>>()
jest.unstable_mockModule('../src/linux/index.js', () => ({ installMultiArch }))
const installLinuxTarball =
  jest.fn<(...args: unknown[]) => Promise<InstallResult>>()
jest.unstable_mockModule('../src/linux/tarball.js', () => ({
  installLinuxTarball
}))
const failureMessage = jest.fn(
  (error: unknown, plan?: unknown) =>
    `${(error as Error).message}${plan ? ' [with context]' : ''}`
)
jest.unstable_mockModule('../src/context.js', () => ({ failureMessage }))
const detectPlatform = jest.fn()
jest.unstable_mockModule('../src/platform.js', () => ({ detectPlatform }))

const { makePlan, run } = await import('../src/main.js')

const raw = {
  version: '10.1.0',
  gfx: 'gfx1200',
  components: 'dev',
  useCache: 'true',
  logFileSuffix: 'log.txt'
}
const linux = {
  os: 'linux' as const,
  arch: 'x64',
  distro: 'ubuntu2404',
  packageManager: 'apt' as const
}

describe('makePlan', () => {
  it('selects multiarch for 10.x', () => {
    expect(makePlan(raw, () => linux).scheme).toBe('multiarch')
  })

  it('selects legacy for 7.0.1', () => {
    expect(makePlan({ ...raw, version: '7.0.1' }, () => linux).scheme).toBe(
      'legacy'
    )
  })

  it('fails fast on a bad version before doing anything', () => {
    expect(() =>
      makePlan({ ...raw, version: '10.1.0; id' }, () => linux)
    ).toThrow(/Invalid ROCm version/)
  })

  it('does not detect the platform when inputs are invalid', () => {
    const detect = jest.fn<() => typeof linux>()
    expect(() => makePlan({ ...raw, gfx: 'nope' }, detect)).toThrow(
      /Invalid gfx/
    )
    expect(detect).not.toHaveBeenCalled()
  })
})

describe('run', () => {
  beforeEach(() => {
    detectPlatform.mockReturnValue(linux)
  })

  it.each([
    ['rhel9', 'dnf' as const],
    ['sles15', 'zypper' as const]
  ])('installs on %s through %s', async (distro, packageManager) => {
    core.getInput.mockImplementation(
      (name) => (raw as Record<string, string>)[name] ?? ''
    )
    detectPlatform.mockReturnValue({ ...linux, distro, packageManager })
    installMultiArch.mockRejectedValueOnce(new Error('stop here'))
    await run()
    expect(installMultiArch).toHaveBeenLastCalledWith(
      expect.objectContaining({ version: '10.1.0' }),
      distro,
      expect.objectContaining({ kind: packageManager })
    )
  })

  it('falls back to the tarball with a warning when there is no AMD repo', async () => {
    core.getInput.mockImplementation(
      (name) => (raw as Record<string, string>)[name] ?? ''
    )
    const reason = 'Unsupported distribution "fedora 43". Supported: ...'
    detectPlatform.mockReturnValue({
      os: 'linux',
      arch: 'x64',
      distro: '',
      noPackageRepo: reason
    })
    installLinuxTarball.mockRejectedValueOnce(new Error('stop here'))
    await run()
    expect(core.warning).toHaveBeenCalledWith(
      `${reason} Installing the ROCm tarball instead.`
    )
    expect(installLinuxTarball).toHaveBeenCalledWith(
      expect.objectContaining({ version: '10.1.0' })
    )
    expect(installMultiArch).not.toHaveBeenCalledWith(
      expect.anything(),
      '',
      expect.anything()
    )
  })

  it.each([true, false])(
    'exports the result and cache-hit=%s after an install',
    async (cacheHit) => {
      core.getInput.mockImplementation(
        (name) => (raw as Record<string, string>)[name] ?? ''
      )
      detectPlatform.mockReturnValue(linux)
      installMultiArch.mockResolvedValueOnce({
        root: '/opt/rocm/core-10.1',
        cacheHit
      })
      await run()
      expect(core.setFailed).not.toHaveBeenCalled()
      expect(core.setOutput).toHaveBeenCalledWith(
        'ROCM_PATH',
        '/opt/rocm/core-10.1'
      )
      expect(core.setOutput).toHaveBeenCalledWith('cache-hit', String(cacheHit))
    }
  )

  it('adds the install context when an install fails', async () => {
    core.getInput.mockImplementation(
      (name) => (raw as Record<string, string>)[name] ?? ''
    )
    installMultiArch.mockRejectedValueOnce(new Error('apt-get failed'))
    await run()
    expect(failureMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'apt-get failed' }),
      expect.objectContaining({ platform: linux, scheme: 'multiarch' })
    )
    expect(core.setFailed).toHaveBeenCalledWith('apt-get failed [with context]')
  })

  it('reports invalid input through setFailed', async () => {
    core.getInput.mockImplementation((name) =>
      name === 'version' ? 'nonsense' : ''
    )
    await run()
    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringMatching(/Invalid ROCm version|Unsupported/)
    )
  })
})

describe('makePlan on a non-x86_64 runner', () => {
  it.each(['arm64', 'arm', 'ppc64', 's390x'])(
    'rejects Linux on %s, naming x86_64',
    (arch) => {
      expect(() => makePlan(raw, () => ({ ...linux, arch }))).toThrow(
        new RegExp(
          `x86_64 only, and this runner is ${arch}\\..*ubuntu-24\\.04-arm`
        )
      )
    }
  )

  it('rejects arm64 before falling back to the tarball', () => {
    expect(() =>
      makePlan(raw, () => ({
        os: 'linux',
        arch: 'arm64',
        distro: '',
        noPackageRepo: 'Unsupported distribution "fedora 43".'
      }))
    ).toThrow(/x86_64 only/)
  })

  it('still reports a bad input first', () => {
    expect(() =>
      makePlan({ ...raw, version: 'nonsense' }, () => ({
        ...linux,
        arch: 'arm64'
      }))
    ).toThrow(/Invalid ROCm version/)
  })

  it('leaves Windows alone', () => {
    expect(
      makePlan(raw, () => ({ os: 'windows', arch: 'arm64', distro: '' }))
        .platform.os
    ).toBe('windows')
  })
})

describe('makePlan per package manager', () => {
  const on =
    (distro: string, packageManager: 'apt' | 'dnf' | 'zypper') =>
    (): Platform => ({ os: 'linux', arch: 'x64', distro, packageManager })

  it('accepts ROCm 10.x on a dnf distro', () => {
    const plan = makePlan(raw, on('rhel9', 'dnf'))
    expect(plan.scheme).toBe('multiarch')
    expect(plan.platform.packageManager).toBe('dnf')
  })

  it('accepts ROCm 10.x on a zypper distro', () => {
    const plan = makePlan(raw, on('sles15', 'zypper'))
    expect(plan.scheme).toBe('multiarch')
    expect(plan.platform.packageManager).toBe('zypper')
  })

  it('rejects legacy versions on a zypper distro before doing anything', () => {
    expect(() =>
      makePlan({ ...raw, version: '7.2.4' }, on('sles16', 'zypper'))
    ).toThrow(
      /ROCm 7\.2\.4 is not available on sles16\..*use ROCm 10\.0\.0 or newer/
    )
  })

  it('rejects a Linux platform without a package manager', () => {
    expect(() =>
      makePlan(raw, () => ({ os: 'linux', arch: 'x64', distro: 'x' }))
    ).toThrow(
      /which uses an unknown package manager\..*apt .*, dnf .* and zypper .* only\./
    )
  })

  it('rejects legacy versions on a dnf distro before doing anything', () => {
    expect(() =>
      makePlan({ ...raw, version: '7.2.4' }, on('rhel8', 'dnf'))
    ).toThrow(
      /ROCm 7\.2\.4 is not available on rhel8\..*use ROCm 10\.0\.0 or newer/
    )
  })

  it('accepts ROCm 10.x on a distro without an AMD repo', () => {
    const plan = makePlan(raw, () => ({
      os: 'linux',
      arch: 'x64',
      distro: '',
      noPackageRepo: 'Unsupported distribution "arch".'
    }))
    expect(plan.scheme).toBe('multiarch')
  })

  it('rejects legacy versions on a distro without an AMD repo', () => {
    expect(() =>
      makePlan({ ...raw, version: '7.2.4' }, () => ({
        os: 'linux',
        arch: 'x64',
        distro: '',
        noPackageRepo: 'Unsupported distribution "fedora 43".'
      }))
    ).toThrow(
      /Unsupported distribution "fedora 43"\. ROCm 7\.2\.4 is only available through AMD's package repos.*10\.0\.0 and newer/
    )
  })

  it('keeps legacy versions on apt', () => {
    expect(
      makePlan({ ...raw, version: '7.2.4' }, on('ubuntu2404', 'apt')).scheme
    ).toBe('legacy')
  })
})
