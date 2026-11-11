// Modified from DS Bot (Apache-2.0): moved into upsello-bot-plugin and adapted.
// The plan step between the diagnosis and the board. A card can only come from a committed
// plan, and a plan can only come from a fresh diagnosis of the store: check the store, write
// the plan, let the user agree to it, then distribute it as cards.
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './shared.js'

const OWNER_NAMES = ['Uppi boss', 'PDP Agent', 'Social Agent', 'Ads Agent', '用户']
const STALE_MS = 24 * 60 * 60 * 1000

const text = value => (typeof value === 'string' ? value : JSON.stringify(value, null, 2))

export function install(rt) {
  const rootOf = () => rt.upselloRoot ?? join(rt.home, 'upsello')
  const planPath = () => join(rootOf(), 'plan.json')

  function readPlan() {
    try {
      const parsed = JSON.parse(readFileSync(planPath(), 'utf8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  async function writePlan(value) {
    await mkdir(rootOf(), { recursive: true })
    await writeFile(planPath(), JSON.stringify(value, null, 2))
    return value
  }

  const diagnosisOf = () => rt.upselloLastDiagnosis?.() ?? null

  const botNameOf = exec => {
    const id = exec?.agent?.session?.header?.id ?? exec?.agent?.id
    return rt.botOf?.(rt.selfOf?.(id))?.name
  }

  rt.teamTools.push(defineTool({
    name: 'plan_view',
    description: 'Read the current plan: whether it is a draft or committed, what it addresses and who owns each part.',
    parameters: {},
    output,
    async execute() {
      await rt.load()
      const plan = readPlan()
      if (plan === null) return 'No plan yet. Diagnose the store first, then write one.'
      return text(plan)
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'plan_propose',
    description: 'Write this stage\'s plan from the last diagnosis. Each action must address a gap the diagnosis named, and carry an owner, one metric, a baseline and a rollback. Show the result to the user before committing it.',
    parameters: {
      stage: { type: 'number', description: 'Stage number. Defaults to 1.' },
      actions: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            gapId: { type: 'string', description: 'The gap id from store_diagnose, e.g. g1' },
            action: { type: 'string', description: 'What will be done, concretely' },
            owner: { type: 'string', enum: OWNER_NAMES, description: 'Which Agent owns it' },
            metric: { type: 'string', description: 'The one metric it moves' },
            baseline: { type: 'string', description: 'The number it starts from, as read from the store' },
            rollback: { type: 'string', description: 'When to stop and undo' },
            deliverable: { type: 'string', description: 'What must exist when it is done' },
            check: { type: 'string', description: 'How it is verified: trust-pages, orders>=N, product:<handle>, or what to look at' },
            due: { type: 'string', description: 'Week key or date it is due' },
          },
        },
      },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      if (botNameOf(exec) !== 'Uppi boss') return 'Only the Main Bot writes the plan.'
      const diagnosis = diagnosisOf()
      if (diagnosis === null) return 'No diagnosis on record. Run store_diagnose first: the plan must answer what the store actually shows.'
      if (Date.now() - Number(diagnosis.at ?? 0) > STALE_MS) return 'The last diagnosis is over a day old. Run store_diagnose again before planning.'
      const gaps = new Set((diagnosis.gaps ?? []).map(gap => gap.id))
      const list = Array.isArray(args?.actions) ? args.actions : []
      if (list.length === 0) return 'Give at least one action.'
      if (list.length > 5) return 'Keep it to five actions; three is the method.'
      const problems = []
      const actions = list.map((item, index) => {
        const gapId = String(item?.gapId ?? '').trim()
        if (gapId !== '' && !gaps.has(gapId)) problems.push(`${gapId} is not a gap in the last diagnosis`)
        for (const field of ['action', 'metric', 'baseline', 'rollback']) {
          if (String(item?.[field] ?? '').trim() === '') problems.push(`action ${index + 1} has no ${field}`)
        }
        return {
          gapId: gapId || null,
          action: String(item?.action ?? '').trim(),
          owner: OWNER_NAMES.includes(item?.owner) ? item.owner : 'Uppi boss',
          metric: String(item?.metric ?? '').trim(),
          baseline: String(item?.baseline ?? '').trim(),
          rollback: String(item?.rollback ?? '').trim(),
          deliverable: String(item?.deliverable ?? '').trim() || null,
          check: String(item?.check ?? '').trim() || null,
          due: String(item?.due ?? '').trim() || null,
        }
      })
      if (problems.length > 0) return text({ ok: false, problems })
      const plan = await writePlan({
        at: Date.now(),
        stage: Number.isInteger(args?.stage) && args.stage > 0 ? args.stage : 1,
        diagnosisAt: diagnosis.at ?? null,
        status: 'draft',
        actions,
      })
      return text({ ok: true, plan })
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'plan_commit',
    description: 'Turn the approved plan into board cards and hand each one to its owner. Only after the user has seen and agreed to the plan.',
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load()
      if (botNameOf(exec) !== 'Uppi boss') return 'Only the Main Bot commits the plan.'
      const plan = readPlan()
      if (plan === null) return 'No plan to commit. Diagnose the store and write the plan first.'
      if (plan.status === 'committed') return 'This plan is already on the board.'
      if (typeof rt.upselloBoardAddCards !== 'function') return 'The board is not available.'
      const cards = await rt.upselloBoardAddCards(plan.actions.map(action => ({
        title: action.action,
        owner: action.owner,
        deliverable: action.deliverable,
        check: action.check,
        due: action.due,
        gapId: action.gapId,
      })), plan.stage)
      await writePlan({ ...plan, status: 'committed', committedAt: Date.now() })
      return text({
        committed: cards.length,
        cards: cards.map(card => ({ id: card.id, title: card.title, owner: card.owner })),
        next: '每张卡用 message_bot 发给负责人，说明交付物和验收标准；卡完成时会回到你这里验收。',
      })
    },
  }))
}
