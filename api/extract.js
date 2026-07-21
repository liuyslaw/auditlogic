import dotenv from 'dotenv'
   dotenv.config({ path: '.env.local' })


import { Readable } from 'stream'

// Repairs a common LLM JSON-generation defect: a raw, unescaped control
// character (most often a literal newline) sitting inside a quoted string
// value, where valid JSON requires it to be escaped (\n, \r, \t, etc.).
// Walks the text tracking whether we are inside a string literal (respecting
// escaped quotes/backslashes) and escapes any control character found there.
// Does not touch structural whitespace between JSON tokens (outside strings),
// so it cannot change the document's actual structure — only repairs what
// would otherwise be a hard parse failure.
function sanitizeJsonControlChars(text) {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const code = text.charCodeAt(i)
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue }
      if (ch === '\\') { out += ch; escaped = true; continue }
      if (ch === '"') { out += ch; inString = false; continue }
      if (code < 0x20) {
        if (ch === '\n') out += '\\n'
        else if (ch === '\r') out += '\\r'
        else if (ch === '\t') out += '\\t'
        else out += '\\u' + code.toString(16).padStart(4, '0')
        continue
      }
      out += ch
    } else {
      if (ch === '"') inString = true
      out += ch
    }
  }
  return out
}

// ── Parse multipart FormData ──────────────────────────────────────────────
async function parseFormData(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const contentType = req.headers['content-type'] || ''
      const boundaryMatch = contentType.match(/boundary=(.+)/)
      if (!boundaryMatch) return reject(new Error('No boundary in multipart'))
      const boundary = '--' + boundaryMatch[1]
      const parts = {}
      const bodyStr = body.toString('binary')
      const sections = bodyStr.split(boundary).slice(1, -1)
      sections.forEach(section => {
        const [headerPart, ...bodyParts] = section.split('\r\n\r\n')
        const bodyContent = bodyParts.join('\r\n\r\n').replace(/\r\n$/, '')
        const nameMatch = headerPart.match(/name="([^"]+)"/)
        if (!nameMatch) return
        const name = nameMatch[1]
        if (headerPart.includes('filename=')) {
          parts[name] = Buffer.from(bodyContent, 'binary')
        } else {
          parts[name] = bodyContent.trim()
        }
      })
      resolve(parts)
    })
    req.on('error', reject)
  })
}

