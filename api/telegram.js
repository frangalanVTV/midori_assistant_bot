/**
 * api/telegram.js — Expense registration bot
 *
 * State machine states:
 *   idle → waiting_for_amount → waiting_for_project → waiting_for_item
 *       → waiting_for_description → waiting_for_payment_method → waiting_for_confirmation
 */

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic project data — fetched from rendiciones API with a 5-min in-memory cache
// ─────────────────────────────────────────────────────────────────────────────

let _projectsCache = null
let _projectsCacheTs = 0
const PROJECTS_CACHE_TTL = 5 * 60 * 1000

async function getProjectsData() {
  const now = Date.now()
  if (_projectsCache && now - _projectsCacheTs < PROJECTS_CACHE_TTL) {
    return _projectsCache
  }
  const url = process.env.RENDICIONES_API_URL
  const key = process.env.MIDORI_API_KEY
  if (!url || !key) throw new Error("Missing env vars: RENDICIONES_API_URL or MIDORI_API_KEY")
  const res = await fetch(`${url}/api/bot/projects`, {
    headers: { "x-api-key": key },
  })
  if (!res.ok) throw new Error(`Projects API error: ${res.status}`)
  _projectsCache = await res.json()
  _projectsCacheTs = now
  return _projectsCache
}

const PAYMENT_METHODS = [
  { id: "cash",           name: "Cash"           },
  { id: "credit_card",    name: "Credit Card"    },
  { id: "bank_transfer",  name: "Bank Transfer"  },
  { id: "digital_wallet", name: "Digital Wallet" },
]

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️  TEMPORARY in-memory session store
//
// Vercel serverless spins up multiple instances and resets on cold starts,
// so this object is NOT reliable across requests in production.
//
// Replace getSession / setSession / deleteSession with a persistent KV store:
//   • Vercel KV (Upstash Redis)  →  https://vercel.com/docs/storage/vercel-kv
//   • Upstash Redis (direct)     →  https://upstash.com
//   • Supabase                   →  https://supabase.com
//
// The three functions below are the only interface the rest of the code uses,
// so swapping the backend requires changing only those three functions.
// ─────────────────────────────────────────────────────────────────────────────

const _sessions = {}

function sessionKey(chatId, userId) {
  return `${chatId}:${userId}`
}

function getSession(chatId, userId) {
  return _sessions[sessionKey(chatId, userId)] ?? null
}

function setSession(chatId, userId, data) {
  _sessions[sessionKey(chatId, userId)] = data
}

function deleteSession(chatId, userId) {
  delete _sessions[sessionKey(chatId, userId)]
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram helpers
// ─────────────────────────────────────────────────────────────────────────────

function tgUrl(method) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error("Missing env var: TELEGRAM_BOT_TOKEN")
  return `https://api.telegram.org/bot${token}/${method}`
}

