import { useState } from 'react'
import { FileText, Sparkles, Lock, ChevronRight } from 'lucide-react'
import { WP_SECTIONS, sectionCompletion } from '../lib/store.js'
import { exportLoanRecords } from '../lib/excel.js'
import A420Documents from './A420Documents.jsx'
import A420Summary, { ResultsModal } from './A420Summary.jsx'
import AIInsight from './AIInsight.jsx'

// ── Phased (incremental) reconcile — an opt-in alternative to the default
// single-call reconcile above. Vercel Hobby (even with Fluid Compute, which
// raises the ceiling to 300s) still hard-caps serverless duration, and a
// bank with many related documents that must all be reconciled together in
// one continuous chain (e.g. Elkom's 7 Hong Leong Bank Berhad letters,
// 2018-2024, one loan account) can need more generation time than that
// ceiling allows. This is not a capability gap — the model handles it fine
// given enough time — it's purely a hosting-tier constraint, and Lawrence
// has explicitly chosen not to upgrade Vercel tiers for a pre-production
// tool.
//
// Instead of one call covering all of a bank's documents, this processes
// them in small chronological phases (default 3 documents each), carrying
// the PRIOR phase's consolidated reconciledFacilities forward as input to
// the NEXT phase alongside only that phase's new raw facilities — a
// "rolling fold." Full document metadata for every document processed so
// far is sent on every phase (cheap, and reconcile.js's own sequencing
// logic needs it), but each phase's actual facility payload stays small.
//
// This is slower and more expensive in aggregate than a single call would
// be if it could complete (more repetitions of reconcile.js's large fixed
// prompt overhead, and some re-generation of already-consolidated facility
// text on every phase) — but it trades that for NEVER timing out, at the
// cost of some time and tokens rather than a hard failure. Off by default;
// the single-call path above remains primary because it's faster/cheaper
// and most engagements have few enough documents per bank to never hit the
// timeout at all.
const RECONCILE_PHASE_SIZE = 3

function parseLoDateClient(s) {
  if (!s) return null
  const m = String(s).match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/)
  if (!m) return null
  const [, d, mo, y] = m
  const t = new Date(Number(y), Number(mo) - 1, Number(d)).getTime()
  return Number.isNaN(t) ? null : t
}

// Sorts documents chronologically by loDate (undated docs keep their
// original relative order) then splits into phases of `phaseSize`, with one
// guard: a document sharing the exact same loDate as the last document
// already placed in the current phase is never pushed into a new phase on
// its own — same-date letters (e.g. an Existing/New Limit pair issued
// together) must be reconciled in the same phase or the sequencing logic
// in reconcile.js has nothing to chain them against.
function chunkDocsIntoPhases(docs, phaseSize) {
  const withIndex = docs.map((d, i) => ({ d, i, t: parseLoDateClient(d.loDate) }))
  const sorted = [...withIndex]
    .sort((a, b) => (a.t === null || b.t === null) ? a.i - b.i : a.t - b.t)
    .map(x => x.d)

  const phases = []
  let current = []
  for (const doc of sorted) {
    const lastT = current.length > 0 ? parseLoDateClient(current[current.length - 1].loDate) : null
    const thisT = parseLoDateClient(doc.loDate)
    const sameDateAsLast = current.length > 0 && lastT !== null && thisT !== null && lastT === thisT
    if (current.length >= phaseSize && !sameDateAsLast) {
      phases.push(current)
      current = []
    }
    current.push(doc)
  }
  if (current.length > 0) phases.push(current)
  return phases
}