export const config = { api: { bodyParser: false } }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const apiKey = process.env.ANTHROPIC_API_KEY
console.log('DEBUG apiKey present?', !!apiKey, 'length:', apiKey ? apiKey.length : 0)
console.log('DEBUG matching env keys:', Object.keys(process.env).filter(k => k.includes('ANTHROPIC') || k.includes('GROQ')))
if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in Vercel environment variables.' })

  let parts
  try { parts = await parseFormData(req) }
  catch (e) { return res.status(400).json({ error: 'Failed to parse upload: ' + e.message }) }

  const fileBuffer = parts.file
  const fileName   = parts.fileName || 'document'
  const mediaType  = parts.mediaType || 'application/pdf'
  const fyEnd      = parts.fyEnd || ''

  if (!fileBuffer?.length) return res.status(400).json({ error: 'No file data received.' })

  const fileSizeMB = (fileBuffer.length / 1024 / 1024).toFixed(1)
  const isImage    = ['image/jpeg','image/png','image/gif','image/webp'].includes(mediaType)
  const isPDF      = mediaType === 'application/pdf'
  if (!isPDF && !isImage) return res.status(400).json({ error: `Unsupported type: ${mediaType}` })

  const base64 = fileBuffer.toString('base64')

  // ── EXTRACTION PROMPT — embedding skills: Doc Classification + Field Rules + HP Rules ──
  const prompt = `You are a senior Malaysian audit specialist at SynerGrowth Consulting (SGC).
Your task is to read this bank document and extract facility data for an A420 Borrowings working paper.
You reason like an experienced auditor — not just extracting text, but understanding what each figure means and which document governs each field.

FY END DATE: ${fyEnd || 'not specified'}

═══════════════════════════════════════════════════════════════
STEP 1 — CLASSIFY THE DOCUMENT BEFORE EXTRACTING ANYTHING
═══════════════════════════════════════════════════════════════

Determine which type this document is. Classification controls what you extract:

ORIGINAL LO (Letter of Offer):
  → Introduces NEW facilities not previously offered
  → Extract ALL facilities listed in this document
  → This is the primary source for all 9 fields

SUPPLEMENTARY LO:
  → Amends specific facilities in an existing Original LO
  → Extract ONLY facilities NEWLY INTRODUCED or SPECIFICALLY AMENDED in this document
  → Do NOT extract unchanged facilities that are merely listed for reference or context
  → If you see a list of "existing facilities" followed by "new facilities" — only extract the new/amended ones

RENEWAL LETTER:
  → Renews existing facilities for a new tenure
  → Extract ALL facilities listed
  → CRITICAL: approvedLimit = the CREDIT LIMIT / SANCTIONED AMOUNT in this renewal
  → Do NOT use the current outstanding balance or repayment schedule figure as the limit
  → The approved limit is the HIGHER figure shown next to the facility name
  → IMPORTANT — amortizing term loans specifically: a renewal letter very often restates
    a term loan's CURRENT REDUCING BALANCE (sometimes explicitly labelled, e.g.
    "RM1,531,858.33 (Original Limit: RM1,950,000.00)"), not a new sanctioned limit. When
    you see a parenthetical "(Original Limit: X)" or similar alongside a term loan figure,
    that confirms the leading figure is the amortized balance — this is a downstream
    reconciliation concern (retaining the true original limit across documents), but
    extract BOTH figures here if both are stated, so nothing is lost: put the renewal
    letter's leading/current figure in approvedLimit as normal, and if an "Original
    Limit" is explicitly stated alongside it, also add a changeHistory-style note in
    securityBlock or purposes is NOT appropriate — instead set newLimitTable.present:
    true with existing = the stated Original Limit and newLimit = the renewal letter's
    current/reduced figure, exactly as if it were a normal Existing/New Limit table, so
    downstream reconciliation has both numbers to work with.

COVENANT / CONDITIONS AMENDMENT LETTER (no facility limit table at all):
  → Some letters — often styled as a "Renewal" or reviewing an existing relationship —
    state or amend financial covenants/conditions (e.g. minimum Debt Service Coverage,
    maximum gearing ratio, dividend restrictions, net worth covenants, subordination of
    director advances) WITHOUT listing any facility-by-facility limit table at all. A
    confirmed real example: a CIMB Bank letter titled "RE: RENEWAL OF BANKING
    FACILITY(IES)" contains only two numbered conditions (a Minimum Debt Service
    Coverage of 1x, and a requirement to maintain gearing of not more than 2.5x) with no
    "Form of Facility / Existing Limit / Revised Limit" table anywhere in it.
  → For this type: set "facilities": [] (there is nothing to extract as a facility row —
    do NOT invent a placeholder facility, and do NOT attach the covenant text to a
    fabricated row). Instead, capture the covenant/condition text verbatim-but-concise in
    the top-level "bankLevelCovenant" field (see STEP 1B below) — this is essential; a
    document of this type that returns an empty bankLevelCovenant has lost real
    information the auditor needs, even though facilities is correctly empty.
  → Do not confuse this with an ordinary Renewal Letter that DOES have a facility table
    (see RENEWAL LETTER above) — if there is a facility table, use that classification
    and extract facilities as normal; bankLevelCovenant is only for the no-table case.

NEW LO / RESTRUCTURING:
  → Replaces existing loan structure — treat as Original LO

HIRE PURCHASE AGREEMENT:
  → Extract as ONE facility PER CONTRACT/AGREEMENT NUMBER — not one facility per
    asset, per unit, or per schedule page. Most HP agreements finance a single
    asset and this distinction never comes up, but some finance SEVERAL assets
    together under one agreement — check the Contract/Agreement No. before
    deciding how many facility rows to create.
  → MULTI-ASSET SCHEDULE — WATCH FOR THIS: if the document contains a Schedule
    with repeating blocks like "Vehicle/Equipment Description: Asset 1", "Asset
    2", "Asset 3"... each with its own unit count/description/serial no., but
    ALL of them printed under the SAME Contract/Agreement No., that is the
    signature of ONE agreement bundling several items — not several separate
    facilities. Do NOT create one facility row per Asset block, and do NOT sum
    or multiply a per-item price across those blocks unless the document
    actually states a separate price per item (it usually does not — the asset
    blocks describe WHAT was financed, not HOW MUCH each item cost).
    → In this case, find the ONE total facility amount stated at the
    contract level — this is usually printed in a place OTHER than the asset
    schedule itself: the company's Board Resolution authorising the facility
    ("...to accept the Hire Purchase facility amount of RM X granted by
    [financier]"), and/or the stamp duty receipt ("Balasan/Consideration: RM
    X"). Use that single figure as approvedLimit for the one combined facility
    row. Do not confuse it with a Guarantee Schedule's "Balance originally
    payable under the agreement (Amount Financed + Total Interest Charged)" —
    that figure already has interest added on top (same trap as Format B's
    item (viii) below) and will be noticeably higher than the correct
    approvedLimit.
    → facilityCode = "Hire purchase"; facilitySubName = a combined description
    naming the bundled assets (e.g. "Dry Sanding Booth c/w Air Exhaust System
    (4 units) + Sky-lift & Crane"), not just the first asset in the list.
    CONFIRMED REAL CASE: BMW Credit (Malaysia) HP Agreement No. 7730328
    (Elkom, dated 01.04.2024) bundles 5 asset blocks — Dry Sanding Booth c/w
    Air Exhaust System (A), (B), (C) [2 units], (D), plus a Sky-lift & Crane —
    6 units across 5 descriptions, all under this one contract number. The
    correct approvedLimit is RM282,240.00, confirmed independently by both the
    Board Resolution ("Hire Purchase facility amount of RM 282,240.00") and
    the LHDN stamp duty receipt ("Balasan: RM282,240.00"). The Guarantee
    Schedule's "Balance originally payable" for the same contract is
    RM338,688.00 (282,240 + interest) — WRONG, do not use. A confirmed past
    error was extracting this contract as multiple facility rows (one per
    asset variant), which inflates the combined reported total for this one
    agreement well above the true RM282,240 — if you find yourself about to
    write more than one facility row for a single Contract/Agreement No.,
    stop and re-check whether this multi-asset pattern applies.
  → For an ordinary single-asset HP agreement, approvedLimit = the pre-interest
    financed amount (Cash Price minus Deposit) — NOT any figure that already
    has term charges/interest added on top.
  → See STEP 4 below for the different field-label formats this appears in.

REPAYMENT SCHEDULE:
  → Shows instalment history and balance
  → Extract commencement date, monthly instalment, final instalment
  → Do NOT use the outstanding balance as the approved limit

═══════════════════════════════════════════════════════════════
STEP 1B — DOCUMENT IDENTITY & LINEAGE (for multi-document reconciliation)
═══════════════════════════════════════════════════════════════

Extract three more pieces of document-level metadata — these let the reconcile step
correctly GROUP and SEQUENCE this document against every other document for the
same client, instead of relying on bank name and date alone.

caRefNo — the BANK'S OWN account/facility reference number for this borrower
relationship, usually printed near the top of the letter as "Our Ref", "CA No.",
"Account No." or similar (e.g. "BLK/2013/00000000084"). This stays constant across
every Original LO, Supplementary LO and Renewal Letter for the same facility
relationship — it is the most reliable anchor that two documents belong together,
more reliable than bank name + borrower name alone (a client can hold more than
one loan account with the same bank). Leave "" if genuinely not present on the
document — do not guess or reuse a value seen elsewhere.

supersedesDate — if this letter explicitly states it supersedes/cancels/replaces
an earlier Letter of Offer (commonly a numbered clause near the signature block,
e.g. "This Letter of Offer shall supersede and cancel our earlier Letter of Offer
dated 14 November 2024"), extract that earlier date in DD.MM.YYYY format. This is
a STRONGER sequencing signal than comparing letter dates, particularly when two
letters share the identical date — trust an explicit supersession statement over
date comparison. Leave "" if no such statement is present. If the letter names a
DOCUMENT rather than a date (e.g. "our Letter of Offer Ref XYZ"), still extract
whatever date is given alongside it; if no date is given at all, leave "".

bankLevelCovenant — financial covenants or conditions stated in THIS document that
apply to the banking relationship as a whole (or to all/several facilities under the
stated caRefNo) rather than to one specific facility row. This is most commonly
needed for the COVENANT / CONDITIONS AMENDMENT LETTER type above (see STEP 1), but
applies EQUALLY when an ordinary Original LO or Renewal Letter ALSO has a full
facility table — general covenants and a facility table are not mutually exclusive,
and the general covenants can appear ANYWHERE in the document: before the facility
table, after it, or both. Do not assume bankLevelCovenant is only relevant when
there is no facility table — that under-reads the far more common case where a
document has both.

Look specifically for a numbered general-terms section, commonly (but not always)
titled something like "Financial Covenants", "Dividend Covenant", "Additional
Conditions Precedent", "Post Disbursement Conditions", or similar — sitting
alongside the document's OTHER numbered general sections (Base Lending Rate,
Variation of Rates, Market Disruption, Taxes, Other Terms and Conditions, etc.),
separate from and in addition to each facility's own "Purpose / Interest Rate /
Tenure / Other Conditions" subsection. These general sections are usually a mix of
genuine covenants worth recording and routine legal boilerplate — extract only the
substantive ones (see the two CONFIRMED REAL CASES below for what counts), and
leave out routine boilerplate (tax indemnities, ESG representations, the Bank's
unilateral discretion/refusal rights, governing law/dispute clauses, standard
insurance/valuation rights) — those add no audit value and just bloat the field.

CONFIRMED REAL CASE 1 (Hong Leong Bank, Elkom, Original LO with a full 9-facility
table — Fixed TL/OD/LC/TR/BA/IVF/OFCL/BG/FEC): section "8. Dividend Covenant" (after
the facility table) states "The Borrower shall not declare any dividends in excess
of 50% of its current financial year's Profit After Tax provided always any such
permissible declaration of dividends may only be made if debt servicing is
current." Section "10. Additional Conditions Precedent" and section "13. Post
Disbursement Conditions" (also after the facility table) between them state several
more genuine covenants: maintain a current account with an Automatic Fund Transfer
authorisation; open and maintain a Foreign Currency Account (FCA) for export trade;
evidence of Paid Up Capital increased by RM1,000,000; subordination of director
advances of RM5,000,000 throughout the loan tenure; maintain Tangible Net Worth of
not less than RM15,000,000; maintain the main operating account with the Bank.
CORRECT: bankLevelCovenant captures ALL of these as one concise list (one line
each), e.g. "Dividend: not to exceed 50% of current FY PAT, provided debt servicing
is current.\nMaintain current account with Automatic Fund Transfer authorisation
for facility servicing.\nMaintain a Foreign Currency Account (FCA) for export
trade.\nEvidence Paid Up Capital increased by RM1,000,000.\nSubordination of
director advances of RM5,000,000 throughout the loan tenure.\nMaintain Tangible Net
Worth of not less than RM15,000,000.\nMaintain main operating account with the
Bank." — do NOT leave this "" just because the document also has a full facility
table; that has been a confirmed real gap (this exact case previously extracted
with bankLevelCovenant empty and every facility's own loanCovenant also "N/A",
losing every one of these seven covenants entirely).

CONFIRMED REAL CASE 2 (UOB, Elkom, Original LO with a full facility table covering
OD/LC/TR/FCTR/BA/SG/FG/BEP/GI/IF/FCIF/FX/FL): section "18. Financial Covenants"
(again, after the facility table, alongside other numbered sections like "19. Taxes,
duties or levies" and "20. Other Terms and Conditions") states: gearing ratio not to
exceed 1.50 times (defined as total bank borrowings against tangible net worth plus
subordinated holding-company advances); minimum tangible net worth of RM23,000,000
at all times; no dividend, bonus issue or other distribution without the Bank's
prior written consent; no additional borrowing without the Bank's prior consent
(excluding hire purchase). Clause "20.7 You shall channel your sales proceeds of not
less than 60% to the Bank" is also a genuine ongoing covenant worth capturing, even
though it sits in the "Other Terms and Conditions" section rather than "Financial
Covenants" — judge each clause on whether it imposes a real ongoing obligation, not
on which numbered section it happens to sit under. CORRECT: bankLevelCovenant
captures all of these, e.g. "Gearing ratio not to exceed 1.50x (total bank
borrowings / tangible net worth plus subordinated holding company advances).
\nMinimum tangible net worth of RM23,000,000 at all times.\nNo dividend/bonus
issue/distribution without the Bank's prior written consent.\nNo additional
borrowing without the Bank's prior consent (excluding hire purchase).\nChannel not
less than 60% of sales proceeds to the Bank." Sections 19 (Taxes) and most of
section 20 (the Bank's discretion to refuse utilisation, debenture representations,
inter-company trade restriction, valuation rights) are routine boilerplate — do NOT
extract those.

State each distinct covenant concisely, one per line, the same concise style as
FIELD 7 loanCovenant below. Leave "" only if this document genuinely states no
covenants/conditions of this kind at all — not merely because a facility table is
also present.

═══════════════════════════════════════════════════════════════
STEP 2 — AMENDED / STRUCK-OFF VALUES
═══════════════════════════════════════════════════════════════

Malaysian bank documents frequently contain manual amendments. Apply these rules to every figure you read:

DISCARD any value that is:
  - Struck through with a single line
  - Crossed with two lines (double-cross XX)
  - Cancelled with a wavy line
  - Typed over with XXXXXX characters

THE CORRECT VALUE is always:
  - The handwritten figure written BESIDE the cancelled one (left, right, or below)
  - The handwritten figure written ABOVE with an arrow pointing to it
  - The typed correction in a formal amendment letter

For HP agreements: when two figures appear together, the LOWER one is typically the correct (negotiated) figure. The higher printed figure was the original that got amended.

DO NOT:
  - Average the two figures
  - Use the higher figure assuming it is approved
  - Treat red circles or tick marks (✓) as cancellations — these are audit marks, not cancellations
  - Extract both figures — only the surviving (uncancelled) value

═══════════════════════════════════════════════════════════════
STEP 3 — EXTRACT EACH OF THE 9 FIELDS
═══════════════════════════════════════════════════════════════

FIELD 1 — bankName (Col A)
  - Full legal name exactly as in the LO header or signing page
  - e.g. "Hong Leong Bank Berhad" NOT "HLB"
  - For HP: include asset identifier e.g. "Mercedes-Benz Services Malaysia Sdn. Bhd. (AKL 763)"

FIELD 2 — facilityCode + facilitySubName (Col D)
  - facilityCode: exact facility name as stated e.g. "Fixed Term Loan 3 (Fixed TL3)", "Bankers' Acceptance 2 (BA2)"
  - facilitySubName: scheme/programme name if any e.g. "SMElite 2.0", "SJPP"
  - For HP: facilityCode = "Hire purchase", facilitySubName = asset description
  - Use exact LO terminology — do not abbreviate or paraphrase

FIELD 3 — approvedLimit (Col E) ← MOST CRITICAL FIELD
  Rules:
  - = the SANCTIONED / APPROVED / CREDIT LIMIT (what the bank has approved to lend)
  - Always the HIGHER figure when both limit and outstanding are shown
  - For Renewal Letters: use the renewed facility limit, NOT the outstanding balance
  - For HP: the pre-interest financed amount (Cash Price minus Deposit) — NOT
    any figure with term charges/interest already added. See STEP 4 for the two
    field-label formats this appears in.
  - For settled facilities: retain original approved amount, not zero
  - For cancelled facilities: 0
  - Number only, no RM symbol, no commas

  NEVER USE:
  - Current outstanding balance
  - Repayment schedule closing balance
  - HP Balance Payable (principal + finance charges combined)

FIELD 3B — conditionalIncrease (only when a New Limit increase is contingent on a
future, not-yet-demonstrated event — check this for EVERY facility that has a
newLimitTable with an increase, not just trade bundles)

Malaysian Supplementary LOs occasionally grant an incremental limit increase that
is NOT immediately available — it is conditional on a future performance trigger
stated in the Conditions Precedent or Additional Conditions Precedent section,
e.g. "Drawdown of additional Combined Trade facilities of RM3,000,000-00 upon six
(6) months turnover reach/achieve RM50,000,000-00", or "subject to the Borrower
achieving [some KPI] for [some future period]".

Distinguish this from ROUTINE conditions precedent, which do NOT count here —
these are administrative/executional, not forward-looking performance tests:
acceptance of the LO, execution of legal documentation, signing of guarantees,
perfection/registration of charges, receipt of solicitor confirmations, board
resolutions, insurance arrangements. A limit tied only to conditions like these is
NOT a conditionalIncrease — it is ordinarily available once paperwork is
complete, and should NOT be flagged here.

A conditionalIncrease IS present only when part of the New Limit is expressly
gated behind a forward-looking business/financial performance milestone that has
not yet been demonstrated as met within this document itself (a turnover target,
a revenue threshold, a ratio to be achieved over a future period, and similar).

When present, still extract approvedLimit as the FULL New Limit per FIELD 3 above
— the bank has approved and offered it, do not reduce approvedLimit yourself or
substitute the unconditional portion. This field exists to FLAG the condition for
the auditor, not to change what approvedLimit is. Set:
  "conditionalIncrease": {
    "present": true,
    "conditionText": "upon six (6) months turnover reach/achieve RM50,000,000-00 and completion of legal documentations",
    "unconditionalPortion": 13500000
  }
unconditionalPortion is the limit already unconditionally in force immediately
before this increase (the "Existing" figure in the New Limit table, or the last
confirmed limit if no table is present).

If no such contingency exists for this facility, output:
  "conditionalIncrease": { "present": false, "conditionText": "", "unconditionalPortion": 0 }

FIELD 3C — POOLED / INTERCHANGEABLE SUB-LIMITS (do NOT double-count these)

Malaysian bank facility tables frequently list several named instruments that all
draw from ONE shared pool rather than each being an independent, additive
sanction. Two confirmed signals that this is happening:
  (a) A figure shown in PARENTHESES in the Existing/Change/Revised Limit columns,
      immediately following or beside an unbracketed "anchor" figure for a
      related instrument — the parenthesis is the confirmed convention in these
      documents for "this instrument draws from the same limit as the instrument
      above/beside it," not a second independent sanction.
  (b) Explicit pooling language nearby, most commonly: "the Facilities may be
      utilised interchangeably, provided always that the total amount of the
      Facilities utilised at any one time shall not exceed RM X" (a Multi Option
      Line/MOL-style clause), or two instruments named as alternate drawdown
      MODES of the same underlying line (e.g. a "Facility" and its "Spot"
      counterpart for FX), or a bundle explicitly labelled with a group name
      (e.g. "Trade Facilities") with several named sub-lines beneath it.

WHEN THIS HAPPENS: output ONE facility row for the whole pool, not one row per
named instrument inside it — the exact same treatment this codebase already
gives "Combined Trade" bundles (e.g. "Combined Trade (BA/DC/TR/MCTL)" as a single
row, not four separate ones). Build the combined facilityCode the same way: the
group's own stated name if the document gives one (e.g. "Trade Facilities
(TRD)", "Foreign Exchange Contracts (FX-Facility / FX-Spot)"), or "Combined
Trade (CODE1/CODE2/...)" if it doesn't. approvedLimit for the combined row is the
pool's own ceiling (the unbracketed anchor figure) — NEVER the sum of the
bracketed figures, since they are the SAME exposure restated, not additional
exposure.

EXCEPTION — a sub-instrument with its OWN genuinely SMALLER cap: if one
instrument in the pool is explicitly limited to a lower figure than the pool
ceiling (its own distinct operating constraint, not just a restatement of the
same number), extract THAT one as its own separate row at its own smaller
figure, in addition to the combined pool row for the rest.

CONFIRMED REAL CASE (CIMB Bank, Elkom): a Multi Option Line (MOL) of RM6,000,000
lists Bank Guarantee (BG), Bankers Acceptance (BA), Documentary Credit (DC), Trust
Receipt (TR) and Multi Currency Trade Loan (MCTL) all in parentheses beneath it —
BA, DC, TR and MCTL are each bracketed at the IDENTICAL RM6,000,000 (the same pool
ceiling restated four times — these do NOT get their own rows, they are fully
represented by the MOL row itself), but BG is bracketed at a DIFFERENT, smaller
RM100,000 ("BG shall be operated up to RM100,000.00 only" is stated explicitly
in the same letter) — BG DOES get its own row, at RM100,000, because that is a
genuinely narrower sub-cap the auditor needs to see, not a restatement of the
RM6,000,000 pool.

CONFIRMED REAL CASE, GET THIS RIGHT (United Overseas Bank, Elkom): "Foreign
Exchange Contracts (FX-Facility)" and "Spot Foreign Exchange Contracts
(FX-Spot)" are stated as an Existing/Change/Revised Limit pair at the IDENTICAL
RM28,300,000 (Spot shown in parentheses — the standard forward-vs-spot mirror of
one FX line, not a second facility). CORRECT: ONE row, "Foreign Exchange
Contracts (FX-Facility / FX-Spot)", approvedLimit RM28,300,000. WRONG, an actual
regression seen in production: two separate rows, each at RM28,300,000,
overstating this one exposure by RM28,300,000.

CONFIRMED REAL CASE, GET THIS RIGHT (Alliance Bank, Elkom): "Trade Facilities
(TRD)" is stated at RM6,000,000 with Letter of Credit, Trust Receipt and Bankers
Acceptance sub-lines all bracketed at the identical RM6,000,000, and Shipping
Guarantee and Bank Guarantee sub-lines bracketed at a smaller RM1,000,000.
CORRECT: two rows — "Trade Facilities (TRD) — LC/TR/BA Sub-lines" at
RM6,000,000, and "Trade Facilities (TRD) — SG/BG Sub-lines" at RM1,000,000 (SG
and BG share their OWN distinct RM1,000,000 sub-pool, smaller than the main
RM6,000,000 pool, per the EXCEPTION above — so they bundle together at their own
figure, not with LC/TR/BA, and not as three more separate rows each restating a
limit). WRONG, an actual regression seen in production: six separate rows (TRD,
plus LC, TR, BA, SG and BG each again at their pool's full figure) — inflating
this bank's total by roughly RM19 million for one relationship.

FIELD 3D — SECURED/MARGIN AMOUNT vs FACILITY LIMIT (do NOT confuse these)

Forward Exchange Contract (FEC), FX and similar hedging-type facilities are
routinely secured by a "risk factor" or margin — a SMALLER percentage of the
actual facility limit, held as security, not the limit itself. Confirmed real
pattern (Hong Leong Bank, Elkom, FEC): a table row states "Forward Exchange
Contract (FEC) Facility secured at RM1,000,000.00 (which is up to 10% of the
FEC limit)" — the RM1,000,000 figure here is the SECURITY/MARGIN amount, not
the limit. The same document, in its own facility-by-facility detail section,
separately and explicitly states "(IX) Forward Exchange Contract ('FEC') ...
Limit: RM10,000,000.00 which is to be secured by 10% risk factor" — confirming
the true approvedLimit is RM10,000,000, ten times the margin figure. WRONG, an
actual regression seen in production: extracting RM1,000,000 as approvedLimit
(the margin, mistaken for the limit) — understating this facility by 90%.
RULE: whenever a facility is described as "secured at/up to X% risk factor" or
similar margin/security wording, that percentage figure is NEVER the
approvedLimit. Find and use the explicit "Limit: RM..." statement for that
same facility elsewhere in the document (commonly in a later facility-by-
facility detail section even when the summary table only shows the secured
amount). If truly no explicit Limit figure is stated anywhere in the document
for that facility, and only a secured amount is given, back-calculate the
limit from the stated percentage (secured amount ÷ risk factor %) rather than
using the secured amount directly, and note the derivation in purposes.

FIELD 3E — RENEWAL/REVIEW LETTERS RESTATING MULTIPLE EXISTING FACILITIES

A Renewal Letter or periodic review letter (see STEP 1) very often restates
SEVERAL existing facilities together in one table — e.g. two Fixed Term Loans,
an Overdraft, and a Combined Trade group all in the same letter, each with its
own current balance/limit. When this happens, match each restated figure to
its facility type EXACTLY as labelled in THIS document — never relabel, merge,
or reassign a restated figure to a different facility type than the one
printed beside it, even if two facilities in the same letter happen to share a
similar or identical amount. Output exactly one row per facility type actually
present in the letter's table — do not manufacture an additional row for a
facility type that is not separately labelled in the document. Confirmed real
case (Hong Leong Bank, Elkom, review letter dated 4.1.2022): the letter
restates "Fixed Term Loan (Fixed TL) – SRF", "Fixed Term Loan (Fixed TL)" and
"Overdraft (OD)" as three separate, clearly-labelled lines (RM843,018.97,
RM1,686,137.52 and RM1,500,000.00 respectively) — there is no second/new Fixed
Term Loan anywhere in this letter. WRONG, an actual regression seen in
production: outputting the Overdraft's RM1,500,000 figure as a second, distinct
"Fixed Term Loan" facility — this fabricates a facility that does not exist in
the source document at all.

FIELD 4 — interestRateText + interestRateCalc (Col I)
  Two-part format:
  - interestRateText: exactly as stated e.g. "BLR - 2.59%", "BLR + 0.5%", "2.5% plus BNM Funding rate"
  - interestRateCalc: computed formula starting with = e.g. "=6.89%-2.59%"
  - If rate is same as another facility: use cross-reference e.g. "=I35"
  - For BNM SRF facilities: show both moratorium rate and post-moratorium rate on separate lines

  For HP only:
  - interestRateCalc: flat rate as decimal e.g. 3.50% flat → 0.035
  - Do NOT use percentage sign for HP rates
  - Derive from stated flat rate or from: Finance Charges / (Net Finance Amount × Years)

FIELD 5 — repaymentLine1, repaymentLine2, repaymentLine3 (Col J)
  For LOANS (3-line format):
  - Line 1: "[X] years by [words] ([number])" e.g. "25 years by three hundred (300)"
  - Line 2: "monthly installments of RM[amount]" e.g. "monthly installments of RM15,008"
  - Line 3: "each inclusive of interest." (if stated in LO)
  - For BA/OD/revolving: "Upon maturity date" or "On demand"

  For HP — two formats exist in Malaysian practice:
  FORMAT 1 (older):
    Line 1: "Installment commence on DD.M.YYYY"
    Line 2: "with each installment of RMXXX and"
    Line 3: "final installment of RMXXX"
  FORMAT 2 (newer, e.g. NDY 3300, SU511L):
    Line 1: "Installment of RMXXX each month"
    Line 2: "commence on DD.MM.YYYY"
    Line 3: "with final installment of RMXXX"

  Use whichever format matches the document style.
  Monthly instalment ≠ final instalment — extract both separately.

FIELD 6 — securityBlock (Col L)
  - CONCISE SUMMARY only — this is a working paper, not a legal document
  - Maximum 8–10 lines
  - Structure: security type header, then specific details
  - Include: type of charge, Title/Lot number, Mukim, District, charged sum
  - Include: guarantor names (IC numbers optional)
  - For upstamped facilities: "Upstamp existing Facilities Agreement to secure principal sum of RMXXX"
  - For HP: always "N/A"
  - For "Refer A4201": use that phrase verbatim

  DO NOT:
  - Transcribe full legal paragraphs or guarantee clause boilerplate
  - Include "The Bank has the right to..." type standard clauses
  - Reproduce entire pages of terms and conditions

FIELD 7 — loanCovenant (Col Q)
  - "N/A" if no covenants
  - If present, state substance concisely. Categories to capture:
    - Dividend covenant: percentage cap, PAT reference, debt service condition
    - Financial ratios: the ratio and minimum threshold (e.g. gearing, DSC)
    - Net worth covenants: minimum amount (tangible net worth, shareholders' funds)
    - Change of control: threshold percentage
    - Paid up capital requirements: minimum amount or required increase
    - Subordination of director/shareholder advances: amount and duration
    - Account-maintenance obligations tied to this specific facility: e.g. maintain
      a Foreign Currency Account (FCA) for trade facilities, maintain a current
      account with Automatic Fund Transfer (AFT) authorisation for facility
      servicing, maintain the main operating account with the Bank
    - Supplier list / buyer list submission or approval conditions attached to a
      trade facility (LC/TR/BA/IVF/OFCL) — e.g. "Other Conditions: submit list of
      suppliers for the Bank's records" repeated under a facility's own subsection
      is a genuine loanCovenant for that row, not boilerplate to discard, even when
      identical text is repeated verbatim under several sibling trade facilities
      (each sibling gets its own copy of the same text — do not leave it "N/A" on
      some rows just because it is not unique to that row)
  - Do NOT extract as a covenant: routine tax indemnities, ESG/compliance
    representations, the Bank's unilateral discretion or refusal-to-utilise rights,
    standard governing law/dispute resolution clauses, insurance or valuation
    interval clauses — these are boilerplate, not covenants.
  - Common Malaysian format: "Shall not declare any dividend in excess of X% of CY PAT provided debt servicing is current"
  - This is for covenants stated AGAINST a SPECIFIC facility row (including
    identical boilerplate conditions repeated under that row's own subsection —
    see supplier list example above). If instead the covenant applies to the whole
    banking relationship / all facilities under this caRefNo generally (not tied to
    one row, e.g. a standalone numbered section like "Dividend Covenant" or
    "Financial Covenants" sitting apart from any facility's own subsection), that
    belongs in the top-level bankLevelCovenant field (STEP 1B) — not fabricated
    onto one arbitrarily-chosen facility here. A document can have both:
    facility-specific loanCovenant text on individual rows, AND general
    bankLevelCovenant text at the document level.

FIELD 8 — purposes (Col S)
  - Use the purpose AS STATED in the LO — do not paraphrase
  - Match the level of detail in the working paper
  - For property purchases: include property description and title reference
    e.g. "To part finance the purchase of 1 unit of single storey warehouse annexed two storey office building held under Geran 79163, Lot 3277, Mukim Beranang"
  - For working capital: use exact wording e.g. "As working capital" or "For working capital purposes"
  - For HP motor vehicles: "Purchase of motor vehicle" then "- Make Model - Reg No" on next line
  - For HP equipment: "Purchase of [equipment name]"

FIELD 9 — facilityDate (Col V)
  - The date this facility was formally established OR most recently varied
  - Format: DD.MM.YYYY e.g. "15.10.2021"
  - For Original LO → use the LO date
  - For Supplementary LO → use the supplement date (for amended facilities only)
  - For Renewal Letter → use the renewal date
  - For HP → use the Agreement Date from the HP agreement
  - When a facility was materially changed by multiple documents → list both dates separated by comma e.g. "15.10.2021, 3.8.2022"
  - Do NOT use the repayment commencement date as the facility date

═══════════════════════════════════════════════════════════════
STEP 4 — HP SPECIFIC CHECKS
═══════════════════════════════════════════════════════════════

THIS RULE HAS TWO DIFFERENT DOCUMENT FORMATS TO RECOGNISE — check which one you're
looking at, because the field LABELS are completely different even though the
underlying concept (use the pre-interest amount, not the post-interest balance)
is identical. A confirmed failure mode from past runs: the model correctly applied
this rule to Format A documents but missed it entirely on Format B documents,
because Format B never uses the words "Net Finance Amount" anywhere on the page.

FORMAT A — labelled fields (e.g. Hitachi Capital repayment schedules):
  Price of Goods:     XXX     ← this is the full asset price
  Less: Deposit:     (XXX)    ← may be zero
  Finance Charges:    XXX
  Balance Payable:    XXX     ← DO NOT USE as approvedLimit
  Net Finance Amount: XXX     ← USE THIS as approvedLimit
  (On Hitachi's own repayment schedules, look for the field literally called
  "Amount Finance" — that is the equivalent of Net Finance Amount here.)

FORMAT B — numbered fields (i) through (xi), confirmed on HLB-issued and Public
Bank-issued Hire Purchase Agreements (Porsche 911, Mitsubishi Outlander, Mazda CX5,
and others use this exact layout):
  (i)    Cash Price of Goods
  (ii)   Deposit
  (iii)  Cash Price less Deposit                           ← DO NOT USE — see warning below
  (iv)   Vehicle Registration Fees, if any
  (v)    Insurance
  (vi)   Total of Items (i),(iii),(iv) and (v) less (ii)   ← USE THIS as approvedLimit
  (vii)  Term Charges (the interest/finance charges)
  (viii) Balance Originally Payable Under This Agreement   ← DO NOT USE — this is
                                                               (vi) PLUS (vii); it has
                                                               interest already added
  (x)    Hire Purchase Price / Total Amount Payable        ← DO NOT USE, same reason

  ⚠ SPECIFIC TRAP, CONFIRMED TO HAVE CAUSED REAL ERRORS: item (iii) "Cash Price
  less Deposit" is NOT the answer, even though it looks like a plausible final
  pre-interest figure and sits right next to the deposit calculation, before you
  even reach (vi). It is only Cash Price minus Deposit — it does NOT yet include
  Vehicle Registration Fees (iv) or Insurance (v), both of which are also financed
  into the loan and must be added back in. Stopping at (iii) instead of continuing
  to (vi) has been a confirmed, recurring source of error — every case of an HP
  limit running consistently a few thousand Ringgit lower than the Reference
  traces back to exactly this: (iii) extracted instead of (vi).

  Field (vi)'s exact wording varies slightly between documents ("Total of Items
  (i),(iii) and (v) less (ii)" vs "Total of Items (i),(iii),(iv) and (v) less
  (ii)" depending on whether item (iv) applies) — the wording will differ, but it
  is always the field described as a total of the cash-price-related items MINUS
  the deposit, and it always comes BEFORE the term charges are added. That is the
  field you want, regardless of its exact printed wording. It also always comes
  AFTER items (iv) and (v) in the document — if you have not yet read past the
  registration fee and insurance lines, you have not reached the right field yet.

  CONFIRMED WORKED EXAMPLES — real documents, get these right:
    Porsche 911 (QRN911): (vi) = RM330,000.00, (viii) = RM403,920.00. CORRECT
    approvedLimit = 330,000. Reference working paper confirms 330,000. Using
    403,920 (the difference is exactly the RM73,920 term charges) has been the
    actual error in past runs — check this specific confusion first if a Porsche-
    or similarly-structured HP figure looks too high.
    Mitsubishi Outlander (VCG3320): (vi) = RM128,000.00. This is the figure to
    extract, and it is CONFIRMED correct against the Reference.
    Mazda CX5 (ALU52): (iii) Cash Price less Deposit = RM91,925.83 — WRONG, this
    is the (iii)-instead-of-(vi) trap described above. (vi) Total of Items
    (i),(iii),(iv) and (v) less (ii) = RM96,800.00 — CORRECT, confirmed against
    the Reference exactly. The RM4,874.17 difference is precisely (iv) RM500.00
    Vehicle Registration Fees plus (v) RM4,374.17 Insurance — both financed into
    the loan and both missing from (iii).

  TRAP VARIANT — a handwritten correction/annotation on item (i) or (iii) does
  NOT change which row you extract. Some Public Bank-issued HP agreements carry
  a handwritten correction to the Cash Price and/or a large, circled/arrowed
  figure next to item (iii) — visually the most prominent number on the page,
  easy to mistake for "the auditor's marked final answer." It is still only
  item (iii), corrected or not. The field to extract is always item (vi), by
  its printed row label — check whether (vi) itself has also been crossed out
  or corrected; if it has not, use its printed value as-is even when (i)/(iii)
  show handwritten corrections elsewhere. Corrections to the component figures
  routinely net to the same (vi) total (a reallocation between Cash Price,
  Registration Fees and Insurance, not a change to the amount financed).

  CONFIRMED WORKED EXAMPLE — real document, get this one right: HINO XZC710R,
  Public Bank (D539, Reg. No. BRR9176). Printed: (i) Cash Price RM146,983.04,
  (ii) Deposit RM23,400.00, (iii) Cash Price less Deposit RM123,583.04, (iv)
  Freight RM0.00, (v) Registration RM60.00, (v) Insurance RM5,356.96, (vi)
  Total RM129,000.00. Handwritten corrections: (i)→RM147,383.10, (iii)→
  RM123,983.10 (large, arrowed — the most visually prominent figure on the
  page), Registration→RM110.00, Insurance→RM4,906.90. (vi) itself carries NO
  correction and remains printed at RM129,000.00 — confirmed correct both by
  the document's own arithmetic (123,983.10 + 110.00 + 4,906.90 = 129,000.00,
  matching 123,583.04 + 60.00 + 5,356.96 = 129,000.00 under the original
  figures — the corrections net to zero change in the total) and against the
  Reference, which carries this facility at RM129,000. CORRECT approvedLimit =
  129,000. Extracting 123,983 (the annotated item (iii)) — WRONG, the exact
  same (iii)-instead-of-(vi) trap, made easier to fall into here because the
  annotation draws the eye to (iii) specifically.

  SECOND CONFIRMED WORKED EXAMPLE — no annotation involved at all, so do not
  treat the HINO case above as only happening when a document has handwritten
  corrections. Perodua Alza, Public Bank (D544, Reg. No. VMG9176) — a
  completely clean, unmarked printed form (only a review tick/arrow next to
  item (i), no figures altered): (i) Cash Price RM62,350.00, (ii) Deposit
  RM6,782.80, (iii) Cash Price less Deposit RM55,567.20, (iv) Registration
  RM500.00, (v) Insurance RM1,932.80, (vi) Total RM58,000.00 (55,567.20 +
  500.00 + 1,932.80 = 58,000.00 exactly). Reference confirms RM58,000.
  CORRECT approvedLimit = 58,000. Extracting 55,567 — WRONG, and this exact
  document has produced this exact error from this exact prompt more than
  once, including after the HINO example above was added. Treat this as
  confirmation that a prose warning is not enough on its own — run the
  MANDATORY SELF-CHECK in STEP 5 below on every single Format B Hire Purchase
  facility before finalizing output, no exceptions, even when nothing about
  the document looks unusual.

FORMAT C — equipment/machinery HP agreements with a DIFFERENT structure, confirmed
on a PAC Lease press machine agreement. DO NOT apply Format A/B's rule here — for
THIS format the correct field is the one that has finance charges ALREADY ADDED,
the exact opposite of Format A/B. Check which format a document actually uses
BEFORE applying either rule; do not assume Format B's logic generalises to every
HP document just because it also involves a cash price and a deposit.
  5.(a) TABLE OF HIRE PURCHASE PRICE
  (i)   Cash Price
  (ii)  LESS Deposit
        BALANCE                    ← DO NOT USE — this is Cash Price minus
                                       Deposit only, BEFORE term charges. Despite
                                       looking exactly like Format B's correct
                                       field (vi), it is NOT the answer here.
  (iii) Fixed Term Charges
  (iv)  BALANCE PAYABLE            ← USE THIS as approvedLimit — this is BALANCE
                                       plus Fixed Term Charges, i.e. WITH interest
                                       already included. This is the correct
                                       field for this format, even though it is
                                       structurally identical to Format B's WRONG
                                       field (viii).

  CONFIRMED WORKED EXAMPLE — real document, get this one right:
    PAC Lease press machine: BALANCE = RM1,850,762.50 (Cash Price RM3,004,208.14
    minus Deposit RM1,153,445.64). Fixed Term Charges = RM240,645.50. BALANCE
    PAYABLE = RM1,850,762.50 + RM240,645.50 = RM2,091,408.00. CORRECT approvedLimit
    = 2,091,408. Reference working paper confirms 2,091,408. This has been
    extracted WRONG as RM1,850,762.50 in past runs — precisely because Format B's
    "avoid the post-interest field" rule was over-applied to this different
    format. Do not let Format B's warning above cause you to pick BALANCE here —
    read which format the document is in first, then apply that format's rule.
    Note: an earlier, separate Letter of Offer within the same file states
    "Amount Financed: a maximum of RM1,989,456.00" — a third, different figure.
    That is not the answer either; it is a preliminary approval ceiling, not the
    final Schedule's computed price. Use the Schedule's own BALANCE PAYABLE.

FORMAT D — MULTI-ASSET AGREEMENT (one Contract/Agreement No., several assets
bundled together, e.g. BMW Credit-issued equipment HP agreements). This format
has NO per-item "TABLE OF HIRE PURCHASE PRICE" at all for each asset — instead
the document has an Asset Schedule (repeating "Vehicle/Equipment Description:
Asset 1 / Asset 2 / Asset 3..." blocks, all sharing one Contract No.) and the
single combined facility amount is stated elsewhere in the document package —
typically in the Hirer's Board Resolution ("...Hire Purchase facility amount of
RM X granted by [financier]") and/or the LHDN stamp duty receipt
("Balasan/Consideration: RM X"). USE THAT single figure as approvedLimit for
ONE facility row covering all assets in the schedule. Do NOT treat each Asset
block as its own facility, and do NOT use a Guarantee Schedule's "Balance
originally payable under the agreement (Amount Financed + Total Interest
Charged)" figure — that is the post-interest total, the same trap as Format
B's item (viii). See the CONFIRMED REAL CASE (BMW Credit Agreement No.
7730328, RM282,240.00) under STEP 1's HIRE PURCHASE AGREEMENT section above.

CORRECTION, confirmed 20 Jul 2026: some BMW Credit (and possibly other
equipment financier) documents DO carry a per-asset payment table after all —
"Format D has NO per-item table" above does not hold universally. Check every
document for a "Part B — Period of Hire and Particulars of Payments" block
(numbered items 1-7) before falling back to the Board Resolution/LHDN route.
When present, THIS is the correct source, per-asset, and should be preferred
over Board Resolution/LHDN:

  1(a) Period of Hire / (b) Hiring Commencement Date
  2.   Cash Price of Goods
  3.   Accessories
  4.   Term Charges: (a) rate per annum (b) total amount of terms charges
  5.   Total Hire Purchase Price [= item 2 + item 4(b) — POST-interest]
  6.   Deposit, with its own printed "Balance Payable" sub-line directly
       beneath it              ← DO NOT USE "Balance Payable" — despite the
                                   reassuring name, it is computed as item 5
                                   MINUS item 6, i.e. Total Hire Purchase
                                   Price (already including term charges)
                                   minus Deposit. This is the exact same
                                   post-interest trap as Format B's item
                                   (viii), just under a label that sounds
                                   like the pre-interest figure you want.
  7.   Balance of Hire Purchase Price, payable by N monthly hire rentals of
       RM X — restates item 6's "Balance Payable," same trap, same reason
       not to use it.

  USE INSTEAD: item 2 (Cash Price of Goods) MINUS item 6 (Deposit), computed
  yourself — this format has no registration/insurance line items to add
  back (unlike Format B), so it is a plain subtraction, nothing more.

  CONFIRMED WORKED EXAMPLES — real documents, get these right:
    Asset "Sky-lift & Crane" (Business Use, qty 1): item 2 Cash Price
    RM357,700.00, item 6 Deposit RM75,460.00, printed "Balance Payable"
    RM338,688.00 — WRONG, this is item 5 (RM414,148.00 Total Hire Purchase
    Price) minus item 6, post-interest. CORRECT approvedLimit = 357,700.00 −
    75,460.00 = 282,240.00 — confirmed by Nexis, and matches the CONFIRMED
    REAL CASE (BMW Credit Agreement No. 7730328) cited above exactly, meaning
    this Part B table is very likely the true per-asset source underlying
    that same agreement.
    Second asset, same batch: item 2 Cash Price RM125,000.00, item 6 Deposit
    RM0.00, printed "Balance Payable" RM150,000.00 — WRONG, same post-interest
    trap (item 5 Total Hire Purchase Price RM150,000.00 minus zero deposit
    happens to equal item 5 itself here, which is why it looks deceptively
    "clean"). CORRECT approvedLimit = 125,000.00 − 0.00 = 125,000.00 —
    confirmed by Nexis. Do not assume a zero deposit means "Balance Payable"
    is safe to use — it never is for this field, zero deposit or not.

MANDATORY SELF-CHECK — run this on EVERY Format B Hire Purchase facility, AND
on every per-asset Format D "Part B" table above, before writing approvedLimit
into the output, no exceptions, even when the document looks perfectly clean
and unmarked. This check has been added because the same underlying trap —
using a plausible-looking post-interest or partial figure instead of the true
pre-interest financed amount — has been confirmed to recur even after being
explicitly documented with worked examples (Mazda CX5, HINO XZC710R, Perodua
Alza, and now the Sky-lift & Crane / second-asset Part B pair above — all
real, all previously extracted wrong despite the rule already being written
out) — a prose warning alone is not reliable enough, so treat this as a hard
arithmetic gate, not a suggestion. For Format B specifically:

  1. Find the document's printed item (iv) Vehicle Registration Fees and item
     (v) Insurance figures (or their equivalent-numbered fields for that
     document's exact layout).
  2. If BOTH are zero or genuinely absent (rare — most real HP agreements
     finance registration and insurance into the loan), item (iii) and item
     (vi) will be equal and either is fine.
  3. If EITHER (iv) or (v) is non-zero, item (vi) MUST be strictly greater
     than item (iii) by exactly (iv)+(v). Compute (iii)+(iv)+(v) yourself and
     confirm it equals the printed (vi) figure.
  4. The number you write into approvedLimit must be item (vi)'s own printed
     total — never item (iii), even if item (iii) is what your arithmetic in
     step 3 landed on. If you catch yourself about to output a number that
     exactly equals (iii) alone on a document where (iv) or (v) is non-zero,
     that is this exact trap — stop and re-read item (vi)'s own printed row.

For Format D's per-asset "Part B" table specifically:

  1. Locate item 2 (Cash Price of Goods) and item 6 (Deposit) by their own
     printed row labels.
  2. Compute item 2 minus item 6 yourself.
  3. The number you write into approvedLimit must equal that computation —
     never item 6's own printed "Balance Payable" sub-line, and never item 5
     or item 7, all three of which already have term charges added in. If
     you catch yourself about to output a number that matches the printed
     "Balance Payable" figure rather than your own item2-minus-item6
     computation, that is this exact trap — stop and recompute.

This check does NOT apply to Format C, where the correct field is the one WITH
term charges included — see Format C above before assuming this check applies.

Flat rate derivation if not stated: Finance Charges ÷ (Net Finance Amount × Tenure in years) × 100

═══════════════════════════════════════════════════════════════
STEP 5 — OUTPUT FORMAT
═══════════════════════════════════════════════════════════════

Return ONLY valid JSON. No markdown fences. No explanation. No text before or after.

{
  "docType": "Original LO",
  "bankName": "Full bank name",
  "loDate": "DD.MM.YYYY",
  "caRefNo": "BLK/2013/00000000084",
  "supersedesDate": "",
  "bankLevelCovenant": "",
  "facilities": [
    {
      "facilityType": "L",
      "awpRef": "",
      "facilityCode": "Fixed Term Loan 3 (Fixed TL3)",
      "facilitySubName": "SMElite 2.0",
      "approvedLimit": 5780000,
      "amtUtilised": "",
      "interestRateText": "BLR - 2.59%",
      "interestRateCalc": "=6.89%-2.59%",
      "repaymentLine1": "23 years by two hundred seventy six (276)",
      "repaymentLine2": "monthly installments of RM29,165.00",
      "repaymentLine3": "each inclusive of interest.",
      "securityBlock": "Facilities Agreement\n- Upstamp to secure RM7,130,000\nProperties with title - Legal Charge\n- Legal charge over Lot 3277, Mukim Beranang\n- Joint guarantee: Sam Chon Chee, Michael Lee Meng Ying",
      "loanCovenant": "Dividend covenant\n- Shall not declare any dividend in excess of 50% of CY PAT\n- Debt servicing must be current\nN1",
      "purposes": "To part finance the purchase of 1 unit of single storey warehouse annexed two storey office building held under Geran 79163, Lot 3277, Mukim Beranang, Daerah Ulu Langat",
      "crossRef": "",
      "facilityDate": "15.10.2021",
      "isSettled": false,
      "loDocType": "Original LO",
      "newLimitTable": {
        "present": false,
        "existing": 0,
        "change": 0,
        "newLimit": 0
      },
      "conditionalIncrease": {
        "present": false,
        "conditionText": "",
        "unconditionalPortion": 0
      }
    }
  ]
}

Field rules:
- facilityType: "L" for all loans/BA/OD/trade finance, "HP" for hire purchase
- approvedLimit: number only, no RM, no commas — this is the sanctioned limit. If a
  newLimitTable (see below) is present for this facility, approvedLimit MUST equal
  newLimitTable.newLimit — never the "existing" figure when a new limit is stated.
- amtUtilised: always empty string — auditor fills from bank confirmation
- awpRef: always empty string — assigned by auditor, not extracted
- crossRef: always empty string — assigned by auditor
- isSettled: true only if document explicitly confirms fully repaid/discharged
- loDocType: must match docType field
- caRefNo: the bank's own account/facility reference ("Our Ref", "CA No." etc.) — see
  STEP 1B. Empty string if not present on the document.
- supersedesDate: the date of the earlier LO this document explicitly supersedes/
  cancels, if stated — see STEP 1B. Empty string if no such statement is present.
- bankLevelCovenant: financial covenants/conditions applying to the banking
  relationship as a whole rather than one facility row — see STEP 1B and the
  COVENANT / CONDITIONS AMENDMENT LETTER document type in STEP 1. Empty string if
  this document states no such general covenants/conditions.
- newLimitTable: THIS FIELD MATTERS — many Malaysian Supplementary/Renewal LOs present
  changes as a table with columns "Existing (RM)" | "Change +/- (RM)" | "New Limit (RM)".
  Whenever you see this table format for a facility — a term loan, a trade instrument,
  ANY facility type — set present: true and fill in existing/change/newLimit exactly as
  printed, using 0 for any cell that shows a dash, blank, or nil. This applies row by
  row, independently, for every facility in the table — check every single row, not
  just the ones that look unusual. If the document does not use this table format for a
  facility, leave present: false and ignore the other three sub-fields (defaults are fine).
  Get this right even for facilities where the New Limit is nil — that is exactly the
  case this field exists to catch reliably. For an amortizing term loan renewal that
  states a parenthetical "(Original Limit: X)" alongside a reduced current figure, also
  use this field: existing = the stated Original Limit, newLimit = the renewal's current/
  reduced figure — see the RENEWAL LETTER note in STEP 1 above.
- conditionalIncrease: see FIELD 3B above — flags when part of a New Limit increase is
  contingent on a future performance milestone rather than routine documentation
  conditions. approvedLimit still uses the full New Limit regardless; this field only
  adds a flag for the auditor, it never changes approvedLimit itself.`

  // ── Build content array for Anthropic API ────────────────────────────────
  const content = isPDF
    ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }, { type: 'text', text: prompt }]
    : [{ type: 'image',    source: { type: 'base64', media_type: mediaType,           data: base64 } }, { type: 'text', text: prompt }]

  // ── callClaude — tiered Haiku → Sonnet ──────────────────────────────────
  async function callClaude(model) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 8192, messages: [{ role: 'user', content }] }),
    })
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}))
      throw new Error(`Anthropic error ${resp.status}: ${e?.error?.message || ''}`)
    }
    const data = await resp.json()
    const raw  = data.content?.[0]?.text || ''

    // Robust JSON extraction — handles preamble text, markdown fences, and
    // malformed control characters inside string values.
    let extracted
    try {
      const stripped = raw.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim()
      try { extracted = JSON.parse(stripped) }
      catch {
        const start = raw.indexOf('{')
        const end = raw.lastIndexOf('}')
        if (start === -1 || end === -1) throw new Error('No JSON object in response')
        const sliced = raw.slice(start, end + 1)
        try { extracted = JSON.parse(sliced) }
        catch (innerErr) {
          // FIX: "Bad control character in string literal" — Claude
          // occasionally emits a raw newline/tab/control character inside a
          // multi-line JSON string value (securityBlock, loanCovenant,
          // purposes and similar fields are long, free-form, multi-line text
          // and are the fields where this has actually been seen) instead of
          // the required escaped \n. Confirmed real cases: D417 and D404
          // extractions both failed with exactly this error at a specific
          // line/column inside a string field. Standard JSON.parse has no
          // tolerance for this — it is strictly correct to reject it, since
          // it's not valid JSON, but Claude produces it often enough on long
          // free-text fields that we sanitize rather than fail the whole
          // extraction over a single unescaped character deep inside a
          // security/covenant paragraph.
          extracted = JSON.parse(sanitizeJsonControlChars(sliced))
        }
      }
    } catch (jsonErr) {
      throw new Error('Claude returned unparseable JSON: ' + jsonErr.message)
    }

    // Deduplicate facilities WITHIN this single extraction response. This is
    // different from the file-level duplicate-upload check (which prevents
    // re-extracting the same PDF twice) and the reconcile-level auto-merge/
    // conservation checks (which handle cross-document merging) — this
    // catches the case where the MODEL describes the same real facility
    // twice within one document's own response (confirmed this session: a
    // Hitachi HP facility appeared twice in one extraction, inflating the
    // Hire Purchase total by its full amount).
    const rawFacs = extracted.facilities || []
    const seen = new Set()
    const dedupedFacs = []
    let duplicatesRemoved = 0
    for (const f of rawFacs) {
      // FIX (dedup signature drift): this signature now matches the two
      // other dedup checks in the app — EngagementShell.jsx's table-wide
      // dedup and A420Summary.jsx's unreconciled-data warning — both of
      // which key on facilityName + facilitySubName + approvedLimit +
      // facilityDate + bankName. The previous version of this check here
      // used only facilityCode/name + limit + date, missing
      // facilitySubName (which is very often what actually distinguishes
      // a generically-named facility, e.g. two "Hire purchase" rows for
      // two different vehicles that happen to share a limit and date) and
      // bankName (defensive — a single document is always one bank, but
      // this keeps all three dedup checks in the app structurally
      // identical rather than silently drifting apart again).
      // extracted.bankName is the model's own top-level field for this
      // document and is already present at this point in the response.
      const sig = [
        (f.facilityCode || f.facilityName || '').trim().toLowerCase(),
        (f.facilitySubName || '').trim().toLowerCase(),
        parseFloat(f.approvedLimit) || 0,
        (f.facilityDate || '').trim(),
        (extracted.bankName || '').trim().toLowerCase(),
      ].join('|')
      if (seen.has(sig)) { duplicatesRemoved++; continue }
      seen.add(sig)
      dedupedFacs.push(f)
    }
    extracted.facilities = dedupedFacs
    if (duplicatesRemoved > 0) {
      extracted._duplicatesRemoved = duplicatesRemoved
    }

    // Deterministic AUTO-MERGE for the CIMB "Multi Option Line (MOL)" pool —
    // WIDENED 20 Jul 2026. Started as a narrow MOL-vs-"Combined Trade" merge
    // (CIMB Bank D401, 13.05.2019, the same document FIELD 3C's worked
    // example cites: MOL RM6,000,000 with BA/DC/TR/MCTL bracketed at the
    // same figure, BG separately at RM100,000) after a fresh re-extraction
    // showed "Multi Option Line (MOL)" and "Combined Trade (BA/DC/TR/MCTL)"
    // as two separate RM6,000,000 rows. That narrow fix stopped THAT
    // collision, but a later reconcile export (20 Jul 2026) showed the same
    // pool fragmented a different way within the data flowing through this
    // pipeline: bare individual sub-instrument rows — "Bankers Acceptance
    // (BA)", "Documentary Credit (DC)", "Trust Receipt (TR)", "Multi
    // Currency Trade Loan (MCTL)" — each restating the identical RM6,000,000
    // MOL limit, with no "Combined Trade" label at all. Prompt text (FIELD
    // 3C) names this exact pattern and still isn't reliably followed after
    // repeated failures, so the deterministic net widens again: if one
    // facility is named as a Multi Option Line and another IN THIS SAME
    // DOCUMENT'S EXTRACTION shares the IDENTICAL limit and is named as one
    // of the MOL's own known sub-instruments (Bankers Acceptance,
    // Documentary Credit, Trust Receipt, Multi Currency Trade Loan, or a
    // "Combined Trade" bundle), it is the same pool restated — drop it and
    // keep only the MOL row. Still intentionally scoped to an identical
    // limit match so it cannot misfire on an unrelated coincidental match —
    // every other pooling pattern (Alliance TRD, UOB FX, etc) still only
    // gets a warning from the general check below, not an automatic merge.
    const molIdx = dedupedFacs.findIndex(f =>
      /\bmol\b|multi[\s-]?option[\s-]?line/i.test(f.facilityCode || f.facilityName || '')
    )
    if (molIdx !== -1) {
      const mol = dedupedFacs[molIdx]
      const molLimit = parseFloat(mol.approvedLimit)
      const subInstrumentPattern = /combined trade|bankers?\s*acceptance|documentary credit|trust receipt|multi\s*currency\s*trade\s*loan/i
      const zeroedNames = []
      for (let i = dedupedFacs.length - 1; i >= 0; i--) {
        if (i === molIdx) continue
        const f = dedupedFacs[i]
        const sameLimit = parseFloat(f.approvedLimit) === molLimit
        const isSubInstrument = subInstrumentPattern.test(f.facilityCode || f.facilityName || '')
        if (sameLimit && isSubInstrument) {
          // Per Lawrence/Nexis confirmation (20 Jul 2026): keep the sub-
          // instrument row visible in the working paper for completeness —
          // do NOT delete it — but zero its limit and mark it with a
          // "Reconcile**" remark, since the real pooled exposure is already
          // carried once on the MOL/Combined Trade row above. Previously this
          // spliced the row out entirely, which required a separate
          // mergedFromIds lineage-transfer fix elsewhere to stop
          // EngagementShell.jsx's conservation check silently restoring it;
          // keeping the row (at RM0) sidesteps that whole problem, since
          // nothing is being removed anymore.
          zeroedNames.push(f.facilityCode || f.facilityName)
          const poolName = mol.facilityCode || mol.facilityName
          f.approvedLimit = 0
          f.purposes = `Reconcile** — drawn under the shared "${poolName}" pool (RM${molLimit.toLocaleString()}); limit shown at RM0 here to avoid double-counting. See "${poolName}" row for the pooled limit.${f.purposes ? ' Original purpose: ' + f.purposes : ''}`
        }
      }
      if (zeroedNames.length > 0) {
        extracted._molCombinedTradeMerge =
          `${zeroedNames.length} row${zeroedNames.length===1?'':'s'} (${zeroedNames.join(', ')}) shown at RM0 with a Reconcile** remark — same Multi Option Line pool as "${mol.facilityCode || mol.facilityName}" at RM${molLimit.toLocaleString()}, restated under different names (see FIELD 3C). Only the MOL row carries the real limit.`
      }
    }

    // Deterministic safety net for the FIELD 3C/3D pooled-sub-limit rule above.
    // That rule is prompt-based (the model must recognise pooling language and
    // collapse sub-instruments into one row) and has proven unreliable in
    // practice — confirmed regressions on documents the prompt already gives
    // worked examples for (CIMB MOL, Alliance TRD), where the model correctly
    // pooled on one extraction run and fragmented into duplicate-limit rows on
    // a later run of the SAME document. Prompt text alone cannot be trusted to
    // catch this every time, so this flags it deterministically instead of
    // silently accepting the model's output. This does NOT alter or merge any
    // facility — a genuine coincidental match (two unrelated facilities that
    // happen to share a limit) is possible, so a human needs to look, not have
    // the row silently removed. Different facility names, identical
    // approvedLimit, same bank, same extraction response = likely double-count.
    const byLimit = new Map()
    for (const f of dedupedFacs) {
      const limit = parseFloat(f.approvedLimit)
      if (!limit) continue
      const key = limit
      if (!byLimit.has(key)) byLimit.set(key, [])
      byLimit.get(key).push(f.facilityCode || f.facilityName || 'Unnamed facility')
    }
    const possiblePoolingWarnings = []
    for (const [limit, names] of byLimit.entries()) {
      const uniqueNames = [...new Set(names)]
      if (uniqueNames.length > 1) {
        possiblePoolingWarnings.push(
          `Possible pooled-sub-limit double-count: ${uniqueNames.length} differently-named facilities all extracted at the identical limit RM${limit.toLocaleString()} (${uniqueNames.join(', ')}). If these are interchangeable sub-limits of one pool (see FIELD 3C), only ONE row should represent this exposure — check before relying on this export.`
        )
      }
    }

    // Deterministic safety net for the STEP 1 "multi-asset HP agreement" rule
    // above (Contract/Agreement No. bundling several assets into ONE facility).
    // That rule is also prompt-based, and the pooled-sub-limit rule right above
    // has already shown that prompt text alone — even with a worked, confirmed
    // real-case example — does not reliably stop the model from fragmenting one
    // thing into several rows. extract.js processes one HP document at a time
    // (see STEP 1), so more than one "Hire purchase" facility coming out of a
    // SINGLE document's extraction is itself suspicious and usually means either
    // a genuine multi-asset agreement got split (the confirmed BMW Credit
    // 7730328 failure mode), or the same asset was described more than once.
    // As with the pooling check, this only flags — it does not merge or alter
    // any row, since a document could legitimately reference more than one
    // separate HP agreement and a human should confirm either way.
    const hpFacs = dedupedFacs.filter(f =>
      /hire[\s_-]?purchase/i.test(f.facilityCode || f.facilityName || '')
    )
    const possibleHpSplitWarnings = []
    if (hpFacs.length > 1) {
      const names = hpFacs.map(f => f.facilitySubName || f.facilityCode || f.facilityName || 'Unnamed asset')
      const total = hpFacs.reduce((sum, f) => sum + (parseFloat(f.approvedLimit) || 0), 0)
      possibleHpSplitWarnings.push(
        `Possible multi-asset HP agreement split into ${hpFacs.length} rows within this single document (${names.join(', ')}), combined total RM${total.toLocaleString()}. If these assets are all financed under ONE Contract/Agreement No., only ONE row should represent this facility, at the single total stated in the Board Resolution or stamp duty receipt — not a sum of these rows. Check the Contract No. on each asset before relying on this export.`
      )
    }

    // Confidence scoring based on extraction completeness
    const facs = extracted.facilities || []
    let score = 70
    if (isPDF)                                   score += 5
    if (facs.length > 0)                         score += 8
    if (facs.every(f => f.approvedLimit))        score += 7
    if (facs.every(f => f.interestRateText))     score += 4
    if (facs.every(f => f.facilityDate))         score += 4
    if (facs.every(f => f.facilityCode))         score += 4
    score = Math.min(98, score)

    if (possiblePoolingWarnings.length > 0) {
      extracted._poolingWarnings = possiblePoolingWarnings
    }
    if (possibleHpSplitWarnings.length > 0) {
      extracted._hpSplitWarnings = possibleHpSplitWarnings
    }

    return { extracted, score, model }
  }

  // ── Tiered extraction: Haiku first, escalate to Sonnet if < 80% ─────────
  // EXCEPTION, added after confirmed real-money errors: Hire Purchase
  // documents skip Haiku entirely and go straight to Sonnet. Reason: the
  // field (iii)-vs-(vi) trap (see STEP 4 above) is a case where Haiku can
  // extract a WRONG field while filling in every part of the schema
  // completely — meaning its own confidence score comes back high, and the
  // score < 80 escalation trigger never fires. Five confirmed real cases
  // this session (Porsche, Mazda CX5, Lexus, Hino, Isuzu) all show this
  // exact failure pattern. Confidence-based escalation cannot catch an
  // error the confidence score isn't designed to detect — the fix is to
  // not depend on it for this specific, proven-risky document category.
  const looksLikeHP = /\bhp\b|hire[\s_-]?purchase/i.test(fileName)

  try {
    let result
    let usedTier

    if (looksLikeHP) {
      result = await callClaude('claude-sonnet-4-6')
      usedTier = 'sonnet (HP document — Haiku skipped, see note above)'
    } else {
      result = await callClaude('claude-haiku-4-5-20251001')
      usedTier = 'haiku'

      if (result.score < 80) {
        try {
          const sonnetResult = await callClaude('claude-sonnet-4-6')
          if (sonnetResult.score >= result.score) { result = sonnetResult; usedTier = 'sonnet' }
        } catch (sonnetErr) {
          if (!result.extracted?.facilities?.length) throw sonnetErr
        }
      }
    }

    const { extracted, score } = result
    const level = score >= 80 ? 'high' : score >= 60 ? 'medium' : 'low'
    const color = level==='high'?'#22c55e':level==='medium'?'#f59e0b':'#ef4444'
    const warnings = []
    if (extracted._duplicatesRemoved > 0) {
      warnings.push(`${extracted._duplicatesRemoved} duplicate facilit${extracted._duplicatesRemoved===1?'y':'ies'} detected and removed from this document's own extraction — the model described the same facility more than once within this single response.`)
    }
    if (extracted._poolingWarnings?.length > 0) {
      warnings.push(...extracted._poolingWarnings)
    }
    if (extracted._hpSplitWarnings?.length > 0) {
      warnings.push(...extracted._hpSplitWarnings)
    }
    if (extracted._molCombinedTradeMerge) {
      warnings.push(extracted._molCombinedTradeMerge)
    }
    extracted.confidence = {
      score, level, color,
      label: level[0].toUpperCase()+level.slice(1),
      reasons: [`AI extraction (${usedTier}) · ${fileSizeMB}MB`],
      warnings,
    }
    extracted.fileName = fileName
    extracted.modelUsed = usedTier

    return res.status(200).json(extracted)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
