import React, { useEffect, useState, useCallback } from 'react'

// Lazy proxy: window.pear is installed by main.jsx but App.jsx is imported
// before that assignment runs. Resolve through window at call time.
const pear = {
  call: (...args) => window.pear.call(...args),
  on: (...args) => window.pear.on(...args),
}

export function App () {
  const [view, setView] = useState({ name: 'list' })
  const [identity, setIdentity] = useState(null)
  const [circles, setCircles] = useState([])
  const [profile, setProfile] = useState(null)

  const refresh = useCallback(async () => {
    const [id, cs, pr] = await Promise.all([
      pear.call('identity:get'),
      pear.call('circles:list'),
      pear.call('profile:get'),
    ])
    setIdentity(id)
    setCircles(cs?.circles ?? [])
    setProfile(pr ?? null)
  }, [])

  useEffect(() => {
    refresh()
    pear.on('ready', refresh)
    pear.on('circle:writer:added', refresh)
    pear.on('deeplink:invite', ({ url }) => {
      if (typeof url === 'string') setView({ name: 'join', invite: url })
    })
  }, [refresh])

  if (view.name === 'list') {
    return <ListView identity={identity} profile={profile} circles={circles} onRefresh={refresh} setView={setView} />
  }
  if (view.name === 'create') {
    return <CreateView setView={setView} onCreated={refresh} />
  }
  if (view.name === 'join') {
    return <JoinView setView={setView} onJoined={refresh} initialInvite={view.invite} />
  }
  if (view.name === 'detail') {
    return <DetailView circleId={view.circleId} setView={setView} />
  }
  if (view.name === 'profile') {
    return <ProfileView profile={profile} setView={setView} onSaved={refresh} />
  }
  return null
}

