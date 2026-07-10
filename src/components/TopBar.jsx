import { useState } from 'react'
import { ChevronLeft, Flame, RotateCcw, CheckCircle, ServerIcon } from 'lucide-react'

export default function TopBar({ activeEng, onBack, apiKey, saveApiKey, settingsOpen, setSettingsOpen, onReset }) {
  const [confirmReset, setConfirmReset] = useState(false)

  // ANTHROPIC_API_KEY is set in Vercel environment variables — the browser
  // never needs to know or store it. The /api/extract serverless function
  // reads process.env.ANTHROPIC_API_KEY directly on the server side.
  // So this dropdown is now just for reset/info — no key input needed.

  function handleReset() {
    if (!confirmReset) { setConfirmReset(true); return }
    setConfirmReset(false)
    setSettingsOpen(false)
    onReset(activeEng?.id)
  }

  return (
    <>
      <header style={{
        height: 52, minHeight: 52, background: 'var(--bg2)',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', padding: '0 20px', gap: 14,
        position: 'relative', zIndex: 50, flexShrink: 0,
      }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 8,
            background: 'linear-gradient(135deg, #f59e0b, #B84480)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Flame size={15} color="#fff" />
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', lineHeight: 1.2 }}>AuditLogic</div>
            <div style={{ fontSize: 10, color: 'var(--text3)', letterSpacing: 0.3 }}>by SynerGrowth</div>
          </div>
        </div>

        {/* Breadcrumb */}
        {activeEng && (
          <>
            <div style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 2px' }} />
            <button onClick={onBack} style={{
              display: 'flex', alignItems: 'center', gap: 5,
              background: 'none', color: 'var(--text3)', fontSize: 12,
              padding: '5px 8px', borderRadius: 6, border: 'none',
              transition: 'all 0.15s', whiteSpace: 'nowrap',
            }}
              onMouseEnter={e => { e.currentTarget.style.color='var(--text)'; e.currentTarget.style.background='rgba(255,255,255,0.05)' }}
              onMouseLeave={e => { e.currentTarget.style.color='var(--text3)'; e.currentTarget.style.background='none' }}
            >
              <ChevronLeft size={15} /> All Engagements
            </button>
            <div style={{ width: 1, height: 14, background: 'var(--border)' }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap' }}>{activeEng.client}</span>
            <span style={{ color: 'var(--border)', fontSize: 14 }}>·</span>
            <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', whiteSpace: 'nowrap' }}>FY {activeEng.fyEnd}</span>
            <span style={{ color: 'var(--border)', fontSize: 14 }}>·</span>
            <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', whiteSpace: 'nowrap' }}>{activeEng.fileRef}</span>
          </>
        )}

        {/* Right — Groq AI status + Phase badge */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={() => { setSettingsOpen(!settingsOpen); setConfirmReset(false) }} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: 'rgba(34,197,94,0.1)',
            border: '1px solid rgba(34,197,94,0.3)',
            borderRadius: 6, padding: '5px 12px',
            color: 'var(--green)', fontSize: 12, fontWeight: 500,
          }}>
            <CheckCircle size={13} />
            AI Ready
          </button>
          <div style={{
            background: 'var(--card2)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '5px 12px',
            fontSize: 12, color: 'var(--text2)', fontWeight: 500,
          }}>
            Phase 1
          </div>
        </div>
      </header>

      {/* Settings dropdown */}
      {settingsOpen && (
        <>
          <div onClick={() => { setSettingsOpen(false); setConfirmReset(false) }}
            style={{ position: 'fixed', inset: 0, zIndex: 98 }} />

          <div style={{
            position: 'fixed', top: 58, right: 16, zIndex: 99,
            background: 'var(--card)', border: '1px solid var(--border)',
            borderRadius: 10, padding: 18, width: 320,
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          }}>

            {/* AI status */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <ServerIcon size={14} color="var(--green)" />
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>AI Extraction</span>
            </div>
            <div style={{
              background: 'rgba(34,197,94,0.07)', border: '1px solid rgba(34,197,94,0.2)',
              borderRadius: 8, padding: '10px 14px', marginBottom: 14,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <CheckCircle size={13} color="var(--green)" />
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--green)' }}>API key configured on server</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.5 }}>
                The Anthropic API key is set in Vercel environment variables.
                All document extraction runs securely on the server — no key needed here.
              </div>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 14, lineHeight: 1.5 }}>
              Model: <span style={{ color: 'var(--text2)', fontFamily: 'var(--mono)' }}>claude-haiku-4-5 → claude-sonnet-4-6</span>
              <br/>Tiered extraction: fast model first, escalates to Sonnet if confidence &lt; 80%.
            </div>

            {/* Reset section — only inside an engagement */}
            {activeEng && (
              <>
                <div style={{ borderTop: '1px solid var(--border)', margin: '14px 0' }} />
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
                  A420 Data — {activeEng.client}
                </div>
                <p style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 10, lineHeight: 1.5 }}>
                  Clears uploaded documents and extracted facilities for this engagement. Other clients are not affected.
                </p>

                {!confirmReset ? (
                  <button onClick={handleReset} style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                    background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
                    borderRadius: 8, padding: '10px', color: 'var(--red)', fontSize: 13, fontWeight: 500,
                    cursor: 'pointer',
                  }}>
                    <RotateCcw size={14} /> Clear A420 Data
                  </button>
                ) : (
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 10, lineHeight: 1.5 }}>
                      Clear all documents and facilities for <strong>{activeEng.client}</strong>? This cannot be undone.
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={handleReset} style={{
                        flex: 1, background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)',
                        borderRadius: 8, padding: '10px', color: 'var(--red)', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                      }}>
                        Yes, clear
                      </button>
                      <button onClick={() => setConfirmReset(false)} style={{
                        flex: 1, background: 'none', border: '1px solid var(--border)',
                        borderRadius: 8, padding: '10px', color: 'var(--text2)', fontSize: 13, cursor: 'pointer',
                      }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </>
  )
}
