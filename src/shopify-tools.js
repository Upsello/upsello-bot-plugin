// Modified from DS Bot (Apache-2.0): moved into upsello-bot-plugin and adapted.
// Read tools over the connected store. Every one goes through rt.shopifyGraphql, so the
// token stays in the host and each answer is plain data the model can quote.
//
// Shapes follow the Admin GraphQL API 2026-07. Where Shopify throttles a long window the
// tool says how much it actually read instead of pretending the number is complete.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './shared.js'

const text = value => (typeof value === 'string' ? value : JSON.stringify(value, null, 2))
const num = (value, fallback, min, max) => Math.min(Math.max(Number(value) || fallback, min), max)
const money = set => {
  const amount = Number(set?.shopMoney?.amount ?? 0)
  return Math.round(amount * 100) / 100
}
const PAGE_CEILING = 8

export function install(rt) {
  const call = (query, variables) => {
    if (typeof rt.shopifyGraphql !== 'function') throw new Error('The Shopify client is not installed.')
    return rt.shopifyGraphql(query, variables)
  }
  const ready = () => typeof rt.shopifyConnected === 'function' && rt.shopifyConnected()

  rt.teamTools.push(defineTool({
    name: 'shopify_products',
    description: 'List products with status, stock, vendor, type, tags and price range. Optional search uses Shopify search syntax, e.g. "status:active" or "tag:summer".',
    parameters: {
      query: { type: 'string', description: 'Shopify product search, e.g. status:active tag:summer. Optional.' },
      limit: { type: 'number', description: 'How many products, 1 to 100. Defaults to 20.' },
    },
    output,
    async execute(args) {
      await rt.load()
      if (!ready()) return 'No Shopify store is connected. Use shopify_connect first.'
      const limit = num(args?.limit, 20, 1, 100)
      const search = String(args?.query ?? '').trim() || null
      const rows = []
      let cursor = null
      while (rows.length < limit) {
        const data = await call(
          `query($first: Int!, $cursor: String, $query: String) {
            products(first: $first, after: $cursor, query: $query, sortKey: UPDATED_AT, reverse: true) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id title handle status vendor productType tags totalInventory
                priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } }
                updatedAt
              }
            }
          }`,
          { first: Math.min(100, limit - rows.length), cursor, query: search },
        )
        const nodes = data?.products?.nodes ?? []
        rows.push(...nodes)
        if (data?.products?.pageInfo?.hasNextPage !== true) break
        cursor = data.products.pageInfo.endCursor
      }
      if (rows.length === 0) return 'No products matched.'
      return text(rows.slice(0, limit).map(product => ({
        id: product.id,
        title: product.title,
        handle: product.handle,
        status: product.status,
        vendor: product.vendor,
        type: product.productType,
        tags: product.tags,
        stock: product.totalInventory,
        price: product.priceRangeV2?.minVariantPrice ? {
          min: Number(product.priceRangeV2.minVariantPrice.amount),
          max: Number(product.priceRangeV2.maxVariantPrice?.amount ?? product.priceRangeV2.minVariantPrice.amount),
          currency: product.priceRangeV2.minVariantPrice.currencyCode,
        } : null,
        updatedAt: product.updatedAt,
      })))
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'shopify_product',
    description: 'Read one product in full: description, variants with SKU, price and stock, images, SEO fields. Give a product id (gid://...) or a handle.',
    parameters: {
      id: { type: 'string', required: true, description: 'Product id (gid://shopify/Product/...) or handle' },
    },
    output,
    async execute(args) {
      await rt.load()
      if (!ready()) return 'No Shopify store is connected. Use shopify_connect first.'
      const raw = String(args?.id ?? '').trim()
      if (raw === '') return 'Give a product id or handle.'
      const data = raw.startsWith('gid://')
        ? await call(
          `query($id: ID!) {
            product(id: $id) {
              id title handle status descriptionHtml vendor productType tags totalInventory onlineStoreUrl updatedAt
              seo { title description }
              featuredImage { url altText }
              images(first: 20) { nodes { url altText } }
              variants(first: 100) { nodes { id title sku price compareAtPrice inventoryQuantity } }
            }
          }`,
          { id: raw },
        )
        : await call(
          `query($search: String!) {
            products(first: 1, query: $search) {
              nodes {
                id title handle status descriptionHtml vendor productType tags totalInventory onlineStoreUrl updatedAt
                seo { title description }
                featuredImage { url altText }
                images(first: 20) { nodes { url altText } }
                variants(first: 100) { nodes { id title sku price compareAtPrice inventoryQuantity } }
              }
            }
          }`,
          { search: `handle:${raw}` },
        )
      const product = data?.product ?? data?.products?.nodes?.[0]
      if (!product) return `No product found for ${raw}.`
      return text({
        id: product.id,
        title: product.title,
        handle: product.handle,
        status: product.status,
        vendor: product.vendor,
        type: product.productType,
        tags: product.tags,
        stock: product.totalInventory,
        url: product.onlineStoreUrl,
        updatedAt: product.updatedAt,
        seo: product.seo,
        description: String(product.descriptionHtml ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
        images: (product.images?.nodes ?? []).map(image => ({ url: image.url, alt: image.altText })),
        variants: (product.variants?.nodes ?? []).map(variant => ({
          id: variant.id,
          title: variant.title,
          sku: variant.sku,
          price: Number(variant.price ?? 0),
          compareAtPrice: variant.compareAtPrice === null ? null : Number(variant.compareAtPrice),
          stock: variant.inventoryQuantity,
        })),
      })
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'shopify_orders',
    description: 'List recent orders, newest first, with totals, payment/fulfilment status, line items and customer.',
    parameters: {
      days: { type: 'number', description: 'How far back, in days. Defaults to 30.' },
      limit: { type: 'number', description: 'How many orders, 1 to 100. Defaults to 25.' },
    },
    output,
    async execute(args) {
      await rt.load()
      if (!ready()) return 'No Shopify store is connected. Use shopify_connect first.'
      const days = num(args?.days, 30, 1, 365)
      const limit = num(args?.limit, 25, 1, 100)
      const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
      const data = await call(
        `query($first: Int!, $search: String) {
          orders(first: $first, query: $search, sortKey: CREATED_AT, reverse: true) {
            nodes {
              id name createdAt cancelledAt
              displayFinancialStatus displayFulfillmentStatus
              totalPriceSet { shopMoney { amount currencyCode } }
              customer { id displayName email }
              lineItems(first: 25) { nodes { title quantity sku } }
            }
          }
        }`,
        { first: limit, search: `created_at:>=${since}` },
      )
      const nodes = data?.orders?.nodes ?? []
      if (nodes.length === 0) return `No orders in the last ${days} days.`
      return text(nodes.map(order => ({
        id: order.id,
        name: order.name,
        createdAt: order.createdAt,
        cancelledAt: order.cancelledAt,
        payment: order.displayFinancialStatus,
        fulfilment: order.displayFulfillmentStatus,
        total: money(order.totalPriceSet),
        currency: order.totalPriceSet?.shopMoney?.currencyCode ?? null,
        customer: order.customer ? { id: order.customer.id, name: order.customer.displayName, email: order.customer.email } : null,
        items: (order.lineItems?.nodes ?? []).map(item => ({ title: item.title, quantity: item.quantity, sku: item.sku })),
      })))
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'shopify_inventory',
    description: 'List variants with their stock. Optional search filters by SKU or product title. Flags variants at or below a low-stock threshold.',
    parameters: {
      query: { type: 'string', description: 'Shopify product search, e.g. sku:ABC or title:shirt. Optional.' },
      limit: { type: 'number', description: 'How many variants, 1 to 100. Defaults to 50.' },
      low: { type: 'number', description: 'Low-stock threshold. Defaults to 5.' },
    },
    output,
    async execute(args) {
      await rt.load()
      if (!ready()) return 'No Shopify store is connected. Use shopify_connect first.'
      const limit = num(args?.limit, 50, 1, 100)
      const low = num(args?.low, 5, 0, 1000)
      const search = String(args?.query ?? '').trim() || null
      const data = await call(
        `query($first: Int!, $query: String) {
          productVariants(first: $first, query: $query, sortKey: INVENTORY_QUANTITY) {
            nodes {
              id sku displayName inventoryQuantity
              product { id title handle status }
            }
          }
        }`,
        { first: limit, query: search },
      )
      const nodes = data?.productVariants?.nodes ?? []
      if (nodes.length === 0) return 'No variants matched.'
      return text(nodes.map(variant => ({
        sku: variant.sku,
        variant: variant.displayName,
        product: variant.product?.title ?? null,
        productId: variant.product?.id ?? null,
        status: variant.product?.status ?? null,
        stock: variant.inventoryQuantity,
        low: variant.inventoryQuantity !== null && variant.inventoryQuantity <= low,
      })))
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'shopify_sales_by_product',
    description: 'Rank products by what actually sold in a window: units, revenue and share of the window\'s revenue. Reads up to eight pages of 250 orders; if the window is bigger it says the ranking is a sample.',
    parameters: {
      days: { type: 'number', enum: [7, 30, 90], description: 'Window in days. Defaults to 30.' },
      limit: { type: 'number', description: 'How many products, 1 to 50. Defaults to 10.' },
    },
    output,
    async execute(args) {
      await rt.load()
      if (!ready()) return 'No Shopify store is connected. Use shopify_connect first.'
      const days = [7, 30, 90].includes(Number(args?.days)) ? Number(args.days) : 30
      const limit = num(args?.limit, 10, 1, 50)
      const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
      const products = new Map()
      let cursor = null
      let complete = true
      let currency = null
      for (let page = 0; page < PAGE_CEILING; page += 1) {
        const data = await call(
          `query($cursor: String, $search: String) {
            shop { currencyCode }
            orders(first: 250, after: $cursor, query: $search, sortKey: CREATED_AT) {
              pageInfo { hasNextPage endCursor }
              nodes {
                lineItems(first: 100) {
                  nodes {
                    quantity title
                    product { id }
                    discountedTotalSet { shopMoney { amount currencyCode } }
                  }
                }
              }
            }
          }`,
          { cursor, search: `created_at:>=${since}` },
        )
        currency ??= data?.shop?.currencyCode ?? null
        for (const order of data?.orders?.nodes ?? []) {
          for (const item of order?.lineItems?.nodes ?? []) {
            const key = item?.product?.id ?? `title:${String(item?.title ?? '')}`
            const row = products.get(key) ?? { id: item?.product?.id ?? null, title: item?.title ?? null, units: 0, revenue: 0 }
            row.units += Number(item?.quantity ?? 0)
            row.revenue = Math.round((row.revenue + money(item?.discountedTotalSet)) * 100) / 100
            products.set(key, row)
          }
        }
        if (data?.orders?.pageInfo?.hasNextPage !== true) break
        cursor = data.orders.pageInfo.endCursor
        if (page === PAGE_CEILING - 1) complete = false
      }
      const rows = [...products.values()].sort((a, b) => b.revenue - a.revenue)
      const total = rows.reduce((sum, row) => sum + row.revenue, 0)
      return text({
        complete,
        window: { days, since, currency },
        totals: { revenue: Math.round(total * 100) / 100, products: rows.length },
        products: rows.slice(0, limit).map(row => ({
          ...row,
          share: total === 0 ? 0 : Math.round((row.revenue / total) * 1000) / 10,
        })),
      })
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'shopify_themes',
    description: 'List the store\'s themes with their role (main, unpublished, demo, development). Use the returned id with shopify_theme_files.',
    parameters: {},
    output,
    async execute() {
      await rt.load()
      if (!ready()) return 'No Shopify store is connected. Use shopify_connect first.'
      const data = await call(`query { themes(first: 50) { nodes { id name role createdAt updatedAt } } }`)
      const nodes = data?.themes?.nodes ?? []
      if (nodes.length === 0) return 'No themes returned.'
      return text(nodes.map(theme => ({ id: theme.id, name: theme.name, role: theme.role, updatedAt: theme.updatedAt })))
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'shopify_theme_files',
    description: 'List the files in one theme (templates, sections, snippets, assets). Give the theme id from shopify_themes. Reading a single file\'s contents is not available through the Admin API here; use the Shopify CLI for that.',
    parameters: {
      id: { type: 'string', required: true, description: 'Theme id from shopify_themes (gid://shopify/OnlineStoreTheme/...)' },
      limit: { type: 'number', description: 'How many files, 1 to 250. Defaults to 100.' },
    },
    output,
    async execute(args) {
      await rt.load()
      if (!ready()) return 'No Shopify store is connected. Use shopify_connect first.'
      const id = String(args?.id ?? '').trim()
      if (id === '') return 'Give a theme id from shopify_themes.'
      const limit = num(args?.limit, 100, 1, 250)
      try {
        const data = await call(
          `query($id: ID!, $first: Int!) {
            theme(id: $id) { id name role files(first: $first) { nodes { filename size } } }
          }`,
          { id, first: limit },
        )
        const theme = data?.theme
        if (!theme) return `No theme found for ${id}.`
        const files = (theme.files?.nodes ?? []).map(file => ({ filename: file.filename, size: file.size }))
        return text({ id: theme.id, name: theme.name, role: theme.role, files })
      } catch (error) {
        return `Could not list theme files through the Admin API: ${String(error?.message ?? error)}. Use the Shopify CLI to pull the theme instead.`
      }
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'shopify_pages',
    description: 'List online-store pages (title, handle, updated time, first part of the body). Use it to see which trust pages already exist before proposing new ones.',
    parameters: {
      limit: { type: 'number', description: 'How many pages, 1 to 50. Defaults to 25.' },
    },
    output,
    async execute(args) {
      await rt.load()
      if (!ready()) return 'No Shopify store is connected. Use shopify_connect first.'
      const limit = num(args?.limit, 25, 1, 50)
      const data = await call(
        `query($first: Int!) { pages(first: $first) { nodes { id title handle updatedAt body } } }`,
        { first: limit },
      )
      const nodes = data?.pages?.nodes ?? []
      if (nodes.length === 0) return 'No pages returned.'
      return text(nodes.map(page => ({
        id: page.id,
        title: page.title,
        handle: page.handle,
        updatedAt: page.updatedAt,
        excerpt: String(page.body ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200),
      })))
    },
  }))
}
