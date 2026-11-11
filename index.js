// The Shopify ops layer of Upsello Bot, packaged as a dsh plugin: four Agents, the store
// tools they work with, the method as skills, and the weekly loop. It has no interface of
// its own and no account: it runs on the Bot team runtime, which publishes `rt` as the
// botRuntime service.
//
// When the profile has no Bot team yet — a plain dsh install — this plugin mounts
// upsello-ds-bot (DS Bot with that one service added) itself, so one package is enough.
// Where a Bot team is already mounted, it uses that runtime and mounts nothing.
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

// The order is the one these modules were installed in beside DS Bot's shell, minus the
// modules that stay there. board and plan run before digest; team runs last, so its
// bootstrap hook is in place before the first client asks for the team.
function install(rt) {
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
  // The base completes its Agent tool scopes at the end of its own install; the tools
  // added above come after that point, so complete them again.
  rt.syncScopedTools?.()
}

export async function apply(ctx) {
  if (ctx.reflect.get('botRuntime') === undefined) {
    try {
      const base = await import('upsello-ds-bot')
      ctx.plugin(base)
    } catch (error) {
      ctx.logger?.warn?.('upsello-bot-plugin: could not mount upsello-ds-bot: %s', error)
    }
  }
  // Waits for the Bot team: this plugin's own mount above, or one the profile already had.
  ctx.inject(['botRuntime'], inner => install(inner.botRuntime))
}
