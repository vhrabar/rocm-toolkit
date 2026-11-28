import * as core from '@actions/core'
import * as path from 'node:path'
import type { InstallResult } from './cache.js'
import type { Inputs } from './inputs.js'
import {
  TARBALL_BASE,
  httpGet,
  spawnTar,
  type Fetcher
} from './tarball/download.js'
import {
  CLIENT_FAMILIES,
  MULTIARCH_FAMILY,
  selectFamily
} from './tarball/families.js'
import { installTarball } from './tarball/install.js'
import { parseVersion } from './versions.js'

export { MULTIARCH_FAMILY }

/** Windows has the client families only. */
export function windowsFamily(gfx: readonly string[]): string {
  return selectFamily(gfx, CLIENT_FAMILIES, 'Windows')
}

export function tarballUrl(version: string, family: string): string {
  return `${TARBALL_BASE}/therock-dist-windows-${family}-${version}.tar.gz`
}

/** C:\rocm\core-v */
export function windowsPrefix(version: string, drive = 'C:'): string {
  const v = parseVersion(version)
  return `${drive}\\rocm\\core-${v.major}.${v.minor}`
}

export const defaultFetcher: Fetcher = {
  get: httpGet,
  spawnTar(args) {
    const tar = path.win32.join(
      process.env['SystemRoot'] ?? 'C:\\Windows',
      'System32',
      'tar.exe'
    )
    return spawnTar(tar, args)
  }
}

/** Install the ROCm 10.x tarball on Windows. */
export async function installWindows(
  inputs: Inputs,
  fetcher: Fetcher = defaultFetcher
): Promise<InstallResult> {
  const family = windowsFamily(inputs.gfx)
  const prefix = windowsPrefix(inputs.version, process.env['SystemDrive'])
  const hipcc = path.win32.join(prefix, 'bin', 'hipcc.exe')
  const stamp = `${family} ${inputs.version}`

  if (inputs.components.some((c) => c !== 'dev')) {
    core.warning(
      'Input "components" has no effect on Windows; the tarball is installed ' +
        'whole.'
    )
  }

  await installTarball(
    {
      url: tarballUrl(inputs.version, family),
      prefix,
      hipcc,
      stamp,
      join: path.win32.join
    },
    fetcher
  )
  return { root: prefix, cacheHit: false }
}
