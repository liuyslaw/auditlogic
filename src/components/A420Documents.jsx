import { useState, useRef } from 'react'
import { Upload, FileText, Image, CheckCircle, AlertCircle, AlertTriangle, X, Table2, Sparkles, Loader, RefreshCw } from 'lucide-react'
import { saveFile, deleteFile, loadFile, hasFile, bufferToBase64 } from '../lib/fileStore.js'

// ── Confidence badge (exported for use in A420Summary) ────────────────────
export function ConfidenceBadge({ confidence, size = 'sm' }) {
  const s = size === 'lg'
  return (
    <div style={{
      display:'inline-flex', alignItems:'center', gap: s?6:4,
      padding: s?'4px 10px':'2px 6px',
      background:`${confidence.color}14`, border:`1px solid ${confidence.color}40`,
      borderRadius:5, flexShrink:0,
    }}>
      <div style={{ width:s?7:6, height:s?7:6, borderRadius:'50%', background:confidence.color, flexShrink:0 }}/>
      <span style={{ fontSize:s?12:10, fontWeight:600, color:confidence.color, fontFamily:'var(--mono)', lineHeight:1 }}>
        {confidence.score}%
      </span>
      <span style={{ fontSize:s?11:9, color:confidence.color, opacity:0.8 }}>{confidence.label}</span>
    </div>
  )
}

// ── Media type from file extension ───────────────────────────────────────
function getMediaType(file) {
  const ext = file.name.split('.').pop().toLowerCase()
  if (ext === 'pdf')  return 'application/pdf'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'png')  return 'image/png'
  return 'application/octet-stream'
}

function formatSize(bytes) {
  if (bytes < 1024*1024) return `${(bytes/1024).toFixed(0)} KB`
  return `${(bytes/1024/1024).toFixed(1)} MB`
}


// ── Auto-compress files over the size limit ───────────────────────────────
async function compressFile(file, mediaType, maxBytes, onProgress) {
  if (mediaType === 'application/pdf') {
    return compressPDF(file, maxBytes, onProgress)
  } else if (mediaType.startsWith('image/')) {
    return compressImage(file, maxBytes)
  }
  throw new Error('Cannot compress this file type')
}

// PDF compression: rasterize each page and re-encode at reduced resolution/quality.
// Structural-only compression (pdf-lib alone) barely helps scanned documents —
// the file size IS the embedded page images, so we have to actually re-render
// and re-compress those, the same way Ghostscript does server-side.
async function loadPdfJs() {
  if (!window.pdfjsLib) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
      script.onload = resolve
      script.onerror = () => reject(new Error('Failed to load pdf.js'))
      document.head.appendChild(script)
    })
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
  }
  return window.pdfjsLib
}

async function loadPdfLib() {
  if (!window.PDFLib) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js'
      script.onload = resolve
      script.onerror = () => reject(new Error('Failed to load pdf-lib'))
      document.head.appendChild(script)
    })
  }
  return window.PDFLib
}

// One rasterize-and-rebuild pass at a given scale (DPI = scale × 72) and JPEG quality.
async function rasterizePdfPass(pdfDoc, PDFDocument, scale, quality, onProgress) {
  const newPdf = await PDFDocument.create()
  const numPages = pdfDoc.numPages
  for (let i = 1; i <= numPages; i++) {
    onProgress && onProgress(i, numPages)
    const page = await pdfDoc.getPage(i)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    const ctx = canvas.getContext('2d')
    await page.render({ canvasContext: ctx, viewport }).promise

    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality))
    const jpgBytes = await blob.arrayBuffer()
    const jpgImage = await newPdf.embedJpg(jpgBytes)

    // Page size in PDF points = viewport size at scale 1 (72 DPI = 1 point per px)
    const baseViewport = page.getViewport({ scale: 1 })
    const newPage = newPdf.addPage([baseViewport.width, baseViewport.height])
    newPage.drawImage(jpgImage, { x: 0, y: 0, width: baseViewport.width, height: baseViewport.height })

    // Free canvas memory before moving to next page — matters on mobile Safari
    canvas.width = 0
    canvas.height = 0
  }
  return newPdf.save({ useObjectStreams: true })
}

async function compressPDF(file, maxBytes, onProgress) {
  const pdfjsLib = await loadPdfJs()
  const { PDFDocument } = await loadPdfLib()

  const arrayBuffer = await file.arrayBuffer()
  const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise

  // Escalating passes: start at a resolution/quality that keeps scanned text
  // legible, only drop further if the file genuinely needs it. Each pass
  // re-rasterizes from the ORIGINAL (not the previous pass's output) to avoid
  // compounding generation loss.
  const passes = [
    { scale: 150 / 72, quality: 0.6 },  // ~150 DPI — usually enough on its own
    { scale: 120 / 72, quality: 0.5 },  // ~120 DPI
    { scale: 105 / 72, quality: 0.45 }, // ~105 DPI — last resort before giving up
  ]

  let lastSize = file.size
  for (let p = 0; p < passes.length; p++) {
    const { scale, quality } = passes[p]
    const bytes = await rasterizePdfPass(pdfDoc, PDFDocument, scale, quality,
      (page, total) => onProgress && onProgress(`Compressing page ${page}/${total} (pass ${p + 1}/${passes.length})…`))
    const compressedFile = new File([bytes], file.name, { type: 'application/pdf' })
    console.log(`PDF compress pass ${p + 1}: ${formatSize(file.size)} → ${formatSize(compressedFile.size)} (${Math.round(scale * 72)} DPI, q=${quality})`)
    lastSize = compressedFile.size
    if (compressedFile.size <= maxBytes) return compressedFile
  }

  throw new Error(`Still ${formatSize(lastSize)} after compression at the lowest quality this tool will use without risking illegible scans. Split the PDF into smaller parts and upload separately.`)
}

