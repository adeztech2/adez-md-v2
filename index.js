// ============================================================
//  ADEZ MD - index.js  (v3: every number links with a pair code)
//  Logins are saved in Supabase table bu_sessions (id, data) as 'user_<number>'.
//  Works with your existing lib/router.js, events.js, settings.js, autobio.js
// ============================================================
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import http from 'http'
import express from 'express'
import { Server } from 'socket.io'
import pino from 'pino'
import AdmZip from 'adm-zip'
import { createClient } from '@supabase/supabase-js'
import * as baileysNS from '@whiskeysockets/baileys'
const baileys = baileysNS.useMultiFileAuthState ? baileysNS : (baileysNS.default ?? baileysNS)
const makeWASocket =
  baileysNS.makeWASocket ||
  (typeof baileysNS.default === 'function' ? baileysNS.default : baileysNS.default?.default) ||
  baileys.makeWASocket
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys
import { loadCommands, loadObservers, handleMessage, getAllCommands } from './lib/router.js'
import { registerEvents } from './lib/events.js'
import { box } from './lib/style.js'
import { loadSettings, getSetting } from './lib/settings.js'
import { startAutoBio } from './lib/autobio.js'

// ---------- Quiet the encryption log spam ----------
const NOISE_PREFIXES = [
  'Closing session', 'Closing open session', 'Failed to decrypt message with any known session',
  'Session error:', 'Bad MAC', 'Decrypted message with closed session', 'Removing old closed session'
]
let noiseCount = 0
for (const fn of ['log', 'info', 'warn', 'error']) {
  const orig = console[fn].bind(console)
  console[fn] = (...args) => {
    if (typeof args[0] === 'string' && NOISE_PREFIXES.some((p) => args[0].startsWith(p))) { noiseCount++; return }
    orig(...args)
  }
}
setInterval(() => {
  if (noiseCount > 0) { console.log(`ℹ️ Hid ${noiseCount} encryption log lines in the last minute`); noiseCount = 0 }
}, 60 * 1000).unref()

// ---------- Settings ----------
const BOT_NAME = process.env.BOT_NAME || 'ADEZ MD'
const PORT = process.env.PORT || 3000
const OWNER_NUMBER = String(process.env.OWNER_NUMBER || '').replace(/\D/g, '')
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 5)
const STAGGER_MS = Number(process.env.STAGGER_MS || 4000)
const PAIR_TIMEOUT_MS = 3 * 60 * 1000
const SYNC_INTERVAL = 2 * 60 * 1000
const START_DELAY_MS = Number(process.env.START_DELAY_MS ?? (process.env.RENDER ? 15000 : 0))
const SESSIONS_ROOT = path.resolve('./sessions')

const logger = pino({ level: 'silent' })
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const app = express()
const server = http.createServer(app)
const io = new Server(server)
const sessions = new Map() // id -> state

const connectedCount = () => [...sessions.values()].filter((s) => s.status === 'connected').length
const emitTo = (s, event, payload) => { if (s.pairClient) io.to(s.pairClient).emit(event, payload) }

function makeState(id, opts = {}) {
  return {
    id, number: id.replace(/^user_/, ''), dir: path.join(SESSIONS_ROOT, id),
    sock: null, status: 'starting', restored: !!opts.skipRestore, live: false,
    starting: false, removed: false,
    startTimer: null, syncTimer: null, syncInterval: null, pairTimeout: null,
    pendingSave: Promise.resolve(), lastSync: 0, welcomeSent: false,
    pairNumber: opts.pairNumber || null, pairClient: opts.pairClient || null, pairAsked: false,
    msgCache: new Map()
  }
}

function cacheMessage(s, m) {
  if (!m?.key?.id || !m.message) return
  s.msgCache.set(m.key.id, m.message)
  if (s.msgCache.size > 300) s.msgCache.delete(s.msgCache.keys().next().value)
}

// ---------- Web ----------
app.get('/', (req, res) => {
  res.json({ status: 'ok', bot: BOT_NAME, sessions: sessions.size, connected: connectedCount(), max: MAX_SESSIONS, uptime: Math.floor(process.uptime()) })
})
app.use(express.static('public', { index: false }))

io.on('connection', (client) => {
  client.emit('status', 'waiting_for_scan')
  client.on('requestPair', async (number) => {
    try {
      const clean = String(number || '').replace(/\D/g, '')
      if (clean.length < 8) return client.emit('pairError', 'Enter your number with country code')
      const id = 'user_' + clean
      const existing = sessions.get(id)
      if (existing) {
        if (existing.status === 'connected') return client.emit('pairError', 'This number is already connected')
        return client.emit('pairError', 'Pairing for this number is already in progress, wait 3 minutes')
      }
      if (sessions.size >= MAX_SESSIONS) return client.emit('pairError', 'Bot is full right now. Contact the owner.')

      const s = makeState(id, { skipRestore: true, pairNumber: clean, pairClient: client.id })
      fs.rmSync(s.dir, { recursive: true, force: true })
      sessions.set(id, s)
      s.pairTimeout = setTimeout(() => {
        if (s.status !== 'connected' && !s.removed) {
          emitTo(s, 'pairError', 'Pairing timed out. Try again.')
          removeSession(s, 'pairing timed out')
        }
      }, PAIR_TIMEOUT_MS)
      await startSession(s)
    } catch (e) {
      client.emit('pairError', 'Failed: ' + e.message)
    }
  })
})