// Runs the rolling-fold phased reconcile for one bank's documents/facilities.
// Returns the same shape as a single /api/reconcile response so the caller
// can merge it into combinedReconciledFacilities/combinedIntentionallyOmitted
// exactly like the non-phased path. `lineage` maps each CURRENT facility id
// back to the set of ORIGINAL raw facility ids it represents, so
// mergedFromIds/intentionallyOmitted ids stay correct against the original
// input set across phases — the downstream conservation check, auto-merge,
// and dedup logic in handleReconcile all depend on that being accurate and
// need no changes themselves.
async function reconcileBankPhased(bankLabel, bankDocs, bankFacilities, onProgress) {
  const phases = chunkDocsIntoPhases(bankDocs, RECONCILE_PHASE_SIZE)
  let runningDocs = []
  let runningReconciled = []
  let lineage = new Map()
  bankFacilities.forEach(f => lineage.set(f.id, new Set([f.id])))
  const allOmitted = []
  const summaryParts = []
  // Original raw facility ids introduced so far, across all phases up to and
  // including the current one — used by the per-phase conservation check
  // below.
  const rawIdsSeenSoFar = new Set()

  for (let p = 0; p < phases.length; p++) {
    const phaseDocs = phases[p]
    const phaseDocIds = new Set(phaseDocs.map(d => d.id))
    const newRaw = bankFacilities.filter(f => (f.sourceDocIds || []).some(id => phaseDocIds.has(id)))
    runningDocs = [...runningDocs, ...phaseDocs]
    newRaw.forEach(f => rawIdsSeenSoFar.add(f.id))

    onProgress(
      phases.length > 1
        ? `Reconciling ${bankLabel} — phase ${p + 1} of ${phases.length} (${phaseDocs.length} document${phaseDocs.length === 1 ? '' : 's'})…`
        : `Reconciling ${bankLabel} (${phaseDocs.length} document${phaseDocs.length === 1 ? '' : 's'})…`
    )

    const resp = await fetch('/api/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docs: runningDocs, facilities: [...runningReconciled, ...newRaw] }),
    })
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}))
      throw new Error(
        `${bankLabel} phase ${p + 1} of ${phases.length} failed: ${e.error || `server error ${resp.status}`}` +
        ' — nothing has been changed yet.'
      )
    }
    const phaseResult = await resp.json()

    const expandIds = (ids) => {
      const out = new Set()
      ;(ids || []).forEach(id => {
        const prior = lineage.get(id)
        if (prior) prior.forEach(x => out.add(x))
        else out.add(id)
      })
      return [...out]
    }

    const newLineage = new Map()
    const newReconciled = (phaseResult.reconciledFacilities || []).map(f => {
      const origIds = expandIds(f.mergedFromIds)
      const newId = crypto.randomUUID()
      newLineage.set(newId, new Set(origIds))
      return { ...f, id: newId, mergedFromIds: origIds }
    })
    const phaseOmitted = (phaseResult.intentionallyOmitted || []).map(o => ({ ...o, ids: expandIds(o.ids) }))
    allOmitted.push(...phaseOmitted)

    // Per-phase conservation check — confirmed necessary via a real test run
    // (7 HLB documents): the model reliably lists mergedFromIds for facilities
    // it's actively merging THIS phase, but for a facility carried forward
    // unchanged from a prior phase (nothing new relates to it), it doesn't
    // always re-state that facility's full original-id lineage. Left
    // unchecked until the very end, this silently drops those facilities from
    // tracking across every remaining phase, and the top-level conservation
    // check in handleReconcile then restores ALL of them at once as raw,
    // unmerged, duplicate rows — exactly what happened: 6 correctly merged
    // facilities plus ~47 raw duplicates dumped in behind them.
    //
    // Checking after every phase instead of only at the very end catches this
    // immediately: anything not accounted for is restored right away, as a
    // clearly flagged standalone facility, and gets carried into the NEXT
    // phase's input — giving the model a fresh, explicit chance to merge it
    // properly instead of accumulating losses invisibly until the final dump.
    const accountedThisPhase = new Set([
      ...newReconciled.flatMap(f => f.mergedFromIds || []),
      ...phaseOmitted.flatMap(o => o.ids || []),
    ])
    const missingThisPhase = [...rawIdsSeenSoFar].filter(id => !accountedThisPhase.has(id))
    let restoredThisPhase = []
    if (missingThisPhase.length > 0) {
      restoredThisPhase = bankFacilities
        .filter(f => missingThisPhase.includes(f.id))
        .map(f => {
          const newId = crypto.randomUUID()
          newLineage.set(newId, new Set([f.id]))
          return {
            ...f,
            id: newId,
            mergedFromIds: [f.id],
            redFlags: [
              ...(f.redFlags || []),
              `Not referenced in reconcile phase ${p + 1} of ${phases.length} — carried forward as a standalone facility so it isn't lost, and will get another chance to be merged in a later phase. If it's still standalone at the end, verify against source.`,
            ],
          }
        })
    }

    runningReconciled = [...newReconciled, ...restoredThisPhase]
    lineage = newLineage

    if (phaseResult.summary) summaryParts.push(phaseResult.summary)
  }

  return { reconciledFacilities: runningReconciled, intentionallyOmitted: allOmitted, summary: summaryParts.join(' ') }
}

