// ── Storage ────────────────────────────────────────────────────────────────
export const SK      = 'nexis_loan_v1'
export const SK_GROQ = 'nexis_groq_key'

// ── Working paper sections ────────────────────────────────────────────────
export const WP_SECTIONS = [
  { code: 'A420', label: 'Borrowings',      group: 'A — FUNDING CYCLE', phase: 1, icon: '🏦' },
  { code: 'A310', label: 'Related Parties', group: 'A — FUNDING CYCLE', phase: 2, icon: '👥' },
  { code: 'A150', label: 'Share Capital',   group: 'A — FUNDING CYCLE', phase: 2, icon: '📋' },
  { code: 'B110', label: 'PPE',             group: 'B — INVESTING',     phase: 2, icon: '🏗️' },
  { code: 'C200', label: 'Receivables',     group: 'C — REVENUE & REC', phase: 2, icon: '📊' },
  { code: 'D200', label: 'Payables',        group: 'D — EXPENDITURE',   phase: 2, icon: '💳' },
  { code: 'E100', label: 'Cash & Bank',     group: 'E — CASH',          phase: 2, icon: '💰' },
]

export const STATUS = {
  new:         { label: 'New',         cls: 'badge-new' },
  in_progress: { label: 'In Progress', cls: 'badge-progress' },
  on_hold:     { label: 'On Hold',     cls: 'badge-hold' },
  completed:   { label: 'Completed',   cls: 'badge-done' },
}

// ── A420 FACILITY DATA MODEL ───────────────────────────────────────────────
// Strictly follows A420.xlsx rules:
// - One record per UNIQUE ACTIVE FACILITY (not per LO document)
// - Grouped by bank with sequential bank number
// - AWP ref manually assigned (A460.xx for loans, A450 for BA, A470.xx for HP)
// - facilityDate = original agreement date (DD.MM.YYYY)
// - amtUtilised = current outstanding balance from bank confirmation
// - amtUnutilised = computed: approvedLimit - amtUtilised
// - Settled facilities shown with limit=0 (completeness)
// - interestRateText = "BLR + 0.5%" (description)
// - interestRateCalc = "6.89%+0.5%" (actual formula value, shown on row below)
// - repaymentLine1 = "X years by Y hundred (Z)"
// - repaymentLine2 = "monthly installments of RMX,XXX.XX"
// - repaymentLine3 = "each inclusive of interest."

export function emptyFacility(engId) {
  return {
    id: crypto.randomUUID(),
    engId,
    // Bank group
    bankNo: '',           // "1", "2", "3" etc — position in bank sequence
    bankName: '',         // "Hong Leong Bank Berhad"
    // Col C
    awpRef: '',           // "A460.10", "A450", "A470.10"
    // Col D
    facilityName: '',     // "Fixed Term Loan 2 (Fixed TL2)"
    facilitySubName: '',  // "SMElite 2.0" (second row of col D if any)
    facilityType: 'L',    // "L"=loan, "HP"=hire purchase
    // Col E
    approvedLimit: '',    // current/final approved limit
    // Col F
    amtUtilised: '',      // current outstanding from bank confirmation
    // Col G = computed
    // Col I
    interestRateText: '', // "BLR + 0.5%"
    interestRateCalc: '', // "6.89%+0.5%" (actual BLR substituted)
    // Col J (3 rows)
    repaymentLine1: '',   // "10 years by one hundred twenty (120)"
    repaymentLine2: '',   // "monthly installments of RM1,055.00"
    repaymentLine3: 'each inclusive of interest.',
    // Col L (security block — multi-line)
    securityBlock: '',    // full multi-line security text
    // Col Q (covenant)
    loanCovenant: 'N/A',
    // Col S (purpose)
    purposes: '',
    // Col U
    crossRef: '',         // "D402", "D401", "D402.10"
    // Col V
    facilityDate: '',     // "15.10.2021" — original agreement date DD.MM.YYYY
    // Status
    isSettled: false,     // true if limit=0, fully paid
    // Source doc tracking
    sourceDocIds: [],     // array of doc IDs this was extracted from
    loDocType: '',        // "Original LO", "Supplementary LO" etc
  }
}

// ── Seed data — EXACTLY MATCHING A420.xlsx ────────────────────────────────

// ── Seed engagements ──────────────────────────────────────────────────────
export function seedEngagements() {
  // Returns empty — user starts with a clean slate
  // Add engagements via "+ New Engagement" on the dashboard
  return []
}



// ── localStorage ──────────────────────────────────────────────────────────
export function loadEngagements() {
  try {
    const r = localStorage.getItem(SK)
    if (r) return JSON.parse(r)
  } catch {}
  return []  // clean start — no sample data
}
export function saveEngagements(engs) {
  try { localStorage.setItem(SK, JSON.stringify(engs)) } catch {}
}

// ── Helpers ───────────────────────────────────────────────────────────────
export function sectionCompletion(eng) {
  const total = WP_SECTIONS.length
  const done  = WP_SECTIONS.filter(s => eng.sections?.[s.code]?.status === 'completed').length
  return { done, total, pct: Math.round((done / total) * 100) }
}

export function fmtRM(val) {
  const n = parseFloat(val)
  if (isNaN(n) || val === '' || val == null) return '—'
  return n.toLocaleString('en-MY', { minimumFractionDigits: 0 })
}

export function docTypeColor(type) {
  if (!type) return '#71717a'
  const t = type.toLowerCase()
  if (t.includes('original'))    return '#22c55e'
  if (t.includes('supplement'))  return '#f59e0b'
  if (t.includes('restructur') || t.includes('new lo')) return '#B84480'
  if (t.includes('renewal'))     return '#3b82f6'
  return '#71717a'
}
