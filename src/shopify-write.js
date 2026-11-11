// Modified from DS Bot (Apache-2.0): moved into upsello-bot-plugin and adapted.
// Writes. Every one asks the user first through the harness's approval service and stops
// the turn there; nothing reaches the store until the card is answered. The approval names
// the Bot that wants the change and what it would change.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './shared.js'

const text = value => (typeof value === 'string' ? value : JSON.stringify(value, null, 2))
const strip = html => String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const clip = (value, size = 80) => {
  const line = String(value ?? '').replace(/\s+/g, ' ').trim()
  return line.length > size ? `${line.slice(0, size - 1)}…` : line
}

async function approve(rt, exec, reason, displayReason) {
  // The user can pre-answer one of these tools in Settings: allow it outright, refuse it
  // outright, or keep asking. Only "ask" reaches the card.
  const rule = rt.upselloApprovalRule?.(exec.name) ?? 'ask'
  if (rule === 'deny') throw new Error('The user has turned this change off in Settings. Nothing was done.')
  if (rule === 'allow') return

  const approval = rt.ctx.get?.('approval')
  if (approval === undefined || exec.agent?.session === undefined) {
    throw new Error("This change needs the user's approval, and there is no way to ask here, so nothing was done.")
  }
  let outcome
  try {
    outcome = await approval.request({
      agent: exec.agent,
      toolName: exec.name,
      ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
      reason,
      displayReason,
      ...(exec.signal ? { signal: exec.signal } : {}),
    })
  } catch {
    throw new Error('The approval service was unavailable. Nothing was done.')
  }
  if (outcome === 'allowed-once') return
  if (outcome === 'rejected') throw new Error('The user did not approve this change. Do not try it again unless the user asks. Nothing was done.')
  if (outcome === 'cancelled') throw new Error('The approval was cancelled. Nothing was done.')
  throw new Error('The approval could not be obtained. Nothing was done.')
}

