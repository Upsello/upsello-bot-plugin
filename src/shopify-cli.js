// Modified from DS Bot (Apache-2.0): moved into upsello-bot-plugin and adapted.
// The Shopify CLI keeps the store's authorization and runs the Admin API call itself
// (`shopify store execute`). The app never holds a token: nothing to refresh, nothing to
// write back into the CLI's own files.
import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// A window opened from Finder gets the system PATH, not the shell's, so `shopify` from
// ~/.local/bin or Homebrew would not be found by name. Look where it is actually installed.
export function cliPath(env = process.env) {
  if (process.platform === 'win32') return env.SHOPIFY_CLI ?? 'shopify.cmd'
  if (typeof env.SHOPIFY_CLI === 'string' && env.SHOPIFY_CLI !== '') return env.SHOPIFY_CLI
  const home = env.HOME ?? homedir()
  const candidates = [
    join(home, '.local', 'bin', 'shopify'),
    '/opt/homebrew/bin/shopify',
    '/usr/local/bin/shopify',
    join(home, '.npm-global', 'bin', 'shopify'),
    join(home, '.bun', 'bin', 'shopify'),
    '/usr/bin/shopify',
  ]
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) return candidate } catch { /* keep looking */ }
  }
  return 'shopify'
}

export const SCOPES = [
  'read_products', 'write_products',
  'read_orders', 'write_orders',
  'read_customers', 'write_customers',
  'read_inventory', 'write_inventory',
  'read_locations',
  'read_themes', 'write_themes',
  'read_content', 'write_content',
  'read_discounts',
].join(',')

export const SHOP = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i

// People paste whatever the browser shows: a full address, an admin link, or just the
// handle. Turn any of those into the myshopify domain the CLI needs.
export function normalizeShop(raw) {
  let text = String(raw ?? '').trim().toLowerCase()
  if (text === '') return ''
  text = text.replace(/^https?:\/\//, '')
  const slash = text.indexOf('/')
  const host = slash === -1 ? text : text.slice(0, slash)
  const path = slash === -1 ? '' : text.slice(slash + 1)
  if (host === 'admin.shopify.com' && path.startsWith('store/')) {
    const handle = path.slice('store/'.length).split(/[/?#]/)[0]
    if (handle !== '') return `${handle}.myshopify.com`
  }
  if (SHOP.test(host)) return host
  // A bare handle, which the CLI itself accepts this way.
  if (/^[a-z0-9][a-z0-9-]*$/.test(host)) return `${host}.myshopify.com`
  return host
}

// The CLI prints its own plugin advertisement as an HTML-ish tag; never show that as an
// error to the user.
const clean = text => String(text ?? '')
  .replace(/<claude-code-hint[^>]*\/?>/gi, '')
  .replace(/\s+/g, ' ')
  .trim()

export function installed() {
  const path = cliPath()
  try { return statSync(path).isFile() ? path : undefined } catch { return undefined }
}

export function run(args, { timeoutMs = 60_000 } = {}) {
  const cli = installed() ?? 'shopify'
  return new Promise((resolve, reject) => {
    execFile(cli, args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, SHOPIFY_CLI_NO_ANALYTICS: '1' },
    }, (error, stdout, stderr) => {
      if (error) {
        const message = clean(stderr || stdout || error.message || String(error))
        reject(new Error(message.slice(0, 300) || error.message))
        return
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

// The store's own name, which is also the check that the store is authorized and alive.
export async function storeInfo(shop) {
  const data = await execute(shop, 'query { shop { name myshopifyDomain currencyCode ianaTimezone plan { displayName } } }')
  return data?.shop
}

export async function execute(shop, query, variables = {}, { timeoutMs = 120_000 } = {}) {
  const args = ['store', 'execute', '-s', shop, '-q', query, '-j', '--no-color']
  if (variables !== undefined && Object.keys(variables).length > 0) args.push('-v', JSON.stringify(variables))
  if (/^\s*mutation\b/i.test(query)) args.push('--allow-mutations')
  const { stdout } = await run(args, { timeoutMs })
  const text = stdout.trim()
  if (text === '') return {}
  let payload
  try { payload = JSON.parse(text) } catch {
    throw new Error(`The Shopify CLI returned something that is not JSON: ${text.slice(0, 200)}`)
  }
  const body = payload?.data !== undefined ? payload : (payload?.result ?? payload)
  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    throw new Error(body.errors.map(error => error?.message ?? String(error)).join('; '))
  }
  return body?.data ?? body
}

// A renamed store keeps its old handle as a 301 to the current one, and Shopify refuses an
// authorize request that lands on a redirect. Follow it first and sign in to the final host.
export async function resolveShop(shop) {
  let current = shop
  for (let hop = 0; hop < 4; hop += 1) {
    try {
      const response = await fetch(`https://${current}/`, { method: 'HEAD', redirect: 'manual' })
      if (response.status < 300 || response.status >= 400) return current
      const location = response.headers.get('location')
      if (location === null) return current
      const next = new URL(location, `https://${current}/`).hostname.toLowerCase()
      if (!SHOP.test(next) || next === current) return current
      current = next
    } catch {
      return current
    }
  }
  return current
}

// `store auth` opens the browser and needs a person, so CI is not set and the call waits.
export async function auth(shop) {
  const target = await resolveShop(shop)
  await run(['store', 'auth', '-s', target, '--scopes', SCOPES, '--no-color'], { timeoutMs: 300_000 })
  const info = await storeInfo(target)
  return { shop: target, info }
}
