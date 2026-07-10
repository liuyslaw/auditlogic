import { useState, useRef, useEffect } from 'react'
import { Sparkles, RefreshCw, Send, AlertCircle, Trash2 } from 'lucide-react'
import { generateLoanInsight, askChat } from '../lib/groq.js'

export default function AIInsight({ eng, updateEngagement }) {
  const facilities = eng.facilities || []
  const bankCount = new Set(facilities.map(f => f.bankName).filter(Boolean)).size

  // Both the summary and chat history persist on the engagement itself,
  // same as everything else in this app — survives switching tabs or
  // reloading, not just local component state.
  const summary = eng.aiSummary || ''
  const messages = eng.chatMessages || []

  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState('')
  const [input, setInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatError, setChatError] = useState('')
  const scrollRef = useRef(null)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, chatLoading])

  function setMessages(next) {
    updateEngagement(() => ({ chatMessages: typeof next === 'function' ? next(messages) : next }))
  }

  async function generateSummary() {
    if (facilities.length === 0) {
      setSummaryError('No reconciled facilities yet. Reconcile at least one bank in the A420 Borrowings summary first.')
      return
    }
    setSummaryLoading(true); setSummaryError('')
    try {
      const text = await generateLoanInsight(facilities, eng)
      updateEngagement(() => ({ aiSummary: text }))
    } catch (e) { setSummaryError(e.message) }
    finally { setSummaryLoading(false) }
  }

  async function send() {
    const question = input.trim()
    if (!question) return
    if (facilities.length === 0) {
      setChatError('No reconciled facilities yet. Reconcile at least one bank in the A420 Borrowings summary first, then come back here.')
      return
    }
    setChatError('')
    const userMsg = { role: 'user', content: question }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    setInput('')
    setChatLoading(true)
    try {
      // Sends the full facilities data fresh with every call (see
      // api/chat.js), so answers reflect the CURRENT reconciled state,
      // not a stale snapshot from when the chat or summary was generated.
      const reply = await askChat(nextMessages, facilities, eng)
      setMessages([...nextMessages, { role: 'assistant', content: reply }])
    } catch (e) {
      setChatError(e.message)
    } finally {
      setChatLoading(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  function clearChat() {
    setMessages([])
    setChatError('')
  }

  function renderMarkdown(text) {
    return text.split('\n').map((line, i) => {
      if (line.match(/^\*\*(.+)\*\*$/)) return (
        <div key={i} style={{ fontSize: 14, fontWeight: 600, color: 'var(--gold)', marginTop: i > 0 ? 18 : 0, marginBottom: 5, display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 2, height: 14, background: 'var(--gold)', borderRadius: 1, flexShrink: 0 }} />
          {line.replace(/\*\*/g, '')}
        </div>
      )
      const parts = line.split(/\*\*(.+?)\*\*/)
      const rendered = parts.map((p, j) => j % 2 === 1 ? <strong key={j} style={{ color: 'var(--text)' }}>{p}</strong> : p)
      return line.trim()
        ? <p key={i} style={{ color: 'var(--text2)', fontSize: 13, lineHeight: 1.75, marginBottom: 2 }}>{rendered}</p>
        : <div key={i} style={{ height: 4 }} />
    })
  }

  function renderChatText(text) {
    return text.split('\n').map((line, i) => {
      const parts = line.split(/\*\*(.+?)\*\*/)
      const rendered = parts.map((p, j) => j % 2 === 1 ? <strong key={j} style={{ color: 'inherit' }}>{p}</strong> : p)
      return line.trim()
        ? <p key={i} style={{ margin: 0, marginBottom: 4 }}>{rendered}</p>
        : <div key={i} style={{ height: 6 }} />
    })
  }

  return (
    <div style={{ padding: '28px 32px', maxWidth: 860 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', marginBottom: 3 }}>Ask AI</h2>
          <p style={{ fontSize: 12, color: 'var(--text3)' }}>
            {eng.client} · A420 Borrowings · FY {eng.fyEnd}
          </p>
        </div>
        <button onClick={generateSummary} disabled={summaryLoading} style={{
          display: 'flex', alignItems: 'center', gap: 7,
          background: summaryLoading ? 'rgba(184,68,128,0.06)' : 'rgba(184,68,128,0.12)',
          border: '1px solid rgba(184,68,128,0.35)',
          borderRadius: 8, padding: '9px 18px',
          color: 'var(--magenta)', fontSize: 12, fontWeight: 500,
          opacity: summaryLoading ? 0.7 : 1,
        }}>
          {summaryLoading
            ? <><RefreshCw size={13} style={{ animation: 'spin 1s linear infinite' }} /> Analysing…</>
            : <><Sparkles size={13} /> {summary ? 'Regenerate Summary' : 'Generate Summary'}</>
          }
        </button>
      </div>

      {/* Context strip — shared by both summary and chat below */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 9, padding: '12px 16px', marginBottom: 18, display: 'flex', gap: 28 }}>
        {[
          { label: 'Facilities', value: facilities.length },
          { label: 'Banks', value: bankCount },
          { label: 'Model', value: 'llama-3.3-70b' },
        ].map(k => (
          <div key={k.label}>
            <div style={{ fontSize: 9, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 3, fontWeight: 600 }}>{k.label}</div>
            <div style={{ fontSize: 12, color: 'var(--text)' }}>{k.value}</div>
          </div>
        ))}
      </div>

      {summaryError && (
        <div style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 9, padding: '12px 16px', marginBottom: 18, display: 'flex', gap: 8 }}>
          <AlertCircle size={14} color="var(--red)" />
          <span style={{ fontSize: 12, color: 'var(--red)' }}>{summaryError}</span>
        </div>
      )}

      {/* Summary section */}
      {summary ? (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, padding: '24px 28px', marginBottom: 28 }}>
          <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 16, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Sparkles size={11} /> A420 Borrowings — Audit Working Paper Narrative
          </div>
          {renderMarkdown(summary)}
        </div>
      ) : !summaryLoading && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, padding: '40px 32px', textAlign: 'center', marginBottom: 28 }}>
          <Sparkles size={24} color="var(--border)" style={{ marginBottom: 10 }} />
          <div style={{ fontSize: 13, color: 'var(--text3)' }}>Click Generate Summary for a working paper narrative</div>
        </div>
      )}

      {summaryLoading && (
        <div style={{ background: 'var(--card)', border: '1px solid rgba(184,68,128,0.25)', borderRadius: 10, padding: '40px 32px', textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 20, color: 'var(--magenta)', marginBottom: 10 }}>✦</div>
          <div style={{ fontSize: 13, color: 'var(--magenta)' }}>Analysing A420 Borrowings working paper…</div>
        </div>
      )}

      {/* Chat section */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Ask a question about this engagement's facilities</div>
        {messages.length > 0 && (
          <button onClick={clearChat} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: 'none', border: '1px solid var(--border)',
            borderRadius: 7, padding: '6px 11px', color: 'var(--text3)', fontSize: 11,
          }}>
            <Trash2 size={12} /> Clear chat
          </button>
        )}
      </div>

      {chatError && (
        <div style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 9, padding: '12px 16px', marginBottom: 14, display: 'flex', gap: 8 }}>
          <AlertCircle size={14} color="var(--red)" style={{ flexShrink: 0, marginTop: 1 }} />
          <span style={{ fontSize: 12, color: 'var(--red)' }}>{chatError}</span>
        </div>
      )}

      {messages.length > 0 && (
        <div ref={scrollRef} style={{ maxHeight: 360, overflowY: 'auto', marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {messages.map((m, i) => (
            <div key={i} style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '80%',
              background: m.role === 'user' ? 'rgba(184,68,128,0.12)' : 'var(--card)',
              border: `1px solid ${m.role === 'user' ? 'rgba(184,68,128,0.3)' : 'var(--border)'}`,
              borderRadius: 10,
              padding: '10px 14px',
              fontSize: 13,
              lineHeight: 1.6,
              color: m.role === 'user' ? 'var(--magenta)' : 'var(--text2)',
            }}>
              {m.role === 'assistant' ? renderChatText(m.content) : m.content}
            </div>
          ))}
          {chatLoading && (
            <div style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text3)', fontSize: 12, padding: '10px 14px' }}>
              <Sparkles size={13} style={{ animation: 'pulse 1.4s ease-in-out infinite' }} /> Thinking…
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={chatLoading}
          placeholder="e.g. Which facilities are secured against the Beranang property?"
          rows={1}
          style={{
            flex: 1, resize: 'none', background: 'var(--card)', border: '1px solid var(--border)',
            borderRadius: 8, padding: '10px 14px', color: 'var(--text)', fontSize: 13,
            fontFamily: 'inherit', outline: 'none', maxHeight: 120,
          }}
        />
        <button onClick={send} disabled={chatLoading || !input.trim()} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: chatLoading || !input.trim() ? 'rgba(184,68,128,0.06)' : 'rgba(184,68,128,0.12)',
          border: '1px solid rgba(184,68,128,0.35)',
          borderRadius: 8, padding: '0 18px',
          color: 'var(--magenta)', fontSize: 12, fontWeight: 500,
          opacity: chatLoading || !input.trim() ? 0.5 : 1,
        }}>
          <Send size={13} /> Send
        </button>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } } @keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }`}</style>
    </div>
  )
}