export default function EngagementShell({ eng, updateEngagement, apiKey }) {
  const [activeSection, setActiveSection] = useState('A420')
  const [activeTab, setActiveTab]         = useState('documents') // 'documents' | 'summary' | 'insight'
  const { done, total, pct } = sectionCompletion(eng)

  // ── Reconcile state, lifted here so it survives switching tabs and can be
  // triggered from either the Documents page (View Summary) or the
  // Borrowings toolbar (Reconcile Facilities) ─────────────────────────────
  const [reconciling, setReconciling]           = useState(false)
  const [reconcileSummary, setReconcileSummary] = useState('')
  const [reconciledCount, setReconciledCount]   = useState(0)
  const [showResults, setShowResults]           = useState(false)
  const [resultTab, setResultTab]               = useState('paper')
  // Opt-in toggle for the phased reconcile path above — off by default so
  // the common case (small document sets) stays on the faster, cheaper
  // single-call path. Turn on for engagements where "Reconcile Facilities"
  // has actually timed out.
  const [batchedReconcile, setBatchedReconcile] = useState(false)

  function updateFacilities(facsOrFn) {
    updateEngagement(prevEng => ({
      facilities: typeof facsOrFn === 'function' ? facsOrFn(prevEng.facilities) : facsOrFn,
    }))
  }

  // rawFacilities is a PERMANENT, extraction-derived store — separate from
  // `facilities` (the working/display table). Clear All and friends only
  // ever touch `facilities`; they have no reference to this field at all,
  // so raw extracted data survives every kind of clear. Reconcile reads
  // its input from here, not from `facilities`, so clearing the summary
  // table never forces a re-extraction just to reconcile again.
  function updateRawFacilities(facsOrFn) {
    updateEngagement(prevEng => ({
      rawFacilities: typeof facsOrFn === 'function' ? facsOrFn(prevEng.rawFacilities || []) : facsOrFn,
    }))
  }

  function updateDocs(docsOrFn) {
    updateEngagement(prevEng => ({
      uploadedDocs: typeof docsOrFn === 'function' ? docsOrFn(prevEng.uploadedDocs) : docsOrFn,
    }))
  }

  // Single atomic update — always merges against the freshest engagement
  // state at apply-time, so concurrent re-extractions (e.g. clicking
  // Re-run on multiple docs close together) can never clobber each other.
  // `rawFacsOrFn` is optional and defaults to `facsOrFn` — safe for
  // reExtractDoc, whose transform is "swap this one doc's entries" and
  // is correct applied identically to either array. The batch upload flow
  // passes an explicit third argument instead, because its accumulator
  // needs to start from rawFacilities (ignores Clear All) rather than
  // facilities (respects Clear All) — reusing one value for both there
  // would silently re-wipe rawFacilities for every other document the
  // moment a new file is uploaded after a clear.
  function updateDocsAndFacilities(docsOrFn, facsOrFn, rawFacsOrFn = facsOrFn) {
    updateEngagement(prevEng => ({
      uploadedDocs: typeof docsOrFn === 'function' ? docsOrFn(prevEng.uploadedDocs) : docsOrFn,
      facilities: typeof facsOrFn === 'function' ? facsOrFn(prevEng.facilities) : facsOrFn,
      rawFacilities: typeof rawFacsOrFn === 'function' ? rawFacsOrFn(prevEng.rawFacilities || []) : rawFacsOrFn,
    }))
  }

  // Fingerprint of a set of ticked document IDs — used to detect whether the
  // current tick-selection has already been reconciled, so re-visiting the
  // Borrowings tab doesn't burn a redundant reconcile call.
  function fingerprintOf(docIds) {
    return [...docIds].sort().join(',')
  }

  function currentTickedFingerprint() {
    const ticked = (eng.uploadedDocs || []).filter(d => d.status === 'extracted' && d.includeInReconcile === true)
    return { fp: fingerprintOf(ticked.map(d => d.id)), count: ticked.length }
  }

  async function handleReconcile() {
    const docs = eng.uploadedDocs || []
    // Prefer the permanent raw store. Fall back to the display table only
    // for engagements whose documents were extracted before rawFacilities
    // existed — those have data nowhere else. Once anything in this
    // engagement is next extracted or re-run, rawFacilities gets properly
    // populated and this fallback stops being needed for it.
    const allFacilities = (eng.rawFacilities && eng.rawFacilities.length > 0) ? eng.rawFacilities : (eng.facilities || [])
    const extractedDocs = docs.filter(d => d.status === 'extracted' && d.includeInReconcile === true)
    const skippedCount = docs.filter(d => d.status === 'extracted' && d.includeInReconcile !== true).length
    if (extractedDocs.length < 2) {
      alert(skippedCount > 0
        ? 'Fewer than 2 documents are ticked for reconcile. Tick more on the Documents tab, or untick fewer.'
        : 'Reconciliation needs at least 2 extracted documents to compare. Upload more LOs first.')
      return
    }
    if (allFacilities.length === 0) {
      alert(extractedDocs.length >= 2
        ? 'Your ticked documents show as extracted, but there\'s no facility data recorded for them anywhere — including the permanent store that normally survives Clear All. This most likely means they were extracted before that permanent store existed. Click Re-run on each ticked document to regenerate its data (no re-upload needed) — after that, this will not happen again for these documents.'
        : 'No facilities to reconcile yet.')
      return
    }
    // Only send facilities that already came from the documents being
    // reconciled — the rest is untouched either way (see the merge step
    // below) and only bloats the request/response for no reason. This is
    // what actually blew up a "just 4 HLB LO files" reconcile once the
    // engagement had accumulated 40 facilities from other testing — every
    // call was dragging the entire table along regardless of batch size.
    const includedDocIds = new Set(extractedDocs.map(d => d.id))
    const facilitiesRaw = allFacilities.filter(f => (f.sourceDocIds || []).some(id => includedDocIds.has(id)))

    // Deterministic pre-filter — does NOT depend on the model's reconcile-stage
    // judgement. Confirmed this session: the same rule for reading an explicit
    // "Existing/Change/New Limit" table has now failed on two separate prompt-only
    // attempts, including a regression where a previously-correct case broke on
    // the second attempt. When extraction has already captured a newLimitTable
    // with newLimit === 0, that is an unambiguous, structured fact — not a
    // judgement call — so it's enforced here in code, before the facility is
    // even sent to reconcile, rather than hoping the model applies it correctly
    // again on every single run.
    const isZeroOrBlank = v => v === null || v === undefined || v === '' || v === '-' ||
      isNaN(parseFloat(v)) || parseFloat(v) === 0
    const deterministicOmissions = facilitiesRaw.filter(
      f => f.newLimitTable?.present === true && isZeroOrBlank(f.newLimitTable?.newLimit)
    )
    const deterministicOmissionIds = new Set(deterministicOmissions.map(f => f.id))
    const facilities = facilitiesRaw.filter(f => !deterministicOmissionIds.has(f.id))
    const sentIds = new Set(facilities.map(f => f.id))

    // Confirmed real gap: the earlier allFacilities.length===0 check only
    // looks at the WHOLE raw store, not what's actually scoped to the
    // documents ticked THIS time. If that scoped set ends up empty — either
    // because facilitiesRaw itself is empty (the ticked documents' raw
    // facilities don't reference back to them correctly) or because the
    // deterministic New-Limit filter removed everything in it — nothing
    // caught that before, and an empty payload went straight to the server,
    // which correctly rejected it with a generic "No documents or
    // facilities to reconcile" error that didn't explain why. Catching it
    // here instead, with a specific explanation for each actual cause.
    if (facilities.length === 0) {
      if (facilitiesRaw.length === 0) {
        alert('The documents you\'ve ticked are marked extracted, but none of their facility data is linked back to them in the permanent store — so there\'s nothing to send for this specific selection, even though the engagement has facility data overall. Try Re-run on each ticked document to regenerate its data with a correct link back to it.')
      } else {
        alert(`Every facility in your ticked documents (${facilitiesRaw.length} found) was determined to have an explicit New Limit of RM0 and was correctly excluded before reconciling — so there's nothing left to send for this specific selection. If that's unexpected, check the documents' New Limit tables directly; if it's expected (e.g. you ticked only documents whose facilities were fully superseded elsewhere), tick a different combination that includes at least one still-active facility.`)
      }
      return
    }

    setReconciling(true)
    setReconcileSummary('')
    setResultTab('paper')
    setShowResults(true)
    try {
      // ── Batching ─────────────────────────────────────────────────────
      // A single /api/reconcile call covering every ticked document (seen
      // live: 7 documents / 53 facilities for Elkom) can run long enough
      // for Vercel to kill the serverless function before it responds —
      // the browser then reports a generic "Failed to fetch" rather than
      // any of this app's own formatted errors, because no response ever
      // arrived to format. Vercel's Hobby plan enforces a 60s timeout by
      // default regardless of the maxDuration:300 set in vercel.json,
      // unless Fluid Compute is separately enabled on the project.
      //
      // Fix: split the ticked documents into independent batches and call
      // /api/reconcile once per batch, sequentially, then combine every
      // batch's reconciledFacilities/intentionallyOmitted/summary into one
      // `result` before falling through to the exact same post-processing
      // (auto-merge clustering, conservation check, dedup, exclusion) that
      // already ran on a single combined response. Nothing below this
      // point needs to know batching happened.
      //
      // Batches are grouped by BANK ONLY — not bank + caRefNo as first
      // implemented. That version broke correctness: confirmed on a real
      // Elkom run (7 HLB documents, one continuous loan account across
      // 2018-2024) that caRefNo is only reliably extracted off the
      // ORIGINAL letter — supplements and renewals frequently don't restate
      // it, or restate it with formatting the model doesn't recognise as
      // identical. That put each document (or small clumps of them) into
      // its OWN batch, so almost nothing ever got jointly reconciled —
      // the working paper came back with every document's facilities
      // listed as separate, unmerged, undated-superseded rows instead of
      // one consolidated set per bank. Grouping by bank alone can't
      // fragment documents that need to be seen together, because
      // reconcile.js's own "DOCUMENT GROUPING" / caRefNo-sequencing prompt
      // logic already runs INSIDE each batch to sort out multiple accounts
      // at the same bank correctly — that's what it was built for, and
      // it's exactly what ran successfully before batching existed at all.
      // The real tradeoff this creates: a bank with many related documents
      // (like Elkom's 7 HLB letters) still lands in ONE batch and gets NO
      // size reduction — for that case, Fluid Compute (see note above) is
      // the fix, not batching, because those documents genuinely must be
      // reconciled together in a single call.
      function batchKeyOf(doc) {
        return (doc.bankName || '').trim().toLowerCase()
      }
      const batchGroups = new Map()
      extractedDocs.forEach(d => {
        const key = batchKeyOf(d)
        if (!batchGroups.has(key)) batchGroups.set(key, [])
        batchGroups.get(key).push(d)
      })
      const batches = [...batchGroups.values()]
        .map(batchDocs => {
          const batchDocIds = new Set(batchDocs.map(d => d.id))
          const batchFacilities = facilities.filter(f => (f.sourceDocIds || []).some(id => batchDocIds.has(id)))
          return { docs: batchDocs, facilities: batchFacilities }
        })
        .filter(b => b.facilities.length > 0)

      const combinedReconciledFacilities = []
      const combinedIntentionallyOmitted = []
      const summaryParts = []
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i]
        const label = batch.docs[0]?.bankName || `group ${i + 1}`

        // Opt-in phased path — see reconcileBankPhased above. Only used
        // when the user has ticked "Batch reconcile" in the toolbar; the
        // default remains the single-call path below unchanged.
        if (batchedReconcile) {
          const phased = await reconcileBankPhased(label, batch.docs, batch.facilities, setReconcileSummary)
          combinedReconciledFacilities.push(...phased.reconciledFacilities)
          combinedIntentionallyOmitted.push(...phased.intentionallyOmitted)
          if (phased.summary) summaryParts.push(phased.summary)
          continue
        }

        // FIX: this used to only set progress text when batches.length > 1,
        // on the assumption "batch 1 of 1" isn't useful info. In practice
        // that's exactly backwards — a bank with many related documents
        // (e.g. Elkom's 7 HLB letters) always produces a SINGLE batch, and
        // that single batch is precisely the slow, timeout-risking case
        // where visible progress matters most. Now shown for every batch,
        // worded to fit whether there's 1 or several.
        setReconcileSummary(
          batches.length > 1
            ? `Reconciling batch ${i + 1} of ${batches.length} (${label})…`
            : `Reconciling ${batch.docs.length} document${batch.docs.length === 1 ? '' : 's'} (${label})…`
        )
        const resp = await fetch('/api/reconcile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ docs: batch.docs, facilities: batch.facilities }),
        })
        if (!resp.ok) {
          const e = await resp.json().catch(() => ({}))
          throw new Error(
            `Batch ${i + 1} of ${batches.length} (${label}) failed: ${e.error || `server error ${resp.status}`}` +
            (batches.length > 1 ? ' — other batches were not attempted; nothing has been changed yet.' : '')
          )
        }
        const batchResult = await resp.json()
        combinedReconciledFacilities.push(...(batchResult.reconciledFacilities || []))
        combinedIntentionallyOmitted.push(...(batchResult.intentionallyOmitted || []))
        if (batchResult.summary) summaryParts.push(batchResult.summary)
      }
      setReconcileSummary('')
      const result = {
        reconciledFacilities: combinedReconciledFacilities,
        intentionallyOmitted: combinedIntentionallyOmitted,
        summary: summaryParts.join(' '),
      }
      let reconciled = (result.reconciledFacilities || []).map(f => ({
        facilitySubName: '', approvedLimit: '', amtUtilised: '',
        interestRateText: '', interestRateCalc: '', repaymentLine1: '', repaymentLine2: '',
        repaymentLine3: '', securityBlock: '', loanCovenant: 'N/A', purposes: '',
        crossRef: '', facilityDate: '', awpRef: '', isSettled: false,
        ...f,
        facilityName: f.facilityCode || f.facilityName || '',
        id: crypto.randomUUID(),
        engId: eng.id,
        bankNo: '1',
        sourceDocIds: f.mergedFromIds
          ? [...new Set(facilities.filter(orig => f.mergedFromIds.includes(orig.id)).flatMap(orig => orig.sourceDocIds || []))]
          : [],
      }))

      // Captured from the model's RAW output, before any of our own
      // post-processing (auto-merge, etc.) touches `reconciled` further —
      // this is what the conservation check below relies on.
      const accountedForIds = new Set(
        (result.reconciledFacilities || []).flatMap(f => f.mergedFromIds || [])
      )

      // Intentional omissions — the model explicitly declared these should NOT
      // appear in the working paper (settled, reduced to RM0 by a stated
      // adjustment, absorbed into a named successor, etc.) and gave a reason.
      // These count as "accounted for" so the conservation check below doesn't
      // treat a correct, explained exclusion as an accidental drop and restore
      // it — but we keep the list so the exclusion is still visible to the
      // auditor, not just silently invisible.
      const intentionalOmissions = result.intentionallyOmitted || []
      intentionalOmissions.forEach(o => (o.ids || []).forEach(id => accountedForIds.add(id)))

      // Evidence-based auto-merge — does NOT rely on the model's own judgement
      // for this specific decision. The Independent vs Shared Limits reasoning
      // has now failed twice in a row on identical inputs (same documents
      // produced pooled totals in some runs, ~RM23-37M overstated independent
      // totals in others, including a phantom extra row on the second attempt).
      // Prompt wording alone hasn't reliably held, so this runs in code every
      // time, regardless of what the model concluded.
      //
      // Two tiers, based on how much corroborating evidence is available:
      //   - Identical limit alone (same bank, date, limit, 3+ facilities) →
      //     FLAG only. Could be coincidence, not enough on its own to act on.
      //   - Identical limit AND a shared bundle label already present in the
      //     data (facilitySubName, e.g. "Combined Trade 1" — this is Nexis's
      //     own document language, not something we're inferring) → MERGE
      //     into one row, and flag it clearly so the auditor can verify the
      //     call was correct. This is the corroborating "note/letter heading/
      //     reference" signal — not just a bare number coincidence.
      const clusterKey = f => `${f.bankName || ''}|${f.facilityDate || ''}|${parseFloat(f.approvedLimit) || 0}`
      const clusters = {}
      reconciled.forEach(f => {
        const key = clusterKey(f)
        if (!clusters[key]) clusters[key] = []
        clusters[key].push(f)
      })

      const mergedIds = new Set()
      const autoMergedRows = []

      Object.values(clusters).forEach(group => {
        if (group.length < 3 || !(parseFloat(group[0].approvedLimit) > 0)) return
        const limitStr = parseFloat(group[0].approvedLimit).toLocaleString('en-MY')

        // Corroboration check: do all members share the same bundle label?
        // Match on the CORE bundle identifier, not byte-exact string equality —
        // the model can generate slightly different trailing text per instrument
        // within the same response (e.g. "Combined Trade 2" vs "Combined Trade 2
        // — SMElite 2.0"), and requiring an exact match across all of them is
        // needlessly fragile. Extract "combined trade N" (or similar bundle-word
        // + number pattern) as the comparison key instead.
        const coreLabel = s => {
          const m = (s || '').match(/\b([a-z]+(?:\s+[a-z]+)?)\s+(\d+)\b/i)
          return m ? `${m[1].toLowerCase()} ${m[2]}` : (s || '').trim().toLowerCase()
        }
        const subNames = group.map(f => (f.facilitySubName || '').trim()).filter(Boolean)
        const coreLabels = subNames.map(coreLabel).filter(Boolean)
        const bundleLabel = coreLabels.length === group.length && new Set(coreLabels).size === 1 ? subNames[0] : null

        if (bundleLabel) {
          // Corroborated — merge into one row.
          const extractCode = name => (name.match(/\(([A-Z0-9]+)\)/) || [])[1] || name
          const codes = group.map(f => extractCode(f.facilityName))
          const base = group[0]
          const merged = {
            ...base,
            id: crypto.randomUUID(),
            facilityName: `${bundleLabel} (${codes.join('/')})`,
            facilitySubName: bundleLabel,
            sourceDocIds: [...new Set(group.flatMap(f => f.sourceDocIds || []))],
            redFlags: [
              `Auto-reconciled: ${group.length} instruments (${codes.join(', ')}) under "${bundleLabel}" all shared the identical limit of RM${limitStr} on ${base.facilityDate || 'the same date'} — the document's own bundle label corroborates this is one pooled limit, not ${group.length} independent exposures. Originally listed as separate rows; merged here. Verify against source if in doubt.`,
            ],
          }
          autoMergedRows.push(merged)
          group.forEach(f => mergedIds.add(f.id))
        } else {
          // Not corroborated — flag only, same as before.
          group.forEach(f => {
            f.redFlags = [
              ...(f.redFlags || []),
              `Automated check: ${group.length} facilities from ${f.bankName || 'this bank'} on ${f.facilityDate || 'this date'} share the identical limit of RM${limitStr}, but no shared bundle label was found to corroborate pooling — kept as separate rows. This is a strong signal they may still be one pooled/shared limit; verify against the source document before relying on this total.`,
            ]
          })
        }
      })

      if (autoMergedRows.length > 0) {
        reconciled = [...reconciled.filter(f => !mergedIds.has(f.id)), ...autoMergedRows]
      }

      // Conservation check — the last line of defence, independent of
      // everything above. Confirmed this session: the same reconcile prompt,
      // on the same input, has produced correct pooling, incorrect
      // independent listing, AND complete omission of facilities across
      // separate runs. Prompt wording and even code-level merging can only
      // improve the CHANCE of a correct structural decision — they can't
      // guarantee one. This check guarantees something different and
      // absolute: every facility sent to the API is accounted for in the
      // final result, full stop. If the model's response doesn't reference
      // an input facility ID anywhere in mergedFromIds, its original raw
      // data is restored here rather than silently disappearing. This can
      // never delete real exposure — it can only ever add back what the
      // model dropped.
      const missingIds = [...sentIds].filter(id => !accountedForIds.has(id))
      if (missingIds.length > 0) {
        const restored = facilities
          .filter(f => missingIds.includes(f.id))
          .map(f => ({
            ...f,
            id: crypto.randomUUID(),
            redFlags: [
              ...(f.redFlags || []),
              'This facility was sent to reconciliation but was not referenced anywhere in the result — restored automatically using its original extracted data to prevent it silently disappearing from the working paper. Not reconciled against other documents; needs review.',
            ],
          }))
        reconciled = [...reconciled, ...restored]
      }

      // Only replace facilities that came from the documents included in THIS
      // reconcile run. Facilities from any other document (skipped here, or
      // added manually) are left exactly as they are — computed against the
      // CURRENT DISPLAY TABLE (eng.facilities), not the raw source used to
      // build the payload above. Using the raw source here would silently
      // resurrect every other bank's data back into view after a Clear All,
      // defeating the point of clearing it in the first place.
      const currentDisplayFacilities = eng.facilities || []
      const untouched = currentDisplayFacilities.filter(f => !(f.sourceDocIds || []).some(id => includedDocIds.has(id)))
      // Final, universal dedup — runs on the WHOLE combined table (untouched
      // + freshly reconciled), not just what this run touched. This is
      // deliberately broader than the extraction-level fix above: it also
      // self-heals pre-existing duplicates sitting untouched in the display
      // table from before that fix existed (confirmed case: a duplicated
      // Hitachi facility, from a bank never included in the batches that
      // produced it, sat unnoticed through multiple unrelated reconciles).
      // Same signature approach as the extraction-level check — genuinely
      // distinct facilities never coincidentally share name + limit + date.
      const combined = [...untouched, ...reconciled]
      const seenSigs = new Set()
      const deduped = []
      let tableDuplicatesRemoved = 0
      for (const f of combined) {
        const sig = [
          (f.facilityName || '').trim().toLowerCase(),
          (f.facilitySubName || '').trim().toLowerCase(),
          parseFloat(f.approvedLimit) || 0,
          (f.facilityDate || '').trim(),
          f.bankName || '',
        ].join('|')
        if (seenSigs.has(sig)) { tableDuplicatesRemoved++; continue }
        seenSigs.add(sig)
        deduped.push(f)
      }

      // Final rule, matching the Reference Working Paper's own convention:
      // zero-limit and settled facilities are not shown in the working paper
      // at all — not kept as a row, not marked "SETTLED", just left out
      // entirely. This is a backstop beyond the newLimitTable-specific
      // pre-filter above: it catches ANY facility that reaches this point
      // with a blank/zero limit or isSettled=true, regardless of which
      // mechanism produced it (a facility the model marked settled via the
      // traditional keep-the-row path, not just the New Limit table path).
      const finalFacs = []
      const excludedZeroOrSettled = []
      for (const f of deduped) {
        const limitIsZero = f.approvedLimit === '' || f.approvedLimit === null || f.approvedLimit === undefined ||
          isNaN(parseFloat(f.approvedLimit)) || parseFloat(f.approvedLimit) === 0
        if (limitIsZero || f.isSettled === true) {
          excludedZeroOrSettled.push(f)
        } else {
          finalFacs.push(f)
        }
      }
      updateFacilities(finalFacs)
      updateEngagement(() => ({ reconcileFingerprint: fingerprintOf(extractedDocs.map(d => d.id)) }))
      setReconciledCount(reconciled.length)
      const bankCount = new Set(reconciled.map(f => f.bankName).filter(Boolean)).size
      const skippedNote = skippedCount > 0 ? ` (${skippedCount} document${skippedCount===1?'':'s'} left out, unaffected.)` : ''
      const restoredNote = missingIds.length > 0 ? ` ⚠ ${missingIds.length} facilit${missingIds.length===1?'y was':'ies were'} not returned by reconciliation and ${missingIds.length===1?'was':'were'} restored automatically — see Review Items.` : ''
      const dedupNote = tableDuplicatesRemoved > 0 ? ` ⚠ ${tableDuplicatesRemoved} duplicate row${tableDuplicatesRemoved===1?'':'s'} found elsewhere in the table and removed automatically.` : ''
      const omittedNote = intentionalOmissions.length > 0
        ? ` ℹ ${intentionalOmissions.length} facilit${intentionalOmissions.length===1?'y was':'ies were'} deliberately left out of the working paper: ${intentionalOmissions.map(o => o.reason).join(' ')}`
        : ''
      const deterministicNote = deterministicOmissions.length > 0
        ? ` ℹ ${deterministicOmissions.length} facilit${deterministicOmissions.length===1?'y':'ies'} excluded automatically — source document showed an explicit New Limit of RM0 (${deterministicOmissions.map(f => f.facilityCode || f.facilityName || 'unnamed').join(', ')}), enforced directly rather than left to the reconcile step.`
        : ''
      const finalExclusionNote = excludedZeroOrSettled.length > 0
        ? ` ℹ ${excludedZeroOrSettled.length} zero-limit/settled facilit${excludedZeroOrSettled.length===1?'y was':'ies were'} left out of the working paper entirely, matching the Reference convention: ${excludedZeroOrSettled.map(f => f.facilityCode || f.facilityName || 'unnamed').join(', ')}.`
        : ''
      const countLine = `${reconciled.length} facilit${reconciled.length === 1 ? 'y' : 'ies'} reconciled from ${extractedDocs.length} document${extractedDocs.length === 1 ? '' : 's'} across ${bankCount} bank${bankCount === 1 ? '' : 's'}.${skippedNote}${restoredNote}${dedupNote}${omittedNote}${deterministicNote}${finalExclusionNote}`
      setReconcileSummary(`${countLine} ${result.summary || ''}`.trim())
      setResultTab('paper')
      setShowResults(true)
    } catch (err) {
      setShowResults(false)
      alert('Reconciliation failed: ' + err.message)
    } finally {
      setReconciling(false)
    }
  }

  // Called by "View Summary" on the Documents page — auto-reconciles only if
  // the ticked selection has changed since the last successful reconcile of
  // that exact set, so re-visiting the tab never burns a wasted API call.
  function viewSummaryAndMaybeReconcile() {
    const { fp, count } = currentTickedFingerprint()
    const alreadyCurrent = fp !== '' && fp === (eng.reconcileFingerprint || '')
    if (count >= 2 && !alreadyCurrent) {
      handleReconcile()
    }
    setActiveSection('A420')
    setActiveTab('summary')
  }

  const facilities  = eng.facilities || []
  const loans        = facilities.filter(f => f.facilityType === 'L')
  const hp            = facilities.filter(f => f.facilityType === 'HP')
  const loanTotal     = loans.reduce((s,f) => s + (parseFloat(f.approvedLimit)||0), 0)
  const loanUtilised  = loans.reduce((s,f) => s + (parseFloat(f.amtUtilised)||0), 0)
  const hpTotal       = hp.reduce((s,f) => s + (parseFloat(f.approvedLimit)||0), 0)
  const hpUtilised    = hp.reduce((s,f) => s + (parseFloat(f.amtUtilised)||0), 0)
  const grandTotal    = loanTotal + hpTotal
  const grandUtil     = loanUtilised + hpUtilised
  const grandUnut     = grandTotal - grandUtil

  // Group sections by group label
  const groups = {}
  WP_SECTIONS.forEach(s => {
    if (!groups[s.group]) groups[s.group] = []
    groups[s.group].push(s)
  })

  const sectionStatus = (code) => eng.sections?.[code]?.status || 'not_started'

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

      {/* ── Left Sidebar ─────────────────────────────────────────────── */}
      <aside style={{
        width: 228, minWidth: 228, background: 'var(--bg2)',
        borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>

        {/* Client card */}
        <div style={{ padding: '16px 16px 14px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>{eng.client}</div>
          <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)', marginBottom: 10 }}>
            FY {eng.fyEnd} · {eng.fileRef}
          </div>
          {/* Progress bar */}
          <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, marginBottom: 4 }}>
            <div style={{
              height: '100%', borderRadius: 2,
              width: `${pct}%`,
              background: pct === 100 ? 'var(--green)' : 'linear-gradient(90deg, var(--gold), var(--magenta))',
              transition: 'width 0.4s ease',
            }} />
          </div>
          <div style={{ fontSize: 10, color: 'var(--text3)' }}>{done}/{total} sections</div>
        </div>

        {/* Engagement nav */}
        <div style={{ padding: '10px 10px 6px' }}>
          <div style={{ fontSize: 9, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 0.8, padding: '4px 6px 6px', fontWeight: 600 }}>
            ENGAGEMENT
          </div>
          {[
            { id: 'documents', label: 'Documents', Icon: FileText,  badge: eng.uploadedDocs?.length || 0 },
            { id: 'insight',   label: 'Ask AI', Icon: Sparkles, badge: null },
          ].map(({ id, label, Icon, badge }) => (
            <button key={id}
              onClick={() => { setActiveSection('A420'); setActiveTab(id) }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                padding: '7px 8px', borderRadius: 6, border: 'none',
                background: activeTab === id && activeSection === 'A420' ? 'rgba(245,158,11,0.1)' : 'none',
                color: activeTab === id && activeSection === 'A420' ? 'var(--gold)' : 'var(--text2)',
                fontSize: 12, fontWeight: activeTab === id ? 500 : 400,
                marginBottom: 1, textAlign: 'left', transition: 'all 0.12s',
              }}
              onMouseEnter={e => { if (!(activeTab === id && activeSection === 'A420')) e.currentTarget.style.color = 'var(--text)' }}
              onMouseLeave={e => { if (!(activeTab === id && activeSection === 'A420')) e.currentTarget.style.color = 'var(--text2)' }}
            >
              <Icon size={13} />
              <span style={{ flex: 1 }}>{label}</span>
              {badge > 0 && (
                <span style={{
                  background: 'rgba(245,158,11,0.15)', color: 'var(--gold)',
                  fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 4,
                }}>{badge}</span>
              )}
            </button>
          ))}
        </div>

        {/* WP sections */}
        <div style={{ flex: 1, overflow: 'auto', padding: '6px 10px 12px' }}>
          {Object.entries(groups).map(([groupName, secs]) => (
            <div key={groupName} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 9, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 0.8, padding: '6px 6px 4px', fontWeight: 600 }}>
                {groupName}
              </div>
              {secs.map(s => {
                const st   = sectionStatus(s.code)
                const isActive = activeSection === s.code && activeTab === 'summary'
                const isPhase1 = s.phase === 1
                const isDone   = st === 'completed'
                const isLive   = st === 'in_progress'

                return (
                  <button key={s.code}
                    onClick={() => { if (isPhase1) { setActiveSection(s.code); setActiveTab('summary') } }}
                    disabled={!isPhase1}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 8px', borderRadius: 6, border: 'none',
                      background: isActive ? 'rgba(245,158,11,0.1)' : 'none',
                      color: !isPhase1 ? 'var(--text3)' : isActive ? 'var(--gold)' : 'var(--text2)',
                      fontSize: 12, fontWeight: isActive ? 500 : 400,
                      marginBottom: 1, textAlign: 'left', cursor: isPhase1 ? 'pointer' : 'default',
                      opacity: !isPhase1 ? 0.5 : 1, transition: 'all 0.12s',
                    }}>
                    {/* Status indicator */}
                    <div style={{
                      width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                      background: isDone ? 'rgba(34,197,94,0.15)' : isLive ? 'rgba(245,158,11,0.15)' : 'var(--card2)',
                      border: `1px solid ${isDone ? 'rgba(34,197,94,0.4)' : isLive ? 'rgba(245,158,11,0.4)' : 'var(--border)'}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 8, color: isDone ? 'var(--green)' : isLive ? 'var(--gold)' : 'transparent',
                    }}>
                      {isDone ? '✓' : isLive ? '●' : ''}
                    </div>
                    <span style={{ flex: 1 }}>{s.code} · {s.label}</span>
                    {!isPhase1 && <Lock size={9} style={{ opacity: 0.4 }} />}
                    {isLive && <span className="badge badge-live" style={{ fontSize: 9, padding: '1px 5px' }}>Live</span>}
                    {isDone && <ChevronRight size={10} style={{ opacity: 0.4 }} />}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </aside>

      {/* ── Main content area ─────────────────────────────────────────── */}
      <main style={{ flex: 1, overflow: 'auto', background: 'var(--bg)' }}>
        {activeTab === 'documents' && (
          <A420Documents
            eng={eng}
            updateDocs={updateDocs}
            updateFacilities={updateFacilities}
            updateRawFacilities={updateRawFacilities}
            updateDocsAndFacilities={updateDocsAndFacilities}
            setActiveTab={setActiveTab}
            setActiveSection={setActiveSection}
            onViewSummary={viewSummaryAndMaybeReconcile}
          />
        )}
        {activeTab === 'summary' && activeSection === 'A420' && (
          <A420Summary
            eng={eng}
            updateFacilities={updateFacilities}
            setActiveTab={setActiveTab}
            reconciling={reconciling}
            reconcileSummary={reconcileSummary}
            reconciledCount={reconciledCount}
            showResults={showResults}
            setShowResults={setShowResults}
            resultTab={resultTab}
            setResultTab={setResultTab}
            handleReconcile={handleReconcile}
            batchedReconcile={batchedReconcile}
            setBatchedReconcile={setBatchedReconcile}
          />
        )}
        {activeTab === 'insight' && (
          <AIInsight eng={eng} updateEngagement={updateEngagement} />
        )}
      </main>

      {/* Results modal — rendered here, independent of which tab is active,
          so it survives switching to Documents/AI Insights and back, and can
          be triggered from either page. */}
      {showResults && (
        <ResultsModal
          facilities={facilities} eng={eng}
          loanTotal={loanTotal} hpTotal={hpTotal} grandTotal={grandTotal} grandUtil={grandUtil} grandUnut={grandUnut}
          tab={resultTab} setTab={setResultTab}
          reconciling={reconciling}
          reconcileProgress={reconciling ? reconcileSummary : ''}
          onExport={() => exportLoanRecords(facilities, eng)}
          onClose={() => setShowResults(false)}
        />
      )}
    </div>
  )
}
