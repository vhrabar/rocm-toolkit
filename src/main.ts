import * as core from '@actions/core'
import * as fs from 'node:fs'
import * as os from 'node:os'
import type { InstallResult } from './cache.js'
import { parseInputs, type Inputs } from './inputs.js'
import { failureMessage } from './context.js'
import { applyEnv, buildEnv } from './env.js'
import { installLegacy } from './linux/legacy.js'
import { installMultiArch } from './linux/index.js'
import { packageManagerFor } from './linux/managers.js'
import { installLinuxTarball } from './linux/tarball.js'
import { installWindows } from './windows.js'
import { detectPlatform, type Os, type Platform } from './platform.js'
import { parseVersion, selectScheme, type Scheme } from './versions.js'

export interface Plan {
  inputs: Inputs
  platform: Platform
  scheme: Scheme
}

export function readRawInputs(): Parameters<typeof parseInputs>[0] {
  return {
    version: core.getInput('version'),
    gfx: core.getInput('gfx'),
    components: core.getInput('components'),
    useCache: core.getInput('use-cache'),
    logFileSuffix: core.getInput('log-file-suffix')
  }
}

/**
 * Validate inputs first so a bad input is reported even on an unsupported
 * platform, then detect the platform.
 */
export function makePlan(
  raw: Parameters<typeof parseInputs>[0],
  detect: () => Platform
): Plan {
  const inputs = parseInputs(raw)
  const scheme = selectScheme(parseVersion(inputs.version))
  const platform = detect()
  // AMD publishes Linux ROCm for x86_64 only: amd64-only apt repos, x86_64/
  // RPM repos, x86-64 tarballs (docs/RESEARCH.md). Check before the distro,
  // so an arm64 Fedora does not fall back to an x86-64 tarball.
  if (platform.os === 'linux' && platform.arch !== 'x64') {
    throw new Error(
      `AMD publishes ROCm for Linux on x86_64 only, and this runner is ` +
        `${platform.arch}. Use an x86_64 runner, e.g. ubuntu-24.04 instead ` +
        `of ubuntu-24.04-arm.`
    )
  }
  if (platform.os === 'linux' && platform.noPackageRepo) {
    if (scheme === 'legacy') {
      throw new Error(
        `${platform.noPackageRepo} ROCm ${inputs.version} is only available ` +
          `through AMD's package repos; on other distributions the action ` +
          `installs the ROCm tarball, which exists for 10.0.0 and newer.`
      )
    }
  } else if (platform.os === 'linux') {
    const pm = platform.packageManager ?? 'an unknown package manager'
    if (!packageManagerFor(platform.packageManager)) {
      throw new Error(
        `Detected ${platform.distro}, which uses ${pm}. This version of the ` +
          `action installs ROCm through apt (Ubuntu, Debian), dnf (RHEL ` +
          `family) and zypper (SLES, openSUSE Leap) only.`
      )
    }
    if (scheme === 'legacy' && pm !== 'apt') {
      throw new Error(
        `ROCm ${inputs.version} is not available on ${platform.distro}. ` +
          `Versions 7.2.x and older are installed through AMD's Ubuntu ` +
          `installer package; on ${platform.distro} use ROCm 10.0.0 or newer.`
      )
    }
  }
  return { inputs, platform, scheme }
}

/** Export the environment and outputs for a finished install. */
function finish(result: InstallResult, os: Os, plan: Plan): void {
  applyEnv(buildEnv(result.root, os), os, plan.inputs.version, result.cacheHit)
}

export async function run(): Promise<void> {
  let plan: Plan | undefined
  try {
    plan = makePlan(readRawInputs(), () =>
      detectPlatform(process.platform, os.arch(), () =>
        fs.readFileSync('/etc/os-release', 'utf8')
      )
    )
    core.info(
      `Plan: ROCm ${plan.inputs.version} on ${plan.platform.os} ` +
        `(${plan.scheme}, gfx: ${plan.inputs.gfx.join(',') || 'all'})`
    )
    if (plan.platform.os === 'linux' && plan.platform.noPackageRepo) {
      core.warning(
        `${plan.platform.noPackageRepo} Installing the ROCm tarball instead.`
      )
      finish(await installLinuxTarball(plan.inputs), 'linux', plan)
      return
    }
    if (plan.platform.os === 'linux' && plan.scheme === 'multiarch') {
      const pm = packageManagerFor(plan.platform.packageManager)
      if (!pm) throw new Error('No package manager for this distro.') // makePlan checked
      finish(
        await installMultiArch(plan.inputs, plan.platform.distro, pm),
        'linux',
        plan
      )
      return
    }
    if (plan.platform.os === 'linux' && plan.scheme === 'legacy') {
      finish(
        await installLegacy(plan.inputs, plan.platform.distro),
        'linux',
        plan
      )
      return
    }
    if (plan.platform.os === 'windows') {
      if (plan.scheme !== 'multiarch') {
        throw new Error(
          `ROCm ${plan.inputs.version} is not available on Windows through ` +
            `this action. Windows supports ROCm 10.x only.`
        )
      }
      finish(await installWindows(plan.inputs), 'windows', plan)
      return
    }
    throw new Error(`No install flow for ${plan.platform.os} / ${plan.scheme}.`)
  } catch (error) {
    core.setFailed(failureMessage(error, plan))
  }
}
