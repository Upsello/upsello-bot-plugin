// Modified from DS Bot (Apache-2.0): moved into upsello-bot-plugin and adapted.
// The SOP board: one card per step, owned by one Agent, moving only through the columns the
// method allows. Uppi opens the supervision gate: a card reaches Done only when the Main Bot
// (or the user) accepts the evidence, and a stage opens only when its cards are all accepted.
//
// State lives in <home>/upsello/board.json so a restart never loses the stage.

import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './shared.js'

const COLUMNS = ['backlog', 'doing', 'review', 'done']
const OWNER_NAMES = ['Uppi boss', 'PDP Agent', 'Social Agent', 'Ads Agent', '用户']
const EMPTY = () => ({ version: 1, title: '运营排期', stage: 1, columns: COLUMNS, cards: [], updatedAt: Date.now() })

const text = value => (typeof value === 'string' ? value : JSON.stringify(value, null, 2))

export function install(rt) {
  const pathOf = () => join(rt.upselloRoot ?? join(rt.home, 'upsello'), 'board.json')

  function read() {
    try {
      const parsed = JSON.parse(readFileSync(pathOf(), 'utf8'))
      return parsed !== null && typeof parsed === 'object' ? { ...EMPTY(), ...parsed } : EMPTY()
    } catch {
      return EMPTY()
    }
  }

  async function write(value) {
    const path = pathOf()
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, JSON.stringify(value, null, 2))
  }

  const botNameOf = exec => {
    const id = exec?.agent?.session?.header?.id ?? exec?.agent?.id
    const bot = rt.botOf?.(rt.selfOf?.(id))
    return bot?.name
  }
  const isMain = exec => {
    const id = exec?.agent?.session?.header?.id ?? exec?.agent?.id
    return rt.isMain?.(id) === true
  }
  const cardOf = (board, id) => board.cards.find(card => card.id === String(id ?? ''))

  function addHistory(board, card, action, by, note) {
    card.history ??= []
    card.history.push({ at: Date.now(), action, by, ...(note ? { note } : {}) })
    card.updatedAt = Date.now()
    board.updatedAt = card.updatedAt
  }

  // The UI reads this; it is also what Uppi quotes back to the user.
  const view = () => {
    const board = read()
    const byStatus = Object.fromEntries(COLUMNS.map(column => [column, board.cards.filter(card => card.status === column)]))
    return {
      title: board.title,
      stage: board.stage,
      columns: COLUMNS.map(id => ({
        id,
        cards: byStatus[id].map(card => ({
          id: card.id,
          title: card.title,
          owner: card.owner ?? null,
          deliverable: card.deliverable ?? null,
          check: card.check ?? null,
          due: card.due ?? null,
          status: card.status,
          evidence: card.evidence ?? null,
          artifact: card.artifact ?? null,
          verdict: card.verdict ?? null,
          reason: card.reason ?? null,
          stage: card.stage ?? null,
        })),
      })),
      counts: Object.fromEntries(COLUMNS.map(id => [id, byStatus[id].length])),
      open: board.cards.filter(card => card.status !== 'done').length,
    }
  }

  rt.upselloBoardView = view

  // A move the page makes by dragging. The page can move any card between backlog, doing and
  // review, but only the acceptance gate puts one in Done.
  rt.upselloBoardMove = async (id, status) => {
    if (!COLUMNS.includes(status)) throw new Error('Unknown column.')
    if (status === 'done') throw new Error('A card reaches Done only through the supervision gate.')
    const board = read()
    const card = cardOf(board, id)
    if (card === undefined) throw new Error('Unknown card.')
    card.status = status
    addHistory(board, card, `moved to ${status}`, 'user')
    await write(board)
    return view()
  }

  rt.upselloBoardReview = async (id, verdict, reason) => {
    if (!['approve', 'reject'].includes(verdict)) throw new Error('Verdict must be approve or reject.')
    const board = read()
    const card = cardOf(board, id)
    if (card === undefined) throw new Error('Unknown card.')
    if (card.status !== 'review') throw new Error('Only a card waiting for review can be judged.')
    if (verdict === 'approve') {
      card.status = 'done'
      card.verdict = 'approved'
      delete card.reason
      addHistory(board, card, 'approved', 'user')
    } else {
      card.status = 'doing'
      card.verdict = 'rejected'
      card.reason = String(reason ?? '').trim() || null
      addHistory(board, card, 'rejected', 'user', card.reason)
    }
    await write(board)
    return view()
  }

  rt.teamTools.push(defineTool({
    name: 'board_view',
    description: 'Read the operating board: columns, cards, owners, deliverables, acceptance criteria and what is waiting for review.',
    parameters: {},
    output,
    async execute() {
      await rt.load()
      return text(view())
    },
  }))

  // Cards enter the board only from a committed plan (plan.js), never straight from a chat.
  rt.upselloBoardAddCards = async (cards, stage) => {
    const board = read()
    if (Number.isInteger(stage) && stage > 0) board.stage = stage
    let next = board.cards.length + 1
    const added = []
    for (const item of cards) {
      const title = String(item?.title ?? '').trim()
      if (title === '') continue
      const card = {
        id: `c${String(next).padStart(2, '0')}`,
        title,
        owner: OWNER_NAMES.includes(item?.owner) ? item.owner : 'Uppi boss',
        deliverable: String(item?.deliverable ?? '').trim() || null,
        check: String(item?.check ?? '').trim() || null,
        due: String(item?.due ?? '').trim() || null,
        gapId: String(item?.gapId ?? '').trim() || null,
        stage: board.stage,
        status: 'backlog',
        evidence: null,
        artifact: null,
        verdict: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        history: [],
      }
      next += 1
      board.cards.push(card)
      added.push(card)
    }
    await write(board)
    return added
  }

  rt.teamTools.push(defineTool({
    name: 'board_my_cards',
    description: 'List the cards assigned to you that are not done yet. Start with board_start, finish with board_submit.',
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load()
      const name = botNameOf(exec)
      const board = read()
      const mine = board.cards.filter(card => card.owner === name && card.status !== 'done')
      if (mine.length === 0) return 'No card is assigned to you right now.'
      return text(mine.map(card => ({
        id: card.id,
        title: card.title,
        status: card.status,
        deliverable: card.deliverable,
        check: card.check,
        due: card.due,
        ...(card.reason ? { rejectedBecause: card.reason } : {}),
      })))
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'board_start',
    description: 'Move one of your cards from the backlog to doing.',
    parameters: { id: { type: 'string', required: true, description: 'Card id' } },
    output,
    async execute(args, exec) {
      await rt.load()
      const board = read()
      const card = cardOf(board, args?.id)
      if (card === undefined) return 'Unknown card.'
      if (card.owner !== botNameOf(exec)) return 'That card is not yours.'
      if (card.status !== 'backlog') return `That card is ${card.status}.`
      card.status = 'doing'
      addHistory(board, card, 'started', botNameOf(exec))
      await write(board)
      return `${card.id} is in doing.`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'board_deliver',
    description: 'Deliver one of your cards: the artifact itself (a page URL, a file path, or the copy) plus a one-line summary. The card goes to review with both. No artifact, no delivery.',
    parameters: {
      id: { type: 'string', required: true, description: 'Card id' },
      artifact: { type: 'string', required: true, description: 'What you delivered: a URL, a file path, or the text itself' },
      summary: { type: 'string', description: 'One line: what it is and what changed' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const board = read()
      const card = cardOf(board, args?.id)
      if (card === undefined) return 'Unknown card.'
      if (card.owner !== botNameOf(exec)) return 'That card is not yours.'
      if (card.status !== 'doing') return `That card is ${card.status}; start it first.`
      const artifact = String(args?.artifact ?? '').trim()
      if (artifact === '') return 'Deliver the artifact itself: the URL, the file, or the text. A card without one cannot be reviewed.'
      card.status = 'review'
      card.artifact = artifact
      card.evidence = String(args?.summary ?? '').trim() || null
      card.verdict = null
      delete card.reason
      addHistory(board, card, 'delivered', botNameOf(exec), artifact)
      await write(board)
      return `${card.id} 已交付，等待验收。交付物：${artifact.slice(0, 120)}`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'board_review',
    description: 'The supervision gate. Accept a card that is waiting for review, or send it back with the reason. Only the Main Bot can do this.',
    parameters: {
      id: { type: 'string', required: true, description: 'Card id' },
      verdict: { type: 'string', required: true, enum: ['approve', 'reject'], description: 'approve moves it to done; reject sends it back to doing' },
      reason: { type: 'string', description: 'Required when rejecting: what fails the check' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      if (!isMain(exec)) return 'Only the Main Bot holds the supervision gate.'
      const board = read()
      const card = cardOf(board, args?.id)
      if (card === undefined) return 'Unknown card.'
      if (card.status !== 'review') return `That card is ${card.status}, not waiting for review.`
      if (args?.verdict === 'approve') {
        card.status = 'done'
        card.verdict = 'approved'
        delete card.reason
        addHistory(board, card, 'approved', botNameOf(exec))
        await write(board)
        return `${card.id} is done.`
      }
      if (args?.verdict !== 'reject') return 'Verdict must be approve or reject.'
      const reason = String(args?.reason ?? '').trim()
      if (reason === '') return 'Say why it fails the check, so the Agent can fix it.'
      card.status = 'doing'
      card.verdict = 'rejected'
      card.reason = reason
      addHistory(board, card, 'rejected', botNameOf(exec), reason)
      await write(board)
      return `${card.id} went back to doing: ${reason}`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'board_stage_gate',
    description: 'Check whether the current stage may close: every card of this stage done, and the stage metric met. Returns what is still open.',
    parameters: {
      stage: { type: 'number', description: 'Stage number. Defaults to the current stage.' },
    },
    output,
    async execute(args) {
      await rt.load()
      const board = read()
      const stage = Number.isInteger(args?.stage) ? args.stage : board.stage
      const cards = board.cards.filter(card => card.stage === stage)
      const open = cards.filter(card => card.status !== 'done')
      if (cards.length === 0) return `Stage ${stage} has no cards yet. Plan it first.`
      if (open.length > 0) {
        return text({ stage, closed: false, open: open.map(card => ({ id: card.id, title: card.title, owner: card.owner, status: card.status })) })
      }
      return text({ stage, closed: true, cards: cards.length, note: 'All cards are accepted. The stage may close once the stage metric is checked.' })
    },
  }))

  // What a `check` string can name. Anything else is reviewed by hand, and says so.
  const TRUST_PAGES = [
    { key: 'about', label: '关于我们', match: /about|关于/i },
    { key: 'refund', label: '退换政策', match: /refund|return|退换|退货/i },
    { key: 'shipping', label: '物流说明', match: /shipping|delivery|物流|配送/i },
    { key: 'faq', label: '常见问题', match: /faq|questions|常见问题/i },
  ]

  async function runCheck(card) {
    const check = String(card.check ?? '').trim()
    if (check === '') return { pass: null, note: '这张卡没有定义验收标准，只能人工判断。' }
    if (typeof rt.shopifyConnected !== 'function' || !rt.shopifyConnected()) {
      return { pass: null, note: '店铺未连接，这条验收无法自动执行。' }
    }
    const gql = rt.shopifyGraphql

    if (check === 'trust-pages') {
      const data = await gql(`query { pages(first: 50) { nodes { title handle } } }`)
      const haystack = (data?.pages?.nodes ?? []).map(page => `${page.title ?? ''} ${page.handle ?? ''}`).join(' \n ')
      const missing = TRUST_PAGES.filter(item => !item.match.test(haystack))
      return {
        pass: missing.length === 0,
        evidence: missing.length === 0
          ? `四个信任页都在：${TRUST_PAGES.map(item => item.label).join('、')}`
          : `缺少：${missing.map(item => item.label).join('、')}`,
      }
    }

    const orders = /^orders\s*>=\s*(\d+)$/i.exec(check)
    if (orders !== null) {
      const want = Number(orders[1])
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
      let count = 0
      let cursor = null
      for (let page = 0; page < 4; page += 1) {
        const data = await gql(
          `query($cursor: String, $search: String) {
            orders(first: 250, after: $cursor, query: $search, sortKey: CREATED_AT) {
              pageInfo { hasNextPage endCursor }
              nodes { id }
            }
          }`,
          { cursor, search: `created_at:>=${since}` },
        )
        count += (data?.orders?.nodes ?? []).length
        if (data?.orders?.pageInfo?.hasNextPage !== true) break
        cursor = data.orders.pageInfo.endCursor
      }
      return { pass: count >= want, evidence: `近 30 天订单 ${count} 单，需要 ≥ ${want} 单。` }
    }

    const product = /^product\s*:\s*(\S+)$/i.exec(check)
    if (product !== null) {
      const handle = product[1]
      const data = await gql(
        `query($search: String!) {
          products(first: 1, query: $search) {
            nodes { title descriptionHtml images(first: 1) { nodes { url } } }
          }
        }`,
        { search: `handle:${handle}` },
      )
      const item = data?.products?.nodes?.[0]
      if (item === undefined) return { pass: false, evidence: `找不到商品 ${handle}。` }
      const length = String(item.descriptionHtml ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length
      const images = (item.images?.nodes ?? []).length
      const pass = length >= 120 && images > 0
      return {
        pass,
        evidence: `${item.title}：描述 ${length} 字（需 ≥120），主图 ${images} 张（需 ≥1）。`,
      }
    }

    return { pass: null, note: `“${check}”没有对应的自动检查，请人工验收。` }
  }

  rt.teamTools.push(defineTool({
    name: 'board_check',
    description: 'Run the automatic check a card names (trust-pages, orders>=N, product:<handle>) and say whether it passes. Use it before accepting a card; a check it cannot run says so and is judged by hand.',
    parameters: {
      id: { type: 'string', required: true, description: 'Card id' },
    },
    output,
    async execute(args) {
      await rt.load()
      const board = read()
      const card = cardOf(board, args?.id)
      if (card === undefined) return 'Unknown card.'
      try {
        return text({ card: card.id, check: card.check ?? null, ...(await runCheck(card)) })
      } catch (error) {
        return text({ card: card.id, check: card.check ?? null, pass: null, note: `检查执行失败：${String(error?.message ?? error)}` })
      }
    },
  }))

  // Nothing on this board is allowed to sit still. A card in doing for a day, waiting for
  // review for half a day, or owned by the user with no movement is a stall, and the people
  // who can move it hear about it.
  const STALL_MS = { doing: 24 * 3600e3, review: 12 * 3600e3, human: 24 * 3600e3 }
  const nudgedAt = new Map()

  function stalledCards(board) {
    const now = Date.now()
    return board.cards.filter(card => {
      if (card.status === 'done') return false
      const age = now - Number(card.updatedAt ?? card.createdAt ?? now)
      if (card.status === 'review') return age > STALL_MS.review
      if (card.status === 'doing') return age > STALL_MS.doing
      if (card.status === 'backlog' && card.owner === '用户') return age > STALL_MS.human
      return false
    })
  }

  rt.upselloBoardStalled = () => stalledCards(read()).map(card => ({
    id: card.id,
    title: card.title,
    owner: card.owner ?? null,
    status: card.status,
    idleHours: Math.round((Date.now() - Number(card.updatedAt ?? card.createdAt ?? Date.now())) / 3600e3),
  }))

  async function watchStalls() {
    try {
      await rt.load()
      const stalled = stalledCards(read())
      if (stalled.length === 0) return
      const now = Date.now()
      const fresh = stalled.filter(card => now - (nudgedAt.get(card.id) ?? 0) > 6 * 3600e3)
      if (fresh.length === 0) return
      for (const card of fresh) nudgedAt.set(card.id, now)
      const lines = fresh.map(card => `${card.id} ${card.title}（${card.owner ?? '未分配'}，${card.status}）`).join('\n')
      const message = [
        `有 ${fresh.length} 张卡停着没动：`,
        lines,
        '下一步：属于 Agent 的立刻催负责人并接着推进；属于用户的马上提醒用户要做什么、不做什么会卡住哪一步；都动不了就换方案，不要等。',
      ].join('\n')
      const mainIds = new Set(rt.state?.mainBotIds ?? [])
      for (const bot of Object.values(rt.state?.bots ?? {})) {
        const owns = fresh.some(card => card.owner === bot.name)
        if (!mainIds.has(bot.id) && !owns) continue
        await rt.deliver({ toId: bot.id, role: 'board', text: message })
          .catch(cause => rt.warn?.('ds-bot: board nudge to %s failed: %s', bot.id, cause))
      }
    } catch (error) {
      rt.warn?.('ds-bot: board watch failed: %s', error)
    }
  }

  rt.teamTools.push(defineTool({
    name: 'board_stalled',
    description: 'List the cards that have not moved: doing for a day, waiting for review for half a day, or a user task with no progress. Use it every turn you run the loop, and nudge whoever can move each one.',
    parameters: {},
    output,
    async execute() {
      await rt.load()
      const stalled = rt.upselloBoardStalled()
      if (stalled.length === 0) return '没有停着的卡。'
      return text(stalled)
    },
  }))

  const interval = setInterval(() => { void watchStalls() }, 30 * 60_000)
  interval.unref?.()
  const first = setTimeout(() => { void watchStalls() }, 3 * 60_000)
  first.unref?.()
}