// ---------- Supabase ----------
async function restoreSession(s) {
  try {
    const { data, error } = await supabase.from('bu_sessions').select('data').eq('id', s.id).maybeSingle()
    if (error) throw error
    if (data?.data) {
      fs.rmSync(s.dir, { recursive: true, force: true })
      fs.mkdirSync(s.dir, { recursive: true })
      new AdmZip(Buffer.from(data.data, 'base64')).extractAllTo(s.dir, true)
      s.live = true
      console.log(`✅ [${s.id}] Session restored from Supabase`)
    } else console.log(`ℹ️ [${s.id}] No saved session`)
  } catch (e) {
    console.log(`⚠️ [${s.id}] Could not restore session:`, e.message)
  }
}

async function uploadSession(s) {
  try {
    if (s.removed || s.status !== 'connected' || !fs.existsSync(s.dir)) return
    await s.pendingSave
    const zip = new AdmZip()
    zip.addLocalFolder(s.dir)
    const { error } = await supabase.from('bu_sessions').upsert({ id: s.id, data: zip.toBuffer().toString('base64') })
    if (error) throw error
    s.lastSync = Date.now()
    console.log(`☁️ [${s.id}] Session saved to Supabase`)
  } catch (e) {
    console.log(`⚠️ [${s.id}] Session upload failed:`, e.message)
  }
}

function scheduleSync(s) {
  if (s.syncTimer || s.removed) return
  s.syncTimer = setTimeout(async () => { s.syncTimer = null; await uploadSession(s) },
    Math.max(0, SYNC_INTERVAL - (Date.now() - s.lastSync)))
}

async function clearSavedSession(s) {
  fs.rmSync(s.dir, { recursive: true, force: true })
  try { await supabase.from('bu_sessions').delete().eq('id', s.id) } catch {}
}

// ---------- One socket per session ----------
function stopSocket(s) {
  if (!s.sock) return
  const old = s.sock
  s.sock = null
  try { old.ev.removeAllListeners() } catch {}
  try { old.end(undefined) } catch {}
}

function scheduleStart(s, ms) {
  if (s.removed) return
  if (s.startTimer) clearTimeout(s.startTimer)
  s.startTimer = setTimeout(() => {
    s.startTimer = null
    startSession(s).catch((e) => { console.log(`❌ [${s.id}] start failed:`, e.message); scheduleStart(s, 5000) })
  }, ms)
}

async function removeSession(s, reason) {
  if (s.removed) return
  s.removed = true
  console.log(`🗑️ [${s.id}] Removed: ${reason}`)
  for (const t of [s.startTimer, s.syncTimer, s.pairTimeout]) if (t) clearTimeout(t)
  if (s.syncInterval) clearInterval(s.syncInterval)
  stopSocket(s)
  sessions.delete(s.id)
  await clearSavedSession(s)
}

