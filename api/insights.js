// api/insights.js — one-shot audit working paper narrative via Groq.
// Restored alongside api/chat.js (not replaced by it) — this generates the
// structured summary; chat.js handles interactive follow-up questions.
// Both read the same real facilities data (eng.facilities), not the old
// dead loanRecords field.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY not set in Vercel environment variables.' })

  const { facilities, engInfo } = req.body
  if (!facilities?.length || !engInfo) {
    return res.status(400).json({ error: 'No facilities or engagement info to generate an insight from. Reconcile at least one bank in the A420 Borrowings summary first.' })
  }

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
    settled: f.isSettled === true,
  }))

  const prompt = `You are a senior Malaysian audit partner reviewing the A420 Borrowings working paper for an audit engagement. The client is ${engInfo.client} (${engInfo.regNo}), FY ending ${engInfo.fyEnd}, industry: ${engInfo.industry}.

Produce a concise, professional audit working paper narrative in British English covering:

**1. Borrowing Portfolio Overview**
Summarise the borrower, lender(s), total exposure, and document timeline.

**2. Facility Structure & Purpose**
Types of facilities, their purposes, and how they interconnect.

**3. Interest Rate & Repayment Risk**
BLR sensitivity, tenure risk, early settlement exposure, any rate changes across LOs.

**4. Security & Guarantee Assessment**
Quality and adequacy of collateral, personal guarantees, insurance assignments.

**5. Covenant Compliance Considerations**
Key financial covenants (dividend cap, director loan subordination, DSCR if any), and audit implications.

**6. Significant Changes & Audit Flags**
Facility restructuring, limit movements, security changes, anything requiring auditor follow-up or disclosure in financial statements.

350–420 words. Professional working paper tone. Use paragraph headings exactly as shown above.

CLIENT LOAN DATA — each entry represents one reconciled facility. "covenant", "security", and "rate" are freeform text extracted directly from the actual bank documents, not standardised categories — read and interpret them as written, don't expect a fixed structure:
${JSON.stringify(context, null, 2)}`

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.25, max_tokens: 900 }),
    })
    if (!groqRes.ok) {
      const e = await groqRes.json().catch(() => ({}))
      return res.status(groqRes.status).json({ error: e?.error?.message || `Groq error ${groqRes.status}` })
    }
    const data = await groqRes.json()
    return res.status(200).json({ text: data.choices?.[0]?.message?.content || '' })
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to generate insight.' })
  }
}
