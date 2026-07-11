// api/reconcile.js — multi-document reconciliation
// Skills applied: Dependency Logic, Field Priority Table, Red Flags, Output Quality Standards

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

// Repairs a different LLM JSON-generation defect: a response that ran out of
// steam structurally rather than textually — confirmed via a real Vercel
// runtime log (10 July 2026, 55,766-character response): the model finished
// a normal, well-formed "summary" string, closed its final quote, and then
// simply stopped (stop_reason: end_turn — it believed it was done) without
// emitting the JSON object's closing brace(s). The existing brace-slice
// repair above (raw.slice(start, raw.lastIndexOf('}') + 1)) assumes the LAST
// "}" anywhere in the text is the true outer closing brace; when the object
// is genuinely left unclosed at the end, that assumption finds some EARLIER
// brace instead (e.g. the last completed facility object) and silently
// truncates real trailing content (intentionallyOmitted/summary) rather than
// fixing anything.
//
// This walks the text (respecting string literals/escapes, same approach as
// sanitizeJsonControlChars) counting unmatched { and [ characters, then
// appends exactly the closing characters needed, in the correct order, to
// balance them. If the text was cut off mid-string, closes that string
// first so the appended braces don't land inside it. No-ops if already
// balanced.
function balanceJsonBrackets(text) {
  const stack = []
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') { inString = false; continue }
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{' || ch === '[') { stack.push(ch); continue }
    if (ch === '}' || ch === ']') { stack.pop(); continue }
  }
  if (stack.length === 0 && !inString) return text
  let closer = ''
  for (let i = stack.length - 1; i >= 0; i--) {
    closer += stack[i] === '{' ? '}' : ']'
  }
  return (inString ? text + '"' : text) + closer
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in Vercel environment variables.' })

  const { docs, facilities } = req.body
  if (!docs?.length || !facilities?.length) {
    return res.status(400).json({ error: 'No documents or facilities to reconcile.' })
  }

  // Parse a DD.MM.YYYY (also tolerates DD/MM/YYYY, D.M.YYYY) date string into a
  // comparable timestamp. Returns null if unparseable/empty — callers must
  // handle null explicitly rather than let it silently coerce to 0 (which
  // would sort unparseable dates to 1970 and corrupt the ordering).
  function parseLoDate(s) {
    if (!s) return null
    const m = String(s).match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/)
    if (!m) return null
    const [, d, mo, y] = m
    const t = new Date(Number(y), Number(mo) - 1, Number(d)).getTime()
    return Number.isNaN(t) ? null : t
  }

  // Build compact doc context, then sort chronologically.
  // FIX (sort comparator bug, was already partly fixed): the previous fix
  // corrected the indexOf(-1)/indexOf(0) `||` bug, but that only ordered
  // documents into doc-type BUCKETS (Original LO / Supplementary LO / ...) —
  // it never actually sorted by date WITHIN a bucket. Two Supplementary LOs
  // from different dates were left in whatever order they happened to be
  // uploaded/extracted, because same-bucket comparisons returned 0 with no
  // secondary sort key. Confirmed real case: two Hong Leong Bank letters
  // dated 6 December 2024 (D417, an "Existing/Change/New Limit" amendment
  // sequence — the second letter's Existing figures equal the first
  // letter's New Limit figures) both landed in the same doc-type bucket and
  // had no reliable order between them.
  //
  // New sort priority:
  //   1. Explicit supersession — if document A's supersedesDate matches
  //      document B's loDate, A is placed after B regardless of any other
  //      signal. This is a stronger anchor than date comparison because it
  //      is the bank's own stated lineage, not an inference.
  //   2. Chronological — sort by loDate ascending when parseable.
  //   3. Doc-type hierarchy — only as a last-resort tiebreak when dates are
  //      equal or unparseable (this is the previously-fixed indexOf logic).
  const docContextRaw = docs.map(d => ({
    id: d.id, name: d.name, docType: d.detectedType, loDate: d.loDate || '',
    caRefNo: d.caRefNo || '', supersedesDate: d.supersedesDate || '',
  }))

  // Index documents by their own loDate so a supersedesDate on one document
  // can be resolved to the specific document(s) it refers to.
  const byLoDate = new Map()
  docContextRaw.forEach(d => {
    const k = parseLoDate(d.loDate)
    if (k === null) return
    if (!byLoDate.has(k)) byLoDate.set(k, [])
    byLoDate.get(k).push(d.id)
  })
  const supersedesMap = new Map() // doc id -> [ids of docs it must come after]
  docContextRaw.forEach(d => {
    const k = parseLoDate(d.supersedesDate)
    if (k !== null && byLoDate.has(k)) supersedesMap.set(d.id, byLoDate.get(k))
  })

  const docTypeOrder = ['Original LO','New LO','Supplementary LO','Supplementary Letter of Offer','Renewal Letter','Letter of Renewal','Repayment Schedule','Bank Confirmation']
  const docContext = docContextRaw.sort((a, b) => {
    if (supersedesMap.get(a.id)?.includes(b.id)) return 1
    if (supersedesMap.get(b.id)?.includes(a.id)) return -1
    const ta = parseLoDate(a.loDate), tb = parseLoDate(b.loDate)
    if (ta !== null && tb !== null && ta !== tb) return ta - tb
    const ia = docTypeOrder.indexOf(a.docType)
    const ib = docTypeOrder.indexOf(b.docType)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })

  const facilityContext = facilities.map(f => ({
    id: f.id, sourceDocIds: f.sourceDocIds,
    bankName: f.bankName, facilityType: f.facilityType,
    facilityCode: f.facilityCode, facilitySubName: f.facilitySubName,
    approvedLimit: f.approvedLimit, interestRateText: f.interestRateText,
    interestRateCalc: f.interestRateCalc, repaymentLine1: f.repaymentLine1,
    repaymentLine2: f.repaymentLine2, repaymentLine3: f.repaymentLine3,
    securityBlock: f.securityBlock, loanCovenant: f.loanCovenant,
    purposes: f.purposes, facilityDate: f.facilityDate,
    isSettled: f.isSettled, loDocType: f.loDocType,
    conditionalIncrease: f.conditionalIncrease || { present: false, conditionText: '', unconditionalPortion: 0 },
    alreadyReconciled: f.alreadyReconciled || false,
  }))

  // PROMPT CACHING — added after a confirmed real 504 (Task timed out after
  // 300 seconds) on Elkom's 7-document Hong Leong Bank run, phase 6 of 7,
  // even with Fix6 (unchangedFacilityIds), Fix7 (adaptive phase sizing) and
  // Fix8 (output length discipline) all already live. That phase's single
  // document happened to revise most of the facilities carried forward from
  // phases 1-5, so it still had to generate a large response — but a real,
  // separate inefficiency was also confirmed sitting underneath all of that:
  // this prompt's ~8,000-word rules section (DOCUMENT GROUPING through
  // OUTPUT FORMAT) is BYTE-IDENTICAL on every single phase call, yet was
  // being resent as a plain string and fully reprocessed by the model from
  // scratch every time — pure repeated overhead that grows with phase count.
  //
  // Anthropic's prompt caching (GA, no beta header needed as of this
  // writing) lets a marked prefix be cached for ~5 minutes and reused on the
  // next call instead of reprocessed — ideal here since consecutive phases
  // of the same reconcile run happen well within that window. Split into:
  //   staticInstructions — everything that never changes between phases
  //     (rules, worked examples, field priority table, incremental-reconcile
  //     explanation, output format schema) — sent as the `system` block with
  //     cache_control, so only the FIRST phase call in a run pays full
  //     processing cost for it; every subsequent phase reads it from cache.
  //   userContent — only the genuinely per-phase data (this run's document
  //     list, this phase's facility list) — sent as the `messages` block,
  //     never cached, since it's different every time by design.
  // This does not reduce how many tokens the model must GENERATE (the
  // actual timeout risk for a dense phase like #6 above) — it specifically
  // targets the INPUT reprocessing cost that was being paid needlessly on
  // every phase regardless of density, which should meaningfully cut
  // per-phase latency across the board and leave more of the 300s ceiling
  // available for genuinely dense phases to finish generating.
  //
  // Note: the INCREMENTAL RECONCILE MODE explanation and OUTPUT FORMAT
  // schema (previously placed AFTER the per-request facility data, since
  // they're static they're moved here into the cached block instead — this
  // reorders the prompt slightly (rules+schema first, data last) but changes
  // no wording. Instructions-before-data is the standard/recommended
  // structure for prompt caching and is not expected to affect output
  // quality.
  const staticInstructions = [
    `You are a senior Malaysian audit partner at SynerGrowth Consulting (SGC).
You have extracted facility data independently from multiple related bank documents.
Your task now is to RECONCILE these extractions into one consolidated A420 working paper — one row per unique real-world facility.

This requires the same reasoning an experienced auditor applies when reviewing an entire loan file: understanding document relationships, determining which document governs each field, spotting discrepancies, and flagging issues for review.

═══════════════════════════════════════════════════════════════
DOCUMENT GROUPING — WHICH DOCUMENTS BELONG TO THE SAME FACILITY RELATIONSHIP
═══════════════════════════════════════════════════════════════

Before applying any dependency/sequencing rule, first confirm which documents
actually belong together. Two documents belong to the SAME facility relationship
(and should be reconciled against each other) only when they agree on ALL of:

  - Bank (same legal entity — treat name-casing/formatting differences as the
    same bank, e.g. "CIMB Bank Berhad" and "CIMB BANK BERHAD" are the SAME bank,
    not two different banks)
  - caRefNo (the bank's own account/facility reference, e.g. "BLK/2013/00000000084"),
    WHEN both documents state one. caRefNo is the strongest grouping signal —
    trust it over any other similarity. If either document has no caRefNo stated,
    fall back to bank + borrower + continuity-of-terms matching as before.
  - Borrower (same legal entity/company registration number)

A client can hold more than one loan account with the same bank (different
caRefNo) — do not merge documents into one facility relationship just because
they share a bank and borrower if their caRefNo values differ. Conversely, do not
split documents that share the same caRefNo into separate relationships just
because a facility was renamed or a subtotal changed.

═══════════════════════════════════════════════════════════════
SAME-DATE MULTI-LETTER SEQUENCING
═══════════════════════════════════════════════════════════════

Occasionally two or more Letters of Offer for the same facility relationship
carry the IDENTICAL date, and both cite the SAME earlier superseded letter rather
than citing each other (so supersedesDate cannot distinguish which of the two
same-date letters comes first). Confirmed real case: two Hong Leong Bank letters
both dated 6 December 2024, both stating they supersede an LO dated 14 November
2024 — neither says it supersedes the other.

When this happens, determine the correct order using the New Limit table
figures themselves, not the dates: for each facility type present in both
same-date documents, check whether one document's "Existing (RM)" figure equals
the OTHER document's "New Limit (RM)" figure. The document whose Existing figure
matches the other's New Limit comes SECOND (it is amending the position the
first letter just established). Chain multiple same-date letters this way if
`,
    `there are more than two.

  WORKED EXAMPLE: Letter A (dated 6.12.2024) shows Combined Trade Existing
  RM8,500,000 → New Limit RM13,500,000. Letter B (also dated 6.12.2024) shows
  Combined Trade Existing RM13,500,000 → New Limit RM16,500,000. Letter B's
  Existing (RM13,500,000) equals Letter A's New Limit (RM13,500,000) — so Letter
  B is sequenced AFTER Letter A. The reconciled Combined Trade limit is
  RM16,500,000 (Letter B's New Limit, the latest in the chain), and
  changeHistory should record both steps.

If the Existing/New Limit figures across same-date documents do NOT chain
cleanly (no document's Existing matches another's New Limit), do not guess an
order — use the higher New Limit as approvedLimit (the bank's most generous
recent offer), and add a redFlag stating the two letters share a date with no
resolvable sequence, naming both document dates/names, for auditor review.

═══════════════════════════════════════════════════════════════
DOCUMENT DEPENDENCY RULES
═══════════════════════════════════════════════════════════════

Documents flow in this hierarchy (earlier documents are superseded by later ones):

  Original LO
    └─► Establishes all 9 fields for each new facility
    └─► Is the primary source for: security, covenants, purposes

  Supplementary LO
    └─► Updates ONLY the fields explicitly changed (limit, rate, tenure, new facilities)
    └─► Inherits ALL unchanged fields from the Original LO
    └─► New facilities introduced in the supplement: treat as Original LO for those

  New LO / Restructuring LO
    └─► Replaces the Original LO entirely
    └─► All previous records for affected facilities are superseded

  Renewal Letter
    └─► Confirms existing facilities for a new tenure
    └─► Updates: interest rate (if repriced)
    └─► Inherits: limit, security, covenants, purposes (unless explicitly restated)
    └─► Facility Date does NOT change at renewal — always retain the original
        agreement date (see Field Priority Table below)

═══════════════════════════════════════════════════════════════
FIELD PRIORITY TABLE — which document wins per field
═══════════════════════════════════════════════════════════════

When the same facility appears across multiple documents and values differ:

  Type of Facility:   Original LO → Supplement overrides if renamed → Renewal carries forward
  Approved Limit:     Original LO → Supplement overrides if changed → Renewal overrides if restated
  Interest Rate:      Original LO → Supplement overrides if changed → RENEWAL ALWAYS OVERRIDES (rate repricing is the primary purpose of renewal)
  Repayment Terms:    Original LO → Supplement overrides if changed → Renewal overrides if restated
  Security:           Original LO → Supplement overrides if changed → Renewal CARRIES FORWARD (security rarely changes at renewal)
  Loan Covenants:     Original LO → Supplement overrides if changed → Renewal CARRIES FORWARD
`,
    `  Purposes:           Original LO → CARRIES FORWARD through all subsequent documents
  Facility Date:      ALWAYS the date of the ORIGINAL agreement that first established the
                      facility (Original LO date, or Supplementary LO date if the facility was
                      first introduced there). Renewal Letters, rate repricing, or restructuring
                      do NOT change this date, even though they may change other fields above.
                      Only a genuinely New/Restructuring LO that replaces the facility outright
                      resets the Facility Date.

═══════════════════════════════════════════════════════════════
FACILITY LIFECYCLE — SETTLEMENT & ABSORPTION
═══════════════════════════════════════════════════════════════

Before merging, first determine whether each facility is still ALIVE at the latest document date.
Look for explicit lifecycle language in any document, regardless of exact wording — e.g.
"fully paid off," "fully settled," "discharged," "to be harmonized/combined into [X],"
"closed," or a limit column showing nil/blank/"–" after previously carrying a value.

  - If a facility is explicitly settled/discharged: keep the row, isSettled: true, retain its
    LAST active approved limit (never RM0), amtUtilised: 0, and record the settlement date
    in changeHistory. Do NOT carry it forward as active exposure in later-dated facilities.

  - If a facility is explicitly absorbed/combined/harmonized into a NAMED successor facility:
    keep the original as settled (as above) AND record in changeHistory what it was absorbed
    into (e.g. "Combined into Combined Trade 2, 3.8.2022"). Do not double-count its limit
    inside the successor facility's total — the successor's own restated limit already
    reflects the absorption.

  - Never assume a facility is still active just because it appeared in an earlier document.
    Check every later document for lifecycle language before treating it as current.

═══════════════════════════════════════════════════════════════
INCREMENTAL LIMIT CHANGES — applies to EVERY facility type, not just trade bundles
═══════════════════════════════════════════════════════════════

THIS RULE APPLIES UNIVERSALLY — to ordinary Fixed Term Loans, Combined Trade bundles,
Bankers' Acceptances, every facility type without exception. Confirmed failure mode from
past runs: this rule was applied correctly to a Combined Trade bundle but skipped for an
ordinary Fixed Term Loan in the SAME document, same table, same reconcile run. If you
find yourself thinking "this rule is for trade facility bundles" — that thinking is
wrong. Apply it to every single row in every Existing/Change/New Limit table you see,
loan and trade facility alike, with zero exceptions.

METHOD 1 — PREFERRED: read the bank's own computed "New Limit" column directly.

Malaysian Supplementary LOs very commonly present changes as an explicit table with
`,
    `columns "Existing (RM)" | "Change +/- (RM)" | "New Limit (RM)" — the bank has ALREADY
done the arithmetic for you. When this table format is present:
  - Extract the "New Limit" column value directly as the facility's limit. Do NOT
    recompute it yourself, and do NOT fall back to the "Existing" column.
  - If "New Limit" shows a dash, blank, nil, or "-", the facility is no longer granted
    — omit it entirely from the working paper, regardless of what "Existing" showed.
  - This applies row-by-row, independently, for EVERY facility listed in that table —
    a table commonly lists five, six, or more facilities together (term loans AND trade
    facilities side by side), and each row's New Limit is independent of every other
    row's. A dash in one row does not affect any other row, and a real figure in one
    row does not mean every row keeps its Existing value.

METHOD 2 — FALLBACK, only when no New Limit column exists: derive it yourself from
narrative text stating an adjustment (e.g. "reduce by RM X", "increase by RM Y"):
    new limit = limit from the immediately preceding document ± the stated adjustment

Either method: if the final limit is RM0 (or below, or the New Limit column shows
nil/dash), the facility is no longer granted by the bank — treat it exactly as a
settled/discontinued facility (see Facility Lifecycle above): do NOT include it as a
row in the working paper at all, not even at RM0. Do NOT carry any of its original
exposure forward into a sibling facility's total unless a document explicitly redirects
it there. List its original raw facility ID(s) under intentionallyOmitted in the output
(see OUTPUT FORMAT) with a reason — do not just leave it out with no record of the
decision.

  WORKED EXAMPLE 1 — an ordinary term loan, read straight from a New Limit column,
  NOT a trade facility bundle (get this one right — this exact case has been missed
  before while a trade-facility row in the same table was handled correctly):
    A Supplementary LO's table shows: "Fixed Term Loan 1 (PROPP-TL1) | Existing:
    RM2,700,000 | Change: -RM2,700,000 | New Limit: -". The New Limit column is blank/
    dash. CORRECT: omit Fixed Term Loan 1 entirely from the working paper — it is an
    ordinary term loan, not a trade facility, and the rule still applies in full. WRONG:
    keeping it at RM2,700,000 (the Existing figure) because it "looks like a normal
    loan facility" rather than a trade bundle — the facility TYPE is irrelevant; only
    what the New Limit column says matters.

  WORKED EXAMPLE 2 — a pooled trade bundle within the SAME table as Example 1 above,
  showing the rule applies consistently across every row, not selectively:
    The SAME Supplementary LO's table also shows five trade instruments (LC1/TR1/BA1/
    IVF1/BG1, "Combined Trade 1"), each existing at RM1,200,000, each with Change
    -RM1,200,000, each New Limit "-". A separate bundle (Combined Trade 2, LC2/TR2/BA2/
`,
    `    IVF2/BG2) existing at RM1,200,000 shows Change +RM2,200,000, New Limit RM3,400,000.
    CORRECT: Combined Trade 1 omitted entirely (New Limit is nil, exactly like Example
    1's term loan above); Combined Trade 2 shown at RM3,400,000, original 15.10.2021
    date retained per the Facility Date rule (the Supplementary LO changes the limit,
    not the facility's identity or date). WRONG, all seen in past runs: showing Combined
    Trade 1 at RM1,200,000; showing Combined Trade 2 at RM1,200,000 (ignoring the New
    Limit column); creating a SECOND row for Combined Trade 2 dated to the Supplementary
    LO instead of retaining the original date.

  This check happens BEFORE the Independent vs Shared Limits pooling logic below — pool
  identical-limit instruments into one bundle first, THEN check later documents for a
  stated adjustment to that pooled limit, THEN apply the adjustment to get the final figure.

═══════════════════════════════════════════════════════════════
CONTINGENT / CONDITIONAL LIMIT INCREASES — MANDATORY FLAGGING
═══════════════════════════════════════════════════════════════

Some facilities carry a conditionalIncrease flag from extraction (see
FACILITY LIFECYCLE and INCREMENTAL LIMIT CHANGES above for how the New Limit
itself is determined — this rule does NOT change that). conditionalIncrease
means part of the New Limit is contractually offered but gated behind a future
performance milestone the borrower had not yet demonstrated as met at the time
of the letter (e.g. a turnover target to be sustained over a future period) —
as distinct from routine documentation conditions precedent (guarantee signing,
charge perfection, board resolution), which do not carry this flag.

DECISION: approvedLimit ALWAYS uses the full New Limit at face value, exactly as
Method 1/Method 2 above already determine it — do NOT hold back the conditional
portion, and do NOT substitute unconditionalPortion for approvedLimit. This is a
deliberate choice: the tool surfaces what the bank has contractually offered, and
leaves the judgment of whether the condition has since been met to the auditor.

However, whenever ANY source document for a facility has conditionalIncrease.present
= true, the reconciled facility MUST carry a redFlag — this is not optional —
stating: the conditional portion (approvedLimit minus unconditionalPortion), the
verbatim/paraphrased conditionText, and that the full New Limit has been used
pending auditor confirmation the condition has been satisfied. Also add a
changeHistory entry recording the unconditional and conditional portions
separately with their source document date, so the split is visible even though
approvedLimit itself only shows the combined total.

  WORKED EXAMPLE: A facility's New Limit is RM16,500,000, made up of an
  unconditional RM13,500,000 plus a conditional RM3,000,000 (per
  conditionalIncrease.conditionText: "upon six (6) months turnover reach/achieve
`,
    `  RM50,000,000-00 and completion of legal documentations"). CORRECT:
  approvedLimit = 16500000. redFlags includes: "RM3,000,000 of this facility's
  RM16,500,000 limit (Combined Trade, HLB, 6.12.2024) is conditional on the
  Borrower sustaining RM50,000,000 turnover over six months and completing legal
  documentation — not confirmed as met in the source documents. Confirm with
  client/bank before treating the full RM16,500,000 as unconditionally available
  at FY end." WRONG: silently reducing approvedLimit to RM13,500,000 (that
  overrides the bank's own New Limit, which is not this tool's call to make);
  equally wrong: showing RM16,500,000 with no flag at all (the auditor would have
  no way to know part of it is conditional without rereading the source PDF).

═══════════════════════════════════════════════════════════════
INDEPENDENT VS. SHARED LIMITS — identical repeated limits are usually pooled
═══════════════════════════════════════════════════════════════

Facilities are sometimes marketed/labelled under a common product or programme name
(e.g. a "Combined Trade" bundle covering several instrument types: LC, TR, BA, IVF, BG).
Malaysian trade facility documents very commonly restate the SAME limit figure once per
instrument as a documentation convention — this is NOT evidence that each instrument
carries its own independent exposure. Treat it as the opposite signal by default:

  DEFAULT RULE: if two or more instruments under the same named bundle show the
  IDENTICAL limit figure, treat this as ONE shared/pooled limit repeated per instrument
  for documentation purposes. Do NOT sum them or list each at full face value. Instead:
    - If the utilisation data shows only ONE of the instruments actually drawn, output
      ONLY that instrument, at the shared limit figure — this matches how such bundles
      are conventionally presented in the working paper.
    - If utilisation data isn't available to tell which instrument (if any) is drawn,
      output ONE row representing the bundle (name it after the bundle, e.g. "Combined
      Trade 2 (LC2/TR2/BA2/IVF2/BG2)") at the shared limit figure, and add a redFlag
      noting utilisation data was unavailable to identify the drawn instrument.
  Only treat instruments as genuinely INDEPENDENT (list each at full face value) when
  their limits DIFFER from each other, or the document explicitly states each carries
  a separate ceiling in words (e.g. "each of the following facilities is granted
  independently of the others and may be utilised in full simultaneously").

  WORKED EXAMPLE — this exact pattern has been seen in real documents, get this one right:
    Source states: LC1 RM1,200,000 / TR1 RM1,200,000 / BA1 RM1,200,000 / IVF1 RM1,200,000
    / BG1 RM1,200,000 — five instruments, identical figures, no utilisation data available.
    CORRECT output AT THIS STAGE: ONE row, "Combined Trade 1 (LC1/TR1/BA1/IVF1/BG1)",
`,
    `    limit RM1,200,000. WRONG output: five separate rows each at RM1,200,000 (this
    overstates total exposure by RM4,800,000 for this bundle alone, and has been the
    single largest source of error in past runs).
    IMPORTANT — this pooling step is not necessarily the FINAL answer. This exact
    Combined Trade 1 bundle is later reduced to RM0 by a Supplementary LO in the real
    case this is drawn from — see the Incremental Limit Changes section above, which
    must be checked AFTER pooling and BEFORE finalizing any limit that appears in more
    than one document.

  If limits genuinely differ across instruments in the same bundle, list them separately
  at their actual stated figures — the identical-limit default above does not apply.

═══════════════════════════════════════════════════════════════
NAME-DRIFT-TOLERANT MATCHING
═══════════════════════════════════════════════════════════════

Facility naming is NOT stable across documents from the same bank over time — later
documents commonly drop numeric suffixes, rename products, or use shorthand. Match
facilities across documents using ALL of the following signals together, not exact
string equality on the facility code alone:

  - Same bank
  - Same facility type/instrument (loan / LC / TR / BA / IVF / BG / HP etc.)
  - Continuity of security given, stated purpose, or amount lineage (e.g. a later
    document's limit is a plausible evolution of an earlier one — an increase, a
    renewal restatement, or an explicit change — not an unrelated coincidence)
  - Sequential/positional consistency (e.g. "the second trade finance suite" continues
    to mean the same suite even if its numeric suffix is dropped in a later letter)

A facility referenced as "LC2" in one document and simply "LC" in a later document from
the same bank, same type, with continuous terms, is the SAME evolving facility — do not
create a duplicate parallel row just because a label changed.

═══════════════════════════════════════════════════════════════
RECONCILIATION DECISION RULES
═══════════════════════════════════════════════════════════════

MERGE into ONE row when:
  - Same facility (per the matching signals above) appears across Original LO + Supplement → one row with latest values
  - Same facility appears in Original LO + Renewal Letter → one row, ORIGINAL LO date retained, rate updated to renewal rate
  - Facility name differs slightly or drifts over time but the matching signals above confirm it's the same facility

KEEP SEPARATE rows when:
  - Two genuinely distinct facilities from the same bank (e.g. TL3 and TL4 are different loans)
  - A settled facility (limit retained, utilised = 0) alongside an active replacement facility
  - Multiple instruments under a common product/programme name, each explicitly carrying its own independent limit (see above)

LIMIT DISCREPANCY HANDLING — when documents disagree:
  - If two documents state the same facility's limit differing only by a small cents/decimal
`,
    `    remainder (one clean round figure, one oddly precise figure resembling a running balance),
    do NOT silently pick one and hide the disagreement. Use the cleanest, earliest explicitly-
    sanctioned figure as the working approvedLimit, but record BOTH figures and their source
    dates in changeHistory, and add a redFlag naming the discrepancy for auditor confirmation.
  - Never fabricate a resolution the source documents don't actually support.

SETTLED FACILITIES:
  - Keep the row — do not delete
  - Retain original approved limit
  - Set isSettled: true
  - amtUtilised = 0

═══════════════════════════════════════════════════════════════
RED FLAGS — flag these for auditor review
═══════════════════════════════════════════════════════════════

Include any triggered red flags in the "redFlags" array on each facility:

Financial:
  - Approved limit increased in Supplement but security not correspondingly upstamped
  - Multiple facilities secured by same property — total charged sums may exceed property value
  - HP instalment in repayment schedule differs from signed HP agreement
  - Flat rate in HP agreement differs from what was quoted in the Letter of Offer
  - Facility's New Limit includes a conditionalIncrease portion gated behind a future
    performance milestone not confirmed as met (MANDATORY — see CONTINGENT / CONDITIONAL
    LIMIT INCREASES above, applies to every facility where any source document set
    conditionalIncrease.present = true)

Compliance:
  - Dividend covenant present — auditor must verify no dividend declared during the year
  - Facility tenure appears expired (agreement date + tenor < FY end date) but balance outstanding
  - BNM SRF facility — check if moratorium period has ended and instalment stepped up
  - Renewal letter date is after the original facility expiry date (gap period)

Documentation:
  - Supplementary LO references a facility not in the Original LO
  - Two documents give materially different limits for the same facility (>5% difference)
  - Security reference to a property title not consistent across documents
  - HP agreement has amendments without visible countersignature

Completeness:
  - Bank mentioned in engagement but no LO uploaded for that bank
  - Renewal letter references N facilities but only N-1 were extracted

═══════════════════════════════════════════════════════════════
OUTPUT QUALITY STANDARDS — the output is acceptable when:
═══════════════════════════════════════════════════════════════

1. Each row represents exactly ONE unique real-world facility (no duplicates)
2. All 9 fields are populated or explicitly N/A
3. Approved limits match sanctioned amounts, not outstanding balances
4. Multi-document facilities reflect the LATEST terms, not the original
5. Struck-off values are never used
6. Settled facilities retained with isSettled: true
7. HP rates are in decimal format (not percentage)
8. Repayment terms follow the 3-line format
`,
    `9. Security is concise — not verbatim legal text
10. Red flags clearly identified for auditor review
11. The "summary" field contains no self-reported counts or numbers — describe what happened qualitatively, by facility/bank name, not by tally
12. Every facility explicitly marked settled/discharged/absorbed in ANY source document is isSettled: true, and is not double-counted inside whatever it was absorbed into
13. No facility with an independently-stated limit has been silently collapsed into a shared/summary row — check each product bundle for whether the source document actually states one shared ceiling or several independent ones
14. Any facility appearing under a different label in a later document (dropped suffix, renamed) has been matched to its earlier instance, not duplicated as new
15. Documents grouped/sequenced using caRefNo and supersedesDate where available, not bank name and date alone (see DOCUMENT GROUPING and SAME-DATE MULTI-LETTER SEQUENCING above)
16. Every facility where any source document set conditionalIncrease.present = true carries a redFlag describing the conditional portion — no exceptions (see CONTINGENT / CONDITIONAL LIMIT INCREASES above)

═══════════════════════════════════════════════════════════════
OUTPUT LENGTH DISCIPLINE — keep every facility's text fields concise
═══════════════════════════════════════════════════════════════

Every extra sentence of free text (securityBlock, changeHistory, redFlags)
multiplies generation time across every facility in the batch — on
engagements with many facilities, this is what pushes a response long
enough to risk a server timeout before it finishes. Apply these hard caps
to every facility, not just as a style preference:

  - securityBlock: maximum 8-10 short lines, matching what extraction
    already captured. When reconciling, CARRY FORWARD the existing concise
    text rather than re-describing it in more detail or adding narrative.
    Never expand a security description beyond what the source facility
    data already contains.
  - changeHistory: maximum 4 entries per facility. Each entry is ONE short
    clause, ideally under 15 words (e.g. "Limit revised 1.11.2021
    (Supplementary LO): RM300,000 -> RM150,000") — a date, the governing
    document type, and the specific number/term that changed. Never restate
    unchanged context, never write a full sentence of narrative. If a
    facility has genuinely been amended more than 4 times, keep the 4 MOST
    RECENT/MOST MATERIAL changes and drop earlier ones — the source
    documents remain the record of full history if it's ever needed.
  - redFlags: each entry is ONE concise sentence, ideally under 25 words —
    state the issue and what to verify, nothing more. Do not repeat the
    same underlying fact in both changeHistory and redFlags; state it once,
    in whichever field it actually belongs.

These caps apply to every facility in every phase/batch, not just large
engagements — following them costs nothing in correctness, since the
source documents remain available as the full reference if an auditor
ever needs more detail than the working paper itself shows.

═══════════════════════════════════════════════════════════════
SOURCE DOCUMENTS (in chronological / hierarchy order):
═══════════════════════════════════════════════════════════════
`,
    `
═══════════════════════════════════════════════════════════════
INCREMENTAL RECONCILE MODE — UNCHANGED FACILITIES
═══════════════════════════════════════════════════════════════

Some facilities in the data below may be marked "alreadyReconciled": true —
these were already correctly consolidated in an earlier round (this
engagement's documents are being processed in batches, oldest first). Do NOT
rewrite these from scratch every round — that wastes generation time
reproducing content that hasn't changed, and on large engagements can push
the response long enough to risk a server timeout.

  - If NOTHING in the current facility data actually affects a given
    alreadyReconciled facility (no document changes its limit, rate,
    security, adds a new red flag, or otherwise touches it), list its "id"
    under "unchangedFacilityIds" in the output and do NOT repeat it in
    reconciledFacilities at all.
  - If something genuinely DOES change or add to it (a limit is restated, a
    new red flag condition now applies, it needs to merge with a newly
    introduced raw facility, etc.), include the FULL updated facility in
    reconciledFacilities as normal, with its own id in mergedFromIds so it
    is not also treated as unaccounted-for.
  - Facilities NOT marked alreadyReconciled (i.e. newly introduced raw
    facilities) have never been reconciled — they must always go through
    reconciledFacilities, even if the correct outcome is simply to keep
    them as extracted with no changes. Never put a raw, not-yet-reconciled
    facility's id into unchangedFacilityIds.
  - Only mark something unchanged after actually checking it against the
    current round's information — this is a time-saving shortcut for
    genuinely untouched facilities, not a way to skip real work.
`,
    `
═══════════════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════════════

Return ONLY valid JSON. No markdown. No explanation.

{
  "reconciledFacilities": [
    {
      "mergedFromIds": ["id1", "id2"],
      "bankName": "",
      "facilityType": "L",
      "awpRef": "",
      "facilityCode": "",
      "facilitySubName": "",
      "approvedLimit": 0,
      "amtUtilised": "",
      "interestRateText": "",
      "interestRateCalc": "",
      "repaymentLine1": "",
      "repaymentLine2": "",
      "repaymentLine3": "",
      "securityBlock": "",
      "loanCovenant": "N/A",
      "purposes": "",
      "crossRef": "",
      "facilityDate": "",
      "isSettled": false,
      "loDocType": "most recent doc type that materially changed this facility",
      "changeHistory": [
        "Limit revised 1.11.2021 (Supplementary LO): RM300,000 → RM150,000",
        "Rate renewed 3.8.2022 (Renewal Letter): BLR+0.5% confirmed"
      ],
      "redFlags": [
        "Dividend covenant present — verify no dividend declared in FY"
      ]
    }
  ],
  "unchangedFacilityIds": ["id-of-an-alreadyReconciled-facility-with-no-changes-this-round"],
  "intentionallyOmitted": [
    {
      "ids": ["id-of-original-raw-facility"],
      "reason": "Trade Line 1 (Combined Trade 1) reduced to RM0 by Supplementary LO dated 3.8.2022 (RM1,200,000 minus RM1,200,000) — no longer granted, correctly excluded from the working paper."
    }
  ],
  "summary": "2-3 sentence QUALITATIVE summary. Do NOT state any numbers/counts (facility counts, document counts, bank counts, percentages) — the app computes and displays those separately from the actual data, and your count would likely not match. Instead name the specific facilities/banks involved in key merges, and describe the nature of the most significant red flags (e.g. which facility, what discrepancy) without tallying totals."
}

IMPORTANT — every input facility ID must end up in ONE of: some reconciledFacilities
entry's mergedFromIds, unchangedFacilityIds (only for facilities marked
alreadyReconciled: true that genuinely need no changes — see INCREMENTAL RECONCILE
MODE above), or intentionallyOmitted with a clear reason. Never just leave an input
facility unreferenced with no explanation anywhere in the output — if you determine a
facility should not appear in the working paper (settled, reduced to RM0 by a stated
adjustment, absorbed into a named successor, etc.), you MUST list its original ID in
intentionallyOmitted and say why. An ID that appears in none of these three places will
be treated as an error and automatically restored with a "needs review" flag — so
anything you deliberately excluded or left unchanged needs to be declared here to
avoid being second-guessed.`
  ].join('')

  // The only genuinely per-phase content — this run's document list and
  // this phase's facility list. Deliberately kept OUT of staticInstructions
  // (and therefore out of the cached block) since it's different on every
  // single call by design; caching it would never produce a hit and would
  // only add cache-write overhead for no benefit.
  const userContent = [
    JSON.stringify(docContext, null, 2),
    `

═══════════════════════════════════════════════════════════════
RAW EXTRACTED FACILITIES (may contain duplicates across documents):
═══════════════════════════════════════════════════════════════
`,
    JSON.stringify(facilityContext, null, 2),
    `

Return ONLY the JSON object described in the OUTPUT FORMAT section above — no markdown, no explanation, nothing before or after the JSON.`,
  ].join('')

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',  // Always Sonnet for reconciliation — needs strongest reasoning
        max_tokens: 20000,  // Hobby plan hard-caps maxDuration at 300s (see vercel.json) — Vercel rejects anything higher at deploy time, it doesn't just get ignored. At Sonnet 4.6's typical throughput this is roughly what 300s of generation can realistically complete; going much higher risks a 504 timeout instead of a clean response. The durable fix for large batches (40+ facilities) is the selective/per-bank reconcile in the UI, not raising this further — that needs a Pro plan (higher maxDuration ceiling) to be safe.
        system: [
          { type: 'text', text: staticInstructions, cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: userContent }],
      }),
    })

    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}))
      return res.status(500).json({ error: `Anthropic error ${resp.status}: ${e?.error?.message || ''}` })
    }

    const data = await resp.json()
    // Diagnostic only — confirms whether prompt caching is actually landing
    // hits (cache_read_input_tokens > 0 on phase 2+ of a run means the
    // ~8,000-word rules block was served from cache instead of reprocessed).
    // Visible in Vercel runtime logs; no effect on behaviour.
    if (data.usage) {
      console.log('[reconcile] usage', JSON.stringify(data.usage))
    }
    const raw  = data.content?.[0]?.text || ''
    const clean = raw.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim()

    let result
    try { result = JSON.parse(clean) }
    catch {
      const start = raw.indexOf('{')
      const end   = raw.lastIndexOf('}')
      if (start !== -1 && end !== -1) {
        const sliced = raw.slice(start, end + 1)
        try { result = JSON.parse(sliced) }
        catch {
          // FIX: "Bad control character in string literal" — same defect as
          // extract.js (see sanitizeJsonControlChars): Claude occasionally
          // emits a raw, unescaped newline/control character inside a long
          // free-text JSON string field (securityBlock, changeHistory
          // entries, redFlags text) instead of the required \n escape. Try a
          // sanitized repair pass before giving up — this is a targeted fix
          // for a specific known defect, not a general fallback, so we still
          // fail loudly with the real error if the sanitized text still
          // won't parse (e.g. genuine truncation).
          try { result = JSON.parse(sanitizeJsonControlChars(sliced)) }
          catch {
            // FIX: confirmed via Vercel runtime logs (10 July 2026) — a real
            // response ended on a normal, well-formed closing quote for the
            // "summary" field with stop_reason: end_turn (the model believed
            // it was done) but never emitted the object's closing brace(s).
            // The slice above (raw.slice(start, raw.lastIndexOf('}') + 1))
            // assumes the LAST "}" anywhere in the text is the true outer
            // closing brace — when the object is genuinely left unclosed at
            // the end, that assumption finds an EARLIER brace instead (e.g.
            // the last completed facility object) and silently truncates
            // real trailing content instead of fixing anything. Try again
            // from the first "{" to the actual end of the response (not the
            // guessed last brace), sanitize, and balance whatever brackets
            // are left open before giving up for real.
            try {
              const fromStart = raw.slice(start)
              result = JSON.parse(balanceJsonBrackets(sanitizeJsonControlChars(fromStart)))
            }
            catch {
              console.error('[reconcile] JSON parse failed. stop_reason=', data.stop_reason, 'raw_length=', raw.length, 'raw_tail=', raw.slice(-500))
              const truncated = data.stop_reason === 'max_tokens'
              return res.status(500).json({
                error: truncated
                  ? `Reconciliation response was too long and got cut off (${raw.length.toLocaleString()} characters generated). This batch has too many facilities for one run — tick fewer documents on the Documents tab (e.g. one bank at a time) and reconcile in smaller groups.`
                  : 'Reconciliation returned malformed data. Try again — if it keeps happening on the same document set, that\'s worth reporting.',
                raw: raw.slice(0,500),
              })
            }
          }
        }
      } else {
        console.error('[reconcile] No JSON braces found. stop_reason=', data.stop_reason, 'raw_length=', raw.length)
        return res.status(500).json({ error: 'No JSON found in reconciliation response', raw: raw.slice(0,500) })
      }
    }

    return res.status(200).json(result)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
