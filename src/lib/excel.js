import XLSX from 'xlsx-js-style'

const COLS = [
  { key: 'bankFlag',     header: 'Bank',                      w: 26, align: 'left'  },
  { key: 'awpRef',       header: 'AWP',                        w: 10, align: 'center'},
  { key: 'facilityName', header: 'Type of Facilities',         w: 30, align: 'left'  },
  { key: 'approvedLimit',header: 'Limit (RM)',                 w: 15, align: 'right' },
  { key: 'amtUtilised',  header: 'Utilised (RM)',               w: 15, align: 'right' },
  { key: 'amtUnutilised',header: 'Unutilised (RM)',             w: 15, align: 'right' },
  { key: 'interestRate', header: 'Interest Rate',               w: 22, align: 'left'  },
  { key: 'repaymentTerms',header:'Repayment Terms',             w: 38, align: 'left'  },
  { key: 'security',     header: 'Security',                    w: 44, align: 'left'  },
  { key: 'loanCovenant', header: 'Loan Covenants',              w: 34, align: 'left'  },
  { key: 'purposes',     header: 'Purposes',                    w: 36, align: 'left'  },
  { key: 'crossRef',     header: 'Cross-ref to PAF',            w: 16, align: 'center'},
  { key: 'facilityDate', header: 'Facility Agreement Date',     w: 18, align: 'center'},
]

const FONT_NAME = 'Calibri'

function cellBorder() {
  const thin = { style: 'thin', color: { rgb: 'D9D9D9' } }
  return { top: thin, bottom: thin, left: thin, right: thin }
}

function cell(value, opts = {}) {
  const { align = 'left', bold = false, italic = false, numFmt, fill, fontColor, sz = 10 } = opts
  const isNum = typeof value === 'number'
  const s = {
    font: { name: FONT_NAME, sz, bold, italic, color: { rgb: fontColor || '2D2D2D' } },
    alignment: { horizontal: align, vertical: 'top', wrapText: true },
    border: cellBorder(),
  }
  if (numFmt) s.numFmt = numFmt
  if (fill) s.fill = { fgColor: { rgb: fill } }
  return { v: value === null || value === undefined ? '' : value, t: isNum ? 'n' : 's', s }
}

const STYLE = {
  title: { font: { name: FONT_NAME, sz: 14, bold: true, color: { rgb: '1A1A2E' } } },
  subtitle: { font: { name: FONT_NAME, sz: 10, italic: true, color: { rgb: '6B6B6B' } } },
  label: { font: { name: FONT_NAME, sz: 10, bold: true, color: { rgb: '1A1A2E' } } },
  body: { font: { name: FONT_NAME, sz: 10, color: { rgb: '2D2D2D' } }, alignment: { wrapText: true, vertical: 'top' } },
  header: {
    font: { name: FONT_NAME, sz: 10, bold: true, color: { rgb: 'FFFFFF' } },
    fill: { fgColor: { rgb: '1A1A2E' } },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
  },
  sectionHeader: {
    font: { name: FONT_NAME, sz: 10, bold: true, color: { rgb: 'FFFFFF' } },
    fill: { fgColor: { rgb: '5A4A6B' } },
    alignment: { horizontal: 'left', vertical: 'center' },
  },
  totalRow: {
    font: { name: FONT_NAME, sz: 10, bold: true, color: { rgb: '1A1A2E' } },
    fill: { fgColor: { rgb: 'F0EAD6' } },
    border: { top: { style: 'medium', color: { rgb: '1A1A2E' } } },
  },
  grandTotalRow: {
    font: { name: FONT_NAME, sz: 11, bold: true, color: { rgb: 'FFFFFF' } },
    fill: { fgColor: { rgb: '1A1A2E' } },
    border: { top: { style: 'medium', color: { rgb: '1A1A2E' } } },
  },
}

function fmtNum(val) {
  const n = parseFloat(val)
  return isNaN(n) ? null : n
}

