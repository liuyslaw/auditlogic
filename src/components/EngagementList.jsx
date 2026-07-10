import { useState } from 'react'
import { Plus, Search, Users, Calendar } from 'lucide-react'
import { sectionCompletion, STATUS, WP_SECTIONS, seedEngagements } from '../lib/store.js'

function ProgressRing({ pct, size = 52, stroke = 4, color }) {
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const dash = (pct / 100) * circ
  const ringColor = pct === 100 ? '#22c55e' : pct > 0 ? '#B84480' : '#2a2a2f'

  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={ringColor} strokeWidth={stroke}
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" />
      <text x={size/2} y={size/2} textAnchor="middle" dominantBaseline="central"
        style={{ transform: 'rotate(90deg)', transformOrigin: `${size/2}px ${size/2}px`,
          fill: pct === 100 ? '#22c55e' : '#e4e4e7', fontSize: size < 48 ? 9 : 11, fontWeight: 600, fontFamily: 'Inter,sans-serif' }}>
        {pct}%
      </text>
    </svg>
  )
}

export default function EngagementList({ engagements, updateEngagements, onOpen, apiKey }) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [showNew, setShowNew] = useState(false)
  const [newForm, setNewForm] = useState({ client: '', regNo: '', industry: '', fyEnd: '', fileRef: '' })

  const total      = engagements.length
  const inProgress = engagements.filter(e => e.status === 'in_progress').length
  const avgPct     = total > 0 ? Math.round(engagements.reduce((s, e) => s + sectionCompletion(e).pct, 0) / total) : 0

  const filtered = engagements.filter(e => {
    const matchSearch = !search || e.client.toLowerCase().includes(search.toLowerCase()) || e.fileRef.toLowerCase().includes(search.toLowerCase())
    const matchFilter = filter === 'all' || e.status === filter
    return matchSearch && matchFilter
  })

  function addEngagement() {
    if (!newForm.client.trim()) return
    const sections = {}
    WP_SECTIONS.forEach(s => { sections[s.code] = { status: 'not_started' } })
    const eng = {
      id: crypto.randomUUID(),
      fileRef: newForm.fileRef || `File ${Date.now().toString().slice(-4)}`,
      client: newForm.client.trim(),
      regNo: newForm.regNo,
      industry: newForm.industry,
      fyEnd: newForm.fyEnd,
      status: 'new',
      team: [],
      createdAt: new Date().toISOString().slice(0, 10),
      sections,
      loanRecords: [],
      uploadedDocs: [],
    }
    updateEngagements([...engagements, eng])
    setNewForm({ client: '', regNo: '', industry: '', fyEnd: '', fileRef: '' })
    setShowNew(false)
  }

  const FILTERS = [
    { id: 'all',         label: 'All' },
    { id: 'new',         label: 'New' },
    { id: 'in_progress', label: 'In Progress' },
    { id: 'on_hold',     label: 'On Hold' },
    { id: 'completed',   label: 'Completed' },
  ]

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '28px 32px' }}>

      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>Engagements</h1>
          <p style={{ fontSize: 13, color: 'var(--text3)' }}>Select an engagement to begin or continue audit work.</p>
        </div>
        <button onClick={() => setShowNew(true)} style={{
          display: 'flex', alignItems: 'center', gap: 7,
          background: 'var(--gold)', border: 'none',
          borderRadius: 8, padding: '9px 18px',
          color: '#111', fontSize: 13, fontWeight: 600,
        }}>
          <Plus size={15} /> New Engagement
        </button>
      </div>

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24 }}>
        {[
          { label: 'Total Engagements', value: total,      color: 'var(--blue)' },
          { label: 'In Progress',       value: inProgress, color: 'var(--gold)' },
          { label: 'Avg Completion',    value: `${avgPct}%`, color: avgPct === 100 ? 'var(--green)' : 'var(--gold)' },
        ].map(k => (
          <div key={k.label} style={{
            background: 'var(--card)', border: '1px solid var(--border)',
            borderRadius: 10, padding: '20px 24px', textAlign: 'center',
          }}>
            <div style={{ fontSize: 32, fontWeight: 700, color: k.color, fontFamily: 'var(--mono)', lineHeight: 1 }}>
              {k.value}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 6 }}>{k.label}</div>
          </div>
        ))}
      </div>

      {/* Search + filters */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <div style={{ position: 'relative', flex: 1, maxWidth: 280 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search client or file ref..."
            style={{
              width: '100%', background: 'var(--card)', border: '1px solid var(--border)',
              borderRadius: 7, padding: '8px 10px 8px 30px', color: 'var(--text)', fontSize: 12, outline: 'none',
            }} />
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {FILTERS.map(f => (
            <button key={f.id} onClick={() => setFilter(f.id)} style={{
              padding: '7px 14px', borderRadius: 7, fontSize: 12, fontWeight: 500,
              background: filter === f.id ? 'var(--gold)' : 'var(--card)',
              color: filter === f.id ? '#111' : 'var(--text2)',
              border: filter === f.id ? 'none' : '1px solid var(--border)',
            }}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* New engagement form */}
      {showNew && (
        <div style={{
          background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
          padding: 20, marginBottom: 20,
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 14 }}>New Engagement</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
            {[
              { key: 'client',   label: 'Client Name *',   placeholder: 'e.g. ABC Sdn. Bhd.' },
              { key: 'regNo',    label: 'Reg No.',          placeholder: 'e.g. 123456-W' },
              { key: 'industry', label: 'Industry',         placeholder: 'e.g. Manufacturing' },
              { key: 'fyEnd',    label: 'FY End',           placeholder: '31/12/2024' },
              { key: 'fileRef',  label: 'File Ref',         placeholder: 'File 0000' },
            ].map(f => (
              <div key={f.key}>
                <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.6 }}>{f.label}</div>
                <input value={newForm[f.key]} onChange={e => setNewForm(p => ({ ...p, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  style={{
                    width: '100%', background: 'var(--bg)', border: '1px solid var(--border)',
                    borderRadius: 6, padding: '7px 10px', color: 'var(--text)', fontSize: 12, outline: 'none',
                  }} />
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={addEngagement} style={{
              background: 'var(--gold)', border: 'none', borderRadius: 7,
              padding: '8px 18px', color: '#111', fontSize: 12, fontWeight: 600,
            }}>Create Engagement</button>
            <button onClick={() => setShowNew(false)} style={{
              background: 'none', border: '1px solid var(--border)', borderRadius: 7,
              padding: '8px 14px', color: 'var(--text2)', fontSize: 12,
            }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Engagement grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {filtered.map(eng => {
          const { done, total: tot, pct } = sectionCompletion(eng)
          const st = STATUS[eng.status] || STATUS.new
          const chips = WP_SECTIONS.map(s => ({
            code: s.code,
            status: eng.sections?.[s.code]?.status || 'not_started',
          }))

          return (
            <div key={eng.id} onClick={() => onOpen(eng.id)}
              style={{
                background: 'var(--card)', border: '1px solid var(--border)',
                borderRadius: 12, padding: '18px 20px', cursor: 'pointer',
                transition: 'border-color 0.15s, background 0.15s',
                position: 'relative',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border2)'; e.currentTarget.style.background = 'var(--card2)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'var(--card)' }}
            >
              {/* Top row: status + file ref + arrow */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span className={`badge ${st.cls}`}>{st.label}</span>
                <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{eng.fileRef}</span>
                <span style={{ marginLeft: 'auto', color: 'var(--text3)', fontSize: 16 }}>›</span>
              </div>

              {/* Client name */}
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 3 }}>
                {eng.client}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 14 }}>
                {[eng.regNo, eng.industry, `FY ${eng.fyEnd}`].filter(Boolean).join(' · ')}
              </div>

              {/* Progress row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
                <ProgressRing pct={pct} />
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>
                    {done} of {tot} working paper sections completed
                  </div>
                  {/* Section chips */}
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {chips.map(c => (
                      <span key={c.code} className={`chip ${c.status === 'completed' ? 'chip-done' : c.status === 'in_progress' ? 'chip-active' : ''}`}>
                        {c.status === 'completed' && <span style={{ fontSize: 9 }}>✓</span>}
                        {c.code}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              {/* Footer: team + date */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--text3)', fontSize: 11 }}>
                  <Users size={11} />
                  {eng.team.slice(0, 3).join(' · ')}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text3)', fontSize: 11, fontFamily: 'var(--mono)' }}>
                  <Calendar size={11} />
                  {eng.createdAt}
                </div>
              </div>
            </div>
          )
        })}

        {filtered.length === 0 && engagements.length === 0 && (
          <div style={{
            gridColumn: '1/-1', padding: '60px 24px', textAlign: 'center',
          }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}>📁</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>
              No engagements yet
            </div>
            <div style={{ fontSize: 13, color: 'var(--text3)', lineHeight: 1.7, maxWidth: 380, margin: '0 auto 24px' }}>
              Create a new engagement for each audit client.<br/>
              Upload their loan and HP documents, then run the A420 summary.
            </div>
            <button onClick={() => setShowNew(true)} style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              background: 'var(--gold)', border: 'none', borderRadius: 8,
              padding: '10px 22px', color: '#111', fontSize: 13, fontWeight: 600,
            }}>
              <Plus size={15} /> Create First Engagement
            </button>
          </div>
        )}
        {filtered.length === 0 && engagements.length > 0 && (
          <div style={{ gridColumn: '1/-1', padding: '60px 0', textAlign: 'center', color: 'var(--text3)' }}>
            No engagements match your search.
          </div>
        )}
      </div>
    </div>
  )
}
