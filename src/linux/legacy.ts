import * as core from '@actions/core'
import * as tc from '@actions/tool-cache'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { InstallResult } from '../cache.js'
import type { Component, Inputs } from '../inputs.js'
import { parseVersion } from '../versions.js'
import { APT_GET, ensurePackages } from './apt.js'
import { requireHipcc } from './prefix.js'
import { asRoot } from './root.js'

export const LEGACY_BASE = 'https://repo.radeon.com/amdgpu-install'

/** Ubuntu repo path segment -> codename used by repo.radeon.com. */
const CODENAMES: Readonly<Record<string, string>> = {
  ubuntu2204: 'jammy',
  ubuntu2404: 'noble'
}

const DEB_PATTERN = /amdgpu-install_[0-9][0-9A-Za-z.+~-]*_all\.deb/

/** Patch 0 has no patch part in the directory name: 7.2.0 -> 7.2. */
export function installerDir(version: string): string {
  const v = parseVersion(version)
  return v.patch === 0
    ? `${v.major}.${v.minor}`
    : `${v.major}.${v.minor}.${v.patch}`
}

export function legacyPrefix(version: string): string {
  const v = parseVersion(version)
  return `/opt/rocm-${v.major}.${v.minor}.${v.patch}`
}

export function codenameFor(distro: string): string {
  const codename = CODENAMES[distro]
  if (!codename) {
    throw new Error(
      `The legacy install flow (ROCm 7.2.x and older) supports Ubuntu 22.04 ` +
        `and 24.04 only, not "${distro}".`
    )
  }
  return codename
}

export function listingUrl(version: string, codename: string): string {
  return `${LEGACY_BASE}/${installerDir(version)}/ubuntu/${codename}/`
}

/**
 * The .deb file name has a build number that cannot be derived from the
 * version, so read it from the directory listing.
 */
export function findInstallerDeb(listing: string): string {
  const match = DEB_PATTERN.exec(listing)
  if (!match) {
    throw new Error(
      'Could not find an amdgpu-install package in the directory listing.'
    )
  }
  return match[0]
}

const PACKAGES: Readonly<Record<Component, string>> = {
  runtime: 'rocm-hip-runtime',
  dev: 'rocm-hip-runtime-dev',
  sdk: 'rocm-hip-sdk',
  'developer-tools': 'rocm-developer-tools',
  opencl: 'rocm-opencl'
}

/**
 * libxml2 is not declared by rocm-llvm, but its lld needs libxml2.so.2
 */
export const EXTRA_PACKAGES: readonly string[] = ['libxml2']

export function legacyPackages(components: readonly Component[]): string[] {
  return [
    ...new Set([...components.map((c) => PACKAGES[c]), ...EXTRA_PACKAGES])
  ]
}

/** Install ROCm 7.2.x and older from repo.radeon.com. */
export async function installLegacy(
  inputs: Inputs,
  distro: string
): Promise<InstallResult> {
  const codename = codenameFor(distro)
  if (inputs.gfx.length > 0) {
    core.warning(
      'Input "gfx" has no effect for ROCm 7.2.x and older; ' +
        'these releases are not packaged per GPU architecture.'
    )
  }

  const base = listingUrl(inputs.version, codename)
  core.startGroup(`Find the amdgpu-install package for ROCm ${inputs.version}`)
  const listingFile = await tc.downloadTool(base)
  const debName = findInstallerDeb(fs.readFileSync(listingFile, 'utf8'))
  core.info(`Found ${debName}`)
  core.endGroup()

  core.startGroup('Configure the AMD ROCm apt repository')
  const debPath = path.join(process.env['RUNNER_TEMP'] ?? os.tmpdir(), debName)
  fs.rmSync(debPath, { force: true })
  const debFile = await tc.downloadTool(`${base}${debName}`, debPath)

  await ensurePackages(['ca-certificates'])
  await asRoot([...APT_GET, 'install', '-y', debFile])
  await asRoot([...APT_GET, 'update'])
  core.endGroup()

  const packages = legacyPackages(inputs.components)
  core.startGroup(`Install ${packages.join(' ')}`)
  await asRoot([
    ...APT_GET,
    'install',
    '-y',
    '--no-install-recommends',
    ...packages
  ])
  core.endGroup()

  const prefix = legacyPrefix(inputs.version)
  requireHipcc(prefix)
  return { root: prefix, cacheHit: false }
}
