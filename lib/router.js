// ============================================================
//  ADEZ MD - lib/router.js  (the brain that finds and runs commands)
// ============================================================
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { getSetting } from './settings.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const COMMANDS_DIR = path.join(ROOT, 'commands')
const OBSERVERS_DIR = path.join(ROOT, 'observers')

const OWNER_NUMBER = (process.env.OWNER_NUMBER || '').replace(/\D/g, '')

const commands = new Map() // name or alias -> command object
const observers = []

// ---------- Helpers ----------
// Turns "254111783552:12@s.whatsapp.net" into "254111783552"
const toNumber = (jid = '') => String(jid).split('@')[0].split(':')[0]

// Walk through folders and sub-folders and collect every .js file
function walk(dir) {
  if (!fs.existsSync(dir)) return []
  let files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files = files.concat(walk(full))
    else if (entry.name.endsWith('.js')) files.push(full)
  }
  return files
}

// ---------- Command loader ----------
export async function loadCommands() {
  commands.clear()
  const files = walk(COMMANDS_DIR)
  for (const file of files) {
    const fileName = path.basename(file)
    try {
      const mod = await import(pathToFileURL(file).href) // pathToFileURL = works on Linux/Render
      const name = mod.name
      const category = mod.category
      const run = mod.run || mod.default

      if (!name) throw new Error('Missing: export const name')
      if (!category) throw new Error('Missing: export const category')
      if (typeof run !== 'function') throw new Error('Missing: export async function run(ctx)')

      const key = String(name).toLowerCase()
      if (commands.has(key)) {
        console.log(`⚠️ DUPLICATE command "${key}" in ${fileName} - skipped`)
        continue
      }

      const cmd = {
        name: key,
        category,
        aliases: mod.aliases || [],
        description: mod.description || '',
        run,
        file: fileName
      }
      commands.set(key, cmd)
      for (const alias of cmd.aliases) {
        const a = String(alias).toLowerCase()
        if (commands.has(a)) console.log(`⚠️ Alias "${a}" of ${key} already used - skipped`)
        else commands.set(a, cmd)
      }
      console.log(`✅ Loaded: ${key} [${category}]`)
    } catch (e) {
      console.log(`❌ FAILED ${fileName}: ${e.stack || e}`)
    }
  }
  console.log(`📦 Total commands loaded: ${getAllCommands().length}`)
}

// ---------- Observer loader ----------
export async function loadObservers() {
  observers.length = 0
  const files = walk(OBSERVERS_DIR)
  for (const file of files) {
    const fileName = path.basename(file)
    try {
      const mod = await import(pathToFileURL(file).href)
      const run = mod.run || mod.default
      if (typeof run !== 'function') throw new Error('Missing: export async function run(ctx)')
      observers.push({ name: mod.name || fileName, run })
      console.log(`👀 Observer loaded: ${mod.name || fileName}`)
    } catch (e) {
      console.log(`❌ FAILED observer ${fileName}: ${e.stack || e}`)
    }
  }
}

// Unique list of commands (aliases not repeated)
export function getAllCommands() {
  return [...new Set(commands.values())]
}

// ---------- LID -> JID resolver ----------
// WhatsApp sometimes shows people as "123@lid". Commands like kick/promote/getpp
// need "number@s.whatsapp.net". This converts it.
export function resolveJid(jid, groupMetadata) {
  if (!jid) return jid
  if (!String(jid).endsWith('@lid')) return jid
  const parts = groupMetadata?.participants || []
  const p = parts.find((x) => x.lid === jid || x.id === jid)
  if (p) {
    if (p.jid && String(p.jid).endsWith('@s.whatsapp.net')) return p.jid
    if (p.phoneNumber) return String(p.phoneNumber).includes('@') ? p.phoneNumber : p.phoneNumber + '@s.whatsapp.net'
    if (String(p.id).endsWith('@s.whatsapp.net')) return p.id
  }
  return jid // could not convert
}

// ---------- Group metadata (cached 30 seconds to avoid WhatsApp rate limits) ----------
const metaCache = new Map()
async function getGroupMeta(sock, jid) {
  const hit = metaCache.get(jid)
  if (hit && Date.now() - hit.time < 30000) return hit.data
  const data = await sock.groupMetadata(jid)
  metaCache.set(jid, { data, time: Date.now() })
  return data
}

