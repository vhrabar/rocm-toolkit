import * as cache from '@actions/cache'
import * as core from '@actions/core'
import { createHash } from 'node:crypto'
import type { Inputs } from './inputs.js'
import type { Os, PackageManagerKind } from './platform.js'

/**
 * Part of every key, in case cashing mecahnism changes
 */
export const CACHE_VERSION = 'v1'
const PREFIX = `setup-rocm-${CACHE_VERSION}`

/** Key for a ROCm tarball, e.g. setup-rocm-v1-linux-gfx120X-all-10.1.0. */
export function tarballKey(os: Os, family: string, version: string): string {
  return `${PREFIX}-${os}-${family}-${version}`
}

/**
 * Key for a package manager's download directory. The package list is
 * hashed because it can be long (gfx=all), and sorted and de-duplicated so
 * the order of inputs does not change the key.
 */
export function packageKey(
  distro: string,
  pm: PackageManagerKind | 'legacy',
  version: string,
  packages: readonly string[]
): string {
  const list = [...new Set(packages)].sort().join('\n')
  const hash = createHash('sha256').update(list).digest('hex').slice(0, 12)
  return `${PREFIX}-${distro}-${pm}-${version}-${hash}`
}

/** What every install flow returns. */
export interface InstallResult {
  /** The ROCm root. */
  root: string
  /** True if ROCm came from the Actions cache or an existing install. */
  cacheHit: boolean
}

/**
 * What the install flows use to talk to the Actions cache. Neither method
 * throws: a cache problem must never fail the step.
 */
export interface Cache {
  /** Restore `paths` from `key`. True on an exact hit. */
  restore(paths: string[], key: string): Promise<boolean>
  /** Save `paths` under `key`. */
  save(paths: string[], key: string): Promise<void>
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The GitHub Actions cache, with every failure turned into a warning. */
export const actionsCache: Cache = {
  async restore(paths, key) {
    if (!cache.isFeatureAvailable()) {
      core.info('The Actions cache is not available on this runner.')
      return false
    }
    try {
      const hit = await cache.restoreCache(paths, key)
      core.info(hit ? `Cache hit: ${key}` : `Cache miss: ${key}`)
      return hit === key
    } catch (error) {
      core.warning(`Could not restore the cache ${key}: ${describe(error)}`)
      return false
    }
  },

  async save(paths, key) {
    if (!cache.isFeatureAvailable()) return
    try {
      await cache.saveCache(paths, key)
      core.info(`Saved the cache ${key}`)
    } catch (error) {
      // Another job saved the same key first, or this run may not write.
      if (error instanceof cache.ReserveCacheError) {
        core.info(`Did not save the cache ${key}: ${describe(error)}`)
        return
      }
      core.warning(`Could not save the cache ${key}: ${describe(error)}`)
    }
  }
}

/** Used with `use-cache: false`: never reads or writes the cache. */
export const noCache: Cache = {
  async restore() {
    return false
  },
  async save() {}
}

export function cacheFor(inputs: Pick<Inputs, 'useCache'>): Cache {
  return inputs.useCache ? actionsCache : noCache
}
