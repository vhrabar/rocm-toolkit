import * as core from '@actions/core'
import type { InstallResult } from '../cache.js'
import type { Inputs } from '../inputs.js'
import { fetchCheckedKey } from './key.js'
import { packageNames } from './packages.js'
import { installPrefix, requireHipcc } from './prefix.js'
import type { PackageManager } from './types.js'

/**
 * Install ROCm 10.x from the multi-arch package repo. The steps are the same
 * on every distro; only the package manager differs.
 */
export async function installMultiArch(
  inputs: Inputs,
  distro: string,
  pm: PackageManager
): Promise<InstallResult> {
  const packages = packageNames(
    inputs.version,
    inputs.gfx,
    inputs.components,
    pm.kind
  )
  core.startGroup(`Configure the AMD ROCm ${pm.kind} repository`)
  await pm.ensurePrereqs()
  await pm.addRepo(distro, await fetchCheckedKey())
  core.endGroup()

  core.startGroup(`Install ${packages.join(' ')}`)
  await pm.install(packages)
  core.endGroup()

  const prefix = installPrefix(inputs.version)
  requireHipcc(prefix)
  return { root: prefix, cacheHit: false }
}
