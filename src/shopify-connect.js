// Modified from DS Bot (Apache-2.0): moved into upsello-bot-plugin and adapted.
// The Settings → Shopify page's one long action: the CLI signs the store in through the
// browser, which can take minutes. The page starts it and polls, so the request itself
// returns at once and the window stays responsive.
import * as cli from './shopify-cli.js'

export function install(rt) {
  let job

  const view = () => {
    const record = rt.upselloShopify?.() ?? {}
    return {
      shop: typeof record.shop === 'string' ? record.shop : null,
      name: typeof record.name === 'string' ? record.name : null,
      via: record.via === 'cli' ? 'cli' : (record.via === 'oauth' ? 'oauth' : null),
      connected: rt.shopifyConnected?.() === true,
      cli: cli.installed() !== undefined,
      job: job === undefined ? null : { shop: job.shop, status: job.status, error: job.error ?? null },
    }
  }

  // Every outcome reaches the team: connected, failed, or disconnected, always with the
  // next step, so no Bot sits waiting for an answer the user already gave in Settings.
  const announce = async (text) => {
    try {
      await rt.load()
      for (const bot of Object.values(rt.state?.bots ?? {})) {
        await rt.deliver({ toId: bot.id, role: 'connector', text })
          .catch(cause => rt.warn?.('ds-bot: connector note to %s failed: %s', bot.id, cause))
      }
    } catch (error) {
      rt.warn?.('ds-bot: connector note failed: %s', error)
    }
  }

  const begin = (rawShop) => {
    const shop = cli.normalizeShop(rawShop)
    if (!cli.SHOP.test(shop)) throw new Error('Enter the store domain, like my-store.myshopify.com.')
    if (cli.installed() === undefined) throw new Error('The Shopify CLI is not installed on this machine.')
    if (job?.status === 'waiting') throw new Error(`A sign-in for ${job.shop} is already waiting in the browser.`)
    job = { shop, status: 'waiting', error: null, startedAt: Date.now() }
    cli.auth(shop)
      .then(async result => {
        await rt.upselloSetShopify({ shop: result.shop, via: 'cli', name: result.info?.name ?? null, connectedAt: Date.now() })
        job = { ...job, status: 'done' }
        await announce(`Shopify 已连接：${result.info?.name ?? result.shop}（${result.shop}）。下一步：先用 shopify_store 确认店铺，再 store_diagnose 建真实基线，然后 plan_propose 出方案、给用户看、用户同意后 plan_commit 上板派活。不要跳过诊断直接派任务。`)
      })
      .catch(async error => {
        job = { ...job, status: 'error', error: String(error?.message ?? error) }
        await announce(`Shopify 连接失败：${String(error?.message ?? error)}。下一步：到 设置 → Connectors → Shopify 重新连接；如果连续失败，把错误告诉用户。`)
      })
    return { started: true, shop }
  }

  const disconnect = async () => {
    await rt.upselloClearShopify?.()
    job = undefined
    await announce('Shopify 已断开。下一步：需要重新授权后才能读取店铺数据；在此之前不要给出任何基于店铺数据的结论。')
  }

  Object.assign(rt, {
    upselloShopifyView: view,
    upselloShopifyBegin: begin,
    upselloShopifyDisconnect: disconnect,
    // The Connectors page draws this beside the MCP services, so the store is bound in the
    // same place as everything else instead of its own settings page.
    upselloShopifyRow: () => {
      const value = view()
      return {
        id: 'shopify',
        name: 'Shopify',
        category: 'commerce',
        about: 'Products, orders, inventory, themes and pages of the store',
        auth: { kind: 'cli' },
        state: value.job?.status === 'waiting' ? 'connecting' : (value.connected ? 'ready' : 'off'),
        account: value.connected ? (value.name ?? value.shop) : null,
        ...(value.job?.status === 'waiting' ? { pending: true } : {}),
        ...(value.job?.status === 'error' ? { error: value.job.error } : {}),
      }
    },
  })
}
