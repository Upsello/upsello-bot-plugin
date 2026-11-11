// Modified from DS Bot (Apache-2.0): moved into upsello-bot-plugin and adapted.
// The daily digest. Once a day the Main Bot is woken to write one, in its own chat, so it
// reaches the user in the app and on every chat the IM connector is bound to. The digest is
// four short parts: what happened, today's three things, what the user owes, what is stuck.
//
// The hour lives in digest.json next to the board, so the user can move it later.

import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './shared.js'

const DEFAULT_HOUR = 9
const DEFAULT_MINUTE = 0

const PROMPT = [
  '【每日日报】现在是固定的日报时间。写一条日报发在这个聊天里，四段，不要客套：',
  '1. 昨天：做了什么（用 board_view 看已完成的卡，附卡片号和交付物）',
  '2. 今天：三件事，各自负责人（从看板和周议程里取）',
  '3. 需要你：最多两条，写清做什么、截止到什么时候；没有就写"无"',
  '4. 卡住的：哪张卡、卡在哪、下一步是什么（用 board_stalled 查）；没有就写"无"',
  '如果发现有任务停着，先用 message_bot 催负责人；属于用户的事写进第 3 段。',
  '不要编数字：只写工具读到的结果。',
].join('\n')

const localDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

export function install(rt) {
  const rootOf = () => rt.upselloRoot ?? join(rt.home, 'upsello')
  const pathOf = () => join(rootOf(), 'digest.json')

  function read() {
    const base = { hour: DEFAULT_HOUR, minute: DEFAULT_MINUTE, enabled: true, last: null }
    try {
      const parsed = JSON.parse(readFileSync(pathOf(), 'utf8'))
      return parsed !== null && typeof parsed === 'object' ? { ...base, ...parsed } : base
    } catch {
      return base
    }
  }

  async function write(value) {
    await mkdir(rootOf(), { recursive: true })
    await writeFile(pathOf(), JSON.stringify(value, null, 2))
  }

  async function send() {
    await rt.load()
    const mainId = (rt.state?.mainBotIds ?? [])[0]
    if (mainId === undefined) return false
    await rt.deliver({ toId: mainId, role: 'digest', text: PROMPT })
    return true
  }

  async function tick() {
    try {
      const config = read()
      if (config.enabled === false) return
      if (rt.upselloFlag?.('dailyDigest') === false) return
      const now = new Date()
      // Past its time counts: a machine asleep at 09:00 still sends its digest when it
      // wakes, once, because today was never stamped.
      const target = Number(config.hour) * 60 + Number(config.minute)
      if (now.getHours() * 60 + now.getMinutes() < target) return
      const today = localDate(now)
      if (config.last === today) return
      if (!(await send())) return
      await write({ ...config, last: today })
    } catch (error) {
      rt.warn?.('ds-bot: daily digest failed: %s', error)
    }
  }

  const view = () => {
    const { hour, minute, enabled, last } = read()
    return { hour, minute, enabled: enabled !== false, last }
  }

  async function set(patch) {
    const next = { ...read() }
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
    if (Number.isInteger(patch.hour)) next.hour = Math.min(Math.max(patch.hour, 0), 23)
    if (Number.isInteger(patch.minute)) next.minute = Math.min(Math.max(patch.minute, 0), 59)
    await write(next)
    return view()
  }

  Object.assign(rt, { upselloDigestView: view, upselloDigestSet: set })

  const timer = setInterval(() => { void tick() }, 60_000)
  timer.unref?.()

  rt.teamTools.push(defineTool({
    name: 'daily_digest_now',
    description: 'Send the daily digest now instead of waiting for its hour: yesterday, today\'s three things, what the user owes, what is stuck.',
    parameters: {},
    output,
    async execute() {
      const sent = await send()
      return sent ? '日报已发给主 Agent，它会写在这个聊天里，并同步到已绑定的 IM。' : '还没有主 Agent，日报没有地方发。'
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'daily_digest_time',
    description: 'Read or set the hour the daily digest goes out, in the machine\'s local time.',
    parameters: {
      hour: { type: 'number', description: '0–23. Leave out to read the current hour.' },
    },
    output,
    async execute(args) {
      const config = read()
      if (!Number.isInteger(args?.hour)) return `日报时间是每天 ${config.hour}:00。`
      const hour = Math.min(Math.max(Number(args.hour), 0), 23)
      await write({ ...config, hour })
      return `日报时间改为每天 ${hour}:00。`
    },
  }))
}
