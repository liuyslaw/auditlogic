import { useState, useRef } from 'react'
import { Plus, Trash2, Edit3, Check, X, Download, AlertTriangle, RotateCcw, GitMerge, Loader, History, RefreshCw } from 'lucide-react'
import { exportLoanRecords } from '../lib/excel.js'
import { fmtRM, docTypeColor } from '../lib/store.js'
import { ConfidenceBadge } from './A420Documents.jsx'

// ── Confidence per facility ───────────────────────────────────────────────
function getFacilityConfidence(fac, uploadedDocs) {
  if (!fac.sourceDocIds?.length || !uploadedDocs?.length) return null
  const confs = fac.sourceDocIds.map(id => {
    const doc = uploadedDocs.find(d => d.id === id)
    return doc?.confidence?.score ?? null
  }).filter(s => s !== null)
  if (!confs.length) return null
  const min = Math.min(...confs)
  const level = min >= 80 ? 'high' : min >= 60 ? 'medium' : 'low'
  const color = level === 'high' ? '#22c55e' : level === 'medium' ? '#f59e0b' : '#ef4444'
  return { score: min, level, color, label: level === 'high' ? 'High' : level === 'medium' ? 'Medium' : 'Low', reasons: [] }
}

// ── Edit modal ────────────────────────────────────────────────────────────
function EditModal({ fac, onSave, onClose }) {
  const [data, setData] = useState({ ...fac })
  const field = (key, label, wide = false, multiline = false) => (
    <div key={key} style={{ gridColumn: wide ? '1 / -1' : 'auto' }}>
      <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      {multiline
        ? <textarea value={data[key] ?? ''} onChange={e => setData(p => ({ ...p, [key]: e.target.value }))} rows={3}
            style={{ width:'100%',background:'var(--bg)',border:'1px solid var(--border)',borderRadius:6,padding:'7px 10px',color:'var(--text)',fontSize:12,outline:'none',resize:'vertical',fontFamily:'var(--font)' }}
            onFocus={e=>e.target.style.borderColor='var(--gold)'} onBlur={e=>e.target.style.borderColor='var(--border)'} />
        : <input value={data[key] ?? ''} onChange={e => setData(p => ({ ...p, [key]: e.target.value }))}
            style={{ width:'100%',background:'var(--bg)',border:'1px solid var(--border)',borderRadius:6,padding:'7px 10px',color:'var(--text)',fontSize:12,outline:'none' }}
            onFocus={e=>e.target.style.borderColor='var(--gold)'} onBlur={e=>e.target.style.borderColor='var(--border)'} />
      }
    </div>
  )
  return (
    <div style={{ position:'fixed',inset:0,zIndex:100,background:'rgba(0,0,0,0.75)',display:'flex',alignItems:'center',justifyContent:'center' }}
      onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{ background:'var(--card)',border:'1px solid var(--border)',borderRadius:12,padding:24,width:720,maxHeight:'88vh',overflow:'auto',boxShadow:'0 20px 60px rgba(0,0,0,0.6)' }}>
        <div style={{ fontSize:14,fontWeight:600,color:'var(--text)',marginBottom:16 }}>Edit Facility — {fac.facilityName}</div>
        <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:12 }}>
          {field('bankNo','Bank No.')}
          {field('bankName','Bank Name')}
          {field('awpRef','AWP Ref')}
          {field('facilityName','Facility Name')}
          {field('facilitySubName','Sub-name (e.g. SMElite 2.0)')}
          {field('facilityType','Type (L / HP)')}
          {field('approvedLimit','Approved Limit (RM)')}
          {field('amtUtilised','Amt Utilised / O/S Balance (RM)')}
          {field('interestRateText','Interest Rate (text)')}
          {field('interestRateCalc','Interest Rate (calc)')}
          {field('repaymentLine1','Repayment Line 1',true)}
          {field('repaymentLine2','Repayment Line 2',true)}
          {field('repaymentLine3','Repayment Line 3',true)}
          {field('securityBlock','Security (multi-line)',true,true)}
          {field('loanCovenant','Loan Covenant',true,true)}
          {field('purposes','Purposes',true,true)}
          {field('crossRef','Cross-ref to PAF')}
          {field('facilityDate','Facility Agreement Date (DD.MM.YYYY)')}
          {field('loDocType','Document Type')}
          <div style={{ display:'flex',alignItems:'center',gap:8 }}>
            <input type="checkbox" checked={!!data.isSettled} onChange={e=>setData(p=>({...p,isSettled:e.target.checked}))} id="settled" />
            <label htmlFor="settled" style={{ fontSize:12,color:'var(--text2)' }}>Mark as Settled</label>
          </div>
        </div>
        <div style={{ display:'flex',gap:8,marginTop:16 }}>
          <button onClick={() => onSave(data)} style={{ background:'var(--gold)',border:'none',borderRadius:7,padding:'8px 20px',color:'#111',fontSize:12,fontWeight:600,display:'flex',alignItems:'center',gap:5 }}>
            <Check size={13}/> Save
          </button>
          <button onClick={onClose} style={{ background:'none',border:'1px solid var(--border)',borderRadius:7,padding:'8px 14px',color:'var(--text2)',fontSize:12 }}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ── Confirm dialog ────────────────────────────────────────────────────────