function ListView ({ identity, profile, circles, onRefresh, setView }) {
  return (
    <div style={s.screen}>
      <header style={s.header}>
        <h1 style={s.h1}>PearCircle</h1>
        <button style={s.iconBtn} onClick={onRefresh} aria-label='Refresh'>↻</button>
      </header>
      {identity?.publicKey && (
        <button
          type='button'
          style={s.profileBtn}
          onClick={() => setView({ name: 'profile' })}
        >
          {profile?.displayName ? (
            <span style={s.idName}>{profile.displayName}</span>
          ) : (
            <span style={s.idNeedName}>Set your name</span>
          )}
          <span style={s.idMuted}>{' · '}{short(identity.publicKey)}</span>
        </button>
      )}
      <div style={s.actions}>
        <button style={s.primaryBtn} onClick={() => setView({ name: 'create' })}>
          Create circle
        </button>
        <button style={s.secondaryBtn} onClick={() => setView({ name: 'join' })}>
          Join via link
        </button>
      </div>
      <h2 style={s.h2}>Your circles</h2>
      {circles.length === 0 ? (
        <p style={s.muted}>No circles yet. Create one or paste an invite.</p>
      ) : (
        <ul style={s.circleList}>
          {circles.map((c) => (
            <li key={c.circleId} style={s.circleItem}
                onClick={() => setView({ name: 'detail', circleId: c.circleId })}>
              <div style={s.circleName}>{c.name}</div>
              <div style={s.circleMeta}>{c.role} · {short(c.circleId)}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CreateView ({ setView, onCreated }) {
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const submit = async () => {
    if (!name.trim()) return
    setCreating(true)
    setError(null)
    const r = await pear.call('circle:create', { name: name.trim() })
    setCreating(false)
    if (r?.invite) {
      setResult(r)
      onCreated()
    } else {
      setError('Could not create circle')
    }
  }

  if (result) {
    return (
      <div style={s.screen}>
        <BackBar onBack={() => setView({ name: 'list' })} title={result.name} />
        <p style={s.muted}>Circle created. Share this invite link:</p>
        <textarea style={s.inviteBox} readOnly value={result.invite} onFocus={(e) => e.target.select()} />
        <CopyButton text={result.invite} />
        <button style={s.primaryBtn} onClick={() => setView({ name: 'list' })}>Done</button>
      </div>
    )
  }

  return (
    <div style={s.screen}>
      <BackBar onBack={() => setView({ name: 'list' })} title='New circle' />
      <label style={s.label}>Circle name</label>
      <input
        style={s.input}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder='Smith Family'
        autoFocus
        maxLength={64}
      />
      <button style={s.primaryBtn} disabled={!name.trim() || creating} onClick={submit}>
        {creating ? 'Creating...' : 'Create'}
      </button>
      {error && <p style={s.error}>{error}</p>}
    </div>
  )
}

function JoinView ({ setView, onJoined, initialInvite }) {
  const [invite, setInvite] = useState(initialInvite ?? '')
  const [joining, setJoining] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const submit = async () => {
    if (!invite.trim()) return
    setJoining(true)
    setError(null)
    try {
      const r = await pear.call('circle:join', { invite: invite.trim() })
      setJoining(false)
      if (r?.circleId) {
        setResult(r)
        onJoined()
      } else {
        setError('Invalid invite')
      }
    } catch (e) {
      setJoining(false)
      setError(String(e?.message ?? e))
    }
  }

  if (result) {
    return (
      <div style={s.screen}>
        <BackBar onBack={() => setView({ name: 'list' })} title={result.name} />
        <p style={s.muted}>
          {result.alreadyJoined ? 'You were already in this circle.' : 'Joined! Waiting for sync...'}
        </p>
        <button style={s.primaryBtn} onClick={() => setView({ name: 'detail', circleId: result.circleId })}>
          Open
        </button>
        <button style={s.secondaryBtn} onClick={() => setView({ name: 'list' })}>Done</button>
      </div>
    )
  }

  return (
    <div style={s.screen}>
      <BackBar onBack={() => setView({ name: 'list' })} title='Join a circle' />
      <label style={s.label}>Paste invite link</label>
      <textarea
        style={s.textarea}
        value={invite}
        onChange={(e) => setInvite(e.target.value)}
        placeholder='https://peerloomllc.com/circle/join?...'
        autoFocus
        rows={4}
      />
      <button style={s.primaryBtn} disabled={!invite.trim() || joining} onClick={submit}>
        {joining ? 'Joining...' : 'Join'}
      </button>
      {error && <p style={s.error}>{error}</p>}
    </div>
  )
}

function DetailView ({ circleId, setView }) {
  const [data, setData] = useState(null)
  const [peers, setPeers] = useState([])
  const [claiming, setClaiming] = useState(false)
  const [claimError, setClaimError] = useState(null)

  const refresh = useCallback(async () => {
    const [d, p] = await Promise.all([
      pear.call('circle:get', { circleId }),
      pear.call('circles:peers'),
    ])
    setData(d)
    setPeers(p?.peers?.[circleId] ?? [])
  }, [circleId])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 3000)
    pear.on('peer:connected', refresh)
    pear.on('peer:disconnected', refresh)
    pear.on('circle:writer:added', refresh)
    return () => clearInterval(id)
  }, [refresh])

  const claimMembership = async () => {
    setClaiming(true)
    setClaimError(null)
    try {
      await pear.call('circle:append:member', { circleId })
      await refresh()
    } catch (e) {
      setClaimError(String(e?.message ?? e))
    }
    setClaiming(false)
  }

  if (!data) {
    return (
      <div style={s.screen}>
        <BackBar onBack={() => setView({ name: 'list' })} title='Loading...' />
      </div>
    )
  }

  const ownMember = data.members.find(m => m.value?.pubkey && data.circle?.ownerKey !== m.value.pubkey)
  const isWritable = data.writable
  const myMember = data.members.find(m => m.key.endsWith(short(window.__myPubkey ?? '')))

  return (
    <div style={s.screen}>
      <BackBar onBack={() => setView({ name: 'list' })} title={data.circle?.name ?? '...'} />
      <section style={s.section}>
        <div style={s.row}><span style={s.muted}>Writable</span><span>{isWritable ? 'yes' : 'no'}</span></div>
        <div style={s.row}><span style={s.muted}>Writers</span><span>{data.writers ?? '?'}</span></div>
        <div style={s.row}><span style={s.muted}>Peers online</span><span>{peers.length}</span></div>
      </section>

      <h3 style={s.h3}>Members ({data.members.length})</h3>
      {data.members.length === 0 ? (
        <p style={s.muted}>No members visible yet. Waiting for sync...</p>
      ) : (
        <ul style={s.memberList}>
          {data.members.map(m => {
            const pubkey = m.value?.pubkey ?? ''
            const seen = data.lastSeen?.[pubkey]
            return (
              <li key={m.key} style={s.memberItem}>
                <div style={s.memberName}>{m.value?.displayName ?? short(pubkey)}</div>
                <div style={s.muted}>{short(pubkey)}</div>
                {seen ? (
                  <div style={s.lastSeen}>
                    {seen.lat.toFixed(5)}, {seen.lon.toFixed(5)}
                    {' · '}{ageLabel(seen.ts)}
                    {seen.accuracy != null && ` · ±${Math.round(seen.accuracy)}m`}
                  </div>
                ) : (
                  <div style={s.lastSeenMuted}>no location yet</div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {isWritable && (
        <button style={s.primaryBtn} disabled={claiming} onClick={claimMembership}>
          {claiming ? 'Posting...' : 'Post my membership'}
        </button>
      )}
      {claimError && <p style={s.error}>{claimError}</p>}
      {!isWritable && (
        <p style={s.muted}>Read-only until owner adds you as a writer.</p>
      )}
    </div>
  )
}

function ProfileView ({ profile, setView, onSaved }) {
  const [name, setName] = useState(profile?.displayName ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  const submit = async () => {
    if (!name.trim()) return
    setSaving(true)
    setError(null)
    try {
      const r = await pear.call('profile:set', { displayName: name.trim() })
      setSaving(false)
      if (r?.ok) {
        setSavedAt(Date.now())
        onSaved()
      } else {
        setError('Could not save profile')
      }
    } catch (e) {
      setSaving(false)
      setError(String(e?.message ?? e))
    }
  }

  return (
    <div style={s.screen}>
      <BackBar onBack={() => setView({ name: 'list' })} title='Profile' />
      <label style={s.label}>Display name</label>
      <input
        style={s.input}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder='Your name'
        autoFocus
        maxLength={64}
      />
      <button style={s.primaryBtn} disabled={!name.trim() || saving} onClick={submit}>
        {saving ? 'Saving...' : 'Save'}
      </button>
      {savedAt && <p style={s.muted}>Saved. Members in your circles will see the new name shortly.</p>}
      {error && <p style={s.error}>{error}</p>}
    </div>
  )
}

function BackBar ({ onBack, title }) {
  return (
    <header style={s.header}>
      <button style={s.iconBtn} onClick={onBack} aria-label='Back'>‹</button>
      <h1 style={s.h1}>{title}</h1>
      <span style={{ width: 32 }} />
    </header>
  )
}

function CopyButton ({ text }) {
  const [copied, setCopied] = useState(false)
  const click = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }
  return (
    <button style={s.secondaryBtn} onClick={click}>
      {copied ? 'Copied' : 'Copy invite link'}
    </button>
  )
}

function ageLabel (ts) {
  if (typeof ts !== 'number') return ''
  const ms = Date.now() - ts
  if (ms < 0) return 'just now'
  if (ms < 60_000) return Math.max(1, Math.floor(ms / 1000)) + 's ago'
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + 'm ago'
  if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + 'h ago'
  return Math.floor(ms / 86_400_000) + 'd ago'
}

function short (s) {
  if (!s || typeof s !== 'string') return '...'
  if (s.length <= 12) return s
  return s.slice(0, 8) + '...' + s.slice(-4)
}

const s = {
  screen: { padding: 16, paddingBottom: 64, color: '#eee', background: '#111', minHeight: '100vh', fontFamily: '-apple-system, system-ui, Roboto, sans-serif', boxSizing: 'border-box' },
  header: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 },
  h1: { fontSize: 24, margin: 0, flex: 1, fontWeight: 600 },
  h2: { fontSize: 18, margin: '24px 0 8px 0', fontWeight: 600 },
  h3: { fontSize: 16, margin: '20px 0 8px 0', fontWeight: 600, color: '#bbb' },
  idLine: { color: '#888', margin: '4px 0 16px 0', fontSize: 13, fontFamily: 'monospace' },
  profileBtn: { display: 'flex', alignItems: 'baseline', gap: 6, width: '100%', padding: '10px 12px', margin: '4px 0 16px 0', background: '#1c1c1c', border: '1px solid #2a2a2a', borderRadius: 8, color: '#eee', textAlign: 'left', cursor: 'pointer', fontSize: 13 },
  idName: { color: '#eee', fontFamily: '-apple-system, system-ui, Roboto, sans-serif', fontWeight: 600, fontSize: 14 },
  idNeedName: { color: '#7ec4cf', fontFamily: '-apple-system, system-ui, Roboto, sans-serif', fontWeight: 600, fontSize: 14 },
  idMuted: { color: '#888', fontFamily: 'monospace' },
  actions: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 },
  primaryBtn: { width: '100%', padding: '14px 16px', background: '#7ec4cf', color: '#0a1f23', border: 'none', borderRadius: 10, fontSize: 16, fontWeight: 600, cursor: 'pointer' },
  secondaryBtn: { width: '100%', padding: '14px 16px', background: '#222', color: '#eee', border: '1px solid #333', borderRadius: 10, fontSize: 16, fontWeight: 500, cursor: 'pointer', marginTop: 8 },
  iconBtn: { width: 32, height: 32, padding: 0, background: 'none', color: '#ccc', border: 'none', fontSize: 22, cursor: 'pointer' },
  circleList: { listStyle: 'none', padding: 0, margin: 0 },
  circleItem: { padding: 14, background: '#1c1c1c', borderRadius: 10, marginBottom: 8, cursor: 'pointer' },
  circleName: { fontSize: 16, fontWeight: 600 },
  circleMeta: { fontSize: 12, color: '#888', marginTop: 2, fontFamily: 'monospace' },
  label: { fontSize: 13, color: '#aaa', display: 'block', marginBottom: 6, marginTop: 8 },
  input: { width: '100%', padding: 12, background: '#1c1c1c', color: '#eee', border: '1px solid #333', borderRadius: 8, fontSize: 16, marginBottom: 16, boxSizing: 'border-box' },
  textarea: { width: '100%', padding: 12, background: '#1c1c1c', color: '#eee', border: '1px solid #333', borderRadius: 8, fontSize: 14, fontFamily: 'monospace', resize: 'vertical', marginBottom: 16, boxSizing: 'border-box' },
  inviteBox: { width: '100%', padding: 12, background: '#1c1c1c', color: '#9cf', border: '1px solid #333', borderRadius: 8, fontSize: 12, fontFamily: 'monospace', resize: 'vertical', marginBottom: 12, minHeight: 80, boxSizing: 'border-box' },
  muted: { color: '#888', fontSize: 14 },
  error: { color: '#f77', marginTop: 8, fontSize: 14 },
  section: { background: '#1c1c1c', padding: 12, borderRadius: 10, marginBottom: 12 },
  row: { display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 14 },
  memberList: { listStyle: 'none', padding: 0, margin: 0 },
  memberItem: { padding: 12, background: '#1c1c1c', borderRadius: 10, marginBottom: 8 },
  memberName: { fontSize: 15, fontWeight: 500 },
  lastSeen: { fontSize: 12, color: '#9cf', marginTop: 4, fontFamily: 'monospace' },
  lastSeenMuted: { fontSize: 12, color: '#555', marginTop: 4, fontStyle: 'italic' },
}
