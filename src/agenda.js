// Modified from DS Bot (Apache-2.0): moved into upsello-bot-plugin and adapted.
// The weekly loop's record and its diagnosis: the store profile, this week's three
// actions with their owners, metrics, baselines and rollback conditions, and the decision
// log that outlives them. Everything is evidence the store tools returned; nothing here
// estimates a number the store did not give.

import { readFileSync, readdirSync } from 'node:fs'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './shared.js'

const DIAGNOSE_DAYS = [7, 30, 90]
const OWNERS = ['主 Agent', 'PDP Agent', 'Social Agent', 'Ads Agent']
const RESULTS = ['keep', 'rollback', 'scale']
const TRUST_PAGES = [
  { key: 'about', match: /about|关于/i, label: '关于我们' },
  { key: 'refund', match: /refund|return|退换|退货/i, label: '退换政策' },
  { key: 'shipping', match: /shipping|delivery|物流|配送/i, label: '物流说明' },
  { key: 'faq', match: /faq|questions|常见问题/i, label: '常见问题' },
]

const text = value => (typeof value === 'string' ? value : JSON.stringify(value, null, 2))
const num = (value, fallback, min, max) => Math.min(Math.max(Number(value) || fallback, min), max)

function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d - yearStart) / 86_400_000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export function install(rt) {
  const rootOf = () => rt.upselloRoot ?? join(rt.home, 'upsello')
  const agendaDir = () => join(rootOf(), 'agenda')
  const agendaPath = week => join(agendaDir(), `${week}.json`)
  const decisionsPath = () => join(rootOf(), 'decisions.jsonl')

  function readAgenda(week) {
    try {
      const parsed = JSON.parse(readFileSync(agendaPath(week), 'utf8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  async function writeAgenda(week, value) {
    await mkdir(agendaDir(), { recursive: true })
    await writeFile(agendaPath(week), JSON.stringify(value, null, 2))
  }

  function listAgendaWeeks(limit = 8) {
    try {
      return readdirSync(agendaDir())
        .filter(name => /^\d{4}-W\d{2}\.json$/.test(name))
        .map(name => name.slice(0, -5))
        .sort()
        .reverse()
        .slice(0, limit)
    } catch {
      return []
    }
  }

  function readDecisions(limit = 20) {
    try {
      const lines = readFileSync(decisionsPath(), 'utf8').split('\n').filter(line => line.trim() !== '')
      return lines.slice(-limit).map(line => {
        try { return JSON.parse(line) } catch { return { raw: line } }
      })
    } catch {
      return []
    }
  }

  async function addDecision(entry) {
    await mkdir(rootOf(), { recursive: true })
    await appendFile(decisionsPath(), `${JSON.stringify(entry)}\n`)
  }

  // The store as the tools actually see it: orders and sales over the window, stock,
  // page quality and which trust pages exist.
  async function collect(days) {
    const call = rt.shopifyGraphql
    if (typeof call !== 'function') throw new Error('The Shopify client is not installed.')
    if (typeof rt.shopifyConnected !== 'function' || !rt.shopifyConnected()) {
      throw new Error('No Shopify store is connected. Use shopify_connect first.')
    }
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
    const byProduct = new Map()
    let orders = 0
    let revenue = 0
    let currency = null
    let cursor = null
    for (let page = 0; page < 4; page += 1) {
      const data = await call(
        `query($cursor: String, $search: String) {
          shop { currencyCode }
          orders(first: 250, after: $cursor, query: $search, sortKey: CREATED_AT) {
            pageInfo { hasNextPage endCursor }
            nodes {
              totalPriceSet { shopMoney { amount currencyCode } }
              lineItems(first: 100) {
                nodes { quantity title product { id } discountedTotalSet { shopMoney { amount } } }
              }
            }
          }
        }`,
        { cursor, search: `created_at:>=${since}` },
      )
      currency ??= data?.shop?.currencyCode ?? null
      for (const order of data?.orders?.nodes ?? []) {
        orders += 1
        revenue += Number(order?.totalPriceSet?.shopMoney?.amount ?? 0)
        for (const item of order?.lineItems?.nodes ?? []) {
          const key = item?.product?.id ?? `title:${String(item?.title ?? '')}`
          const row = byProduct.get(key) ?? { id: item?.product?.id ?? null, title: item?.title ?? null, units: 0, revenue: 0 }
          row.units += Number(item?.quantity ?? 0)
          row.revenue += Number(item?.discountedTotalSet?.shopMoney?.amount ?? 0)
          byProduct.set(key, row)
        }
      }
      if (data?.orders?.pageInfo?.hasNextPage !== true) break
      cursor = data.orders.pageInfo.endCursor
    }

    const catalogue = await call(
      `query($first: Int!) {
        products(first: $first, sortKey: UPDATED_AT, reverse: true) {
          nodes {
            id title handle status totalInventory
            descriptionHtml
            images(first: 1) { nodes { url } }
          }
        }
      }`,
      { first: 50 },
    ).catch(() => ({ products: { nodes: [] } }))

    const pages = await call(`query { pages(first: 50) { nodes { title handle } } }`)
      .catch(() => ({ pages: { nodes: [] } }))

    return {
      days,
      since,
      currency,
      orders,
      revenue: Math.round(revenue * 100) / 100,
      aov: orders === 0 ? 0 : Math.round((revenue / orders) * 100) / 100,
      byProduct: [...byProduct.values()].sort((a, b) => b.revenue - a.revenue),
      products: (catalogue?.products?.nodes ?? []).map(product => ({
        id: product.id,
        title: product.title,
        handle: product.handle,
        status: product.status,
        stock: product.totalInventory,
        descriptionLength: String(product.descriptionHtml ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length,
        images: (product.images?.nodes ?? []).length,
      })),
      pages: (pages?.pages?.nodes ?? []).map(page => ({ title: page.title, handle: page.handle })),
    }
  }

  function diagnose(data) {
    const gaps = []
    const sold = new Map(data.byProduct.map(row => [row.id ?? `title:${row.title}`, row]))
    const byId = new Map(data.products.map(product => [product.id, product]))
    const push = (gap) => gaps.push(gap)

    if (data.orders < 10) {
      push({
        area: 'traffic',
        finding: `近 ${data.days} 天只有 ${data.orders} 个订单`,
        evidence: `订单 ${data.orders} 单，收入 ${data.revenue} ${data.currency ?? ''}`.trim(),
        impact: 'high',
        owner: 'Ads Agent',
        action: '先用一个小预算验证一个角度，不要同时测人群和素材',
      })
    }

    const top = data.byProduct.slice(0, 5)
    for (const row of top) {
      const product = row.id === null ? undefined : byId.get(row.id)
      if (product === undefined) continue
      if (typeof product.stock === 'number' && product.stock <= 5) {
        push({
          area: 'stock',
          finding: `${product.title} 是卖得最好的品之一，但只剩 ${product.stock} 件`,
          evidence: `近 ${data.days} 天卖出 ${row.units} 件，收入 ${Math.round(row.revenue * 100) / 100} ${data.currency ?? ''}`.trim(),
          impact: 'high',
          owner: '主 Agent',
          action: '补货或先降低投放，避免断货后广告白烧',
        })
      }
      if (product.descriptionLength < 120) {
        push({
          area: 'pdp',
          finding: `${product.title} 有销量，但页面描述只有 ${product.descriptionLength} 字`,
          evidence: `近 ${data.days} 天卖出 ${row.units} 件`,
          impact: 'medium',
          owner: 'PDP Agent',
          action: '补卖点、规格和异议区，先改这一个品',
        })
      }
      if (product.images === 0) {
        push({
          area: 'pdp',
          finding: `${product.title} 没有商品图`,
          evidence: '图片数量为 0',
          impact: 'high',
          owner: 'PDP Agent',
          action: '先补主图，再谈文案',
        })
      }
    }

    const slow = data.products
      .filter(product => typeof product.stock === 'number' && product.stock >= 50 && !sold.has(product.id))
      .sort((a, b) => b.stock - a.stock)
      .slice(0, 3)
    for (const product of slow) {
      push({
        area: 'inventory',
        finding: `${product.title} 有 ${product.stock} 件库存，近 ${data.days} 天没有销量`,
        evidence: '库存高、零销量',
        impact: 'medium',
        owner: 'Ads Agent',
        action: '先用内容或小预算测试这个品有没有需求，卖不动就清库存',
      })
    }

    const haystack = data.pages.map(page => `${page.title ?? ''} ${page.handle ?? ''}`).join(' \n ')
    const missing = TRUST_PAGES.filter(item => !item.match.test(haystack))
    if (missing.length > 0) {
      push({
        area: 'trust',
        finding: `缺少信任页：${missing.map(item => item.label).join('、')}`,
        evidence: `现有页面：${data.pages.map(page => page.title).join('、') || '无'}`,
        impact: data.orders < 30 ? 'high' : 'medium',
        owner: 'PDP Agent',
        action: '先补最贵的两个：退换和物流',
      })
    }

    const score = { high: 3, medium: 2, low: 1 }
    gaps.sort((a, b) => (score[b.impact] ?? 0) - (score[a.impact] ?? 0))
    return {
      baselines: { window: data.days, since: data.since, orders: data.orders, revenue: data.revenue, aov: data.aov, currency: data.currency },
      gaps: gaps.map((gap, index) => ({ id: `g${index + 1}`, ...gap })),
    }
  }

  rt.teamTools.push(defineTool({
    name: 'store_profile_get',
    description: 'Read the store profile this team keeps: name, category, market, currency, timezone and notes. Lists what is still missing so the user can fill it once.',
    parameters: {},
    output,
    async execute() {
      await rt.load()
      const profile = rt.upselloProfile?.() ?? {}
      const shop = rt.upselloShopify?.() ?? {}
      const missing = ['name', 'category', 'market'].filter(key => typeof profile[key] !== 'string' || profile[key].trim() === '')
      return text({
        connected: typeof shop.shop === 'string' ? shop.shop : null,
        profile,
        missing,
      })
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'store_profile_set',
    description: 'Save what the user told you about the store: its name, category, main market, currency, timezone or free notes. Only change what the user actually said.',
    parameters: {
      name: { type: 'string', description: 'Store name shown to customers' },
      category: { type: 'string', description: 'Main category, e.g. beauty, home textiles, consumer electronics' },
      market: { type: 'string', description: 'Main market, e.g. US, EU, Japan' },
      currency: { type: 'string', description: 'Currency code, e.g. USD' },
      timezone: { type: 'string', description: 'IANA timezone, e.g. America/New_York' },
      notes: { type: 'string', description: 'Anything else the team should know: seasons, policies, constraints' },
    },
    output,
    async execute(args) {
      await rt.load()
      const patch = {}
      for (const key of ['name', 'category', 'market', 'currency', 'timezone', 'notes']) {
        const value = args?.[key]
        if (typeof value === 'string' && value.trim() !== '') patch[key] = value.trim()
      }
      if (Object.keys(patch).length === 0) return 'Nothing to save: give at least one field.'
      const profile = await rt.upselloSetProfile(patch)
      return text({ saved: true, profile })
    },
  }))

  // The plan step reads the last diagnosis, so it has to be on disk, not just in a reply.
  async function writeDiagnosis(result) {
    await mkdir(rootOf(), { recursive: true })
    await writeFile(join(rootOf(), 'diagnosis.json'), JSON.stringify({ at: Date.now(), ...result }, null, 2))
  }

  function lastDiagnosis() {
    try {
      return JSON.parse(readFileSync(join(rootOf(), 'diagnosis.json'), 'utf8'))
    } catch {
      return null
    }
  }

  rt.upselloLastDiagnosis = lastDiagnosis

  rt.teamTools.push(defineTool({
    name: 'store_diagnose',
    description: 'Diagnose the store from what the Shopify tools return: orders and revenue for the window, best sellers, stock risks, page quality and missing trust pages. Gaps come back ordered by how much revenue they likely cost.',
    parameters: {
      days: { type: 'number', enum: DIAGNOSE_DAYS, description: 'Window in days. Defaults to 30.' },
    },
    output,
    async execute(args) {
      await rt.load()
      const days = DIAGNOSE_DAYS.includes(Number(args?.days)) ? Number(args.days) : 30
      try {
        const result = diagnose(await collect(days))
        await writeDiagnosis(result)
        return text(result)
      } catch (error) {
        return `Could not diagnose the store: ${String(error?.message ?? error)}`
      }
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'agenda_plan',
    description: 'Write this week\'s agenda. Each action needs an owner, one metric, the baseline it starts from, and the condition that makes it stop. Re-planning the same week replaces its actions.',
    parameters: {
      week: { type: 'string', description: 'Week key like 2026-W45. Defaults to this week.' },
      diagnosis: { type: 'string', description: 'One line: the most expensive problem this week.' },
      actions: {
        type: 'array',
        required: true,
        description: 'One to five actions. Three is the method.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', description: 'What will be done, concretely' },
            owner: { type: 'string', enum: OWNERS, description: 'Which Agent owns it' },
            metric: { type: 'string', description: 'The one metric it moves' },
            baseline: { type: 'string', description: 'The number it starts from, as read from the store' },
            rollback: { type: 'string', description: 'When to stop and undo' },
          },
        },
      },
    },
    output,
    async execute(args) {
      await rt.load()
      const week = typeof args?.week === 'string' && /^\d{4}-W\d{2}$/.test(args.week.trim()) ? args.week.trim() : isoWeek()
      const list = Array.isArray(args?.actions) ? args.actions : []
      if (list.length === 0) return 'Give at least one action.'
      if (list.length > 5) return 'Keep it to five actions at most; three is the method.'
      const actions = list.map((item, index) => ({
        id: `a${index + 1}`,
        action: String(item?.action ?? '').trim(),
        owner: OWNERS.includes(item?.owner) ? item.owner : '主 Agent',
        metric: String(item?.metric ?? '').trim(),
        baseline: String(item?.baseline ?? '').trim(),
        rollback: String(item?.rollback ?? '').trim(),
        status: 'open',
        result: undefined,
      }))
      const incomplete = actions.filter(item => !item.action || !item.metric || !item.baseline || !item.rollback)
      if (incomplete.length > 0) return 'Every action needs action, metric, baseline and rollback. Nothing was written.'
      const previous = readAgenda(week)
      const value = {
        week,
        diagnosis: typeof args?.diagnosis === 'string' ? args.diagnosis.trim() : previous?.diagnosis,
        createdAt: previous?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        actions,
      }
      await writeAgenda(week, value)
      return text({ saved: week, actions })
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'agenda_review',
    description: 'Close this week\'s agenda: record for each action whether it was kept, rolled back or scaled, with one line on what actually happened.',
    parameters: {
      week: { type: 'string', description: 'Week key like 2026-W45. Defaults to this week.' },
      results: {
        type: 'array',
        required: true,
        description: 'One entry per action reviewed.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'Action id from agenda_plan, e.g. a1' },
            status: { type: 'string', enum: RESULTS, description: 'keep, rollback or scale' },
            note: { type: 'string', description: 'What actually happened' },
          },
        },
      },
    },
    output,
    async execute(args) {
      await rt.load()
      const week = typeof args?.week === 'string' && /^\d{4}-W\d{2}$/.test(args.week.trim()) ? args.week.trim() : isoWeek()
      const agenda = readAgenda(week)
      if (agenda === null) return `No agenda saved for ${week}. Plan one first.`
      const list = Array.isArray(args?.results) ? args.results : []
      if (list.length === 0) return 'Give at least one result.'
      const byId = new Map(agenda.actions.map(item => [item.id, item]))
      const unknown = []
      for (const result of list) {
        const action = byId.get(String(result?.id ?? ''))
        if (action === undefined) { unknown.push(result?.id); continue }
        action.status = RESULTS.includes(result?.status) ? result.status : action.status
        action.result = typeof result?.note === 'string' ? result.note.trim() : action.result
        action.reviewedAt = Date.now()
      }
      agenda.updatedAt = Date.now()
      await writeAgenda(week, agenda)
      if (unknown.length > 0) return text({ saved: week, unknown, actions: agenda.actions })
      return text({ saved: week, actions: agenda.actions })
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'decision_add',
    description: 'Write one decision into the log that outlives the week: what we chose, why, what we expected, and later what happened.',
    parameters: {
      context: { type: 'string', required: true, description: 'The problem or evidence that forced a decision' },
      decision: { type: 'string', required: true, description: 'What was decided' },
      expected: { type: 'string', description: 'What the decision should produce' },
      result: { type: 'string', description: 'What happened, filled in at review time' },
    },
    output,
    async execute(args) {
      await rt.load()
      const context = String(args?.context ?? '').trim()
      const decision = String(args?.decision ?? '').trim()
      if (context === '' || decision === '') return 'A decision needs both context and decision.'
      const entry = {
        at: new Date().toISOString(),
        week: isoWeek(),
        context,
        decision,
        ...(typeof args?.expected === 'string' && args.expected.trim() !== '' ? { expected: args.expected.trim() } : {}),
        ...(typeof args?.result === 'string' && args.result.trim() !== '' ? { result: args.result.trim() } : {}),
      }
      await addDecision(entry)
      return text({ saved: true, entry })
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'decision_list',
    description: 'Read the latest decisions, newest last. Use it before proposing something the team may already have tried.',
    parameters: {
      limit: { type: 'number', description: 'How many, 1 to 100. Defaults to 20.' },
    },
    output,
    async execute(args) {
      await rt.load()
      const limit = num(args?.limit, 20, 1, 100)
      const decisions = readDecisions(limit)
      if (decisions.length === 0) return 'No decisions recorded yet.'
      return text(decisions)
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'agenda_list',
    description: 'List saved agendas, newest first, with each action\'s status. Use it at review time or when the user asks what the team chose recently.',
    parameters: {
      limit: { type: 'number', description: 'How many weeks, 1 to 26. Defaults to 8.' },
    },
    output,
    async execute(args) {
      await rt.load()
      const limit = num(args?.limit, 8, 1, 26)
      const weeks = listAgendaWeeks(limit)
      if (weeks.length === 0) return 'No agendas saved yet.'
      return text(weeks.map(week => {
        const agenda = readAgenda(week)
        return {
          week,
          diagnosis: agenda?.diagnosis ?? null,
          actions: (agenda?.actions ?? []).map(item => ({ id: item.id, action: item.action, owner: item.owner, status: item.status, metric: item.metric })),
        }
      }))
    },
  }))

  rt.upselloIsoWeek = isoWeek
}