export function exportLoanRecords(facilities, eng) {
  const wb = XLSX.utils.book_new()
  const rows = []
  const merges = []

  function pushRow(cells) { rows.push(cells); return rows.length - 1 }
  function blank(n = COLS.length) { return Array(n).fill(cell('')) }

  pushRow([{ v: `${eng.client || 'Client'} — A420 Borrowings Summary`, t: 's', s: STYLE.title }])
  merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: COLS.length - 1 } })

  pushRow([{ v: `FY ${eng.fyEnd || ''}  ·  ${eng.fileRef || ''}  ·  Generated ${new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}`, t: 's', s: STYLE.subtitle }])
  merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: COLS.length - 1 } })

  pushRow(blank())

  const headerRowIdx = pushRow(COLS.map(c => ({ v: c.header, t: 's', s: STYLE.header })))

  const loanFacs = facilities.filter(f => f.facilityType === 'L')
  const hpFacs    = facilities.filter(f => f.facilityType === 'HP')

  function facilityRow(fac, isLoan, bankLabel) {
    const limitVal = fmtNum(fac.approvedLimit)
    const utilVal  = fmtNum(fac.amtUtilised)
    const hasUnutil = limitVal !== null && utilVal !== null
    const unutilVal = hasUnutil ? limitVal - utilVal : null
    const isSettled = !!fac.isSettled
    const baseFill = isSettled ? 'F5F5F5' : undefined
    const nameStyle = isSettled ? { italic: true, fontColor: '999999' } : {}

    const interestRate = [fac.interestRateText, fac.interestRateCalc].filter(Boolean).join('\n')
    const repayment = [fac.repaymentLine1, fac.repaymentLine2, fac.repaymentLine3].filter(Boolean).join('\n')
    const security = fac.securityBlock || ''
    const covenant = fac.loanCovenant || 'N/A'
    const purposes = fac.purposes || ''

    return [
      cell(bankLabel || (isLoan ? 'L' : 'HP'), { bold: !!bankLabel, fill: bankLabel ? 'FAA819' : baseFill, fontColor: bankLabel ? 'FFFFFF' : undefined }),
      cell(fac.awpRef || '', { align: 'center', fill: baseFill }),
      cell([fac.facilityName, fac.facilitySubName].filter(Boolean).join('\n'), { bold: true, fill: baseFill, ...nameStyle }),
      cell(limitVal, { align: 'right', numFmt: '#,##0', fill: baseFill }),
      cell(utilVal !== null ? utilVal : '', { align: 'right', numFmt: '#,##0', fill: utilVal !== null ? 'E8F5E9' : baseFill }),
      cell(unutilVal !== null ? unutilVal : '', { align: 'right', numFmt: '#,##0', fill: unutilVal !== null ? 'FFF3E0' : baseFill }),
      cell(interestRate, { fill: baseFill }),
      cell(repayment, { fill: baseFill }),
      cell(security, { fill: baseFill }),
      cell(covenant, { fill: baseFill, fontColor: covenant === 'N/A' ? '999999' : undefined }),
      cell(purposes, { fill: baseFill }),
      cell(fac.crossRef || '', { align: 'center', fill: baseFill }),
      cell(fac.facilityDate || '', { align: 'center', fill: baseFill }),
    ]
  }

  if (loanFacs.length > 0) {
    pushRow(COLS.map((_, i) => i === 0
      ? { v: 'LOANS (L)', t: 's', s: STYLE.sectionHeader }
      : { v: '', t: 's', s: { fill: STYLE.sectionHeader.fill } }))
    merges.push({ s: { r: rows.length - 1, c: 0 }, e: { r: rows.length - 1, c: COLS.length - 1 } })

    // FIX (bankNo bug): bank sequence numbers are computed HERE, from order
    // of first appearance by bankName — NOT read from fac.bankNo. Extraction
    // and reconcile currently write bankNo as a hardcoded '1' on every
    // facility (an upstream limitation left untouched here deliberately, to
    // avoid risking the extraction/reconcile pipeline). Grouping itself was
    // never actually broken, because it already keyed on bankName (which IS
    // reliably distinct per bank) alongside bankNo — only the DISPLAYED
    // number "N)" was wrong, since every bank's facilities carried the same
    // bankNo and so all displayed as "1)". This block fixes only the display
    // number; it does not touch fac.bankNo itself.
    const seen = new Set()
    const bankOrder = []
    loanFacs.forEach(f => {
      const name = f.bankName || ''
      if (!seen.has(name)) { seen.add(name); bankOrder.push({ bankName: name, key: name }) }
    })
    bankOrder.forEach((b, i) => { b.bankNo = String(i + 1) })

    const headerShown = new Set()
    bankOrder.forEach(({ bankNo, bankName, key }) => {
      const groupFacs = loanFacs.filter(f => f.bankName === bankName)
      groupFacs.forEach(fac => {
        let bankLabel = ''
        if (!headerShown.has(key) && !fac.noBankHeader) {
          bankLabel = `${bankNo}) ${bankName}`
          headerShown.add(key)
        }
        pushRow(facilityRow(fac, true, bankLabel))
      })
    })

    const loanLimitTotal = loanFacs.reduce((s, f) => s + (fmtNum(f.approvedLimit) || 0), 0)
    const loanUtilTotal  = loanFacs.reduce((s, f) => s + (fmtNum(f.amtUtilised) || 0), 0)
    const totalRow = blank().map(c => ({ ...c, s: STYLE.totalRow }))
    totalRow[2] = { v: 'Total Loans', t: 's', s: STYLE.totalRow }
    totalRow[3] = { v: loanLimitTotal, t: 'n', s: { ...STYLE.totalRow, numFmt: '#,##0' } }
    totalRow[4] = { v: loanUtilTotal,  t: 'n', s: { ...STYLE.totalRow, numFmt: '#,##0' } }
    totalRow[5] = { v: loanLimitTotal - loanUtilTotal, t: 'n', s: { ...STYLE.totalRow, numFmt: '#,##0' } }
    pushRow(totalRow)
  }

  if (hpFacs.length > 0) {
    pushRow(blank())
    pushRow(COLS.map((_, i) => i === 0
      ? { v: 'HIRE PURCHASE (HP)', t: 's', s: STYLE.sectionHeader }
      : { v: '', t: 's', s: { fill: STYLE.sectionHeader.fill } }))
    merges.push({ s: { r: rows.length - 1, c: 0 }, e: { r: rows.length - 1, c: COLS.length - 1 } })

    // Same sequential-numbering fix as the loan section above. HP rows are
    // not grouped under a shared bank header (each row carries its own
    // "N) Bank" label), so the bank order/number is computed independently
    // here, counting only among HP facilities.
    const hpSeen = new Set()
    const hpBankOrder = []
    hpFacs.forEach(f => {
      const name = f.bankName || ''
      if (!hpSeen.has(name)) { hpSeen.add(name); hpBankOrder.push(name) }
    })
    hpFacs.forEach(fac => {
      const name = fac.bankName || ''
      const idx = hpBankOrder.indexOf(name)
      const label = name ? `${idx + 1}) ${name}` : ''
      pushRow(facilityRow(fac, false, label))
    })

    const hpLimitTotal = hpFacs.reduce((s, f) => s + (fmtNum(f.approvedLimit) || 0), 0)
    const hpUtilTotal   = hpFacs.reduce((s, f) => s + (fmtNum(f.amtUtilised) || 0), 0)
    const totalRow = blank().map(c => ({ ...c, s: STYLE.totalRow }))
    totalRow[2] = { v: 'Total Hire Purchase', t: 's', s: STYLE.totalRow }
    totalRow[3] = { v: hpLimitTotal, t: 'n', s: { ...STYLE.totalRow, numFmt: '#,##0' } }
    totalRow[4] = { v: hpUtilTotal,  t: 'n', s: { ...STYLE.totalRow, numFmt: '#,##0' } }
    totalRow[5] = { v: hpLimitTotal - hpUtilTotal, t: 'n', s: { ...STYLE.totalRow, numFmt: '#,##0' } }
    pushRow(totalRow)
  }

  if (loanFacs.length > 0 || hpFacs.length > 0) {
    pushRow(blank())
    const grandLimit = facilities.reduce((s, f) => s + (fmtNum(f.approvedLimit) || 0), 0)
    const grandUtil  = facilities.reduce((s, f) => s + (fmtNum(f.amtUtilised) || 0), 0)
    const grandRow = blank().map(c => ({ ...c, s: STYLE.grandTotalRow }))
    grandRow[2] = { v: 'GRAND TOTAL', t: 's', s: STYLE.grandTotalRow }
    grandRow[3] = { v: grandLimit, t: 'n', s: { ...STYLE.grandTotalRow, numFmt: '#,##0' } }
    grandRow[4] = { v: grandUtil,  t: 'n', s: { ...STYLE.grandTotalRow, numFmt: '#,##0' } }
    grandRow[5] = { v: grandLimit - grandUtil, t: 'n', s: { ...STYLE.grandTotalRow, numFmt: '#,##0' } }
    pushRow(grandRow)
  }

  if (facilities.length === 0) {
    pushRow([{ v: 'No facilities recorded. Upload documents and run extraction first.', t: 's', s: STYLE.subtitle }])
    merges.push({ s: { r: rows.length - 1, c: 0 }, e: { r: rows.length - 1, c: COLS.length - 1 } })
  }

  pushRow(blank()); pushRow(blank())
  const findRow = blank()
  findRow[0] = { v: 'Findings:', t: 's', s: STYLE.label }
  findRow[1] = { v: eng.findings || 'N1 — No dividend was declared during the financial year.', t: 's', s: STYLE.body }
  pushRow(findRow)
  pushRow(blank())

  const wdLabelRow = blank()
  wdLabelRow[0] = { v: 'Work done:', t: 's', s: STYLE.label }
  pushRow(wdLabelRow)

  const wd1 = blank()
  wd1[0] = { v: 'L', t: 's', s: STYLE.body }
  wd1[1] = { v: 'Extracted from bank facilities letter / agreement (AI-assisted, reviewed by auditor)', t: 's', s: STYLE.body }
  pushRow(wd1)

  const wd2 = blank()
  wd2[0] = { v: 'HP', t: 's', s: STYLE.body }
  wd2[1] = { v: 'Extracted from hire purchase agreement / repayment schedule', t: 's', s: STYLE.body }
  pushRow(wd2)
  pushRow(blank())

  const concLabelRow = blank()
  concLabelRow[0] = { v: 'Conclusion:', t: 's', s: STYLE.label }
  pushRow(concLabelRow)

  const concRow = blank()
  concRow[0] = { v: eng.conclusion || 'Based on our audit procedures performed, we conclude that the risk of material misstatement has been reduced to an acceptable low level.', t: 's', s: STYLE.body }
  pushRow(concRow)
  merges.push({ s: { r: rows.length - 1, c: 0 }, e: { r: rows.length - 1, c: COLS.length - 1 } })

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!merges'] = merges
  ws['!cols'] = COLS.map(c => ({ wch: c.w }))

  ws['!rows'] = rows.map((row, i) => {
    if (i === headerRowIdx) return { hpt: 32 }
    const maxLines = row.reduce((max, c) => {
      const text = String(c?.v ?? '')
      const lines = text.split('\n')
      const wrapped = lines.reduce((sum, l) => sum + Math.max(1, Math.ceil(l.length / 50)), 0)
      return Math.max(max, wrapped)
    }, 1)
    return { hpt: Math.min(Math.max(16, maxLines * 13), 220) }
  })

  ws['!freeze'] = { xSplit: 3, ySplit: headerRowIdx + 1 }
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: headerRowIdx, c: 0 }, e: { r: headerRowIdx, c: COLS.length - 1 } }) }

  XLSX.utils.book_append_sheet(wb, ws, 'A420 Borrowings')

  // Sheet 2 — Security register
  const secRows = []
  secRows.push([{ v: 'A4201 — Security Register', t: 's', s: STYLE.title }])
  const secMerges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }]
  secRows.push(Array(6).fill(cell('')))

  const secHeader = ['Bank', 'Facility', 'Security Type', 'Title / Description', 'Proprietor / Guarantor', 'Charged Sum (RM)']
  secRows.push(secHeader.map(h => ({ v: h, t: 's', s: STYLE.header })))
  const secHeaderIdx = secRows.length - 1

  loanFacs.filter(f => f.securityBlock && f.securityBlock !== 'Refer A4201').forEach(f => {
    const lines = f.securityBlock.split('\n').filter(Boolean)
    lines.forEach((line, i) => {
      secRows.push([
        cell(i === 0 ? f.bankName : ''),
        cell(i === 0 ? f.facilityName : ''),
        cell(''),
        cell(line),
        cell(''),
        i === 0 ? cell(fmtNum(f.approvedLimit), { align: 'right', numFmt: '#,##0' }) : cell(''),
      ])
    })
  })

  if (secRows.length === secHeaderIdx + 1) {
    secRows.push([{ v: 'No detailed security records yet.', t: 's', s: STYLE.subtitle }])
  }

  const ws2 = XLSX.utils.aoa_to_sheet(secRows)
  ws2['!merges'] = secMerges
  ws2['!cols'] = [{ wch: 24 }, { wch: 28 }, { wch: 18 }, { wch: 56 }, { wch: 30 }, { wch: 16 }]
  ws2['!rows'] = secRows.map((row, i) => i === secHeaderIdx ? { hpt: 24 } : { hpt: 16 })
  ws2['!freeze'] = { xSplit: 0, ySplit: secHeaderIdx + 1 }

  XLSX.utils.book_append_sheet(wb, ws2, 'A4201 Security Register')

  const filename = `${eng.fileRef || 'A420'}_A420_Borrowings_FY${(eng.fyEnd || '').replace(/\//g, '-')}.xlsx`
  XLSX.writeFile(wb, filename)
  return filename
}
