const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages"
const TELEGRAM_API_BASE = `https://api.telegram.org/bot`

function getTelegramUrl(method) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error("Missing env var: TELEGRAM_BOT_TOKEN")
  return `${TELEGRAM_API_BASE}${token}/${method}`
}

function getAnthropicKey() {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error("Missing env var: ANTHROPIC_API_KEY")
  return key
}

async function sendTelegramMessage(chatId, text) {
  const url = getTelegramUrl("sendMessage")
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    console.error("Telegram sendMessage failed:", res.status, err)
  }
}

async function askClaude(userMessage) {
  const res = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": getAnthropicKey(),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system:
        "You are Midori, a helpful and friendly assistant. " +
        "Keep your answers concise and clear.",
      messages: [{ role: "user", content: userMessage }],
    }),
  })

  const data = await res.json()

  if (!res.ok) {
    console.error("Claude API error:", res.status, data)
    throw new Error(
      `Claude returned ${res.status}: ${data?.error?.message ?? "unknown error"}`
    )
  }

  return data.content?.[0]?.text ?? "I could not generate a response."
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).end()
  }

  const chatId = req.body?.message?.chat?.id
  const userText = req.body?.message?.text

  if (!chatId || !userText) {
    return res.status(200).end()
  }

  try {
    const reply = await askClaude(userText)
    await sendTelegramMessage(chatId, reply)
  } catch (err) {
    console.error("Handler error:", err.message)
    await sendTelegramMessage(chatId, "Sorry, something went wrong. Please try again.")
  }

  return res.status(200).end()
}
