# Upsello Bot Plugin

The Shopify ops layer of [Upsello Bot](https://upsello.ai/bot), packaged as a
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin: four
Agents that work on one Shopify store, the Admin API tools they use, the method as
skills, and the weekly loop that keeps them honest.

It ships no interface of its own and no account. It runs on DS Bot's Bot team, so the
Agents are ordinary long-lived Bots: each has its own chat, its own memory, and can hand
work to the others.

## Requirements

- dsh with the plugin API this package uses (0.2.2 or newer).

This package brings its own Bot team: when the profile has no runtime publishing the
`botRuntime` service, it mounts [upsello-ds-bot](https://github.com/upsello/upsello-ds-bot)
(DS Bot with that one service added) as a dependency. Where a profile already mounts a
Bot team that provides `botRuntime` — the desktop app does — this package uses that
runtime and mounts nothing.

## What it adds

- **Four Bots**, seeded once on a fresh install: the Main Bot (`Uppi boss`) runs the
  weekly loop and hands work out; `PDP Agent` owns the product page, `Social Agent` owns
  organic content, `Ads Agent` owns paid creative. A team that already has Bots keeps
  them.
- **Shopify Admin tools** (16): the store summary, products, orders, inventory, pages,
  themes, sales by product; product and page edits, theme file writes, and the Shopify
  CLI sign-in. Every write goes through an approval card unless the user allowed it in
  Settings.
- **Five skills** carrying the method: the operating loop, store onboarding, PDP copy
  rules, ad briefs, short-video hooks.
- **The operating board, plan, weekly agenda and a daily digest** (21 tools) the team
  works from.

## Install

Through the Plugins page, by package name `upsello-bot-plugin`. Through the CLI:

```sh
dsh plugin --profile <profile> add upsello-bot-plugin
```

Then make it a bundle in that profile's `package.json` — anywhere after `@deepseek-ai/dsh-base`:

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "upsello-bot-plugin"] } }
```

A profile that already mounts DS Bot keeps it: `ds-bot` and `upsello-bot-plugin` share one
Bot team.

## Connect a store

Settings → Shopify takes the store domain and signs in through the Shopify CLI when one
is installed. Without the CLI, create an app in the Shopify Dev Dashboard, set its
redirect URI to `http://127.0.0.1:43119/shopify/callback`, and store
`SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` in Settings → Secrets; a build can also
ship them in `shopify-app.json`.

## Where its data lives

`<DSH_HOME>/bot/upsello/`: the connected store, the board, the plan, the agenda, the
digest setting and the store profile, one JSON file each. The Shopify Admin token is
kept in dsh's secrets store, never in these files and never in a prompt.

## What it does not do

No account, no licence check, no telemetry, no network calls of its own besides Shopify
and the public storefront pages the diagnosis reads. It never invents a number: every
figure comes from a tool result.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