async function sendMessage(chatId, text, replyMarkup = null) {
  const body = { chat_id: chatId, text, parse_mode: "HTML" }
  if (replyMarkup) body.reply_markup = replyMarkup

  const res = await fetch(tgUrl("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    console.error("[tg] sendMessage error:", res.status, err.description)
  }
}

async function answerCallbackQuery(callbackQueryId) {
  await fetch(tgUrl("answerCallbackQuery"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  })
}

/**
 * Build an inline keyboard.
 * items: Array<{ name: string, callbackData: string }>
 * columns: how many buttons per row
 */
function inlineKeyboard(items, columns = 2) {
  const rows = []
  for (let i = 0; i < items.length; i += columns) {
    rows.push(
      items.slice(i, i + columns).map((item) => ({
        text: item.name,
        callback_data: item.callbackData,
      }))
    )
  }
  return { inline_keyboard: rows }
}

// ─────────────────────────────────────────────────────────────────────────────
// Amount parsing
// ─────────────────────────────────────────────────────────────────────────────

const SYMBOL_MAP = { "€": "EUR", "$": "USD", "£": "GBP" }

function parseAmount(raw) {
  const t = raw.trim()

  // €42.50  /  $100
  let m = t.match(/^([€$£])\s*([\d]+(?:[.,]\d{1,2})?)$/)
  if (m) {
    return { amount: parseFloat(m[2].replace(",", ".")), currency: SYMBOL_MAP[m[1]] }
  }

  // 42.50 EUR  /  42 eur
  m = t.match(/^([\d]+(?:[.,]\d{1,2})?)\s+([A-Za-z]{3})$/)
  if (m) {
    return { amount: parseFloat(m[1].replace(",", ".")), currency: m[2].toUpperCase() }
  }

  // EUR 42.50  /  usd 100
  m = t.match(/^([A-Za-z]{3})\s+([\d]+(?:[.,]\d{1,2})?)$/)
  if (m) {
    return { amount: parseFloat(m[2].replace(",", ".")), currency: m[1].toUpperCase() }
  }

  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Placeholder OCR
// (v2: call Google Vision, AWS Textract, or similar)
// ─────────────────────────────────────────────────────────────────────────────

function runOcr(/* fileId */) {
  return { amount: null, currency: null, date: null, merchant: null }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step helpers — ask the next question
// ─────────────────────────────────────────────────────────────────────────────

async function askForAmount(chatId) {
  await sendMessage(
    chatId,
    "💬 I couldn't read the amount automatically.\n" +
      "Please enter the amount and currency.\n" +
      "<i>Examples: 42.50 EUR · €42.50 · USD 100</i>"
  )
}

async function askForProject(chatId) {
  const projects = await getProjectsData()
  const keyboard = inlineKeyboard(
    projects.map((p) => ({ name: p.name, callbackData: `proj_${p.id}` })),
    1  // one project per row so names never wrap
  )
  await sendMessage(chatId, "📁 Which project is this expense for?", keyboard)
}

async function askForItem(chatId, projectId) {
  const projects = await getProjectsData()
  const project = projects.find((p) => p.id === projectId)
  const items = project?.items ?? []
  const keyboard = inlineKeyboard(
    items.map((i) => ({ name: i.name, callbackData: `item_${i.id}` }))
  )
  await sendMessage(chatId, "📌 Which budget item does this expense belong to?", keyboard)
}

async function askForDescription(chatId) {
  await sendMessage(
    chatId,
    "📝 Add a description for this expense.\n" +
      '<i>Send any text, or reply <b>skip</b> to leave it blank.</i>'
  )
}

async function askForPaymentMethod(chatId) {
  const keyboard = inlineKeyboard(
    PAYMENT_METHODS.map((m) => ({ name: m.name, callbackData: `pay_${m.id}` }))
  )
  await sendMessage(chatId, "💳 Which payment method was used?", keyboard)
}

async function showSummary(chatId, expense) {
  const lines = [
    "📋 <b>Expense Summary</b>",
    "──────────────────",
    `👤 Submitted by: ${expense.userName}`,
    `📁 Project: ${expense.projectName}`,
    `📌 Item: ${expense.itemName}`,
    `💰 Amount: ${expense.amount} ${expense.currency}`,
    `📝 Description: ${expense.description ?? "No description"}`,
    `💳 Payment: ${expense.paymentMethodName}`,
    expense.date     ? `📅 Date: ${expense.date}`         : null,
    expense.merchant ? `🏪 Merchant: ${expense.merchant}` : null,
    "──────────────────",
    "Confirm this expense?",
  ]
    .filter(Boolean)
    .join("\n")

  const keyboard = {
    inline_keyboard: [[
      { text: "✅ Confirm", callback_data: "conf_yes" },
      { text: "❌ Cancel",  callback_data: "conf_no"  },
    ]],
  }
  await sendMessage(chatId, lines, keyboard)
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow entry point — triggered when a receipt is received
// ─────────────────────────────────────────────────────────────────────────────

async function handleReceipt(chatId, userId, userName, messageId, fileId) {
  const ocr = runOcr(fileId)
  console.log(`[flow] new receipt | user:${userId} (${userName}) | hasAmount:${!!ocr.amount} | hasCurrency:${!!ocr.currency}`)

  const expense = {
    chatId,
    userId,
    userName,
    telegramMessageId: messageId,
    projectId:         null,
    projectName:       null,
    itemId:            null,
    itemName:          null,
    amount:            ocr.amount,
    currency:          ocr.currency,
    date:              ocr.date,
    merchant:          ocr.merchant,
    description:       null,
    paymentMethodId:   null,
    paymentMethodName: null,
    receiptFileId:     fileId,
    createdAt:         new Date().toISOString(),
  }

  await sendMessage(chatId, `🧾 Got it, ${userName}! Let's register this expense.`)

  if (!ocr.amount || !ocr.currency) {
    setSession(chatId, userId, { state: "waiting_for_amount", expense })
    await askForAmount(chatId)
  } else {
    setSession(chatId, userId, { state: "waiting_for_project", expense })
    await askForProject(chatId)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Text message handler (amount input, description input)
// ─────────────────────────────────────────────────────────────────────────────

async function handleText(chatId, userId, text, session) {
  const { state, expense } = session

  if (state === "waiting_for_amount") {
    const parsed = parseAmount(text)
    if (!parsed) {
      await sendMessage(
        chatId,
        "❌ Couldn't parse that. Please use a format like:\n" +
          "<code>42.50 EUR</code>  ·  <code>€42.50</code>  ·  <code>USD 100</code>"
      )
      return
    }
    expense.amount   = parsed.amount
    expense.currency = parsed.currency
    setSession(chatId, userId, { state: "waiting_for_project", expense })
    await askForProject(chatId)
    return
  }

  if (state === "waiting_for_description") {
    const trimmed = text.trim()
    // "skip" or empty → no description
    expense.description =
      !trimmed || trimmed.toLowerCase() === "skip" ? null : trimmed
    setSession(chatId, userId, { state: "waiting_for_payment_method", expense })
    await askForPaymentMethod(chatId)
    return
  }

  // User sent text during another waiting state — remind them
  await sendMessage(
    chatId,
    "⏳ Please complete the current step using the buttons, or send a new receipt to start over."
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Callback query handler (button presses)
// ─────────────────────────────────────────────────────────────────────────────

async function handleCallbackQuery(chatId, userId, callbackQueryId, data, session) {
  // Always acknowledge immediately so the Telegram spinner goes away
  await answerCallbackQuery(callbackQueryId)

  if (!session) {
    await sendMessage(chatId, "No active expense flow. Please send a receipt to begin.")
    return
  }

  const { state, expense } = session

  // ── Project selection ──────────────────────────────────────────────────────
  if (data.startsWith("proj_") && state === "waiting_for_project") {
    const projectId = data.slice(5)
    const projects  = await getProjectsData()
    const project   = projects.find((p) => p.id === projectId)
    if (!project) return

    expense.projectId   = project.id
    expense.projectName = project.name
    setSession(chatId, userId, { state: "waiting_for_item", expense })
    await askForItem(chatId, projectId)
    return
  }

  // ── Budget item selection ──────────────────────────────────────────────────
  if (data.startsWith("item_") && state === "waiting_for_item") {
    const itemId   = data.slice(5)
    const projects = await getProjectsData()
    const project  = projects.find((p) => p.id === expense.projectId)
    const item     = (project?.items ?? []).find((i) => i.id === itemId)
    if (!item) return

    expense.itemId   = item.id
    expense.itemName = item.name
    setSession(chatId, userId, { state: "waiting_for_description", expense })
    await askForDescription(chatId)
    return
  }

  // ── Payment method selection ───────────────────────────────────────────────
  if (data.startsWith("pay_") && state === "waiting_for_payment_method") {
    const payId  = data.slice(4)
    const method = PAYMENT_METHODS.find((m) => m.id === payId)
    if (!method) return

    expense.paymentMethodId   = method.id
    expense.paymentMethodName = method.name
    setSession(chatId, userId, { state: "waiting_for_confirmation", expense })
    await showSummary(chatId, expense)
    return
  }

  // ── Confirmation ───────────────────────────────────────────────────────────
  if (state === "waiting_for_confirmation") {
    if (data === "conf_yes") {
      const final = { ...expense }

      const res = await fetch(`${process.env.RENDICIONES_API_URL}/api/bot/expenses`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.MIDORI_API_KEY },
        body: JSON.stringify({
          amount_cents:    Math.round(final.amount * 100),
          currency:        final.currency || "EUR",
          description:     final.description || final.merchant || "Telegram expense",
          project_id:      final.projectId,
          project_item_id: final.itemId || null,
          paid_by:         final.userName,
          cash_source:     final.paymentMethodName,
          expense_date:    final.date || new Date().toISOString().split("T")[0],
        }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        console.error("[expense] API error:", res.status, err.error)
        await sendMessage(chatId, "⚠️ Could not save expense. Please try again.")
        return
      }

      deleteSession(chatId, userId)
      await sendMessage(chatId, "✅ Expense saved!")
      return
    }

    if (data === "conf_no") {
      deleteSession(chatId, userId)
      await sendMessage(chatId, "🚫 Expense cancelled. Send a new receipt whenever you're ready.")
      return
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Vercel handler — entry point
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Return 200 immediately for non-POST (e.g. Vercel health checks)
  if (req.method !== "POST") {
    return res.status(200).end()
  }

  const update = req.body

  try {
    // ── Callback query (button press) ────────────────────────────────────────
    if (update.callback_query) {
      const cq      = update.callback_query
      const chatId  = cq.message?.chat?.id
      const userId  = cq.from?.id
      if (!chatId || !userId) return res.status(200).end()

      const session = getSession(chatId, userId)
      await handleCallbackQuery(chatId, userId, cq.id, cq.data ?? "", session)

    // ── Regular message ──────────────────────────────────────────────────────
    } else if (update.message) {
      const msg     = update.message
      const chatId  = msg.chat?.id
      const userId  = msg.from?.id
      const userName = msg.from?.first_name ?? msg.from?.username ?? "Unknown"
      if (!chatId || !userId) return res.status(200).end()

      // Photo — use the largest available size (last element in the array)
      if (msg.photo?.length) {
        const fileId = msg.photo[msg.photo.length - 1].file_id
        await handleReceipt(chatId, userId, userName, msg.message_id, fileId)

      // Document (PDF, image file, etc.)
      } else if (msg.document) {
        const fileId = msg.document.file_id
        await handleReceipt(chatId, userId, userName, msg.message_id, fileId)

      // Text message
      } else if (msg.text) {
        const session = getSession(chatId, userId)
        if (session) {
          await handleText(chatId, userId, msg.text, session)
        }
        // No session + plain text → silently ignore (bot is not a chatbot)
      }
    }
  } catch (err) {
    // Log the error but always return 200 so Telegram does not keep retrying
    console.error("[handler] unhandled error:", err.message)
  }

  return res.status(200).end()
}
