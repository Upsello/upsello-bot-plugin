// The Shopify ops layer of Upsello Bot, packaged as a dsh plugin: four Agents, the store
// tools they work with, the method as skills, and the weekly loop. It has no interface
// of its own and no account: it runs on ds-bot's team runtime, which publishes `rt` as
// the botRuntime service, so ds-bot has to be mounted first.
import * as store from './src/store.js'
import * as skills from './src/skills.js'
import * as auth from './src/shopify-auth.js'
import * as shopify from './src/shopify-client.js'
import * as connect from './src/shopify-connect.js'
import * as board from './src/board.js'
import * as plan from './src/plan.js'
import * as digest from './src/digest.js'
import * as tools from './src/shopify-tools.js'
import * as writes from './src/shopify-write.js'
import * as agenda from './src/agenda.js'
import * as team from './src/team.js'

export const name = 'upsello-bot-plugin'

export const inject = ['botRuntime']

// The order is the one these modules were installed in beside ds-bot's shell, minus the
// modules that stayed there. board and plan run before digest; team runs last, so its
// bootstrap hook is in place before the first client asks for the team.
export function apply(ctx) {
  const rt = ctx.botRuntime
  store.install(rt)
  skills.install(rt)
  auth.install(rt)
  shopify.install(rt)
  connect.install(rt)
  board.install(rt)
  plan.install(rt)
  digest.install(rt)
  tools.install(rt)
  writes.install(rt)
  agenda.install(rt)
  team.install(rt)
  // ds-bot completes its Agent tool scopes at the end of its own install; the tools added
  // above come after that point, so complete them again.
  rt.syncScopedTools?.()
}