export function install(rt) {
  const call = (query, variables) => rt.shopifyGraphql(query, variables)
  const ready = () => typeof rt.shopifyConnected === 'function' && rt.shopifyConnected()
  const botName = exec => rt.botOf?.(rt.selfOf?.(exec.agent?.session?.header?.id ?? exec.agent?.id))?.name ?? '这个 Agent'

  rt.teamTools.push(defineTool({
    name: 'shopify_update_product',
    description: 'Change a product: title, description, tags or SEO fields. Shows the user exactly what changes and waits for approval before writing. Give only the fields that change.',
    parameters: {
      id: { type: 'string', required: true, description: 'Product id (gid://shopify/Product/...)' },
      title: { type: 'string', description: 'New title' },
      descriptionHtml: { type: 'string', description: 'New description as HTML' },
      tags: { type: 'array', items: { type: 'string' }, description: 'The full tag list after the change' },
      seoTitle: { type: 'string', description: 'SEO title' },
      seoDescription: { type: 'string', description: 'SEO description' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      if (!ready()) return 'No Shopify store is connected. Use shopify_connect first.'
      const id = String(args?.id ?? '').trim()
      if (!id.startsWith('gid://shopify/Product/')) return 'Give a product id from shopify_products or shopify_product.'
      const current = await call(
        `query($id: ID!) { product(id: $id) { id title descriptionHtml tags seo { title description } } }`,
        { id },
      )
      const product = current?.product
      if (!product) return `No product found for ${id}.`
      const patch = {}
      if (typeof args?.title === 'string' && args.title.trim() !== '') patch.title = args.title.trim()
      if (typeof args?.descriptionHtml === 'string') patch.descriptionHtml = args.descriptionHtml
      if (Array.isArray(args?.tags)) patch.tags = args.tags.map(tag => String(tag))
      if (typeof args?.seoTitle === 'string' || typeof args?.seoDescription === 'string') {
        patch.seo = {}
        if (typeof args.seoTitle === 'string') patch.seo.title = args.seoTitle
        if (typeof args.seoDescription === 'string') patch.seo.description = args.seoDescription
      }
      if (Object.keys(patch).length === 0) return 'Nothing to change: give at least one field.'

      const changes = []
      if (patch.title !== undefined) changes.push(`标题：${clip(product.title)} → ${clip(patch.title)}`)
      if (patch.descriptionHtml !== undefined) {
        changes.push(`描述：${strip(product.descriptionHtml).length} 字 → ${strip(patch.descriptionHtml).length} 字`)
      }
      if (patch.tags !== undefined) changes.push(`标签：${(product.tags ?? []).length} 个 → ${patch.tags.length} 个`)

      await approve(
        rt,
        exec,
        `Let ${botName(exec)} change product "${clip(product.title, 60)}": ${changes.join('; ')}?`,
        { en: `Let ${botName(exec)} change product "${clip(product.title, 60)}"?`, zh: `允许${botName(exec)}修改商品「${clip(product.title, 40)}」吗？` },
      )

      const data = await call(
        `mutation($product: ProductUpdateInput!) {
          productUpdate(product: $product) {
            product { id title updatedAt }
            userErrors { field message }
          }
        }`,
        { product: { id, ...patch } },
      )
      const errors = data?.productUpdate?.userErrors ?? []
      if (errors.length > 0) return text({ ok: false, errors, changes })
      return text({ ok: true, product: data?.productUpdate?.product, changes })
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'shopify_update_page',
    description: 'Change an online-store page: title or body. Shows the change and waits for approval before writing.',
    parameters: {
      id: { type: 'string', required: true, description: 'Page id (gid://shopify/Page/...)' },
      title: { type: 'string', description: 'New title' },
      body: { type: 'string', description: 'New body as HTML' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      if (!ready()) return 'No Shopify store is connected. Use shopify_connect first.'
      const id = String(args?.id ?? '').trim()
      if (!id.startsWith('gid://shopify/Page/')) return 'Give a page id from shopify_pages.'
      const current = await call(`query($id: ID!) { page(id: $id) { id title body } }`, { id })
      const page = current?.page
      if (!page) return `No page found for ${id}.`
      const patch = {}
      if (typeof args?.title === 'string' && args.title.trim() !== '') patch.title = args.title.trim()
      if (typeof args?.body === 'string') patch.body = args.body
      if (Object.keys(patch).length === 0) return 'Nothing to change: give a title or a body.'

      const changes = []
      if (patch.title !== undefined) changes.push(`标题：${clip(page.title)} → ${clip(patch.title)}`)
      if (patch.body !== undefined) changes.push(`正文：${strip(page.body).length} 字 → ${strip(patch.body).length} 字`)

      await approve(
        rt,
        exec,
        `Let ${botName(exec)} change page "${clip(page.title, 60)}": ${changes.join('; ')}?`,
        { en: `Let ${botName(exec)} change page "${clip(page.title, 60)}"?`, zh: `允许${botName(exec)}修改页面「${clip(page.title, 40)}」吗？` },
      )

      const data = await call(
        `mutation($page: PageUpdateInput!) {
          pageUpdate(page: $page) {
            page { id title updatedAt }
            userErrors { field message }
          }
        }`,
        { page: { id, ...patch } },
      )
      const errors = data?.pageUpdate?.userErrors ?? []
      if (errors.length > 0) return text({ ok: false, errors, changes })
      return text({ ok: true, page: data?.pageUpdate?.page, changes })
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'shopify_update_theme_file',
    description: "Create or replace one file in a theme (a section, snippet or template). Shows the file and waits for approval. Publishing the theme is a separate step the user does.",
    parameters: {
      themeId: { type: 'string', required: true, description: 'Theme id from shopify_themes' },
      filename: { type: 'string', required: true, description: 'Path inside the theme, e.g. sections/pdp-objections.liquid' },
      content: { type: 'string', required: true, description: 'Full file contents' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      if (!ready()) return 'No Shopify store is connected. Use shopify_connect first.'
      const themeId = String(args?.themeId ?? '').trim()
      const filename = String(args?.filename ?? '').trim()
      const content = String(args?.content ?? '')
      if (!themeId.startsWith('gid://shopify/OnlineStoreTheme/')) return 'Give a theme id from shopify_themes.'
      if (filename === '' || content === '') return 'Give both a filename and its contents.'

      await approve(
        rt,
        exec,
        `Let ${botName(exec)} write ${filename} in theme ${themeId} (${content.length} chars)?`,
        { en: `Let ${botName(exec)} write ${filename}?`, zh: `允许${botName(exec)}写入主题文件 ${filename} 吗？` },
      )

      try {
        const data = await call(
          `mutation($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
            themeFilesUpsert(themeId: $themeId, files: $files) {
              upsertedThemeFiles { filename }
              userErrors { field message }
            }
          }`,
          { themeId, files: [{ filename, body: { type: 'TEXT', value: content } }] },
        )
        const errors = data?.themeFilesUpsert?.userErrors ?? []
        if (errors.length > 0) return text({ ok: false, errors })
        return text({ ok: true, files: data?.themeFilesUpsert?.upsertedThemeFiles ?? [] })
      } catch (error) {
        return `The theme file was not written: ${String(error?.message ?? error)}. If this app's API version does not expose theme files, use the Shopify CLI for theme changes.`
      }
    },
  }))
}
