import * as core from '@actions/core'
import * as io from '@actions/io'
import * as path from 'node:path'
import type { InstallResult } from '../cache.js'
import type { Inputs } from '../inputs.js'
import {
  TARBALL_BASE,
  httpGet,
  spawnTar,
  type Fetcher
} from '../tarball/download.js'
import {
  CLIENT_FAMILIES,
  DCGPU_FAMILIES,
  selectFamily
} from '../tarball/families.js'
import { installTarball } from '../tarball/install.js'
import { installPrefix, majorMinor } from './prefix.js'

/** Linux has the client families plus the data-centre ones. */
export const LINUX_FAMILIES: Readonly<Record<string, string>> = {
  ...CLIENT_FAMILIES,
  ...DCGPU_FAMILIES
}

export function linuxFamily(gfx: readonly string[]): string {
  return selectFamily(gfx, LINUX_FAMILIES, 'Linux')
}

export function linuxTarballUrl(version: string, family: string): string {
  return `${TARBALL_BASE}/therock-dist-linux-${family}-${version}.tar.gz`
}

/**
 * Where the tarball goes.
 */
export function tarballPrefix(
  version: string,
  isRoot: boolean,
  toolCache: string | undefined
): string {
  if (isRoot) return installPrefix(version)
  if (!toolCache) {
    throw new Error(
      'Installing the ROCm tarball without root needs RUNNER_TOOL_CACHE, ' +
        'which is not set. Run the job as root or on a GitHub Actions runner.'
    )
  }
  return path.posix.join(toolCache, 'rocm', `core-${majorMinor(version)}`)
}

/** The system tar, not whatever is first on PATH. */
export const linuxFetcher: Fetcher = {
  get: httpGet,
  spawnTar: (args) => spawnTar('/usr/bin/tar', args)
}

/**
 * What the tarball needs from the host and cannot bring along.
 */
export async function hostToolWarnings(): Promise<string[]> {
  const warnings: string[] = []
  if (!(await io.which('c++', false))) {
    warnings.push(
      'No C++ compiler (c++) found on PATH. hipcc needs one to compile HIP ' +
        'code: install it with the distro package manager, e.g. gcc-c++ on ' +
        'Fedora, gcc on Arch.'
    )
  }
  if (!(await io.which('python3', false))) {
    warnings.push(
      'python3 not found on PATH. hipcc --version and some ROCm tools need it.'
    )
  }
  return warnings
}

/**
 * Install the ROCm 10.x Linux tarball, for distros without an AMD repo.
 */
export async function installLinuxTarball(
  inputs: Inputs,
  fetcher: Fetcher = linuxFetcher
): Promise<InstallResult> {
  const family = linuxFamily(inputs.gfx)
  const prefix = tarballPrefix(
    inputs.version,
    process.getuid?.() === 0,
    process.env['RUNNER_TOOL_CACHE']
  )

  if (inputs.components.some((c) => c !== 'dev')) {
    core.warning(
      'Input "components" has no effect with the tarball; it is installed ' +
        'whole.'
    )
  }
  for (const warning of await hostToolWarnings()) core.warning(warning)

  await installTarball(
    {
      url: linuxTarballUrl(inputs.version, family),
      prefix,
      hipcc: path.posix.join(prefix, 'bin', 'hipcc'),
      stamp: `${family} ${inputs.version}`,
      join: path.posix.join
    },
    fetcher
  )
  return { root: prefix, cacheHit: false }
}
