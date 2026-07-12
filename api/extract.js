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
  → Single document per asset
  → Extract as ONE facility
  → approvedLimit = the pre-interest financed amount (Cash Price minus Deposit) —
  → NOT any figure that already has term charges/interest added on top.
  → See STEP 4 below for the two different field-label formats this appears in.

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
apply to the banking relationship as a whole (or to all facilities under the stated
caRefNo) rather than to one specific facility row. This is most commonly needed for
the COVENANT / CONDITIONS AMENDMENT LETTER type above (see STEP 1), but also
applies when an ordinary Renewal or Original LO opens with general conditions
before its facility table (extract those into bankLevelCovenant IN ADDITION to any
facility-specific loanCovenant text on individual facilities — the two are not
mutually exclusive). State each distinct covenant concisely, one per line, the same
concise style as FIELD 7 loanCovenant below (e.g. "Minimum Debt Service Coverage
(DSC) of 1x to be maintained at all times." / "Gearing not to exceed 2.5x at all
times."). Leave "" if this document states no covenants/conditions at all.

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
  - If present, state substance concisely:
    - Dividend covenant: percentage cap, PAT reference, debt service condition
    - Financial ratios: the ratio and minimum threshold
    - Net worth covenants: minimum amount
    - Change of control: threshold percentage
  - Common Malaysian format: "Shall not declare any dividend in excess of X% of CY PAT provided debt servicing is current"
  - This is for covenants stated AGAINST a SPECIFIC facility row. If instead the
    covenant applies to the whole banking relationship / all facilities under this
    caRefNo generally (not tied to one row), that belongs in the top-level
    bankLevelCovenant field (STEP 1B) — not fabricated onto one arbitrarily-chosen
    facility here. A document can have both: facility-specific loanCovenant text on
    individual rows, AND general bankLevelCovenant text at the document level.

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

Sanity check for Format A/B specifically: approvedLimit should equal Cash Price
minus Deposit (plus any financed accessories/insurance/fees included in the same
pre-interest total) — NOT that figure plus term charges/interest. This check does
NOT apply to Format C, where the correct field is the one WITH term charges
included — see Format C above before assuming this sanity check applies.

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
    extracted.confidence = {
      score, level, color,
      label: level[0].toUpperCase()+level.slice(1),
      reasons: [`AI extraction (${usedTier}) · ${fileSizeMB}MB`],
      warnings: extracted._duplicatesRemoved > 0
        ? [`${extracted._duplicatesRemoved} duplicate facilit${extracted._duplicatesRemoved===1?'y':'ies'} detected and removed from this document's own extraction — the model described the same facility more than once within this single response.`]
        : [],
    }
    extracted.fileName = fileName
    extracted.modelUsed = usedTier

    return res.status(200).json(extracted)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
