import * as core from '@actions/core'
import * as path from 'node:path'
import type { Os } from './platform.js'

export interface RocmEnv {
  rocmPath: string
  hipPath: string
  binDir: string
  libDir: string
  /**
   * Windows only. With ROCM_PATH set to the tarball root, clang cannot find the
   * device libraries on its own.
   */
  deviceLibPath?: string
}

export function buildEnv(root: string, os: Os): RocmEnv {
  const p = os === 'windows' ? path.win32 : path.posix
  const env: RocmEnv = {
    rocmPath: root,
    hipPath: root,
    binDir: p.join(root, 'bin'),
    libDir: p.join(root, 'lib')
  }
  if (os === 'windows') {
    env.deviceLibPath = p.join(root, 'lib', 'llvm', 'amdgcn', 'bitcode')
  }
  return env
}

/** Prepend libDir to an existing LD_LIBRARY_PATH value without duplicates. */
export function mergeLibraryPath(
  libDir: string,
  existing: string | undefined
): string {
  const parts = (existing ?? '').split(':').filter((s) => s.length > 0)
  return [libDir, ...parts.filter((s) => s !== libDir)].join(':')
}

export function applyEnv(
  env: RocmEnv,
  os: Os,
  version: string,
  cacheHit: boolean
): void {
  core.exportVariable('ROCM_PATH', env.rocmPath)
  core.exportVariable('HIP_PATH', env.hipPath)
  if (env.deviceLibPath) {
    core.exportVariable('HIP_DEVICE_LIB_PATH', env.deviceLibPath)
  }
  core.addPath(env.binDir)
  if (os === 'linux') {
    core.exportVariable(
      'LD_LIBRARY_PATH',
      mergeLibraryPath(env.libDir, process.env['LD_LIBRARY_PATH'])
    )
  }
  core.setOutput('ROCM_PATH', env.rocmPath)
  core.setOutput('version', version)
  core.setOutput('cache-hit', String(cacheHit))
}
