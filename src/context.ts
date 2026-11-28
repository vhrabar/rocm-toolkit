import { packageKey, tarballKey } from './cache.js'
import { codenameFor, legacyPackages, listingUrl } from './linux/legacy.js'
import { packageNames, repoUrl } from './linux/packages.js'
import { linuxFamily, linuxTarballUrl } from './linux/tarball.js'
import type { Plan } from './main.js'
import { tarballUrl, windowsFamily } from './windows.js'

/**
 * Evaluate `fn` for a context line. The flow has usually already thrown for
 * the same reason, so a failure here must not hide the original error.
 */
function safe(fn: () => string): string {
  try {
    return fn()
  } catch (error) {
    return `(unknown: ${error instanceof Error ? error.message : String(error)})`
  }
}

/**
 * What the action set out to do, built with the same helpers the install
 * flows use, so a failure can be diagnosed from the message alone.
 */
export function describePlan(plan: Plan): string[] {
  const { inputs, platform, scheme } = plan
  const lines = [`ROCm:     ${inputs.version} (${scheme} flow)`]
  const cacheLine = (key: () => string): string =>
    `Cache:    ${inputs.useCache ? safe(key) : 'disabled (use-cache: false)'}`

  if (platform.os === 'windows') {
    lines.push(`Platform: windows ${platform.arch}`)
    lines.push(
      `Tarball:  ${safe(() => tarballUrl(inputs.version, windowsFamily(inputs.gfx)))}`
    )
    lines.push(
      cacheLine(() =>
        tarballKey('windows', windowsFamily(inputs.gfx), inputs.version)
      )
    )
    return lines
  }

  if (platform.noPackageRepo) {
    lines.push(
      `Platform: linux ${platform.arch}, no AMD package repo (tarball)`
    )
    lines.push(
      `Tarball:  ${safe(() => linuxTarballUrl(inputs.version, linuxFamily(inputs.gfx)))}`
    )
    lines.push(
      cacheLine(() =>
        tarballKey('linux', linuxFamily(inputs.gfx), inputs.version)
      )
    )
    return lines
  }

  lines.push(
    `Platform: linux ${platform.arch}, ${platform.distro} ` +
      `(${platform.packageManager ?? 'unknown package manager'})`
  )
  if (scheme === 'legacy') {
    lines.push(
      `Installer from: ${safe(() => listingUrl(inputs.version, codenameFor(platform.distro)))}`
    )
    const packages = legacyPackages(inputs.components)
    lines.push(`Packages: ${packages.join(' ')}`)
    lines.push(
      cacheLine(() =>
        packageKey(platform.distro, 'legacy', inputs.version, packages)
      )
    )
  } else {
    const pm = platform.packageManager
    lines.push(
      `Repo:     ${safe(() => {
        if (!pm) throw new Error('no package manager detected')
        return repoUrl(platform.distro, pm)
      })}`
    )
    lines.push(
      `Packages: ${safe(() => {
        if (!pm) throw new Error('no package manager detected')
        return packageNames(
          inputs.version,
          inputs.gfx,
          inputs.components,
          pm
        ).join(' ')
      })}`
    )
    lines.push(
      cacheLine(() => {
        if (!pm) throw new Error('no package manager detected')
        return packageKey(
          platform.distro,
          pm,
          inputs.version,
          packageNames(inputs.version, inputs.gfx, inputs.components, pm)
        )
      })
    )
  }
  return lines
}

/** The step's failure message: the error +plan. */
export function failureMessage(error: unknown, plan?: Plan): string {
  const message = error instanceof Error ? error.message : String(error)
  if (!plan) return message
  return [message, '', 'Install context:', ...describePlan(plan)].join('\n')
}