function getText(message) {
  if (!message) return ''
  let msg = message
  if (msg.ephemeralMessage) msg = msg.ephemeralMessage.message
  if (msg.viewOnceMessage) msg = msg.viewOnceMessage.message
  if (msg.viewOnceMessageV2) msg = msg.viewOnceMessageV2.message
  if (msg.documentWithCaptionMessage) msg = msg.documentWithCaptionMessage.message
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.buttonsResponseMessage?.selectedButtonId ||
    msg.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ''
  )
}

// ---------- Main message handler ----------
export async function handleMessage(sock, m) {
  if (!m?.message) return
  const PREFIX = getSetting('prefix') || '.'
  const from = m.key.remoteJid
  if (!from || from === 'status@broadcast') return

  const isGroup = from.endsWith('@g.us')
  const senderRaw = isGroup ? m.key.participant || m.participant : from
  const text = getText(m.message).trim()

  // ----- Admin checks -----
  let groupMetadata = null
  let isAdmin = false
  let isBotAdmin = false
  let sender = senderRaw

  if (isGroup) {
    try {
      groupMetadata = await getGroupMeta(sock, from)
      sender = resolveJid(senderRaw, groupMetadata)

      const matches = (p, ids) => ids.some((id) => id && (p.id === id || p.lid === id || p.jid === id || p.phoneNumber === id))
      const senderIds = [senderRaw, sender]
      const botIds = [
        sock.user?.id && toNumber(sock.user.id) + '@s.whatsapp.net',
        sock.user?.lid && toNumber(sock.user.lid) + '@lid'
      ]
      for (const p of groupMetadata.participants) {
        const isAdm = p.admin === 'admin' || p.admin === 'superadmin'
        if (isAdm && matches(p, senderIds)) isAdmin = true
        if (isAdm && matches(p, botIds)) isBotAdmin = true
      }
    } catch (e) {
      console.log(`⚠️ Could not read group info for ${from}: ${e.message}`)
    }
  }

  // The owner is the number the bot is linked with (plus OWNER_NUMBER if it is set)
  const botNumber = toNumber(sock.user?.id)
  const botLid = toNumber(sock.user?.lid)
  const senderNumber = toNumber(sender)
  const isOwner =
    !!m.key.fromMe ||
    (botNumber && senderNumber === botNumber) ||
    (botLid && senderNumber === botLid) ||
    (OWNER_NUMBER && senderNumber === OWNER_NUMBER)

  const reply = (content) => sock.sendMessage(from, typeof content === 'string' ? { text: content } : content, { quoted: m })

  // Everything a command or observer can use
  const ctx = {
    sock, m, from, sender, text, isGroup, isOwner,
    isAdmin, isBotAdmin, groupMetadata,
    prefix: PREFIX, reply,
    resolveJid: (jid) => resolveJid(jid, groupMetadata),
    getAllCommands,
    args: [], command: ''
  }

  // ----- Observers (run in the background so they never slow commands down) -----
  for (const ob of observers) {
    Promise.resolve()
      .then(() => ob.run(ctx))
      .catch((e) => console.log(`❌ Observer "${ob.name}" error: ${e.stack || e}`))
  }

  // ----- Commands -----
  if (!text.startsWith(PREFIX)) return
  const body = text.slice(PREFIX.length).trim()
  if (!body) return
  const args = body.split(/\s+/)
  const commandName = args.shift().toLowerCase()
  ctx.args = args
  ctx.command = commandName

  // Banned people cannot use commands (the owner can always use them)
  if (!isOwner) {
    try {
      const banned = JSON.parse(getSetting('banned') || '[]')
      if (banned.includes(toNumber(sender))) return
    } catch {}
  }

  const cmd = commands.get(commandName)
  if (!cmd) {
    console.log(`❓ Command not found: ${commandName}`)
    return
  }

  try {
    await cmd.run(ctx)
  } catch (e) {
    console.log(`❌ Command "${cmd.name}" (${cmd.file}) crashed: ${e.stack || e}`)
    try { await reply('⚠️ Something went wrong running that command.') } catch {}
  }
     }
