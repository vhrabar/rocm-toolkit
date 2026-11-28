import { jest } from '@jest/globals'

class ReserveCacheError extends Error {}

const actionsCacheMock = {
  isFeatureAvailable: jest.fn<() => boolean>(),
  restoreCache:
    jest.fn<(paths: string[], key: string) => Promise<string | undefined>>(),
  saveCache: jest.fn<(paths: string[], key: string) => Promise<number>>(),
  ReserveCacheError
}
const core = { info: jest.fn(), warning: jest.fn() }
jest.unstable_mockModule('@actions/cache', () => actionsCacheMock)
jest.unstable_mockModule('@actions/core', () => core)

const {
  CACHE_VERSION,
  actionsCache,
  cacheFor,
  noCache,
  packageKey,
  tarballKey
} = await import('../src/cache.js')

describe('tarballKey', () => {
  it('names the os, family and version', () => {
    expect(tarballKey('linux', 'gfx120X-all', '10.1.0')).toBe(
      `setup-rocm-${CACHE_VERSION}-linux-gfx120X-all-10.1.0`
    )
  })

  it('differs per os, family and version', () => {
    const keys = new Set([
      tarballKey('linux', 'gfx120X-all', '10.1.0'),
      tarballKey('windows', 'gfx120X-all', '10.1.0'),
      tarballKey('linux', 'gfx110X-all', '10.1.0'),
      tarballKey('linux', 'gfx120X-all', '10.2.0')
    ])
    expect(keys.size).toBe(4)
  })
})

describe('packageKey', () => {
  const packages = ['amdrocm-core-sdk-10.1', 'amdrocm-gfx1200-10.1']

  it('names the distro, manager and version, then a short hash', () => {
    expect(packageKey('ubuntu2404', 'apt', '10.1.0', packages)).toMatch(
      new RegExp(
        `^setup-rocm-${CACHE_VERSION}-ubuntu2404-apt-10\\.1\\.0-[0-9a-f]{12}$`
      )
    )
  })

  it('ignores package order and duplicates', () => {
    const key = packageKey('ubuntu2404', 'apt', '10.1.0', packages)
    expect(
      packageKey('ubuntu2404', 'apt', '10.1.0', [
        packages[1]!,
        packages[0]!,
        packages[1]!
      ])
    ).toBe(key)
  })

  it('changes when the package list changes', () => {
    expect(packageKey('ubuntu2404', 'apt', '10.1.0', packages)).not.toBe(
      packageKey('ubuntu2404', 'apt', '10.1.0', [
        ...packages,
        'amdrocm-gfx1100-10.1'
      ])
    )
  })

  it('differs per distro, manager and version', () => {
    const keys = new Set([
      packageKey('ubuntu2404', 'apt', '10.1.0', packages),
      packageKey('ubuntu2204', 'apt', '10.1.0', packages),
      packageKey('rhel9', 'dnf', '10.1.0', packages),
      packageKey('ubuntu2404', 'legacy', '10.1.0', packages),
      packageKey('ubuntu2404', 'apt', '10.2.0', packages)
    ])
    expect(keys.size).toBe(5)
  })
})

describe('actionsCache', () => {
  const key = 'setup-rocm-v1-linux-gfx120X-all-10.1.0'
  const paths = ['/tmp/rocm.tar.gz']

  beforeEach(() => {
    actionsCacheMock.isFeatureAvailable.mockReturnValue(true)
  })

  it('reports an exact hit', async () => {
    actionsCacheMock.restoreCache.mockResolvedValueOnce(key)
    await expect(actionsCache.restore(paths, key)).resolves.toBe(true)
    expect(actionsCacheMock.restoreCache).toHaveBeenCalledWith(paths, key)
  })

  it('reports a miss', async () => {
    actionsCacheMock.restoreCache.mockResolvedValueOnce(undefined)
    await expect(actionsCache.restore(paths, key)).resolves.toBe(false)
  })

  it('turns a restore failure into a warning and a miss', async () => {
    actionsCacheMock.restoreCache.mockRejectedValueOnce(new Error('boom'))
    await expect(actionsCache.restore(paths, key)).resolves.toBe(false)
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('boom'))
  })

  it('saves under the key', async () => {
    actionsCacheMock.saveCache.mockResolvedValueOnce(1)
    await actionsCache.save(paths, key)
    expect(actionsCacheMock.saveCache).toHaveBeenCalledWith(paths, key)
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('turns a save failure into a warning', async () => {
    actionsCacheMock.saveCache.mockRejectedValueOnce(new Error('full'))
    await expect(actionsCache.save(paths, key)).resolves.toBeUndefined()
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('full'))
  })

  it('does not warn when another job saved the key first', async () => {
    actionsCacheMock.saveCache.mockRejectedValueOnce(
      new ReserveCacheError('already exists')
    )
    await actionsCache.save(paths, key)
    expect(core.warning).not.toHaveBeenCalled()
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('already exists')
    )
  })

  it('does nothing when the cache service is unavailable', async () => {
    actionsCacheMock.isFeatureAvailable.mockReturnValue(false)
    await expect(actionsCache.restore(paths, key)).resolves.toBe(false)
    await actionsCache.save(paths, key)
    expect(actionsCacheMock.restoreCache).not.toHaveBeenCalled()
    expect(actionsCacheMock.saveCache).not.toHaveBeenCalled()
    expect(core.warning).not.toHaveBeenCalled()
  })
})

describe('cacheFor', () => {
  it('uses the Actions cache when use-cache is true', () => {
    expect(cacheFor({ useCache: true })).toBe(actionsCache)
  })

  it('never touches the Actions cache when use-cache is false', async () => {
    const c = cacheFor({ useCache: false })
    expect(c).toBe(noCache)
    await expect(c.restore(['/x'], 'k')).resolves.toBe(false)
    await c.save(['/x'], 'k')
    expect(actionsCacheMock.isFeatureAvailable).not.toHaveBeenCalled()
    expect(actionsCacheMock.restoreCache).not.toHaveBeenCalled()
    expect(actionsCacheMock.saveCache).not.toHaveBeenCalled()
  })
})
