import { packageKey } from '../src/cache.js'
import { describePlan, failureMessage } from '../src/context.js'
import type { Plan } from '../src/main.js'

const inputs = {
  version: '10.1.0',
  gfx: ['gfx1200'],
  components: ['dev' as const],
  useCache: true,
  logFileSuffix: 'log.txt'
}
const multiarch: Plan = {
  inputs,
  platform: {
    os: 'linux',
    arch: 'x64',
    distro: 'ubuntu2404',
    packageManager: 'apt'
  },
  scheme: 'multiarch'
}

describe('describePlan', () => {
  it('lists distro, repo and packages for the multi-arch flow', () => {
    expect(describePlan(multiarch)).toEqual([
      'ROCm:     10.1.0 (multiarch flow)',
      'Platform: linux x64, ubuntu2404 (apt)',
      'Repo:     https://stable.repo.amd.com/rocm/core/packages/ubuntu2404',
      'Packages: amdrocm-core-dev10.1-gfx1200',
      `Cache:    ${packageKey('ubuntu2404', 'apt', '10.1.0', ['amdrocm-core-dev10.1-gfx1200'])}`
    ])
  })

  it('says when the cache is disabled', () => {
    expect(
      describePlan({ ...multiarch, inputs: { ...inputs, useCache: false } }).at(
        -1
      )
    ).toBe('Cache:    disabled (use-cache: false)')
  })

  it('lists the installer listing and packages for the legacy flow', () => {
    expect(
      describePlan({
        ...multiarch,
        inputs: { ...inputs, version: '7.2.4', gfx: [] },
        scheme: 'legacy'
      })
    ).toEqual([
      'ROCm:     7.2.4 (legacy flow)',
      'Platform: linux x64, ubuntu2404 (apt)',
      'Installer from: https://repo.radeon.com/amdgpu-install/7.2.4/ubuntu/noble/',
      'Packages: rocm-hip-runtime-dev libxml2',
      `Cache:    ${packageKey('ubuntu2404', 'legacy', '7.2.4', ['rocm-hip-runtime-dev', 'libxml2'])}`
    ])
  })

  it('lists the tarball URL on Windows', () => {
    expect(
      describePlan({
        ...multiarch,
        platform: { os: 'windows', arch: 'x64', distro: '' }
      })
    ).toEqual([
      'ROCm:     10.1.0 (multiarch flow)',
      'Platform: windows x64',
      'Tarball:  https://stable.repo.amd.com/rocm/core/tarball/therock-dist-windows-gfx120X-all-10.1.0.tar.gz',
      'Cache:    setup-rocm-v1-windows-gfx120X-all-10.1.0'
    ])
  })

  it('lists the x86_64 repo and RPM package names on a dnf distro', () => {
    expect(
      describePlan({
        ...multiarch,
        platform: {
          ...multiarch.platform,
          distro: 'rhel9',
          packageManager: 'dnf'
        }
      })
    ).toEqual([
      'ROCm:     10.1.0 (multiarch flow)',
      'Platform: linux x64, rhel9 (dnf)',
      'Repo:     https://stable.repo.amd.com/rocm/core/packages/rhel9/x86_64/',
      'Packages: amdrocm-core-devel10.1-gfx1200',
      `Cache:    ${packageKey('rhel9', 'dnf', '10.1.0', ['amdrocm-core-devel10.1-gfx1200'])}`
    ])
  })

  it('lists the x86_64 repo and RPM package names on a zypper distro', () => {
    expect(
      describePlan({
        ...multiarch,
        platform: {
          ...multiarch.platform,
          distro: 'sles15',
          packageManager: 'zypper'
        }
      }).slice(1)
    ).toEqual([
      'Platform: linux x64, sles15 (zypper)',
      'Repo:     https://stable.repo.amd.com/rocm/core/packages/sles15/x86_64/',
      'Packages: amdrocm-core-devel10.1-gfx1200',
      `Cache:    ${packageKey('sles15', 'zypper', '10.1.0', ['amdrocm-core-devel10.1-gfx1200'])}`
    ])
  })

  it('does not guess package names without a package manager', () => {
    const platform = { ...multiarch.platform, packageManager: undefined }
    expect(describePlan({ ...multiarch, platform }).slice(2)).toEqual([
      'Repo:     (unknown: no package manager detected)',
      'Packages: (unknown: no package manager detected)',
      'Cache:    (unknown: no package manager detected)'
    ])
  })

  it('lists the tarball URL on a distro without an AMD repo', () => {
    expect(
      describePlan({
        ...multiarch,
        platform: {
          os: 'linux',
          arch: 'x64',
          distro: '',
          noPackageRepo: 'Unsupported distribution "fedora 43".'
        }
      })
    ).toEqual([
      'ROCm:     10.1.0 (multiarch flow)',
      'Platform: linux x64, no AMD package repo (tarball)',
      'Tarball:  https://stable.repo.amd.com/rocm/core/tarball/therock-dist-linux-gfx120X-all-10.1.0.tar.gz',
      'Cache:    setup-rocm-v1-linux-gfx120X-all-10.1.0'
    ])
  })

  it('keeps going when a detail cannot be computed', () => {
    const lines = describePlan({
      ...multiarch,
      inputs: { ...inputs, version: '7.2.4' },
      platform: { ...multiarch.platform, distro: 'debian12' },
      scheme: 'legacy'
    })
    expect(lines[2]).toMatch(
      /^Installer from: \(unknown: The legacy install flow .* not "debian12"\.\)$/
    )
    expect(lines[3]).toBe('Packages: rocm-hip-runtime-dev libxml2')
  })
})

describe('failureMessage', () => {
  it('is the bare message before a plan exists', () => {
    expect(failureMessage(new Error('Invalid ROCm version'))).toBe(
      'Invalid ROCm version'
    )
    expect(failureMessage('plain string')).toBe('plain string')
  })

  it('appends the context once there is a plan', () => {
    expect(failureMessage(new Error('apt-get failed'), multiarch)).toBe(
      [
        'apt-get failed',
        '',
        'Install context:',
        'ROCm:     10.1.0 (multiarch flow)',
        'Platform: linux x64, ubuntu2404 (apt)',
        'Repo:     https://stable.repo.amd.com/rocm/core/packages/ubuntu2404',
        'Packages: amdrocm-core-dev10.1-gfx1200',
        `Cache:    ${packageKey('ubuntu2404', 'apt', '10.1.0', ['amdrocm-core-dev10.1-gfx1200'])}`
      ].join('\n')
    )
  })
})
