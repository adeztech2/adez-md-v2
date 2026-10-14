import os from 'os'

export const name = 'menu'
export const category = 'Main'
export const aliases = ['help', 'commands']
export const description = 'Shows all commands'

const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1).toLowerCase()

function uptime() {
  const s = Math.floor(process.uptime())
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h}h ${m}m`
}

function ramBar() {
  const used = process.memoryUsage().rss
  const total = os.totalmem()
  const pct = Math.min(100, Math.round((used / total) * 100))
  const filled = Math.round(pct / 10)
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled)
  const usedMb = Math.round(used / 1024 / 1024)
  const totalGb = (total / 1024 / 1024 / 1024).toFixed(0)
  return { text: `[${bar}] ${pct}%`, usage: `${usedMb} MB of ${totalGb} GB` }
}

export async function run({ sock, from, m, reply, prefix, getAllCommands }) {
  const botName = process.env.BOT_NAME || 'ADEZ MD'
  const all = getAllCommands()
  const groups = {}

  for (const cmd of all) {
    const cat = cap(cmd.category)
    if (!groups[cat]) groups[cat] = []
    groups[cat].push(cmd.name)
  }

  const sent = Number(m?.messageTimestamp || 0) * 1000
  const speed = sent ? Math.max(0, Date.now() - sent) : 0
  const ram = ramBar()

  let text = `┌▣ ◈ *${botName}* ◈\n`
  text += `│ *OWNER* : Arnold Adez\n`
  text += `│ *PREFIX* : [ ${prefix} ]\n`
  text += `│ *HOST* : Render\n`
  text += `│ *PLUGINS* : ${all.length}\n`
  text += `│ *MODE* : Public\n`
  text += `│ *VERSION* : 1.0.0\n`
  text += `│ *SPEED* : ${speed} ms\n`
  text += `│ *USAGE* : ${ram.usage}\n`
  text += `│ *RAM* : ${ram.text}\n`
  text += `│ *UPTIME* : ${uptime()}\n`
  text += `└▣\n`

  for (const [cat, names] of Object.entries(groups)) {
    text += `\n┌▣ ◈ *${cat.toUpperCase()} MENU* ◈\n`
    for (const n of names.sort()) {
      text += `│ ➽ ${n}\n`
    }
    text += `└▣\n`
  }

  const image = process.env.MENU_IMAGE
  if (image) {
    try {
      await sock.sendMessage(from, { image: { url: image }, caption: text }, { quoted: m })
      return
    } catch (e) {
      console.log('Menu image failed, sending text only:', e.message)
    }
  }

  await reply(text)
}
