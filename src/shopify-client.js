// Modified from DS Bot (Apache-2.0): moved into upsello-bot-plugin and adapted.
// The Shopify Admin GraphQL client every store tool goes through. The access token is
// read on each call and never leaves this module: tools get data, the model gets results.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './shared.js'
import * as cli from './shopify-cli.js'

export const API_VERSION = '2026-07'
const SHOP = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i
const TOKEN_SECRET = 'SHOPIFY_ADMIN_TOKEN'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

export function install(rt) {
  const shopDomain = () => {
    const shop = rt.upselloShopify?.()?.shop
    return typeof shop === 'string' && SHOP.test(shop) ? shop.toLowerCase() : undefined
  }
  // Two ways in: the CLI keeps the authorization, or an OAuth token lives in the secrets.
  const via = () => (rt.upselloShopify?.()?.via === 'cli' ? 'cli' : 'oauth')
  const token = () => {
    const value = rt.secretValue?.(TOKEN_SECRET)
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  }
  const connected = () => {
    if (shopDomain() === undefined) return false
    return via() === 'cli' ? cli.installed() !== undefined : token() !== undefined
  }

  async function once(shop, access, query, variables) {
    const response = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Shopify-Access-Token': access,
      },
      body: JSON.stringify({ query, variables }),
    })
    const text = await response.text()
    let payload
    try { payload = JSON.parse(text) } catch {
      throw new Error(`Shopify returned ${response.status}: ${text.slice(0, 200)}`)
    }
    if (!response.ok) {
      throw Object.assign(new Error(`Shopify ${response.status}: ${payload?.errors ?? text.slice(0, 200)}`), { status: response.status })
    }
    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      throw new Error(payload.errors.map(error => error.message).join('; '))
    }
    return payload.data
  }

  // 429 and 503 are Shopify asking for a slower pace, not a real answer.
  async function graphql(query, variables = {}) {
    const shop = shopDomain()
    if (shop === undefined) throw new Error('No Shopify store is connected. Use shopify_connect_cli or shopify_connect first.')
    // The CLI path runs the call itself: the app holds no token.
    if (via() === 'cli') return cli.execute(shop, query, variables)
    const access = token()
    if (access === undefined) throw new Error('The Shopify access token is missing. Use shopify_connect again.')
    let last
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await once(shop, access, query, variables)
      } catch (error) {
        last = error
        if (error?.status !== 429 && error?.status !== 503) throw error
        await delay(1000 * attempt)
      }
    }
    throw last
  }

  rt.shopifyGraphql = graphql
  rt.shopifyTokenPresent = token

  rt.teamTools.push(defineTool({
    name: 'shopify_store',
    description: 'Read the connected store: its name, domain, currency, timezone and plan. Use it to confirm the connection before other work.',
    parameters: {},
    output,
    async execute() {
      await rt.load()
      if (!connected()) return 'No Shopify store is connected. Use shopify_connect first.'
      const data = await graphql(`query Store { shop { name myshopifyDomain currencyCode ianaTimezone plan { displayName } } }`)
      const shop = data?.shop ?? {}
      return [
        `Store: ${shop.name ?? '(unnamed)'}`,
        `Domain: ${shop.myshopifyDomain ?? shopDomain()}`,
        `Currency: ${shop.currencyCode ?? 'unknown'}`,
        `Timezone: ${shop.ianaTimezone ?? 'unknown'}`,
        `Plan: ${shop.plan?.displayName ?? 'unknown'}`,
      ].join('\n')
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'shopify_connect_cli',
    description: 'Connect a Shopify store through the Shopify CLI. The user approves once in the browser and the CLI keeps the session; this app stores no token. Use this when the store is already reachable from the machine that runs the CLI.',
    parameters: {
      shop: { type: 'string', required: true, description: 'Store domain, e.g. my-store.myshopify.com' },
    },
    output,
    async execute(args) {
      await rt.load()
      const shop = cli.normalizeShop(args?.shop)
      if (!SHOP.test(shop)) return 'Enter the store domain, like my-store.myshopify.com.'
      if (cli.installed() === undefined) return 'The Shopify CLI is not installed on this machine. Install it with npm i -g @shopify/cli, then try again.'
      try {
        const result = await cli.auth(shop)
        await rt.upselloSetShopify({ shop: result.shop, via: 'cli', name: result.info?.name ?? null, connectedAt: Date.now() })
        return `Connected to ${result.info?.name ?? result.shop} (${result.shop}) through the Shopify CLI. The store tools work now.`
      } catch (error) {
        return `The Shopify CLI sign-in did not finish: ${String(error?.message ?? error)}`
      }
    },
  }))
}
