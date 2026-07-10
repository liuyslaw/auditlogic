// api/chat.js — interactive Q&A over the current engagement's reconciled
// facilities, via Groq. Same architecture as api/insights.js (which this
// replaces): the key lives only in Vercel's environment, never the browser.
// Grounding is the whole point of this feature — every request re-sends the
// full current facilities data as system context, so answers are based on
// what's actually been reconciled, not on what the model remembers from
// earlier in the conversation or invents.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY not set in Vercel environment variables.' })

  const { messages, facilities, engInfo } = req.body
  if (!messages?.length) {
    return res.status(400).json({ error: 'No message to respond to.' })
  }
  if (!facilities?.length || !engInfo) {
    return res.status(400).json({ error: 'No facilities or engagement info available. Reconcile at least one bank in the A420 Borrowings summary first.' })
  }

  // Same field mapping as the previous AI Insights context — real facility
  // fields, not the old dead loanRecords structure.
  const context = facilities.map(f => ({
    bank: f.bankName,
    facility: [f.facilityName, f.facilitySubName].filter(Boolean).join(' — '),
    limit: f.approvedLimit,
    utilised: f.amtUtilised,
    rate: f.interestRateText || f.interestRateCalc,
    repayment: [f.repaymentLine1, f.repaymentLine2, f.repaymentLine3].filter(Boolean).join(' '),
    security: f.securityBlock,
    covenant: f.loanCovenant,
    purpose: f.purposes,
    facilityDate: f.facilityDate,
    crossRef: f.crossRef,
    settled: f.isSettled === true,
  }))

  const systemPrompt = `You are answering questions about the A420 Borrowings working paper for ${engInfo.client} (${engInfo.regNo}), FY ending ${engInfo.fyEnd}, industry: ${engInfo.industry}.

You have ONLY the reconciled facility data below — not the original source documents, not any external knowledge about this client. Answer strictly from this data.

RULES, follow these exactly:
- If the data answers the question, answer directly and specifically — cite the actual facility name, bank, and figures involved.
- If the question asks about something not covered by this data (a facility not yet reconciled, a document not yet uploaded, a figure not present here), say so plainly. Do not guess, estimate, or fill the gap with plausible-sounding information.
- If a figure or fact in the data looks internally inconsistent or unclear, say that too, rather than confidently picking an interpretation.
- Keep answers concise and direct — this is a professional audit working paper context, not a general chat.
- "covenant", "security", and "rate" fields are freeform text taken directly from the actual bank documents — read them as written.

CURRENT RECONCILED FACILITY DATA:
${JSON.stringify(context, null, 2)}`

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature: 0.2,
        max_tokens: 700,
      }),
    })
    if (!groqRes.ok) {
      const e = await groqRes.json().catch(() => ({}))
      return res.status(groqRes.status).json({ error: e?.error?.message || `Groq error ${groqRes.status}` })
    }
    const data = await groqRes.json()
    return res.status(200).json({ text: data.choices?.[0]?.message?.content || '' })
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to get a response.' })
  }
}
