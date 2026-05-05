export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).end()
  }

  try {
    const body = req.body

    const message = body.message?.text
    const chatId = body.message?.chat?.id

    if (!message || !chatId) {
      return res.status(200).end()
    }

    // respuesta básica
 const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": process.env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01"
  },
  body: JSON.stringify({
    model: "claude-3-5-haiku-latest",
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: message
      }
    ]
  })
})

const data = await claudeResponse.json()

if (!claudeResponse.ok) {
  console.error("Claude error:", data)
}

let reply = "Error con Claude"

if (!claudeResponse.ok) {
  reply = JSON.stringify(data)
} else {
  reply = data.content?.[0]?.text || "Sin respuesta"
}

    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: reply
      })
    })

    return res.status(200).end()

  } catch (error) {
    console.error(error)
    return res.status(200).end()
  }
}