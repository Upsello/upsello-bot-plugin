// Modified from DS Bot (Apache-2.0): moved into upsello-bot-plugin and adapted.
// The Upsello layer's own state: one small JSON file beside the team's state.json.
// It holds the connected store and, later, the store profile. Kept out of state.json so
// the base's format stays untouched across upgrades.

import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { replaceFile } from './shared.js'

const EMPTY = { version: 1, shopify: {}, profile: {} }

export function install(rt) {
  const root = join(rt.home, 'upsello')
  const path = join(root, 'store.json')

  function read() {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      return parsed !== null && typeof parsed === 'object' ? { ...EMPTY, ...parsed } : { ...EMPTY }
    } catch {
      return { ...EMPTY }
    }
  }

  async function write(value) {
    await mkdir(root, { recursive: true })
    const temp = `${path}.tmp`
    await writeFile(temp, JSON.stringify(value, null, 2))
    await replaceFile(temp, path)
  }

  const shopify = () => read().shopify ?? {}
  const setShopify = async (patch) => {
    const value = read()
    value.shopify = { ...(value.shopify ?? {}), ...patch }
    await write(value)
    return value.shopify
  }
  const clearShopify = async () => {
    const value = read()
    value.shopify = {}
    await write(value)
  }

  const profile = () => read().profile ?? {}
  const setProfile = async (patch) => {
    const value = read()
    value.profile = { ...(value.profile ?? {}), ...patch }
    await write(value)
    return value.profile
  }

  Object.assign(rt, {
    upselloRoot: root,
    upselloStorePath: path,
    upselloShopify: shopify,
    upselloSetShopify: setShopify,
    upselloClearShopify: clearShopify,
    upselloProfile: profile,
    upselloSetProfile: setProfile,
  })
}
