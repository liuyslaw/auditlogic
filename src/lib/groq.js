// src/lib/groq.js — two functions, two server routes, same architecture:
// the Groq key lives only in Vercel's environment, never the browser.
//
// generateLoanInsight: one-shot structured working paper summary.
// askChat: interactive follow-up Q&A, grounded in the same facilities data.

export async function generateLoanInsight(facilities, engInfo) {
  const res = await fetch('/api/insights', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ facilities, engInfo }),
  })
  if (!res.ok) {
    const e = await res.json().catch(() => ({}))
    throw new Error(e.error || `Server error ${res.status}`)
  }
  const data = await res.json()
  return data.text || ''
}

export async function askChat(messages, facilities, engInfo) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, facilities, engInfo }),
  })
  if (!res.ok) {
    const e = await res.json().catch(() => ({}))
    throw new Error(e.error || `Server error ${res.status}`)
  }
  const data = await res.json()
  return data.text || ''
}
