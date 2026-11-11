// Modified from DS Bot (Apache-2.0): moved into upsello-bot-plugin and adapted.
// Shopify Admin access by OAuth, the way Shopify documents it: the browser goes to the
// store's own authorise page, Shopify redirects back to this machine, and the code is
// exchanged for an Admin API access token that never reaches the model.
//
// Set once in Settings → Secrets, or ship them in shopify-app.json:
//   SHOPIFY_CLIENT_ID      the app's client id
//   SHOPIFY_CLIENT_SECRET  the app's client secret, used only for the token exchange
//   SHOPIFY_REDIRECT_URI   optional; defaults to http://127.0.0.1:43119/shopify/callback
// The redirect URI must be registered on that app in the Dev Dashboard, exactly as written.

import { createServer } from 'node:http'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './shared.js'

const SHIPPED = (() => {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../shopify-app.json', import.meta.url), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
})()
const shipped = key => (typeof SHIPPED[key] === 'string' ? SHIPPED[key].trim() : '')

const TOKEN_SECRET = 'SHOPIFY_ADMIN_TOKEN'
const DEFAULT_REDIRECT = 'http://127.0.0.1:43119/shopify/callback'
const SCOPES = [
  'read_products', 'write_products',
  'read_orders', 'write_orders',
  'read_customers', 'write_customers',
  'read_inventory', 'write_inventory',
  'read_locations',
  'read_themes', 'write_themes',
  'read_content', 'write_content',
  'read_discounts',
]
const TIMEOUT_MS = 10 * 60_000
const SHOP = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i

