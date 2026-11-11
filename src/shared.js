// Modified from DS Bot (Apache-2.0): moved into upsello-bot-plugin and adapted.
// The two helpers these modules used from ds-bot's host, copied so this package does
// not import another plugin's files (Apache-2.0, from ds-bot: src/host/tools.js and
// src/host/files.js).
import { rename } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

export const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

// On Windows a file cannot be replaced while another program has it open: another DSH
// reading the state, the search indexer, a virus scanner, a sync client. Those readers
// let go within moments.
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])
const TRIES = 6
const WAIT_MS = 40

export async function replaceFile(temp, path, check = () => {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await rename(temp, path)
    } catch (error) {
      if (process.platform !== 'win32' || attempt >= TRIES || !BUSY.has(error?.code)) throw error
      // Real filesystem contention must clear even while tests freeze application timers.
      await delay(WAIT_MS * attempt)
      check()
    }
  }
}
