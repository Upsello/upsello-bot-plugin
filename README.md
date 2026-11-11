# Upsello Bot Plugin

An operations team for a Shopify store, running inside
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

Install it, connect a store, and four long-lived Agents go to work on revenue — each with
its own chat, its own memory, and the tools to actually change the store. It is the
Shopify ops layer of [Upsello Bot](https://upsello.ai/bot), packaged as a dsh plugin,
with no interface and no account of its own.

## What it actually does

**Monday.** The Main Bot reads the store — sales by product, orders, inventory, the pages
people land on — names the three most expensive gaps, and turns each into one action with
an owner, one metric, a baseline, and the condition that would make you roll it back.

**Then.** It hands each action to the Agent who owns it: the product page to PDP Agent,
organic content to Social Agent, paid creative to Ads Agent. What comes back is the work
itself — the rewritten page, the content plan, the ad brief — not advice about it.

**Friday.** It asks each owner what actually happened and writes one decision: kept,
rolled back, or scaled.

Every write to the store — a price, a product, a page, a theme file — waits for your
approval. Every number comes from a tool result; when an Agent does not know, it asks you
instead of guessing.

## The four Agents

| Agent | Owns | Something you can type |
|---|---|---|
| **Uppi boss** (Main) | the weekly loop, priorities, decisions | "这周店里最亏的三件事是什么？" |
| **PDP Agent** | product page copy, structure, objections | "把这款的详情页改一版，先给我看 before/after" |
| **Social Agent** | TikTok / Instagram organic content | "给我这个月上新的 5 条短视频脚本，带前三秒钩子" |
| **Ads Agent** | paid angles and creative briefs | "按差评里的顾虑写 3 条广告角度" |

They work like a team, not four chat windows: they see the same board, remember what each
other learned, and hand work to each other by name.

## What you get installed

- **Four Bots**, seeded once on a fresh install. A team that already has Bots keeps them.
- **Shopify Admin tools** (16): the store summary, products, orders, inventory, pages,
  themes, sales by product; product and page edits, theme file writes, and the Shopify
  CLI sign-in. Every write goes through an approval card unless you allowed it in
  Settings.
- **Five skills** carrying the method: the operating loop, store onboarding, PDP copy
  rules, ad briefs, short-video hooks.
- **The operating board, plan, weekly agenda and a daily digest** (21 tools) the team
  works from.

## Install

Install through dsh — the Plugins page, by package name `upsello-bot-plugin`, or:

```sh
dsh plugin --profile <profile> add upsello-bot-plugin
```

Then make it a bundle in that profile's `package.json`, anywhere after
`@deepseek-ai/dsh-base`:

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "upsello-bot-plugin"] } }
```

Do not `npm install` it into an empty project: outside a dsh profile npm resolves the
`@deepseek-ai/*` peers to old registry releases and the Bot team will not start. dsh
provides those packages itself.

This package brings its own Bot team: when the profile has no runtime publishing the
`botRuntime` service, it mounts [upsello-ds-bot](https://github.com/upsello/upsello-ds-bot)
(DS Bot with that one service added) as a dependency. Where a profile already mounts a
Bot team that provides `botRuntime` — the desktop app does — this package uses that
runtime and mounts nothing.

Requires dsh 0.2.2 or newer.

## Connect a store

Say "连接我的店铺" to the Main Bot: it opens Shopify's authorization page and finishes
the sign-in on this machine. With the Shopify CLI installed, `shopify_connect_cli` does
the same in one step.

Either way the store needs a Shopify app: create one in the Dev Dashboard, set its
redirect URI to `http://127.0.0.1:43119/shopify/callback`, and store `SHOPIFY_CLIENT_ID`
and `SHOPIFY_CLIENT_SECRET` in Settings → Secrets. A build can also ship them in
`shopify-app.json`.

## Where its data lives

`<DSH_HOME>/bot/upsello/`: the connected store, the board, the plan, the agenda, the
digest setting and the store profile, one JSON file each. The Shopify Admin token is kept
in dsh's secrets store, never in these files and never in a prompt.

## What it does not do

No account, no licence check, no telemetry, no network calls of its own besides Shopify
and the public storefront pages the diagnosis reads.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