async function startSession(s) {
  if (s.starting || s.removed) return
  s.starting = true
  try {
    stopSocket(s)
    await s.pendingSave
    if (!s.restored) { await restoreSession(s); s.restored = true }

    const { state, saveCreds } = await useMultiFileAuthState(s.dir)
    const { version } = await fetchLatestBaileysVersion()
    const sock = makeWASocket({
      version, auth: state, logger, browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false, syncFullHistory: false, fireInitQueries: false,
      markOnlineOnConnect: false, generateHighQualityLinkPreview: false,
      getMessage: async (key) => s.msgCache.get(key?.id)
    })
    s.sock = sock
    registerEvents(sock)

    sock.ev.on('creds.update', () => {
      s.pendingSave = s.pendingSave.then(() => saveCreds()).catch((e) => console.log(`⚠️ [${s.id}] saveCreds failed:`, e.message))
      scheduleSync(s)
    })

    sock.ev.on('connection.update', async (update) => {
      if (sock !== s.sock || s.removed) return
      const { connection, lastDisconnect, qr } = update

      // A brand-new login is ready: ask WhatsApp for the pair code
      if (qr) {
        if (s.pairNumber && !s.pairAsked) {
          s.pairAsked = true
          s.status = 'waiting_for_pair'
          try {
            const code = await sock.requestPairingCode(s.pairNumber)
            emitTo(s, 'pairCode', code)
            console.log(`🔑 [${s.id}] Pair code sent`)
          } catch (e) {
            emitTo(s, 'pairError', 'Failed: ' + e.message)
            removeSession(s, 'could not get pair code')
          }
        } else if (!s.pairNumber) {
          removeSession(s, 'saved login expired')
        }
      }

      if (connection === 'open') {
        s.status = 'connected'
        s.live = true
        if (s.pairTimeout) { clearTimeout(s.pairTimeout); s.pairTimeout = null }
        emitTo(s, 'status', 'connected')
        emitTo(s, 'connected', true)
        console.log(`✅ [${s.id}] ${BOT_NAME} connected! (${connectedCount()}/${sessions.size})`)
        if (OWNER_NUMBER && s.number === OWNER_NUMBER) startAutoBio(sock)
        uploadSession(s)

        if (!s.syncInterval) {
          s.syncInterval = setInterval(() => {
            if (s.status !== 'connected') return
            try {
              const changed = fs.readdirSync(s.dir).some((f) => fs.statSync(path.join(s.dir, f)).mtimeMs > s.lastSync)
              if (changed) uploadSession(s)
            } catch {}
          }, SYNC_INTERVAL + Math.floor(Math.random() * 30000))
        }

        if (!s.welcomeSent) {
          s.welcomeSent = true
          const prefix = getSetting('prefix') || '.'
          const jid = String(sock.user?.id || '').split(':')[0].split('@')[0] + '@s.whatsapp.net'
          const alert = box(`${BOT_NAME} LINKED`, [
            ['status', 'Connected successfully ✅'],
            ['owner', OWNER_NUMBER && s.number === OWNER_NUMBER ? 'Arnold Adez' : 'You'],
            ['prefix', `[ ${prefix} ]`],
            ['plugins', getAllCommands().length],
            ['time', new Date().toLocaleString('en-GB', { timeZone: 'Africa/Nairobi' })]
          ]) + `\n\n_Type ${prefix}menu to see all commands_`
          const image = process.env.MENU_IMAGE
          try {
            await sock.sendMessage(jid, image ? { image: { url: image }, caption: alert } : { text: alert })
          } catch {
            try { await sock.sendMessage(jid, { text: alert }) } catch (e) { console.log(`⚠️ [${s.id}] welcome failed:`, e.message) }
          }
        }
      }

      if (connection === 'close') {
        s.status = 'disconnected'
        const err = lastDisconnect?.error
        const code = err?.output?.statusCode
        const msg = String(err?.message || '')
        console.log(`❌ [${s.id}] Connection closed. Code: ${code} | ${msg}`)

        // 515 = WhatsApp wants a restart right after pairing. Just reconnect.
        if (code === DisconnectReason.restartRequired) return scheduleStart(s, 1000)

        if (code === DisconnectReason.connectionReplaced || msg.toLowerCase().includes('conflict')) {
          s.status = 'conflict'
          console.log(`🚨 [${s.id}] CONFLICT: another copy uses this login. Stopping this session.`)
          return stopSocket(s)
        }

        if (code === DisconnectReason.loggedOut && s.live) return removeSession(s, 'user logged out')

        if (!s.live) {
          emitTo(s, 'pairError', 'Pairing did not finish. Try again.')
          return removeSession(s, 'pairing did not finish')
        }

        scheduleStart(s, 5000)
      }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (sock !== s.sock) return
      for (const m of messages) cacheMessage(s, m)
      if (type !== 'notify') return
      for (const m of messages) {
        try { await handleMessage(sock, m) } catch (e) { console.log(`❌ [${s.id}] handler error:`, e.stack || e) }
      }
    })
  } finally {
    s.starting = false
  }
}

async function startAllSessions() {
  const ids = []
  try {
    const { data, error } = await supabase.from('bu_sessions').select('id')
    if (error) throw error
    for (const row of data || []) ids.push(row.id)
  } catch (e) {
    console.log('⚠️ Could not list saved sessions:', e.message)
  }
  console.log(`👥 Starting ${Math.min(ids.length, MAX_SESSIONS)} saved session(s) (max ${MAX_SESSIONS})`)
  for (const id of ids.slice(0, MAX_SESSIONS)) {
    const s = makeState(id)
    sessions.set(id, s)
    try { await startSession(s) } catch (e) { console.log(`❌ [${id}] start failed:`, e.message); scheduleStart(s, 5000) }
    await sleep(STAGGER_MS)
  }
}

server.listen(PORT, async () => {
  console.log(`🌐 Server running on port ${PORT}`)
  await loadCommands()
  await loadObservers()
  await loadSettings()
  if (START_DELAY_MS > 0) {
    console.log(`⏳ Waiting ${START_DELAY_MS / 1000}s so any older copy can shut down first...`)
    await sleep(START_DELAY_MS)
  }
  await startAllSessions()
})

async function shutdown() {
  try { await Promise.all([...sessions.values()].map((s) => uploadSession(s))) } catch {}
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('unhandledRejection', (e) => console.log('Unhandled rejection:', e))
process.on('uncaughtException', (e) => console.log('Uncaught exception:', e))
