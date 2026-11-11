// Modified from DS Bot (Apache-2.0): moved into upsello-bot-plugin and adapted.
// The four skills that carry the ops method. They ship as files beside this module, so the
// text can be edited without touching code, and they reach every Bot through one provider.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROVIDER = 'upsello'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'skills')
const RANK = 540

function parseSkill(raw, path) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  const metadata = frontmatter?.[1] ? Object.fromEntries(
    frontmatter[1].split('\n').map(line => /^(\w[\w-]*):\s*(.+)$/.exec(line.trim())?.slice(1) ?? []).filter(pair => pair.length === 2)) : {}
  if (typeof metadata.description !== 'string' || metadata.description.length === 0) {
    throw new Error(`${PROVIDER}: ${path} has no description`)
  }
  return { description: metadata.description, content: raw.slice(frontmatter[0].length).trim() }
}

function candidate(name) {
  const directory = join(ROOT, name)
  const locator = join(directory, 'SKILL.md')
  const { description } = parseSkill(readFileSync(locator, 'utf8'), locator)
  return {
    name,
    description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER,
    source: 'bundled',
    rank: RANK,
    resourceBase: { kind: 'directory', path: directory.split(sep).join('/') },
    locator,
  }
}

function candidates() {
  const all = []
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      all.push(candidate(entry.name))
    } catch {
      // A half-written skill is left out rather than failing the whole provider.
    }
  }
  return all
}

export function upselloProvider() {
  const all = candidates()
  return {
    name: PROVIDER,
    list: () => Promise.resolve(all),
    async get(item) {
      const { description, content } = parseSkill(readFileSync(item.locator, 'utf8'), item.locator)
      return { ...item, description, content }
    },
  }
}

export function install(rt) {
  rt.ctx.inject?.({ skills: null }, ctx => ctx.skills.registerProvider(() => upselloProvider()))
  // Settings → 技能 lists what this build carries; the text is not editable from the app.
  Object.assign(rt, {
    upselloSkillsView: () => candidates().map(({ name, description }) => ({ name, description })),
  })
}
