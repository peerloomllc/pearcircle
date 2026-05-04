import React, { useEffect, useState } from 'react'

export function App() {
  const [identity, setIdentity] = useState(null)
  const [circles, setCircles] = useState([])

  useEffect(() => {
    window.pear.call('identity:get').then(setIdentity)
    window.pear.call('circles:list').then((r) => setCircles(r?.circles ?? []))
  }, [])

  return (
    <div style={styles.root}>
      <h1 style={styles.h1}>PearCircle</h1>
      <p style={styles.subtitle}>Scaffold. Wire protocol pending proposal review.</p>
      <section style={styles.section}>
        <h2 style={styles.h2}>Identity</h2>
        <pre style={styles.pre}>{JSON.stringify(identity, null, 2)}</pre>
      </section>
      <section style={styles.section}>
        <h2 style={styles.h2}>Circles</h2>
        {circles.length === 0
          ? <p style={styles.muted}>No circles yet. Invite flow not implemented.</p>
          : <ul>{circles.map((c) => <li key={c.id}>{c.name}</li>)}</ul>}
      </section>
    </div>
  )
}

const styles = {
  root: { padding: 20, color: '#eee', background: '#111', minHeight: '100vh', fontFamily: 'system-ui, sans-serif' },
  h1: { fontSize: 28, margin: '0 0 4px 0' },
  subtitle: { color: '#888', marginTop: 0 },
  section: { marginTop: 24 },
  h2: { fontSize: 18, marginBottom: 8 },
  pre: { background: '#1c1c1c', padding: 12, borderRadius: 8, color: '#9cf' },
  muted: { color: '#888' }
}