// Image compression via canvas
async function compressImage(file, maxBytes) {
  return new Promise((resolve, reject) => {
    const img = new window.Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      let { width, height } = img
      let quality = 0.85
      let scale   = 1.0

      // Reduce scale if needed to hit target size
      // Rough estimate: image data ≈ width × height × 3 bytes before JPEG compression
      const rawSize = width * height * 3
      if (rawSize * quality > maxBytes) {
        scale = Math.sqrt(maxBytes / (rawSize * quality)) * 0.9
        width  = Math.floor(width  * scale)
        height = Math.floor(height * scale)
      }

      const canvas = document.createElement('canvas')
      canvas.width  = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, width, height)

      canvas.toBlob(blob => {
        if (!blob) return reject(new Error('Canvas compression failed'))
        const result = new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' })
        console.log(`Image compressed: ${formatSize(file.size)} → ${formatSize(result.size)}`)
        if (result.size > maxBytes) {
          reject(new Error(`Still ${formatSize(result.size)} after compression. Use a smaller image.`))
        } else {
          resolve(result)
        }
      }, 'image/jpeg', quality)
    }
    img.onerror = () => reject(new Error('Failed to load image for compression'))
    img.src = url
  })
}

// ── Main component ────────────────────────────────────────────────────────
export default function A420Documents({ eng, updateDocs, updateFacilities, updateRawFacilities, updateDocsAndFacilities, setActiveTab, setActiveSection, onViewSummary }) {
  const [dragging, setDragging]   = useState(false)
  const [hoverDoc, setHoverDoc]   = useState(null)
  const [processingIds, setProcessingIds] = useState(new Set())
  const fileRef = useRef()

  const docs = eng.uploadedDocs || []
  const fyEnd = eng.fyEnd || ''

  // ── Upload + extract ──────────────────────────────────────────────────
  async function handleFiles(files) {
    const fileArr = Array.from(files)
    if (!fileArr.length) return

    const MAX_FILE_SIZE = 4.4 * 1024 * 1024

    // ── KEY FIX: maintain a local docs array that accumulates across
    // all files in the batch. Each iteration reads from this local copy
    // (not eng.uploadedDocs which is stale in the closure), so batches
    // of 3, 5, 10 files all append correctly without overwriting.
    let currentDocs = [...(eng.uploadedDocs || [])]
    let currentFacs = [...(eng.facilities || [])]
    let currentRawFacs = [...(eng.rawFacilities || [])]
    const skippedDuplicates = []

    for (const file of fileArr) {
      // Skip files that have already been successfully extracted — same
      // filename AND exact byte size. This is what actually costs tokens:
      // re-dropping a batch that overlaps with a previous upload silently
      // re-extracted everything again with no way to tell it had already
      // been done. Genuinely different files rarely share both name and
      // exact size, so this is a safe check, not just a filename guess.
      const alreadyExtracted = currentDocs.some(d =>
        d.status === 'extracted' && d.name === file.name && d.rawSize === file.size
      )
      if (alreadyExtracted) {
        skippedDuplicates.push(file.name)
        continue
      }

      const tempId = crypto.randomUUID()
      const mediaType = getMediaType(file)

      // Auto-compress if over limit, then retry
      let fileToSend = file
      if (file.size > MAX_FILE_SIZE) {
        const compressPlaceholder = {
          id: tempId, name: file.name, mediaType, rawSize: file.size,
          isImage: mediaType.startsWith('image/'),
          size: formatSize(file.size), status: 'extracting',
          detectedType: 'Compressing…', typeColor: '#f59e0b',
          confidence: null, uploadedAt: new Date().toISOString().slice(0,10),
          extractedFacilities: [],
        }
        currentDocs = [...currentDocs, compressPlaceholder]
        updateDocs(currentDocs)

        try {
          fileToSend = await compressFile(file, mediaType, MAX_FILE_SIZE, (statusText) => {
            currentDocs = currentDocs.map(d => d.id === tempId ? { ...d, detectedType: statusText } : d)
            updateDocs(currentDocs)
          })
        } catch (compErr) {
          const errDoc = {
            ...compressPlaceholder, status: 'error',
            detectedType: 'Compression failed', typeColor: '#ef4444',
            errorMsg: `${formatSize(file.size)} file — compression failed: ${compErr.message}`,
            confidence: { score:0, level:'low', color:'#ef4444', label:'Error', reasons:[] },
          }
          currentDocs = currentDocs.filter(d => d.id !== tempId)
          currentDocs = [...currentDocs, errDoc]
          updateDocs(currentDocs)
          continue
        }
      }

      // Add placeholder to local array + push to state
      const placeholder = {
        id: tempId,
        name: file.name,
        mediaType,
        rawSize: file.size,
        isImage: mediaType.startsWith('image/'),
        size: formatSize(file.size),
        status: 'extracting',
        detectedType: 'Extracting…',
        typeColor: '#6e6660',
        confidence: null,
        uploadedAt: new Date().toISOString().slice(0,10),
        extractedFacilities: [],
      }

      if (file.size <= MAX_FILE_SIZE) {
        currentDocs = [...currentDocs, placeholder]
        updateDocs(currentDocs)
      }
      setProcessingIds(prev => new Set([...prev, tempId]))

      try {
        // Save raw file to IndexedDB for later re-extraction (no re-upload needed)
        try { await saveFile(tempId, fileToSend) } catch (e) { console.warn('IndexedDB save failed:', e) }

        // Send as raw binary FormData — avoids 33% base64 overhead
        const formData = new FormData()
        formData.append('file', fileToSend, file.name)
        formData.append('fileName', file.name)
        formData.append('mediaType', mediaType)
        formData.append('fyEnd', fyEnd)

        const resp = await fetch('/api/extract', {
          method: 'POST',
          body: formData,  // No Content-Type header — browser sets multipart boundary automatically
        })

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}))
          throw new Error(err.error || `Server error ${resp.status}`)
        }

        const result = await resp.json()
        const facs = (result.facilities || []).map(f => ({
          // Defaults first so spread below overrides only what's present
          facilitySubName: '',
          approvedLimit: '',
          amtUtilised: '',
          interestRateText: '',
          interestRateCalc: '',
          repaymentLine1: '',
          repaymentLine2: '',
          repaymentLine3: '',
          securityBlock: '',
          loanCovenant: 'N/A',
          purposes: '',
          crossRef: '',
          facilityDate: '',
          awpRef: '',
          isSettled: false,
          loDocType: result.docType || '',
          ...f,
          // Normalize field name: API returns "facilityCode", table reads "facilityName"
          facilityName: f.facilityCode || f.facilityName || '',
          id: crypto.randomUUID(),
          engId: eng.id,
          bankNo: '1',
          bankName: result.bankName || '',
          sourceDocIds: [tempId],
          noBankHeader: false,
        }))

        // Update doc record with extraction results
        const updatedDoc = {
          ...placeholder,
          status: 'extracted',
          detectedType: result.docType || 'Unknown',
          typeColor: docTypeColor(result.docType),
          confidence: result.confidence,
          extractedFacilities: facs,
          bankName: result.bankName,
          loDate: result.loDate,
          facilityCount: facs.length,
          // FIX (caRefNo/supersedesDate never reached reconcile): extract.js
          // has returned these two document-identity fields at the top level
          // of its response since the multi-document reconcile enhancement,
          // but this doc record never carried them past extraction — so
          // reconcile.js's DOCUMENT GROUPING and SAME-DATE MULTI-LETTER
          // SEQUENCING logic was always receiving empty strings for both,
          // regardless of what extract.js actually detected. Copying them
          // onto the doc record here is what makes them visible to
          // handleReconcile (EngagementShell.jsx), which sends the doc
          // objects — not just facilities — to /api/reconcile.
          caRefNo: result.caRefNo || '',
          supersedesDate: result.supersedesDate || '',
          // FIX (CIMB/HLB covenants stated at bank-relationship level, not
          // tied to any one facility, silently lost): some documents state
          // covenants/conditions (e.g. a CIMB "Renewal of Banking
          // Facility(ies)" letter with a Minimum DSC and gearing condition)
          // with NO facility limit table at all — extract.js now surfaces
          // this via a new top-level bankLevelCovenant field, but same as
          // caRefNo/supersedesDate above, it needs to be carried onto the
          // doc record here or it never reaches handleReconcile
          // (EngagementShell.jsx), which is what actually applies it to
          // every facility sharing this document's bank via a deterministic
          // backfill (see bankLevelCovenantsOf in EngagementShell.jsx).
          bankLevelCovenant: result.bankLevelCovenant || '',
        }

        // Update local accumulators — keeps batch-uploaded files intact.
        // currentFacs (display) starts from eng.facilities and respects
        // any prior Clear All. currentRawFacs (permanent) starts from
        // eng.rawFacilities and is never affected by Clear All — this is
        // what reconcile will actually read from.
        currentFacs = [...currentFacs.filter(f => !(f.sourceDocIds||[]).includes(tempId)), ...facs]
        currentRawFacs = [...currentRawFacs.filter(f => !(f.sourceDocIds||[]).includes(tempId)), ...facs]
        currentDocs = [...currentDocs.filter(d => d.id !== tempId), updatedDoc]
        updateDocsAndFacilities(currentDocs, currentFacs, currentRawFacs)

      } catch (err) {
        // Update placeholder with error
        const errDoc = {
          ...placeholder,
          status: 'error',
          detectedType: 'Extraction failed',
          typeColor: '#ef4444',
          errorMsg: err.message,
          confidence: { score: 0, level: 'low', color: '#ef4444', label: 'Error', reasons: [err.message] },
        }
        currentDocs = [...currentDocs.filter(d => d.id !== tempId), errDoc]
        updateDocs(currentDocs)
      } finally {
        setProcessingIds(prev => { const s = new Set(prev); s.delete(tempId); return s })
      }
    }

    if (skippedDuplicates.length > 0) {
      alert(
        `${skippedDuplicates.length} file${skippedDuplicates.length===1?'':'s'} already extracted — skipped, no tokens used:\n\n` +
        skippedDuplicates.map(n => `• ${n}`).join('\n')
      )
    }
  }

  // ── Re-run extraction on an already-uploaded doc ────────────────────────
  // Reads the raw file back from IndexedDB (saved at upload time) so no
  // re-upload is needed. If the binary isn't in IndexedDB — e.g. this doc
  // was uploaded before file-persistence existed, or the browser cleared
  // storage — we cannot silently pretend to re-extract. The doc is marked
  // as an explicit error instead of staying on 'extracted', so the status
  // badge never claims a re-run succeeded when it didn't.
  async function reExtractDoc(doc) {
    setProcessingIds(prev => new Set([...prev, doc.id]))
    updateDocs(prevDocs => prevDocs.map(d =>
      d.id === doc.id ? { ...d, status: 'extracting', detectedType: 'Re-extracting…', typeColor: '#6e6660', errorMsg: undefined } : d
    ))

    try {
      const stored = await loadFile(doc.id)
      if (!stored) {
        const errDoc = {
          ...doc,
          status: 'error',
          detectedType: 'File not stored — re-upload required',
          typeColor: '#ef4444',
          confidence: { score: 0, level: 'low', color: '#ef4444', label: 'Error', reasons: [] },
          errorMsg: 'The original file is no longer available in this browser. Drop the same file again to re-extract.',
        }
        updateDocs(prevDocs => prevDocs.map(d => d.id === doc.id ? errDoc : d))
        return
      }

      const fileToSend = new File([stored.data], stored.name || doc.name, { type: stored.mediaType || doc.mediaType })

      const formData = new FormData()
      formData.append('file', fileToSend, doc.name)
      formData.append('fileName', doc.name)
      formData.append('mediaType', doc.mediaType)
      formData.append('fyEnd', fyEnd)

      const resp = await fetch('/api/extract', { method: 'POST', body: formData })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        throw new Error(err.error || `Server error ${resp.status}`)
      }

      const result = await resp.json()
      const facs = (result.facilities || []).map(f => ({
        facilitySubName: '', approvedLimit: '', amtUtilised: '',
        interestRateText: '', interestRateCalc: '', repaymentLine1: '', repaymentLine2: '',
        repaymentLine3: '', securityBlock: '', loanCovenant: 'N/A', purposes: '',
        crossRef: '', facilityDate: '', awpRef: '', isSettled: false,
        loDocType: result.docType || '',
        ...f,
        facilityName: f.facilityCode || f.facilityName || '',
        id: crypto.randomUUID(),
        engId: eng.id,
        bankNo: '1',
        bankName: result.bankName || '',
        sourceDocIds: [doc.id],
        noBankHeader: false,
      }))

      const updatedDoc = {
        ...doc,
        status: 'extracted',
        detectedType: result.docType || 'Unknown',
        typeColor: docTypeColor(result.docType),
        confidence: result.confidence,
        extractedFacilities: facs,
        bankName: result.bankName,
        loDate: result.loDate,
        facilityCount: facs.length,
        errorMsg: undefined,
        // Same fix as handleFiles above — carry these through on re-run too.
        caRefNo: result.caRefNo || '',
        supersedesDate: result.supersedesDate || '',
        bankLevelCovenant: result.bankLevelCovenant || '',
      }

      updateDocsAndFacilities(
        prevDocs => prevDocs.map(d => d.id === doc.id ? updatedDoc : d),
        prevFacs => [...(prevFacs || []).filter(f => !(f.sourceDocIds || []).includes(doc.id)), ...facs]
      )

    } catch (err) {
      const errDoc = {
        ...doc,
        status: 'error',
        detectedType: 'Extraction failed',
        typeColor: '#ef4444',
        confidence: { score: 0, level: 'low', color: '#ef4444', label: 'Error', reasons: [err.message] },
        errorMsg: err.message,
      }
      updateDocs(prevDocs => prevDocs.map(d => d.id === doc.id ? errDoc : d))
    } finally {
      setProcessingIds(prev => { const s = new Set(prev); s.delete(doc.id); return s })
    }
  }

  function docTypeColor(type) {
    if (!type) return '#71717a'
    const t = type.toLowerCase()
    if (t.includes('original'))   return '#22c55e'
    if (t.includes('supplement')) return '#f59e0b'
    if (t.includes('restructur') || t.includes('new lo')) return '#B84480'
    if (t.includes('renewal'))    return '#3b82f6'
    if (t.includes('hire purchase') || t.includes('repayment')) return '#e879f9'
    if (t.includes('bank confirm')) return '#38bdf8'
    return '#71717a'
  }

  function removeDoc(id) {
    // Remove from IndexedDB
    deleteFile(id).catch(e => console.warn('IndexedDB delete failed:', e))
    // Remove facilities from this doc — both the display table and the
    // permanent raw store, since the document itself is gone for good;
    // there's nothing left to ever regenerate this data from.
    const remaining = (eng.facilities || []).filter(f => !(f.sourceDocIds || []).includes(id))
    const remainingRaw = (eng.rawFacilities || []).filter(f => !(f.sourceDocIds || []).includes(id))
    updateFacilities(remaining)
    updateRawFacilities(remainingRaw)
    updateDocs(docs.filter(d => d.id !== id))
  }

  function onDrop(e) { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files) }

  const isProcessing = processingIds.size > 0
  const lowConf = docs.filter(d => d.confidence?.level === 'low' && d.status !== 'error').length
  const errors  = docs.filter(d => d.status === 'error').length

  return (
    <div style={{ padding:'24px 28px', maxWidth:960 }}>

      <div style={{ marginBottom:18 }}>
        <h2 style={{ fontSize:19, fontWeight:700, color:'var(--text)', marginBottom:4 }}>Documents</h2>
        <p style={{ fontSize:12, color:'var(--text3)', lineHeight:1.5 }}>
          Upload loan LOs, supplements, renewals, HP agreements and repayment schedules.
          Each document is read by Claude AI and facilities are extracted automatically.
        </p>
      </div>

      {/* Status bar */}
      {docs.length > 0 && (
        <div style={{ display:'flex', gap:10, marginBottom:14, padding:'9px 14px', background:'var(--card)', border:'1px solid var(--border)', borderRadius:9, alignItems:'center', flexWrap:'wrap' }}>
          <span style={{ fontSize:10, color:'var(--text3)', textTransform:'uppercase', letterSpacing:0.7, fontWeight:600 }}>Extraction Status</span>
          {[
            { label:`${docs.filter(d=>d.status==='extracted').length} extracted`, color:'var(--green)' },
            { label:`${docs.filter(d=>d.status==='extracting').length} in progress`, color:'var(--gold)', hide: !isProcessing },
            { label:`${errors} failed`, color:'var(--red)', hide: errors===0 },
            { label:`${lowConf} low confidence`, color:'#f59e0b', hide: lowConf===0 },
          ].filter(c => !c.hide).map(c => (
            <span key={c.label} style={{ fontSize:11, color:c.color }}>{c.label}</span>
          ))}
          {docs.filter(d=>d.status==='extracted').length > 0 && (
            <span style={{ fontSize:11, color:'var(--magenta)' }}>
              ✓ {docs.filter(d=>d.status==='extracted' && d.includeInReconcile===true).length} of {docs.filter(d=>d.status==='extracted').length} ticked for next Reconcile
            </span>
          )}
          {docs.filter(d=>d.confidence?.level==='low'&&d.status==='extracted').length > 0 && (
            <button
              onClick={async () => {
                const lowDocs = docs.filter(d => d.confidence?.level==='low' && d.status==='extracted')
                for (const d of lowDocs) await reExtractDoc(d)
              }}
              style={{ display:'flex',alignItems:'center',gap:5,background:'rgba(239,68,68,0.08)',border:'1px solid rgba(239,68,68,0.2)',borderRadius:6,padding:'4px 10px',color:'var(--red)',fontSize:11,fontWeight:500,marginLeft:'auto' }}>
              <RefreshCw size={11}/> Re-extract {docs.filter(d=>d.confidence?.level==='low'&&d.status==='extracted').length} low-confidence
            </button>
          )}
          {docs.filter(d=>d.status==='extracted').length > 0 && (
            <div style={{ marginLeft:'auto', display:'flex', gap:8 }}>
              {(() => {
                const tickedExtracted = docs.filter(d => d.status === 'extracted' && d.includeInReconcile === true)
                const fp = [...tickedExtracted.map(d => d.id)].sort().join(',')
                const willReconcile = tickedExtracted.length >= 2 && fp !== '' && fp !== (eng.reconcileFingerprint || '')
                return (
                  <button
                    onClick={() => onViewSummary ? onViewSummary() : (() => { setActiveSection('A420'); setActiveTab('summary') })()}
                    title={willReconcile ? 'Selection has changed — will reconcile automatically, then show the summary' : 'Go to the summary table'}
                    style={{
                      display:'flex',alignItems:'center',gap:5,background:'rgba(245,158,11,0.1)',border:'1px solid rgba(245,158,11,0.3)',borderRadius:6,padding:'5px 11px',color:'var(--gold)',fontSize:11,fontWeight:500
                    }}>
                    <Table2 size={12}/> View Summary
                    {willReconcile && <span style={{ width:6,height:6,borderRadius:'50%',background:'var(--magenta)',flexShrink:0 }}/>}
                  </button>
                )
              })()}
              <button onClick={() => setActiveTab('insight')} style={{
                display:'flex',alignItems:'center',gap:5,background:'rgba(184,68,128,0.08)',border:'1px solid rgba(184,68,128,0.25)',borderRadius:6,padding:'5px 11px',color:'var(--magenta)',fontSize:11,fontWeight:500
              }}>
                <Sparkles size={12}/> AI Insights
              </button>
            </div>
          )}
        </div>
      )}

      {/* Multi-bank quick select — only shows once documents from more than one bank are extracted */}
      {(() => {
        const isHP = d => (d.loDocType || '').toLowerCase().includes('hire purchase') || (d.loDocType || '').toLowerCase().includes('repayment')
        const extracted = docs.filter(d => d.status === 'extracted' && d.bankName)
        const banks = [...new Set(extracted.map(d => d.bankName))]
        const singleBankHasBothTypes = banks.length === 1 &&
          extracted.some(d => !isHP(d)) && extracted.some(d => isHP(d))
        if (banks.length < 2 && !singleBankHasBothTypes) return null

        // For each bank, work out whether it has Loan docs, HP docs, or both —
        // only split into two buttons when a bank actually has both, so this
        // doesn't add noise for banks that are purely one or the other.
        const bankGroups = banks.map(bank => {
          const bankDocs = extracted.filter(d => d.bankName === bank)
          const hasLoan = bankDocs.some(d => !isHP(d))
          const hasHP   = bankDocs.some(d => isHP(d))
          return { bank, hasLoan, hasHP }
        })

        function selectOnly(bank, type) {
          // type: 'loan' | 'hp' | null (null = everything for that bank, old behaviour)
          updateDocs(prevDocs => prevDocs.map(d => {
            if (d.status !== 'extracted') return d
            if (d.bankName !== bank) return { ...d, includeInReconcile: false }
            if (type === 'loan') return { ...d, includeInReconcile: !isHP(d) }
            if (type === 'hp')   return { ...d, includeInReconcile: isHP(d) }
            return { ...d, includeInReconcile: true }
          }))
        }

        return (
          <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap', marginBottom:14, padding:'8px 14px', background:'rgba(184,68,128,0.05)', border:'1px solid rgba(184,68,128,0.2)', borderRadius:9 }}>
            <span style={{ fontSize:11, color:'var(--text3)' }}>
              {banks.length >= 2 ? `Documents span ${banks.length} banks` : `${banks[0]} has both Loans and HP`} — reconcile in small groups. If a batch still fails as "too long," split by Loans/HP too:
            </span>
            {bankGroups.map(({ bank, hasLoan, hasHP }) => (
              hasLoan && hasHP ? (
                <span key={bank} style={{ display:'flex', gap:4 }}>
                  <button
                    onClick={() => selectOnly(bank, 'loan')}
                    title={`Tick only ${bank}'s loan documents`}
                    style={{ background:'rgba(184,68,128,0.12)', border:'1px solid rgba(184,68,128,0.35)', borderRadius:'6px 0 0 6px', padding:'4px 10px', color:'var(--magenta)', fontSize:11, fontWeight:500 }}>
                    Only {bank} — Loans
                  </button>
                  <button
                    onClick={() => selectOnly(bank, 'hp')}
                    title={`Tick only ${bank}'s HP documents`}
                    style={{ background:'rgba(184,68,128,0.12)', border:'1px solid rgba(184,68,128,0.35)', borderLeft:'none', borderRadius:'0 6px 6px 0', padding:'4px 10px', color:'var(--magenta)', fontSize:11, fontWeight:500 }}>
                    HP
                  </button>
                </span>
              ) : (
                <button key={bank}
                  onClick={() => selectOnly(bank, null)}
                  title={`Tick only ${bank}'s documents, untick everything else`}
                  style={{ background:'rgba(184,68,128,0.12)', border:'1px solid rgba(184,68,128,0.35)', borderRadius:6, padding:'4px 10px', color:'var(--magenta)', fontSize:11, fontWeight:500 }}>
                  Only {bank}
                </button>
              )
            ))}
            <button
              onClick={() => updateDocs(prevDocs => prevDocs.map(d => d.status !== 'extracted' ? d : { ...d, includeInReconcile: true }))}
              style={{ background:'none', border:'1px solid var(--border)', borderRadius:6, padding:'4px 10px', color:'var(--text3)', fontSize:11 }}>
              Select all
            </button>
          </div>
        )
      })()}

      {lowConf > 0 && (
        <div style={{ background:'rgba(239,68,68,0.05)',border:'1px solid rgba(239,68,68,0.2)',borderRadius:8,padding:'10px 14px',marginBottom:14,display:'flex',gap:8 }}>
          <AlertTriangle size={14} color="#ef4444" style={{flexShrink:0,marginTop:1}}/>
          <div>
            <div style={{ fontSize:12,fontWeight:600,color:'#ef4444',marginBottom:2 }}>Low confidence on {lowConf} file{lowConf>1?'s':''}</div>
            <div style={{ fontSize:11,color:'var(--text3)' }}>Review highlighted rows in the Summary table. For amended HP docs, verify figures manually against the original.</div>
          </div>
        </div>
      )}

      {errors > 0 && (
        <div style={{ background:'rgba(239,68,68,0.05)',border:'1px solid rgba(239,68,68,0.2)',borderRadius:8,padding:'10px 14px',marginBottom:14,display:'flex',gap:8 }}>
          <AlertCircle size={14} color="#ef4444" style={{flexShrink:0,marginTop:1}}/>
          <div style={{ fontSize:12,color:'#ef4444' }}>
            {errors} file{errors>1?'s':''} failed to extract. Check that ANTHROPIC_API_KEY is set in Vercel environment variables, then re-upload.
          </div>
        </div>
      )}

      {/* Upload zone */}
      <div
        onDragOver={e=>{e.preventDefault();setDragging(true)}}
        onDragLeave={()=>setDragging(false)}
        onDrop={onDrop}
        onClick={()=>!isProcessing&&fileRef.current?.click()}
        style={{
          border:`1.5px dashed ${dragging?'var(--gold)':'var(--border2)'}`,
          borderRadius:10, padding:'28px 24px', textAlign:'center',
          background:dragging?'rgba(245,158,11,0.04)':'var(--card)',
          cursor:isProcessing?'default':'pointer', transition:'all 0.15s', marginBottom:20,
        }}>
        <input ref={fileRef} type="file" multiple accept=".pdf,.jpg,.jpeg,.png"
          style={{display:'none'}} onChange={e=>handleFiles(e.target.files)}/>

        {isProcessing ? (
          <div>
            <Loader size={22} color="var(--gold)" style={{marginBottom:10,animation:'spin 1s linear infinite'}}/>
            <div style={{fontSize:13,color:'var(--gold)',marginBottom:4}}>Extracting with Claude AI…</div>
            <div style={{fontSize:11,color:'var(--text3)'}}>Reading document content and extracting facility details</div>
          </div>
        ) : (
          <>
            <Upload size={22} color="var(--text3)" style={{marginBottom:10}}/>
            <div style={{fontSize:13,color:'var(--text2)',marginBottom:5}}>Drop files here or click to browse</div>
            <div style={{fontSize:11,color:'var(--text3)',marginBottom:10}}>
              PDF · JPG · PNG — LO, Supplements, Renewals, HP Agreements, Repayment Schedules
            </div>
            <div style={{fontSize:10,color:'var(--text3)',background:'rgba(245,158,11,0.06)',border:'1px solid rgba(245,158,11,0.15)',borderRadius:6,padding:'5px 12px',display:'inline-block',marginBottom:6}}>
              ✦ Claude AI reads every document and extracts all facility details automatically
            </div>
            <div style={{fontSize:10,color:'var(--text3)',background:'rgba(184,68,128,0.06)',border:'1px solid rgba(184,68,128,0.15)',borderRadius:6,padding:'5px 12px',display:'block',maxWidth:480,margin:'0 auto'}}>
              💡 Got Original + Supplementary + Renewal LOs? Upload them all, then click <strong style={{color:'var(--magenta)'}}>Reconcile Facilities</strong> in the Summary tab to merge duplicates and capture the current state.
            </div>
          </>
        )}
      </div>

      {/* File list */}
      {docs.length > 0 && (
        <div style={{background:'var(--card)',border:'1px solid var(--border)',borderRadius:10,overflow:'hidden'}}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 150px 70px 160px 130px 80px',padding:'8px 14px',borderBottom:'1px solid var(--border)',fontSize:10,color:'var(--text3)',textTransform:'uppercase',letterSpacing:0.6,fontWeight:600}}>
            <span>FILE</span><span>DOC TYPE</span><span>SIZE</span><span>STATUS</span><span>CONFIDENCE</span><span/>
          </div>

          {docs.map((doc, i) => {
            const isExtracting = doc.status === 'extracting'
            const isError      = doc.status === 'error'
            const isLow        = doc.confidence?.level === 'low' && !isError
            const isMed        = doc.confidence?.level === 'medium'

            return (
              <div key={doc.id}
                onMouseEnter={()=>setHoverDoc(doc.id)}
                onMouseLeave={()=>setHoverDoc(null)}
                style={{
                  display:'grid',gridTemplateColumns:'1fr 150px 70px 160px 130px 80px',
                  padding:'11px 14px',alignItems:'start',
                  borderBottom:i<docs.length-1?'1px solid var(--border)':'none',
                  background:isError?'rgba(239,68,68,0.04)':isLow?'rgba(239,68,68,0.03)':isMed?'rgba(245,158,11,0.02)':'transparent',
                  borderLeft:isError?'3px solid rgba(239,68,68,0.5)':isLow?'3px solid rgba(239,68,68,0.4)':isMed?'3px solid rgba(245,158,11,0.35)':'none',
                }}>

                {/* File name */}
                <div style={{display:'flex',alignItems:'flex-start',gap:8}}>
                  {doc.status === 'extracted' && (
                    <input
                      type="checkbox"
                      checked={doc.includeInReconcile === true}
                      onChange={e => {
                        e.stopPropagation()
                        const checked = e.target.checked
                        updateDocs(prevDocs => prevDocs.map(d => d.id === doc.id ? { ...d, includeInReconcile: checked } : d))
                      }}
                      onClick={e => e.stopPropagation()}
                      title="Include this document in the next Reconcile run"
                      style={{ marginTop:3, flexShrink:0, width:14, height:14, accentColor:'var(--magenta)', cursor:'pointer' }}
                    />
                  )}
                  {doc.isImage
                    ? <Image size={15} color="var(--text3)" style={{flexShrink:0,marginTop:1}}/>
                    : <FileText size={15} color="var(--text3)" style={{flexShrink:0,marginTop:1}}/>
                  }
                  <div>
                    <div style={{fontSize:12,color:'var(--text)',lineHeight:1.3}}>{doc.name}</div>
                    <div style={{fontSize:10,color:'var(--text3)',marginTop:2}}>
                      {doc.isImage?'Image scan':'PDF'} · {doc.uploadedAt}
                      {doc.facilityCount > 0 && ` · ${doc.facilityCount} facilit${doc.facilityCount===1?'y':'ies'} extracted`}
                    </div>
                    {isError && doc.errorMsg && (
                      <div style={{fontSize:10,color:'var(--red)',marginTop:3}}>⚠ {doc.errorMsg}</div>
                    )}
                    {doc.confidence?.warnings?.length > 0 && (
                      <div style={{fontSize:9,color:'#f59e0b',marginTop:3}}>⚠ {doc.confidence.warnings[0]}</div>
                    )}
                  </div>
                </div>

                {/* Doc type */}
                <div style={{paddingTop:1}}>
                  {isExtracting
                    ? <span style={{fontSize:10,color:'var(--gold)'}}>Reading…</span>
                    : <span style={{display:'inline-flex',alignItems:'center',fontSize:10,fontWeight:500,padding:'2px 7px',borderRadius:4,color:doc.typeColor,background:`${doc.typeColor}15`,border:`1px solid ${doc.typeColor}30`}}>
                        {doc.detectedType}
                      </span>
                  }
                </div>

                {/* Size */}
                <div style={{fontSize:11,color:'var(--text3)',fontFamily:'var(--mono)',paddingTop:2}}>{doc.size}</div>

                {/* Status */}
                <div style={{paddingTop:1}}>
                  {isExtracting
                    ? <span style={{display:'flex',alignItems:'center',gap:4,fontSize:11,color:'var(--gold)'}}><Loader size={11} style={{animation:'spin 1s linear infinite'}}/> Extracting…</span>
                    : isError
                    ? <span style={{display:'flex',alignItems:'center',gap:4,fontSize:11,color:'var(--red)'}}><AlertCircle size={11}/> Failed</span>
                    : <span style={{display:'flex',alignItems:'center',gap:4,fontSize:11,color:'var(--green)'}}><CheckCircle size={11}/> Extracted</span>
                  }
                </div>

                {/* Confidence */}
                <div style={{paddingTop:1}}>
                  {doc.confidence && !isExtracting
                    ? <ConfidenceBadge confidence={doc.confidence}/>
                    : isExtracting
                    ? <span style={{fontSize:10,color:'var(--text3)'}}>—</span>
                    : null
                  }
                </div>

                {/* Re-extract + Remove */}
                <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                  <button
                    onClick={e=>{e.stopPropagation();reExtractDoc(doc)}}
                    title="Re-extract using stored file — no re-upload needed"
                    style={{
                      background:'rgba(245,158,11,0.12)',border:'1px solid rgba(245,158,11,0.3)',
                      borderRadius:6,color:'var(--gold)',padding:'4px 7px',
                      display:'flex',alignItems:'center',gap:3,cursor:'pointer',fontSize:10,
                    }}>
                    <RefreshCw size={11}/> Re-run
                  </button>
                  <button
                    onClick={e=>{e.stopPropagation();removeDoc(doc.id)}}
                    title="Remove file and its extracted data"
                    style={{
                      background:'rgba(239,68,68,0.15)',border:'1px solid rgba(239,68,68,0.35)',
                      borderRadius:6,color:'#ffffff',padding:'4px 7px',
                      display:'flex',alignItems:'center',gap:3,cursor:'pointer',fontSize:10,
                    }}
                    onMouseEnter={e=>e.currentTarget.style.background='rgba(239,68,68,0.35)'}
                    onMouseLeave={e=>e.currentTarget.style.background='rgba(239,68,68,0.15)'}
                  >
                    <X size={13} strokeWidth={2.5}/> Del
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {docs.length === 0 && !isProcessing && (
        <div style={{textAlign:'center',padding:'20px 0',color:'var(--text3)',fontSize:12}}>
          No documents uploaded yet. Drop files above to begin extraction.
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
