import { useState, useEffect } from 'react'
import { loadEngagements, saveEngagements, seedEngagements } from './lib/store.js'
import TopBar from './components/TopBar.jsx'
import EngagementList from './components/EngagementList.jsx'
import EngagementShell from './components/EngagementShell.jsx'

export default function App() {
  const [engagements, setEngagements] = useState([])
  const [activeEngId, setActiveEngId] = useState(null)
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('nexis_groq_key') || '')
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => { setEngagements(loadEngagements()) }, [])

  function updateEngagements(engs) {
    setEngagements(engs)
    saveEngagements(engs)
  }

  function updateEngagement(id, patchOrFn) {
    setEngagements(prev => {
      const updated = prev.map(e => {
        if (e.id !== id) return e
        const patch = typeof patchOrFn === 'function' ? patchOrFn(e) : patchOrFn
        return { ...e, ...patch }
      })
      saveEngagements(updated)
      return updated
    })
  }

  function saveApiKey(key) {
    setApiKey(key)
    localStorage.setItem('nexis_groq_key', key)
  }

  // Clears uploaded docs + extracted facilities for ONE engagement only
  // Engagements on the dashboard are NOT affected
  function handleClearEngagementData(engId) {
    if (!engId) return
    const updated = engagements.map(e =>
      e.id === engId
        ? { ...e, uploadedDocs: [], facilities: [] }
        : e
    )
    setEngagements(updated)
    saveEngagements(updated)
  }

  const activeEng = engagements.find(e => e.id === activeEngId)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <TopBar
        activeEng={activeEng}
        onBack={() => setActiveEngId(null)}
        apiKey={apiKey}
        saveApiKey={saveApiKey}
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
        onReset={(engId) => handleClearEngagementData(engId)}
      />

      <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
        {!activeEngId ? (
          <EngagementList
            engagements={engagements}
            updateEngagements={updateEngagements}
            onOpen={setActiveEngId}
            apiKey={apiKey}
          />
        ) : (
          <EngagementShell
            eng={activeEng}
            updateEngagement={(patch) => updateEngagement(activeEngId, patch)}
            apiKey={apiKey}
          />
        )}
      </div>
    </div>
  )
}
