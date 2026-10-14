export const botName = () => process.env.BOT_NAME || 'ADEZ MD'

// rows: ['text'] gives "➽ text", [['key','value']] gives "KEY : value"
export function box(title, rows = []) {
  let t = `┌▣ ◈ *${title}* ◈\n`
  for (const r of rows) {
    if (Array.isArray(r)) t += `│ *${String(r[0]).toUpperCase()}* : ${r[1]}\n`
    else t += `│ ➽ ${r}\n`
  }
  return t + `└▣`
}

// Sends text, with the menu picture on top if MENU_IMAGE is set
export async function sendCard({ sock, from, m, reply }, text) {
  const image = process.env.MENU_IMAGE
  if (image) {
    try {
      await sock.sendMessage(from, { image: { url: image }, caption: text }, { quoted: m })
      return
    } catch (e) {
      console.log('Card image failed, sending text only:', e.message)
    }
  }
  await reply(text)
}