function ConfirmDialog({ message, onConfirm, onCancel }) {
  return (
    <div style={{ position:'fixed',inset:0,zIndex:200,background:'rgba(0,0,0,0.75)',display:'flex',alignItems:'center',justifyContent:'center' }}
      onClick={onCancel}>
      <div onClick={e=>e.stopPropagation()} style={{ background:'var(--card)',border:'1px solid var(--border)',borderRadius:10,padding:24,width:340,boxShadow:'0 20px 60px rgba(0,0,0,0.6)' }}>
        <div style={{ fontSize:13,color:'var(--text)',marginBottom:16,lineHeight:1.5 }}>{message}</div>
        <div style={{ display:'flex',gap:8 }}>
          <button onClick={onConfirm} style={{ flex:1,background:'rgba(239,68,68,0.12)',border:'1px solid rgba(239,68,68,0.3)',borderRadius:6,padding:'8px',color:'var(--red)',fontSize:12,fontWeight:600 }}>
            Yes, clear
          </button>
          <button onClick={onCancel} style={{ flex:1,background:'none',border:'1px solid var(--border)',borderRadius:6,padding:'8px',color:'var(--text3)',fontSize:12 }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Results modal: Working Paper + Review Items (Option A) ─────────────────
export function ResultsModal({ facilities, eng, loanTotal, hpTotal, grandTotal, grandUtil, grandUnut, tab, setTab, reconciling, reconcileProgress, onExport, onClose }) {
  const flagged = facilities.filter(f => (f.redFlags?.length > 0) || (f.changeHistory?.length > 0))
  const flagCount = facilities.reduce((s, f) => s + (f.redFlags?.length || 0), 0)
  const loans = facilities.filter(f => f.facilityType === 'L')
  const hp    = facilities.filter(f => f.facilityType === 'HP')

  const TabBtn = ({ id, label, count }) => (
    <button onClick={() => setTab(id)} style={{
      display:'flex', alignItems:'center', gap:6, padding:'8px 14px', fontSize:12, fontWeight:600,
      background: tab===id ? 'var(--bg)' : 'transparent',
      color: tab===id ? 'var(--text)' : 'var(--text3)',
      border:'none', borderBottom: tab===id ? '2px solid var(--gold)' : '2px solid transparent',
      borderRadius:0,
    }}>
      {label}
      {count > 0 && (
        <span style={{ background: id==='review' ? 'rgba(239,68,68,0.15)' : 'rgba(184,68,128,0.15)', color: id==='review' ? 'var(--red)' : 'var(--magenta)',
          borderRadius:10, padding:'1px 7px', fontSize:10, fontWeight:700 }}>{count}</span>
      )}
    </button>
  )

  const Row = ({ f }) => (
    <tr>
      <td style={{ padding:'7px 10px', fontSize:11, color:'var(--text2)', borderTop:'1px solid var(--border)' }}>{f.bankName || '—'}</td>
      <td style={{ padding:'7px 10px', fontSize:11, color:'var(--text3)', borderTop:'1px solid var(--border)', fontFamily:'var(--mono)' }}>{f.awpRef || '—'}</td>
      <td style={{ padding:'7px 10px', fontSize:11, color:'var(--text)', borderTop:'1px solid var(--border)' }}>
        {f.facilityName}{f.facilitySubName ? <span style={{ color:'var(--text3)' }}> · {f.facilitySubName}</span> : ''}
        {f.isSettled && <span style={{ marginLeft:6, fontSize:9, color:'var(--amber)', border:'1px solid rgba(245,158,11,0.35)', borderRadius:4, padding:'1px 5px' }}>SETTLED</span>}
      </td>
      <td style={{ padding:'7px 10px', fontSize:11, textAlign:'right', fontFamily:'var(--mono)', color:'var(--text)', borderTop:'1px solid var(--border)' }}>{fmtRM(f.approvedLimit)}</td>
      <td style={{ padding:'7px 10px', fontSize:11, textAlign:'right', fontFamily:'var(--mono)', color:'var(--green)', borderTop:'1px solid var(--border)' }}>{f.amtUtilised!=='' && f.amtUtilised!=null ? fmtRM(f.amtUtilised) : '—'}</td>
      <td style={{ padding:'7px 10px', fontSize:11, color:'var(--text3)', borderTop:'1px solid var(--border)' }}>{f.facilityDate || '—'}</td>
    </tr>
  )

  return (
    <div style={{ position:'fixed', top:0, left:228, right:0, bottom:0, zIndex:100, background:'rgba(0,0,0,0.75)', display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}
      onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{ background:'var(--card)', border:'1px solid var(--border)', borderRadius:12, width:820, maxWidth:'100%', maxHeight:'86vh', display:'flex', flexDirection:'column', boxShadow:'0 20px 60px rgba(0,0,0,0.6)' }}>

        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'16px 20px 0 20px', flexShrink:0 }}>
          <div style={{ fontSize:14, fontWeight:600, color:'var(--text)' }}>Reconciliation Results</div>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text3)', padding:4 }}><X size={18}/></button>
        </div>

        {/* Tabs + Body, or a loading state while reconcile is in flight */}
        {reconciling ? (
          <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:14, padding:'50px 20px' }}>
            <Loader size={28} color="var(--gold)" style={{ animation:'spin 1s linear infinite' }}/>
            <div style={{ fontSize:13, color:'var(--text2)', fontWeight:500 }}>Reconciling facilities…</div>
            {reconcileProgress ? (
              <div style={{ fontSize:11, color:'var(--gold)', fontWeight:600 }}>{reconcileProgress}</div>
            ) : null}
            <div style={{ fontSize:11, color:'var(--text3)', textAlign:'center', maxWidth:340 }}>
              Comparing documents, merging duplicates, and checking for settlement, shared limits and drift. Larger sets are processed in smaller batches by bank/account, so this can take a little while — feel free to switch tabs, this stays running.
            </div>
          </div>
        ) : (
        <>
        <div style={{ display:'flex', gap:4, padding:'10px 16px 0 16px', borderBottom:'1px solid var(--border)', flexShrink:0 }}>
          <TabBtn id="paper"  label="Working Paper" count={0} />
          <TabBtn id="review" label="Review Items"  count={flagCount} />
        </div>

        {/* Body */}
        <div style={{ flex:1, overflow:'auto', padding:16 }}>
          {tab === 'paper' && (
            <>
              <div style={{ display:'flex', gap:18, marginBottom:12, flexWrap:'wrap' }}>
                {[
                  { label:'LOAN TOTAL',  val:loanTotal,  color:'var(--text2)' },
                  { label:'HP TOTAL',    val:hpTotal,    color:'var(--text2)' },
                  { label:'GRAND TOTAL', val:grandTotal, color:'var(--gold)' },
                  { label:'UTILISED',    val:grandUtil,  color:'var(--green)' },
                  { label:'UNUTILISED',  val:grandUnut,  color:'var(--amber)' },
                ].map(t => (
                  <div key={t.label} style={{ display:'flex', gap:4, alignItems:'baseline' }}>
                    <span style={{ fontSize:9, color:'var(--text3)', textTransform:'uppercase', letterSpacing:0.5 }}>{t.label}</span>
                    <span style={{ fontSize:11, fontFamily:'var(--mono)', color:t.color, fontWeight:600 }}>RM {t.val.toLocaleString('en-MY')}</span>
                  </div>
                ))}
              </div>
              <div style={{ fontSize:10, color:'var(--text3)', marginBottom:14, lineHeight:1.5 }}>
                This is exactly what Export A420 will produce. Switch to Review Items for anything worth confirming before you send it.
              </div>
              {loans.length > 0 && <>
                <div style={{ fontSize:10, color:'var(--text3)', fontWeight:700, letterSpacing:0.5, marginBottom:4 }}>LOANS (L)</div>
                <table style={{ width:'100%', borderCollapse:'collapse', marginBottom:18 }}>
                  <thead><tr>
                    {['Bank','AWP','Facility','Limit (RM)','Utilised (RM)','Date'].map(h => (
                      <th key={h} style={{ padding:'6px 10px', textAlign: h.includes('RM')?'right':'left', fontSize:9, color:'var(--text3)', textTransform:'uppercase', letterSpacing:0.5, borderBottom:'1px solid var(--border)' }}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>{loans.map(f => <Row key={f.id} f={f} />)}</tbody>
                </table>
              </>}
              {hp.length > 0 && <>
                <div style={{ fontSize:10, color:'var(--text3)', fontWeight:700, letterSpacing:0.5, marginBottom:4 }}>HIRE PURCHASE (HP)</div>
                <table style={{ width:'100%', borderCollapse:'collapse' }}>
                  <thead><tr>
                    {['Bank','AWP','Facility','Limit (RM)','Utilised (RM)','Date'].map(h => (
                      <th key={h} style={{ padding:'6px 10px', textAlign: h.includes('RM')?'right':'left', fontSize:9, color:'var(--text3)', textTransform:'uppercase', letterSpacing:0.5, borderBottom:'1px solid var(--border)' }}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>{hp.map(f => <Row key={f.id} f={f} />)}</tbody>
                </table>
              </>}
            </>
          )}

          {tab === 'review' && (
            flagged.length === 0 ? (
              <div style={{ fontSize:12, color:'var(--text3)', textAlign:'center', padding:'30px 0' }}>Nothing flagged. AuditLogic found no items needing confirmation on this run.</div>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
                {flagged.map(f => (
                  <div key={f.id} style={{ border:'1px solid var(--border)', borderRadius:8, padding:12 }}>
                    <div style={{ fontSize:12, fontWeight:600, color:'var(--text)', marginBottom:8 }}>
                      {f.bankName ? `${f.bankName} — ` : ''}{f.facilityName}
                    </div>
                    {f.redFlags?.map((item, i) => (
                      <div key={'r'+i} style={{ display:'flex', gap:8, marginBottom:6 }}>
                        <div style={{ width:6,height:6,borderRadius:'50%',background:'var(--red)',marginTop:5,flexShrink:0 }}/>
                        <div style={{ fontSize:11, color:'var(--text2)', lineHeight:1.5 }}>{item}</div>
                      </div>
                    ))}
                    {f.changeHistory?.map((item, i) => (
                      <div key={'c'+i} style={{ display:'flex', gap:8, marginBottom:6 }}>
                        <div style={{ width:6,height:6,borderRadius:'50%',background:'var(--magenta)',marginTop:5,flexShrink:0 }}/>
                        <div style={{ fontSize:11, color:'var(--text3)', lineHeight:1.5 }}>{item}</div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )
          )}
        </div>
        </>
        )}

        {/* Footer */}
        <div style={{ display:'flex', gap:8, padding:14, borderTop:'1px solid var(--border)', flexShrink:0 }}>
          <button onClick={onExport} disabled={reconciling} style={{ display:'flex',alignItems:'center',gap:6,background: reconciling?'rgba(34,197,94,0.04)':'rgba(34,197,94,0.1)',border:'1px solid rgba(34,197,94,0.3)',borderRadius:7,padding:'8px 16px',color: reconciling?'var(--text3)':'var(--green)',fontSize:12,fontWeight:600,cursor: reconciling?'default':'pointer' }}>
            <Download size={13}/> Export A420
          </button>
          <button onClick={onClose} style={{ marginLeft:'auto',background:'none',border:'1px solid var(--border)',borderRadius:7,padding:'8px 16px',color:'var(--text2)',fontSize:12 }}>
            {reconciling ? 'Hide — keep running' : 'Close — keep editing'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────
export default function A420Summary({ eng, updateFacilities, setActiveTab, reconciling, reconcileSummary, reconciledCount, showResults, setShowResults, resultTab, setResultTab, handleReconcile }) {
  const [editing, setEditing]             = useState(null)
  const [confirm, setConfirm]             = useState(null)
  const [historyView, setHistoryView]     = useState(null)
  const tableRef = useRef(null)

  function scrollTable(dir) {
    if (tableRef.current) tableRef.current.scrollBy({ left: dir * 320, behavior: 'smooth' })
  }

  const facilities = eng.facilities || []
  const loans = facilities.filter(f => f.facilityType === 'L')
  const hp    = facilities.filter(f => f.facilityType === 'HP')

  const loanTotal    = loans.reduce((s,f) => s + (parseFloat(f.approvedLimit)||0), 0)
  const loanUtilised = loans.reduce((s,f) => s + (parseFloat(f.amtUtilised)||0), 0)
  const hpTotal      = hp.reduce((s,f) => s + (parseFloat(f.approvedLimit)||0), 0)
  const hpUtilised   = hp.reduce((s,f) => s + (parseFloat(f.amtUtilised)||0), 0)
  const grandTotal   = loanTotal + hpTotal
  const grandUtil    = loanUtilised + hpUtilised
  const grandUnut    = grandTotal - grandUtil

  const lowConf = facilities.filter(f => getFacilityConfidence(f, eng.uploadedDocs)?.level === 'low').length

  // Unreconciled-data warning — detects the specific failure mode where a
  // reconcile call fails (e.g. network error) and the table is left showing
  // extraction's raw per-document dump instead of a merged result. Signal:
  // the same facility name + bank appearing more than once, which a
  // successful reconcile always collapses. This is independent of whether
  // reconcile "looks" like it ran — it checks the actual data for the
  // fingerprint a failed/incomplete reconcile leaves behind.
  // Signature MUST match EngagementShell.jsx's actual dedup-removal logic
  // exactly (name+limit+date+bank) — NOT just name+bank. Using a weaker
  // signature here than what actually gets removed causes false positives.
  // ALSO includes facilitySubName — the working paper itself displays
  // facilityName and facilitySubName combined (see excel.js), and the
  // sub-name is very often what actually distinguishes a generically-named
  // facility ("Hire Purchase") into something specific ("Isuzu D-Max
  // CEQ3320"). Leaving it out of the signature risks treating genuinely
  // different vehicles as the same fact; leaving it out of the display
  // makes a real duplicate impossible to identify at a glance.
  const dupSigCounts = {}
  const dupSigEntries = {}
  facilities.forEach(f => {
    const sig = [
      (f.facilityName||'').trim().toLowerCase(),
      (f.facilitySubName||'').trim().toLowerCase(),
      parseFloat(f.approvedLimit) || 0,
      (f.facilityDate||'').trim(),
      f.bankName||'',
    ].join('|')
    dupSigCounts[sig] = (dupSigCounts[sig] || 0) + 1
    if (!dupSigEntries[sig]) dupSigEntries[sig] = []
    dupSigEntries[sig].push(f)
  })
  const likelyUnreconciled = Object.values(dupSigCounts).some(c => c >= 2)
  const duplicateCount = Object.values(dupSigCounts).filter(c => c >= 2).reduce((s,c) => s + c, 0)

  // Resolve source document filenames so a genuine duplicate shows exactly
  // which file(s) it came from, not just a repeated facility name.
  function sourceFileNames(f) {
    const names = (f.sourceDocIds || [])
      .map(id => (eng.uploadedDocs || []).find(d => d.id === id)?.name)
      .filter(Boolean)
    return names.length ? names.join('; ') : 'source document unknown'
  }

  // Same combination the working paper itself uses (facilityName +
  // facilitySubName), so the warning reads the same way the table does.
  function displayName(f) {
    return [f.facilityName, f.facilitySubName].filter(Boolean).join(' — ') || 'Unnamed facility'
  }

  const duplicateGroupLabels = Object.entries(dupSigCounts)
    .filter(([, c]) => c >= 2)
    .map(([sig, c]) => {
      const group = dupSigEntries[sig]
      const f = group[0]
      const limitStr = parseFloat(f.approvedLimit) ? `RM${parseFloat(f.approvedLimit).toLocaleString('en-MY')}` : 'no limit stated'
      const header = `${displayName(f)} (${f.bankName || 'unknown bank'}), ${limitStr}, dated ${f.facilityDate || 'unknown date'} — appears ${c} times:`
      const sources = group.map(g => `— ${sourceFileNames(g)}`).join('  ')
      return `${header}  ${sources}`
    })

  function saveFac(updated) {
    updateFacilities(facilities.map(f => f.id === updated.id ? updated : f))
    setEditing(null)
  }

  function deleteFac(id) {
    setConfirm({
      message: 'Remove this facility from the summary?',
      onConfirm: () => { updateFacilities(facilities.filter(f => f.id !== id)); setConfirm(null) }
    })
  }

  function clearAll() {
    setConfirm({
      message: 'Clear ALL facilities from the summary? Your uploaded documents stay, and their extraction status stays too — but their facility data will be removed along with everything else. To bring a document\'s facilities back afterwards, click Re-run on it (reads from the file already stored, no re-upload needed). Are you sure?',
      onConfirm: () => { updateFacilities([]); setConfirm(null) }
    })
  }

  function clearLoans() {
    setConfirm({
      message: 'Clear all LOAN facilities from the summary? To bring a document\'s facilities back afterwards, click Re-run on it.',
      onConfirm: () => { updateFacilities(facilities.filter(f => f.facilityType !== 'L')); setConfirm(null) }
    })
  }

  function clearHP() {
    setConfirm({
      message: 'Clear all HIRE PURCHASE facilities from the summary? To bring a document\'s facilities back afterwards, click Re-run on it.',
      onConfirm: () => { updateFacilities(facilities.filter(f => f.facilityType !== 'HP')); setConfirm(null) }
    })
  }

  function clearByDoc(docId) {
    setConfirm({
      message: `Remove all facilities extracted from this document? Click Re-run on it afterwards to bring them back.`,
      onConfirm: () => {
        updateFacilities(facilities.filter(f => !(f.sourceDocIds || []).includes(docId)))
        setConfirm(null)
      }
    })
  }

  // FIX (dead code bug): the old `rerunning` state and `handleRerun()`
  // function that used to live here have been removed. Nothing in this
  // file's JSX ever called handleRerun or referenced rerunning — it was a
  // fully unreachable leftover from an earlier re-run design (superseded by
  // the working Re-run button in A420Documents.jsx, which reads the stored
  // file from IndexedDB). Removing it changes no behaviour; the real Re-run
  // flow is untouched.

  // Build bank groups — FIX (bankNo bug): numbered by order of first
  // appearance (bankName), NOT read from fac.bankNo. Extraction and
  // reconcile currently write bankNo as a hardcoded '1' on every facility
  // (an upstream limitation left untouched here deliberately, to avoid
  // risking that pipeline). Grouping by bankName instead means each
  // distinct bank still gets its own correct group and its own correct
  // sequential display number, without depending on bankNo being correct.
  const seenGroups = new Set()
  const bankGroups = []
  loans.forEach(f => {
    const name = f.bankName || ''
    if (!seenGroups.has(name)) { seenGroups.add(name); bankGroups.push({ key: name, bankName: name }) }
  })
  bankGroups.forEach((g, i) => { g.bankNo = String(i + 1) })

  const TH = ({ ch, right, tint, w }) => (
    <th style={{ padding:'8px 10px', textAlign:right?'right':'left', fontSize:10, color:'var(--text3)', fontWeight:600, textTransform:'uppercase', letterSpacing:0.5, borderBottom:'2px solid var(--border)', borderLeft:'1px solid var(--border)', background:tint==='green'?'rgba(34,197,94,0.05)':tint==='amber'?'rgba(245,158,11,0.05)':'var(--bg2)', whiteSpace:'nowrap', minWidth:w||'auto', position:'sticky', top:0, zIndex:10 }}>
      {ch}
    </th>
  )

  function FacRow({ fac, isLoan }) {
    const unutilised = (parseFloat(fac.approvedLimit)||0) - (parseFloat(fac.amtUtilised)||0)
    const conf = getFacilityConfidence(fac, eng.uploadedDocs)
    const isLow = conf?.level === 'low'
    const isMed = conf?.level === 'medium'
    const repLines = [fac.repaymentLine1, fac.repaymentLine2, fac.repaymentLine3].filter(Boolean)
    const secLines = (fac.securityBlock||'').split('\n').filter(Boolean)
    const covLines = (fac.loanCovenant||'').split('\n').filter(Boolean)
    const purLines = (fac.purposes||'').split('\n').filter(Boolean)

    const hasFlags = fac.redFlags?.length > 0
    const hasChanges = fac.changeHistory?.length > 0

    return (
      <tr style={{
        borderBottom:'1px solid var(--border)', verticalAlign:'top',
        borderLeft: hasFlags ? '4px solid var(--red)' : isLow ? '3px solid rgba(239,68,68,0.5)' : isMed ? '3px solid rgba(245,158,11,0.4)' : 'none',
        background: hasFlags ? 'rgba(239,68,68,0.04)' : isLow ? 'rgba(239,68,68,0.03)' : isMed ? 'rgba(245,158,11,0.02)' : 'transparent',
      }}>
        <td style={{ padding:'9px 8px', borderLeft:'1px solid var(--border)', width:54, textAlign:'center', verticalAlign:'top' }}>
          <span style={{ fontSize:10, color:'var(--text3)', fontFamily:'var(--mono)', fontWeight:600 }}>{isLoan?'L':'HP'}</span>
          {fac.isSettled && <div style={{ fontSize:9, color:'var(--text3)', marginTop:2 }}>SETTLED</div>}
          {(hasFlags || hasChanges) && (
            <button
              onClick={() => setHistoryView(hasFlags ? {...fac, _showFlags: true} : fac)}
              title={hasFlags ? `${fac.redFlags.length} red flag(s) — tap to review` : `${fac.changeHistory.length} change(s) tracked`}
              style={{ marginTop:4, width:22, height:22, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center',
                background: hasFlags ? 'rgba(239,68,68,0.18)' : 'rgba(184,68,128,0.18)', border: hasFlags ? '1px solid var(--red)' : '1px solid var(--magenta)',
                color: hasFlags ? 'var(--red)' : 'var(--magenta)', marginLeft:'auto', marginRight:'auto' }}>
              {hasFlags ? <AlertTriangle size={12}/> : <History size={12}/>}
            </button>
          )}
        </td>
        <td style={{ padding:'9px 10px', borderLeft:'1px solid var(--border)', width:90, verticalAlign:'top' }}>
          <span style={{ fontSize:11, fontFamily:'var(--mono)', color:'var(--text2)' }}>{fac.awpRef}</span>
        </td>
        <td style={{ padding:'9px 10px', borderLeft:'1px solid var(--border)', minWidth:200, maxWidth:260, wordBreak:'break-word', verticalAlign:'top' }}>
          <div style={{ fontSize:12, fontWeight:600, color:fac.isSettled?'var(--text3)':'var(--text)' }}>{fac.facilityName || fac.facilityCode || '(unnamed facility)'}</div>
          {fac.facilitySubName && <div style={{ fontSize:10, color:'var(--text3)', marginTop:2 }}>{fac.facilitySubName}</div>}
          {fac.loDocType && (
            <div style={{ marginTop:4, display:'inline-flex', alignItems:'center', fontSize:9, padding:'1px 5px', borderRadius:3, color:docTypeColor(fac.loDocType), background:`${docTypeColor(fac.loDocType)}15`, border:`1px solid ${docTypeColor(fac.loDocType)}30` }}>
              {fac.loDocType}
            </div>
          )}
        </td>
        <td style={{ padding:'9px 10px', borderLeft:'1px solid var(--border)', textAlign:'right', minWidth:110, fontFamily:'var(--mono)', fontSize:12, color:fac.isSettled?'var(--text3)':'var(--text)' }}>
          {fac.approvedLimit!=null&&fac.approvedLimit!==''?fmtRM(fac.approvedLimit):'—'}
        </td>
        <td style={{ padding:'9px 10px', borderLeft:'1px solid var(--border)', textAlign:'right', minWidth:110, background:'rgba(34,197,94,0.04)' }}>
          <span style={{ fontFamily:'var(--mono)', fontSize:12, color:fac.amtUtilised?'var(--green)':'var(--text3)' }}>
            {fac.amtUtilised!=null&&fac.amtUtilised!=='' ? fmtRM(fac.amtUtilised) : <span style={{fontSize:10}}>— enter</span>}
          </span>
        </td>
        <td style={{ padding:'9px 10px', borderLeft:'1px solid var(--border)', textAlign:'right', minWidth:110, background:'rgba(245,158,11,0.04)' }}>
          <span style={{ fontFamily:'var(--mono)', fontSize:12, color:'var(--amber)' }}>
            {(fac.approvedLimit!=null&&fac.amtUtilised!=null&&fac.amtUtilised!=='') ? fmtRM(unutilised) : '—'}
          </span>
        </td>
        <td style={{ padding:'9px 10px', borderLeft:'1px solid var(--border)', minWidth:150, maxWidth:200, wordBreak:'break-word', verticalAlign:'top' }}>
          <div style={{ fontSize:11, color:'var(--text)' }}>{fac.interestRateText}</div>
          {fac.interestRateCalc && <div style={{ fontSize:10, color:'var(--text3)', fontFamily:'var(--mono)', marginTop:2 }}>={fac.interestRateCalc}</div>}
        </td>
        <td style={{ padding:'9px 10px', borderLeft:'1px solid var(--border)', minWidth:240, maxWidth:300, wordBreak:'break-word', verticalAlign:'top' }}>
          {repLines.map((l,i) => <div key={i} style={{ fontSize:11, lineHeight:1.6, color:i===0?'var(--text)':'var(--text2)' }}>{l}</div>)}
        </td>
        <td style={{ padding:'9px 10px', borderLeft:'1px solid var(--border)', minWidth:240, maxWidth:300, wordBreak:'break-word', verticalAlign:'top' }}>
          {secLines.map((l,i) => <div key={i} style={{ fontSize:10, lineHeight:1.6, color:l.startsWith('-')?'var(--text2)':'var(--text)' }}>{l}</div>)}
        </td>
        <td style={{ padding:'9px 10px', borderLeft:'1px solid var(--border)', minWidth:180, maxWidth:240, wordBreak:'break-word', verticalAlign:'top' }}>
          {covLines.map((l,i) => <div key={i} style={{ fontSize:10, lineHeight:1.6, color:l==='N/A'?'var(--text3)':l.startsWith('-')?'var(--text2)':'var(--text)' }}>{l}</div>)}
        </td>
        <td style={{ padding:'9px 10px', borderLeft:'1px solid var(--border)', minWidth:200, maxWidth:280, wordBreak:'break-word', verticalAlign:'top' }}>
          {purLines.map((l,i) => <div key={i} style={{ fontSize:10, lineHeight:1.6, color:i===0?'var(--text)':'var(--text2)' }}>{l}</div>)}
        </td>
        <td style={{ padding:'9px 10px', borderLeft:'1px solid var(--border)', minWidth:90 }}>
          <span style={{ fontFamily:'var(--mono)', fontSize:11, color:'var(--blue)' }}>{fac.crossRef||'—'}</span>
        </td>
        <td style={{ padding:'9px 10px', borderLeft:'1px solid var(--border)', minWidth:110 }}>
          <span style={{ fontFamily:'var(--mono)', fontSize:11 }}>{fac.facilityDate}</span>
        </td>
        <td style={{ padding:'9px 10px', borderLeft:'1px solid var(--border)', minWidth:100 }}>
          {conf ? <ConfidenceBadge confidence={conf} /> : <span style={{fontSize:10,color:'var(--text3)'}}>—</span>}
        </td>
        <td style={{ padding:'9px 8px', borderLeft:'1px solid var(--border)' }}>
          <div style={{ display:'flex',flexDirection:'column',gap:3 }}>
            {fac.changeHistory?.length > 0 && (
              <button onClick={() => setHistoryView(fac)} title={`${fac.changeHistory.length} change(s) tracked`} style={{ background:'rgba(184,68,128,0.12)',border:'1px solid rgba(184,68,128,0.35)',borderRadius:5,padding:'5px 9px',color:'var(--magenta)',display:'flex',alignItems:'center',gap:3,fontSize:11 }}>
                <History size={11}/> {fac.changeHistory.length} change{fac.changeHistory.length>1?'s':''}
              </button>
            )}
            {fac.redFlags?.length > 0 && (
              <button onClick={() => setHistoryView({...fac, _showFlags: true})} title={`${fac.redFlags.length} red flag(s) — click to review`} style={{ background:'rgba(239,68,68,0.1)',border:'1px solid rgba(239,68,68,0.3)',borderRadius:5,padding:'5px 9px',color:'var(--red)',display:'flex',alignItems:'center',gap:3,fontSize:11 }}>
                <AlertTriangle size={11}/> {fac.redFlags.length} flag{fac.redFlags.length>1?'s':''}
              </button>
            )}
            <button onClick={() => setEditing(fac)} style={{ background:'rgba(255,255,255,0.04)',border:'1px solid var(--border)',borderRadius:5,padding:'5px 9px',color:'var(--text2)',display:'flex',alignItems:'center',gap:3,fontSize:11 }}>
              <Edit3 size={11}/> Edit
            </button>
            <button onClick={() => deleteFac(fac.id)} style={{ background:'rgba(239,68,68,0.07)',border:'1px solid rgba(239,68,68,0.3)',borderRadius:5,padding:'5px 9px',color:'var(--red)',display:'flex',alignItems:'center',gap:3,fontSize:11 }}>
              <Trash2 size={11}/> Remove
            </button>
          </div>
        </td>
      </tr>
    )
  }

  function BankHeader({ bankNo, bankName, facs }) {
    return (
      <tr style={{ background:'var(--bg2)' }}>
        <td colSpan={12} style={{ padding:'7px 12px', fontSize:12, fontWeight:700, color:'var(--gold)', borderBottom:'1px solid var(--border)', borderTop:'2px solid var(--border)' }}>
          {bankNo}) {bankName}
        </td>
        <td colSpan={3} style={{ padding:'7px 12px', borderBottom:'1px solid var(--border)', borderTop:'2px solid var(--border)', textAlign:'right' }}>
          <button onClick={() => setConfirm({
            message: `Remove all ${bankName} facilities from the summary?`,
            onConfirm: () => {
              // FIX (bankNo bug): filter on bankName only. bankNo here is
              // the computed DISPLAY sequence number (see bankGroups above),
              // which no longer matches the underlying facility's raw
              // bankNo field (still hardcoded '1' upstream) — comparing
              // against it would silently no-op this button for every bank
              // except whichever one happened to display as "1)".
              updateFacilities(facilities.filter(f => f.bankName !== bankName))
              setConfirm(null)
            }
          })} style={{ background:'rgba(239,68,68,0.07)',border:'1px solid rgba(239,68,68,0.25)',borderRadius:6,padding:'5px 10px',color:'var(--red)',fontSize:11,display:'flex',alignItems:'center',gap:4,marginLeft:'auto',cursor:'pointer' }}>
            <RotateCcw size={9}/> Clear bank
          </button>
        </td>
      </tr>
    )
  }

  function SectionHeader({ label, onClear }) {
    return (
      <tr style={{ background:'var(--bg2)' }}>
        <td colSpan={12} style={{ padding:'6px 12px', fontSize:10, fontWeight:700, color:'var(--text3)', textTransform:'uppercase', letterSpacing:1, borderBottom:'1px solid var(--border)', borderTop:'3px solid var(--border)' }}>
          {label}
        </td>
        <td colSpan={3} style={{ padding:'6px 12px', borderBottom:'1px solid var(--border)', borderTop:'3px solid var(--border)', textAlign:'right' }}>
          <button onClick={onClear} style={{ background:'rgba(239,68,68,0.07)',border:'1px solid rgba(239,68,68,0.25)',borderRadius:6,padding:'5px 10px',color:'var(--red)',fontSize:11,display:'flex',alignItems:'center',gap:4,marginLeft:'auto',cursor:'pointer' }}>
            <RotateCcw size={9}/> Clear all {label.split(' ')[0].toLowerCase()}s
          </button>
        </td>
      </tr>
    )
  }

  function TotalRow({ label, total, utilised, unutilised }) {
    return (
      <tr style={{ background:'var(--panel)', fontWeight:600 }}>
        <td colSpan={3} style={{ padding:'8px 12px', fontSize:12, color:'var(--text)', borderLeft:'1px solid var(--border)', borderTop:'2px solid var(--border)' }}>{label}</td>
        <td style={{ padding:'8px 10px', textAlign:'right', fontFamily:'var(--mono)', fontSize:12, borderLeft:'1px solid var(--border)', borderTop:'2px solid var(--border)' }}>{fmtRM(total)}</td>
        <td style={{ padding:'8px 10px', textAlign:'right', fontFamily:'var(--mono)', fontSize:12, color:'var(--green)', borderLeft:'1px solid var(--border)', borderTop:'2px solid var(--border)', background:'rgba(34,197,94,0.06)' }}>{fmtRM(utilised)}</td>
        <td style={{ padding:'8px 10px', textAlign:'right', fontFamily:'var(--mono)', fontSize:12, color:'var(--amber)', borderLeft:'1px solid var(--border)', borderTop:'2px solid var(--border)', background:'rgba(245,158,11,0.06)' }}>{fmtRM(unutilised)}</td>
        <td colSpan={9} style={{ borderLeft:'1px solid var(--border)', borderTop:'2px solid var(--border)' }} />
      </tr>
    )
  }

  return (
    <div style={{ height:'100%', display:'flex', flexDirection:'column' }}>

      {/* Toolbar */}
      <div style={{ padding:'10px 20px', borderBottom:'1px solid var(--border)', background:'var(--bg2)', display:'flex', alignItems:'center', gap:10, flexShrink:0, flexWrap:'wrap' }}>
        <div>
          <span style={{ fontSize:13, fontWeight:600, color:'var(--text)' }}>A420 · Borrowings</span>
          <span style={{ fontSize:11, color:'var(--text3)', marginLeft:8 }}>
            {loans.length} loan{loans.length!==1?'s':''} · {hp.length} HP
          </span>
        </div>

        {/* Totals */}
        <div style={{ display:'flex', gap:16, marginLeft:8 }}>
          {[
            { label:'LOAN TOTAL',  val: loanTotal,  color:'var(--text2)' },
            { label:'HP TOTAL',    val: hpTotal,     color:'var(--text2)' },
            { label:'GRAND TOTAL', val: grandTotal,  color:'var(--gold)' },
            { label:'UTILISED',    val: grandUtil,   color:'var(--green)' },
            { label:'UNUTILISED',  val: grandUnut,   color:'var(--amber)' },
          ].map(t => (
            <div key={t.label} style={{ display:'flex', gap:4, alignItems:'baseline' }}>
              <span style={{ fontSize:9, color:'var(--text3)', textTransform:'uppercase', letterSpacing:0.5 }}>{t.label}</span>
              <span style={{ fontSize:11, fontFamily:'var(--mono)', color:t.color, fontWeight:600 }}>RM {t.val.toLocaleString('en-MY')}</span>
            </div>
          ))}
        </div>

        {lowConf > 0 && (
          <div style={{ display:'flex',alignItems:'center',gap:5,background:'rgba(239,68,68,0.08)',border:'1px solid rgba(239,68,68,0.2)',borderRadius:6,padding:'4px 9px',fontSize:11,color:'#ef4444' }}>
            <AlertTriangle size={12}/> {lowConf} low-confidence — review closely
          </div>
        )}

        {reconcileSummary ? (
          <div onClick={() => setShowResults(true)} title="Click to view full results"
            style={{ display:'flex',alignItems:'center',gap:7,background:'rgba(184,68,128,0.08)',border:'1px solid rgba(184,68,128,0.25)',borderRadius:6,padding:'4px 10px',fontSize:11,color:'var(--magenta)',cursor:'pointer',whiteSpace:'nowrap' }}>
            <GitMerge size={12} style={{flexShrink:0}}/>
            {reconciledCount} facilit{reconciledCount===1?'y':'ies'} reconciled
          </div>
        ) : (
          facilities.filter(f=>f.redFlags?.length>0).length > 0 && (
            <div style={{ display:'flex',alignItems:'center',gap:5,background:'rgba(239,68,68,0.06)',border:'1px solid rgba(239,68,68,0.18)',borderRadius:6,padding:'4px 9px',fontSize:11,color:'#ef4444' }}>
              <AlertTriangle size={12}/> {facilities.reduce((s,f)=>s+(f.redFlags?.length||0),0)} audit flag{facilities.reduce((s,f)=>s+(f.redFlags?.length||0),0)>1?'s':''} — see ⚑ buttons
            </div>
          )
        )}

        <div style={{ marginLeft:'auto', display:'flex', gap:8 }}>
          <button
            onClick={handleReconcile}
            disabled={reconciling || (eng.uploadedDocs||[]).filter(d=>d.status==='extracted').length < 2}
            title="Merge duplicate facilities across Original/Supplement/Renewal docs into one consolidated row per facility"
            style={{
              display:'flex', alignItems:'center', gap:5,
              background: reconciling ? 'rgba(184,68,128,0.06)' : 'rgba(184,68,128,0.12)',
              border:'1px solid rgba(184,68,128,0.35)',
              borderRadius:6, padding:'8px 14px', color:'var(--magenta)', fontSize:12, fontWeight:500,
              opacity: (eng.uploadedDocs||[]).filter(d=>d.status==='extracted').length < 2 ? 0.4 : 1,
              cursor: (eng.uploadedDocs||[]).filter(d=>d.status==='extracted').length < 2 ? 'not-allowed' : 'pointer',
            }}>
            {reconciling
              ? <><Loader size={12} style={{animation:'spin 1s linear infinite'}}/> Reconciling…</>
              : <><GitMerge size={12}/> Reconcile Facilities</>
            }
          </button>

          {facilities.length > 0 && (
            <button onClick={clearAll} style={{ display:'flex',alignItems:'center',gap:5,background:'rgba(239,68,68,0.06)',border:'1px solid rgba(239,68,68,0.2)',borderRadius:6,padding:'8px 14px',color:'var(--red)',fontSize:12,fontWeight:500 }}>
              <RotateCcw size={13}/> Clear All
            </button>
          )}
          <button onClick={() => {
            if (likelyUnreconciled) {
              setConfirm({
                message: `This table shows ${duplicateCount} facilities that look duplicated (same name, same limit, same date, same bank) — a strong sign Reconcile hasn't successfully completed on all documents, possibly because a previous reconcile attempt failed. Exporting now will likely produce a working paper with inflated totals. Export anyway?`,
                onConfirm: () => { exportLoanRecords(facilities, eng); setConfirm(null) }
              })
            } else {
              exportLoanRecords(facilities, eng)
            }
          }} style={{ display:'flex',alignItems:'center',gap:5,background:'rgba(34,197,94,0.08)',border:'1px solid rgba(34,197,94,0.25)',borderRadius:6,padding:'8px 14px',color:'var(--green)',fontSize:12,fontWeight:500 }}>
            <Download size={13}/> Export A420
          </button>
        </div>
      </div>

      {/* Unreconciled-data warning — same detection as the export guard, but
          visible at all times, not just at the moment of export */}
      {likelyUnreconciled && (
        <div style={{ background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.3)', borderRadius:9, padding:'12px 16px', marginBottom:14, display:'flex', alignItems:'flex-start', gap:10 }}>
          <span style={{ fontSize:16 }}>⚠</span>
          <div style={{ fontSize:12, color:'var(--text)', lineHeight:1.5 }}>
            <strong>{duplicateCount} facilities in this table look duplicated</strong> — same name, same limit, same date, same bank, appearing more than once. This usually means Reconcile did not complete successfully on all the documents behind them at some point (a failed or interrupted reconcile leaves raw, unmerged data in place). Totals below are likely inflated.
            <div style={{ marginTop:8, marginBottom:8 }}>
              {duplicateGroupLabels.map((label, i) => (
                <div key={i} style={{ fontSize:11, color:'var(--text2)', paddingLeft:8, borderLeft:'2px solid rgba(239,68,68,0.3)', marginBottom:6, whiteSpace:'pre-wrap' }}>{label}</div>
              ))}
            </div>
            Ticking any documents and successfully running Reconcile — even ones unrelated to the facilities above — will automatically clean these duplicates up as part of that run. You do not need to specifically Re-run (re-extract) the affected documents; any successful reconcile clears this for the whole table.
          </div>
        </div>
      )}

      {/* Empty state */}
      {facilities.length === 0 && (
        <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', color:'var(--text3)', gap:12, padding:32 }}>
          <div style={{ fontSize:32 }}>📄</div>
          <div style={{ fontSize:14, fontWeight:500, color:'var(--text2)' }}>No facilities in summary</div>
          {(eng.uploadedDocs||[]).filter(d=>d.status==='extracted').length > 0 ? (
            <div style={{ fontSize:12, textAlign:'center', lineHeight:1.8, maxWidth:400, background:'rgba(245,158,11,0.07)', border:'1px solid rgba(245,158,11,0.2)', borderRadius:9, padding:'14px 20px' }}>
              <div style={{ color:'var(--gold)', fontWeight:600, marginBottom:6 }}>⚠ Facilities were cleared</div>
              <div style={{ color:'var(--text3)' }}>
                You have <strong style={{color:'var(--text)'}}>{(eng.uploadedDocs||[]).filter(d=>d.status==='extracted').length} document{(eng.uploadedDocs||[]).filter(d=>d.status==='extracted').length>1?'s':''}</strong> already uploaded.<br/>
                Go to the <strong style={{color:'var(--blue)', cursor:'pointer'}} onClick={()=>setActiveTab&&setActiveTab('documents')}>Documents tab</strong> and re-upload the same files — extraction runs automatically.
              </div>
            </div>
          ) : (
            <div style={{ fontSize:12, textAlign:'center', lineHeight:1.6, maxWidth:340 }}>
              Go to the <strong style={{color:'var(--blue)', cursor:'pointer'}} onClick={()=>setActiveTab&&setActiveTab('documents')}>Documents</strong> tab to upload files — extraction runs automatically.
            </div>
          )}
        </div>
      )}

      {/* Table */}
      {facilities.length > 0 && (
        <div style={{ position:'relative', flex:1, overflow:'hidden', display:'flex', flexDirection:'column' }}>
          {/* Scroll buttons */}
          <div style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', zIndex:20, display:'flex', gap:4 }}>
            <button onClick={() => scrollTable(-1)} title="Scroll left"
              style={{ width:40, height:40, borderRadius:'50%', background:'rgba(245,158,11,0.16)', border:'1.5px solid rgba(245,158,11,0.5)',
                color:'var(--gold)', display:'flex', alignItems:'center', justifyContent:'center',
                cursor:'pointer', boxShadow:'0 3px 12px rgba(0,0,0,0.5)', fontSize:20, fontWeight:700 }}>
              ‹
            </button>
          </div>
          <div style={{ position:'absolute', right:10, top:'50%', transform:'translateY(-50%)', zIndex:20 }}>
            <button onClick={() => scrollTable(1)} title="Scroll right"
              style={{ width:40, height:40, borderRadius:'50%', background:'rgba(245,158,11,0.16)', border:'1.5px solid rgba(245,158,11,0.5)',
                color:'var(--gold)', display:'flex', alignItems:'center', justifyContent:'center',
                cursor:'pointer', boxShadow:'0 3px 12px rgba(0,0,0,0.5)', fontSize:20, fontWeight:700 }}>
              ›
            </button>
          </div>
          <div ref={tableRef} style={{ flex:1, overflow:'auto' }}>
          <table style={{ borderCollapse:'collapse', width:'max-content', minWidth:'100%', fontSize:12 }}>
            <thead>
              <tr style={{ background:'var(--card)', position:'sticky', top:0, zIndex:10 }}>
                <TH ch="Type" w={50} />
                <TH ch="AWP" w={90} />
                <TH ch="Type of Facilities" w={220} />
                <TH ch="Limit (RM)" right w={110} />
                <TH ch="Utilised (RM)" right tint="green" w={110} />
                <TH ch="Unutilised (RM)" right tint="amber" w={110} />
                <TH ch="Interest Rate" w={160} />
                <TH ch="Repayment Terms" w={260} />
                <TH ch="Security" w={280} />
                <TH ch="Loan Covenants" w={200} />
                <TH ch="Purposes" w={240} />
                <TH ch="Cross-ref" w={90} />
                <TH ch="Facility Date" w={110} />
                <TH ch="Confidence" w={100} />
                <th style={{ width:90, background:'var(--card)', borderBottom:'2px solid var(--border)' }} />
              </tr>
            </thead>
            <tbody>
              {/* LOANS */}
              {loans.length > 0 && <SectionHeader label="LOANS (L)" onClear={clearLoans} />}
              {bankGroups.map(({ key, bankNo, bankName }) => {
                const groupFacs = loans.filter(f => f.bankName === bankName)
                return [
                  <BankHeader key={`bh-${key}`} bankNo={bankNo} bankName={bankName} facs={groupFacs} />,
                  ...groupFacs.map(f => <FacRow key={f.id} fac={f} isLoan={true} />)
                ]
              })}
              {loans.length > 0 && <TotalRow label="BA + TL" total={loanTotal} utilised={loanUtilised} unutilised={loanTotal-loanUtilised} />}

              {/* HIRE PURCHASE */}
              {hp.length > 0 && <SectionHeader label="HIRE PURCHASE (HP)" onClear={clearHP} />}
              {hp.map(f => <FacRow key={f.id} fac={f} isLoan={false} />)}
              {hp.length > 0 && <TotalRow label="HP Total" total={hpTotal} utilised={hpUtilised} unutilised={hpTotal-hpUtilised} />}

              {/* Grand total */}
              {(loans.length > 0 || hp.length > 0) && (
                <TotalRow label="TOTAL" total={grandTotal} utilised={grandUtil} unutilised={grandUnut} />
              )}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {editing && <EditModal fac={editing} onSave={saveFac} onClose={() => setEditing(null)} />}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      {confirm && <ConfirmDialog message={confirm.message} onConfirm={confirm.onConfirm} onCancel={() => setConfirm(null)} />}

      {historyView && (
        <div style={{ position:'fixed',inset:0,zIndex:100,background:'rgba(0,0,0,0.75)',display:'flex',alignItems:'center',justifyContent:'center' }}
          onClick={() => setHistoryView(null)}>
          <div onClick={e=>e.stopPropagation()} style={{ background:'var(--card)',border:'1px solid var(--border)',borderRadius:12,padding:24,width:460,maxHeight:'70vh',overflow:'auto',boxShadow:'0 20px 60px rgba(0,0,0,0.6)' }}>
            <div style={{ display:'flex',alignItems:'center',gap:8,marginBottom:4 }}>
              {historyView._showFlags
                ? <AlertTriangle size={15} color="var(--red)"/>
                : <History size={15} color="var(--magenta)"/>
              }
              <div style={{ fontSize:14,fontWeight:600,color:'var(--text)' }}>
                {historyView._showFlags ? 'Red Flags' : 'Change History'}
              </div>
            </div>
            <div style={{ fontSize:11,color:'var(--text3)',marginBottom:16 }}>{historyView.facilityName || historyView.facilityCode}</div>
            <div style={{ display:'flex',flexDirection:'column',gap:10 }}>
              {(historyView._showFlags ? historyView.redFlags : historyView.changeHistory)?.map((item, i) => {
                const list = historyView._showFlags ? historyView.redFlags : historyView.changeHistory
                return (
                <div key={i} style={{ display:'flex',gap:10,paddingBottom:10,borderBottom: i<list.length-1?'1px solid var(--border)':'none' }}>
                  <div style={{ width:6,height:6,borderRadius:'50%',background:historyView._showFlags?'var(--red)':'var(--magenta)',marginTop:5,flexShrink:0 }}/>
                  <div style={{ fontSize:12,color:'var(--text2)',lineHeight:1.6 }}>{item}</div>
                </div>
                )
              })}
            </div>
            <button onClick={() => setHistoryView(null)} style={{ marginTop:16,background:'none',border:'1px solid var(--border)',borderRadius:7,padding:'7px 16px',color:'var(--text2)',fontSize:12,width:'100%' }}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// spin keyframe injected via style tag in AIInsight — reused here
