// ── IndexedDB file storage ────────────────────────────────────────────────
// Stores raw PDF/image binaries keyed by doc.id
// Persists across sessions, no size limit, no base64 overhead

const DB_NAME    = 'nexis_files'
const DB_VERSION = 1
const STORE_NAME = 'files'

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
    }
    req.onsuccess = e => resolve(e.target.result)
    req.onerror   = e => reject(e.target.error)
  })
}

// Save file binary + mediaType under doc.id
export async function saveFile(docId, file) {
  const buffer = await file.arrayBuffer()
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put({
      id:        docId,
      name:      file.name,
      mediaType: file.type || 'application/pdf',
      data:      buffer,
      savedAt:   Date.now(),
    })
    tx.oncomplete = () => resolve()
    tx.onerror    = e => reject(e.target.error)
  })
}

// Read stored file as { id, name, mediaType, data: ArrayBuffer }
export async function loadFile(docId) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(docId)
    req.onsuccess = e => resolve(e.target.result || null)
    req.onerror   = e => reject(e.target.error)
  })
}

// Delete stored file
export async function deleteFile(docId) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(docId)
    tx.oncomplete = () => resolve()
    tx.onerror    = e => reject(e.target.error)
  })
}

// Delete all files for an engagement (by list of docIds)
export async function deleteFiles(docIds) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    docIds.forEach(id => store.delete(id))
    tx.oncomplete = () => resolve()
    tx.onerror    = e => reject(e.target.error)
  })
}

// Check if a file is stored
export async function hasFile(docId) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).count(docId)
    req.onsuccess = e => resolve(e.target.result > 0)
    req.onerror   = e => reject(e.target.error)
  })
}

// Convert ArrayBuffer to base64 for API call
export function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary  = ''
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}
