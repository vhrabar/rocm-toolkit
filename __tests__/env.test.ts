import { jest } from '@jest/globals'

const core = {
  exportVariable: jest.fn(),
  addPath: jest.fn(),
  setOutput: jest.fn()
}
jest.unstable_mockModule('@actions/core', () => core)

const { applyEnv, buildEnv, mergeLibraryPath } = await import('../src/env.js')

describe('buildEnv', () => {
  it('builds posix paths on linux', () => {
    expect(buildEnv('/opt/rocm', 'linux')).toEqual({
      rocmPath: '/opt/rocm',
      hipPath: '/opt/rocm',
      binDir: '/opt/rocm/bin',
      libDir: '/opt/rocm/lib'
    })
  })

  it('builds windows paths on windows', () => {
    const env = buildEnv('C:\\Program Files\\AMD\\ROCm\\6.2', 'windows')
    expect(env.binDir).toBe('C:\\Program Files\\AMD\\ROCm\\6.2\\bin')
  })

  it('adds the device library path on windows only', () => {
    expect(buildEnv('C:\\rocm\\core-10.1', 'windows').deviceLibPath).toBe(
      'C:\\rocm\\core-10.1\\lib\\llvm\\amdgcn\\bitcode'
    )
    expect(
      buildEnv('/opt/rocm/core-10.1', 'linux').deviceLibPath
    ).toBeUndefined()
  })
})

describe('mergeLibraryPath', () => {
  it('prepends and dedupes', () => {
    expect(mergeLibraryPath('/a', '/b:/a:/c')).toBe('/a:/b:/c')
  })

  it('handles an unset value', () => {
    expect(mergeLibraryPath('/a', undefined)).toBe('/a')
  })
})

describe('applyEnv', () => {
  it('exports variables, PATH and outputs on linux', () => {
    applyEnv(buildEnv('/opt/rocm', 'linux'), 'linux', '10.1.0', false)
    expect(core.exportVariable).toHaveBeenCalledWith('ROCM_PATH', '/opt/rocm')
    expect(core.exportVariable).toHaveBeenCalledWith('HIP_PATH', '/opt/rocm')
    expect(core.addPath).toHaveBeenCalledWith('/opt/rocm/bin')
    expect(core.exportVariable).toHaveBeenCalledWith(
      'LD_LIBRARY_PATH',
      expect.stringContaining('/opt/rocm/lib')
    )
    expect(core.setOutput).toHaveBeenCalledWith('version', '10.1.0')
    expect(core.setOutput).toHaveBeenCalledWith('cache-hit', 'false')
  })

  it('sets cache-hit to true on a hit', () => {
    applyEnv(buildEnv('/opt/rocm', 'linux'), 'linux', '10.1.0', true)
    expect(core.setOutput).toHaveBeenCalledWith('cache-hit', 'true')
  })

  it('exports HIP_DEVICE_LIB_PATH on windows', () => {
    applyEnv(buildEnv('C:\\r', 'windows'), 'windows', '10.1.0', false)
    expect(core.exportVariable).toHaveBeenCalledWith(
      'HIP_DEVICE_LIB_PATH',
      'C:\\r\\lib\\llvm\\amdgcn\\bitcode'
    )
  })

  it('does not export HIP_DEVICE_LIB_PATH on linux', () => {
    core.exportVariable.mockClear()
    applyEnv(buildEnv('/opt/rocm/core-10.1', 'linux'), 'linux', '10.1.0', false)
    expect(core.exportVariable).not.toHaveBeenCalledWith(
      'HIP_DEVICE_LIB_PATH',
      expect.anything()
    )
  })

  it('does not set LD_LIBRARY_PATH on windows', () => {
    applyEnv(buildEnv('C:\\r', 'windows'), 'windows', '6.2.2', false)
    expect(core.exportVariable).not.toHaveBeenCalledWith(
      'LD_LIBRARY_PATH',
      expect.anything()
    )
  })
})