const page = title => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:20vh auto;max-width:30rem;text-align:center;color:#111">
<h1 style="font-size:1.1rem">${title}</h1><p>You can close this window and return to Upsello.</p></body>`

export function install(rt) {
  // One sign-in at a time: a second request closes the first window.
  let pending

  const secret = name => {
    const value = rt.secretValue?.(name)
    return typeof value === 'string' ? value.trim() : ''
  }
  const clientId = () => secret('SHOPIFY_CLIENT_ID') || shipped('clientId')
  const clientSecret = () => secret('SHOPIFY_CLIENT_SECRET') || shipped('clientSecret')
  const redirectUri = () => secret('SHOPIFY_REDIRECT_URI') || shipped('redirectUri') || DEFAULT_REDIRECT
  const configured = () => clientId() !== '' && clientSecret() !== ''

  const connected = () => {
    const record = rt.upselloShopify?.() ?? {}
    const shop = record.shop
    if (typeof shop !== 'string' || shop === '') return false
    if (record.via === 'cli') return true
    return secret(TOKEN_SECRET) !== ''
  }

  function authView() {
    const record = rt.upselloShopify?.() ?? {}
    const shop = record.shop
    return {
      configured: configured(),
      clientId: clientId() === '' ? null : clientId(),
      redirectUri: redirectUri(),
      connected: connected(),
      via: record.via === 'cli' ? 'cli' : 'oauth',
      shop: typeof shop === 'string' ? shop : null,
    }
  }

  function verifyHmac(params) {
    const hmac = params.get('hmac')
    if (!hmac) throw new Error('Shopify did not return an hmac.')
    const message = [...params.entries()]
      .filter(([key]) => key !== 'hmac' && key !== 'signature')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('&')
    const digest = createHmac('sha256', clientSecret()).update(message).digest('hex')
    const left = Buffer.from(digest, 'utf8')
    const right = Buffer.from(hmac, 'utf8')
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new Error("Shopify's signature did not verify. Check the app's client secret.")
    }
  }

  async function exchange(shop, code) {
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId(), client_secret: clientSecret(), code }),
    })
    const text = await response.text()
    let payload
    try { payload = JSON.parse(text) } catch { throw new Error(`Shopify returned ${response.status}: ${text.slice(0, 200)}`) }
    if (!response.ok || typeof payload?.access_token !== 'string') {
      throw new Error(`Shopify refused the token exchange: ${payload?.error_description ?? payload?.error ?? response.status}`)
    }
    return payload
  }

  async function saveToken(token, shop, scopes) {
    await rt.load()
    await rt.secretEndpoint('secret-set', {
      name: TOKEN_SECRET,
      value: token,
      purpose: `Shopify Admin API for ${shop}`,
      scope: 'all',
    })
    await rt.upselloSetShopify({ shop, scopes, connectedAt: Date.now() })
  }

  async function begin(rawShop) {
    const shop = String(rawShop ?? '').trim().toLowerCase()
    if (!SHOP.test(shop)) throw new Error('Enter the store domain, like my-store.myshopify.com.')
    if (!configured()) throw new Error('Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET first (Settings → Secrets).')

    pending?.close()

    const redirect = new URL(redirectUri())
    const port = Number(redirect.port || (redirect.protocol === 'https:' ? 443 : 80))
    const callbackPath = redirect.pathname
    const nonce = randomUUID()

    const url = new URL(`https://${shop}/admin/oauth/authorize`)
    url.searchParams.set('client_id', clientId())
    url.searchParams.set('scope', SCOPES.join(','))
    url.searchParams.set('redirect_uri', redirectUri())
    url.searchParams.set('state', nonce)

    let resolveUrl
    const opened = new Promise(resolve => { resolveUrl = resolve })

    const server = createServer(async (req, res) => {
      let target
      try { target = new URL(req.url ?? '/', 'http://127.0.0.1') } catch { res.writeHead(400); res.end(); return }
      if (target.pathname !== callbackPath) { res.writeHead(404); res.end(); return }
      try {
        if (target.searchParams.get('state') !== nonce) throw new Error('The sign-in came back to a different request.')
        verifyHmac(target.searchParams)
        const code = target.searchParams.get('code')
        if (typeof code !== 'string' || code === '') throw new Error('Shopify did not return a code.')
        const token = await exchange(shop, code)
        await saveToken(token.access_token, shop, token.scope)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(page('Shopify connected'))
        resolveUrl({ ok: true, shop })
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(page(`Connection failed: ${String(error?.message ?? error)}`))
        resolveUrl({ ok: false, error })
      } finally {
        clearTimeout(timer)
        server.close()
        if (pending?.server === server) pending = undefined
      }
    })

    const timer = setTimeout(() => {
      server.close()
      if (pending?.server === server) pending = undefined
      resolveUrl({ ok: false, error: new Error('The sign-in timed out after ten minutes.') })
    }, TIMEOUT_MS)

    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })

    pending = { server, close: () => { try { server.close() } catch {} } }
    return { url: url.toString(), result: opened }
  }

  async function disconnect() {
    await rt.load()
    await rt.secretEndpoint('secret-delete', { name: TOKEN_SECRET }).catch(() => {})
    await rt.upselloClearShopify?.()
    pending?.close()
    pending = undefined
  }

  rt.shopifyAuthView = authView
  rt.shopifyConnected = connected
  rt.shopifyConnectBegin = begin
  rt.shopifyDisconnect = disconnect

  rt.teamTools.push(defineTool({
    name: 'shopify_connect',
    description: 'Connect the Shopify store this team works on. Give the store domain; the user opens the returned link in a browser and approves access. The token is stored on the machine and never shown to you.',
    parameters: {
      shop: { type: 'string', required: true, description: 'Store domain, e.g. my-store.myshopify.com' },
    },
    output,
    async execute(args) {
      await rt.load()
      if (!configured()) {
        return 'The Shopify app is not configured yet. Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in Settings → Secrets, then try again.'
      }
      try {
        const { url } = await begin(args.shop)
        return `Open this link in a browser to authorize Shopify for this store:\n\n${url}\n\nAfter the user approves, the store is connected and the store tools start working.`
      } catch (error) {
        return `Could not start the Shopify sign-in: ${String(error?.message ?? error)}`
      }
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'shopify_status',
    description: 'Say whether a Shopify store is connected, which one, and what the app is configured with.',
    parameters: {},
    output,
    async execute() {
      await rt.load()
      const view = authView()
      if (!view.connected) return 'No store is connected. Use shopify_connect_cli with the store domain (the CLI path needs no app credentials), or shopify_connect for OAuth.'
      return `Connected to ${view.shop}${view.via === 'cli' ? ' through the Shopify CLI' : ' with an OAuth token'}.`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'shopify_disconnect',
    description: "Forget the connected Shopify store and delete its access token from this machine.",
    parameters: {},
    output,
    async execute() {
      await disconnect()
      return 'The Shopify store is disconnected and its token is deleted.'
    },
  }))
}
