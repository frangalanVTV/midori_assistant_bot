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
    const reply = `Recibí: ${message}`

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