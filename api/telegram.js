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

    // 🔥 Llamada a Claude (formato correcto + modelo estable)
    const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-3-haiku-20240307",
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: message
              }
            ]
          }
        ]
      })
    })

    const data = await claudeResponse.json()

    let reply = "Error con Claude"

    if (!claudeResponse.ok) {
      console.error("Claude error:", data)
      reply = JSON.stringify(data)
    } else {
      reply = data.content?.[0]?.text || "Sin respuesta"
    }

    // 📩 Enviar respuesta a Telegram
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

    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: req.body?.message?.chat?.id,
        text: "Error interno"
      })
    })

    return res.status(200).end()
  }
}