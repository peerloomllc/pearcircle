import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import maplibregl from 'maplibre-gl'
import maplibreCss from 'maplibre-gl/dist/maplibre-gl.css'
import QRCode from 'qrcode'

// Lazy proxy: window.pear is installed by main.jsx but App.jsx is imported
// before that assignment runs. Resolve through window at call time.
const pear = {
  call: (...args) => window.pear.call(...args),
  on: (...args) => window.pear.on(...args),
}

// Inject MapLibre's stylesheet exactly once per page. esbuild's
// --loader:.css=text drops the CSS into the JS bundle as a string so we
// can stamp it into a <style> tag at runtime - we have no separate CSS
// pipeline.
let _mapLibreCssInjected = false
function ensureMapLibreCss () {
  if (_mapLibreCssInjected) return
  const styleEl = document.createElement('style')
  styleEl.textContent = maplibreCss
  document.head.appendChild(styleEl)
  _mapLibreCssInjected = true
}

// OpenFreeMap is a free, key-less, OSM-based MapLibre style. Swap to
// Protomaps in a follow-up slice once we have an API key (TODO.md).
const TILE_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty'

export function App () {
  const [view, setView] = useState({ name: 'home' })
  const [identity, setIdentity] = useState(null)
  const [profile, setProfile] = useState(null)

  const refresh = useCallback(async () => {
    const [id, pr] = await Promise.all([
      pear.call('identity:get'),
      pear.call('profile:get'),
    ])
    setIdentity(id)
    setProfile(pr ?? null)
  }, [])

  useEffect(() => {
    refresh()
    pear.on('ready', refresh)
    pear.on('deeplink:invite', ({ url }) => {
      if (typeof url === 'string') setView({ name: 'join', invite: url })
    })
  }, [refresh])

  if (view.name === 'home') {
    return (
      <HomeMapView
        key={view.selectCircle ?? 'all'}
        identity={identity}
        profile={profile}
        setView={setView}
        initialSelectedCircleId={view.selectCircle ?? null}
      />
    )
  }
  if (view.name === 'create') {
    return <CreateView setView={setView} onCreated={refresh} />
  }
  if (view.name === 'join') {
    return <JoinView setView={setView} onJoined={refresh} initialInvite={view.invite} />
  }
  if (view.name === 'profile') {
    return <ProfileView profile={profile} setView={setView} onSaved={refresh} />
  }
  return null
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
        <BackBar onBack={() => setView({ name: 'home', selectCircle: result.circleId })} title={result.name} />
        <p style={s.muted}>Circle created. Share the QR code or paste the link:</p>
        <QrImage text={result.invite} />
        <textarea style={s.inviteBox} readOnly value={result.invite} onFocus={(e) => e.target.select()} />
        <ShareButton text={result.invite} />
        <button style={s.primaryBtn} onClick={() => setView({ name: 'home', selectCircle: result.circleId })}>Done</button>
      </div>
    )
  }

  return (
    <div style={s.screen}>
      <BackBar onBack={() => setView({ name: 'home' })} title='New circle' />
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
  const [error, setError] = useState(null)

  const onScan = async () => {
    setError(null)
    try {
      const text = await pear.call('shell:scanQr')
      if (typeof text === 'string' && text.length > 0) setInvite(text)
    } catch (err) {
      setError('Scan failed: ' + (err?.message ?? err))
    }
  }

  const submit = async () => {
    if (!invite.trim()) return
    setJoining(true)
    setError(null)
    try {
      const r = await pear.call('circle:join', { invite: invite.trim() })
      setJoining(false)
      if (r?.circleId) {
        // Route straight back to the map with the newly joined circle
        // pre-selected as the dropdown filter so the title bar and map
        // immediately reflect the join. onJoined refreshes App-level
        // state; HomeMapView's own circles:getAll picks up the new
        // circle on mount.
        onJoined()
        setView({ name: 'home', selectCircle: r.circleId })
      } else {
        setError('Invalid invite')
      }
    } catch (e) {
      setJoining(false)
      setError(String(e?.message ?? e))
    }
  }

  return (
    <div style={s.screen}>
      <BackBar onBack={() => setView({ name: 'home' })} title='Join a circle' />
      <label style={s.label}>Paste invite link</label>
      <textarea
        style={s.textarea}
        value={invite}
        onChange={(e) => setInvite(e.target.value)}
        placeholder='https://peerloomllc.com/circle/join?...'
        rows={4}
      />
      <button style={s.secondaryBtn} onClick={onScan}>
        Scan QR code
      </button>
      <button style={s.primaryBtn} disabled={!invite.trim() || joining} onClick={submit}>
        {joining ? 'Joining...' : 'Join'}
      </button>
      {error && <p style={s.error}>{error}</p>}
    </div>
  )
}

// Merge per-circle snapshots into one view-model. Members are deduped by
// pubkey (keep the row with the latest joinedAt); lastSeen by pubkey too
// (newest ts wins). Places carry their circleId so per-place actions
// (fire transition, future delete) know where to write. Transitions are
// flattened across circles and sorted desc by ts for the latest-per-
// pubkey lookup.
function mergeCircleSnapshots (circles) {
  const memberMap = new Map()
  const lastSeen = {}
  const places = []
  const transitions = []
  for (const c of circles ?? []) {
    if (!c || c.error) continue
    for (const m of c.members ?? []) {
      const pubkey = m.value?.pubkey
      if (!pubkey) continue
      const existing = memberMap.get(pubkey)
      const incomingJoinedAt = m.value?.joinedAt ?? 0
      const existingJoinedAt = existing?.value?.joinedAt ?? 0
      if (!existing || incomingJoinedAt > existingJoinedAt) memberMap.set(pubkey, m)
    }
    for (const [pubkey, seen] of Object.entries(c.lastSeen ?? {})) {
      const existing = lastSeen[pubkey]
      if (!existing || (seen?.ts ?? 0) > (existing?.ts ?? 0)) lastSeen[pubkey] = seen
    }
    for (const p of c.places ?? []) places.push({ ...p, circleId: c.circleId })
    for (const t of c.transitions ?? []) transitions.push({ ...t, circleId: c.circleId })
  }
  transitions.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
  return { members: Array.from(memberMap.values()), lastSeen, places, transitions }
}

function HomeMapView ({ identity, profile, setView, initialSelectedCircleId = null }) {
  const [circles, setCircles] = useState([])
  const [selfSeen, setSelfSeen] = useState(null)
  const [peerCount, setPeerCount] = useState(0)
  const [selectedCircleId, setSelectedCircleId] = useState(initialSelectedCircleId) // null = All
  const [selectedPubkey, setSelectedPubkey] = useState(null) // null = auto-fit-everyone view
  const [sheetOpen, setSheetOpen] = useState(false)
  const [showAddPlace, setShowAddPlace] = useState(false)
  const [editingPlace, setEditingPlace] = useState(null) // { circleId, id, name, radiusMeters } or null
  const [transitionError, setTransitionError] = useState(null)
  const [claiming, setClaiming] = useState(false)
  const [claimError, setClaimError] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const mapApiRef = useRef(null)

  const refresh = useCallback(async () => {
    try {
      const [all, peersResp] = await Promise.all([
        pear.call('circles:getAll'),
        pear.call('circles:peers'),
      ])
      setCircles(all?.circles ?? [])
      setSelfSeen(all?.selfLastSeen ?? null)
      const sets = peersResp?.peers ?? {}
      let total = 0
      for (const k of Object.keys(sets)) total += sets[k]?.length ?? 0
      setPeerCount(total)
    } catch {}
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 3000)
    pear.on('peer:connected', refresh)
    pear.on('peer:disconnected', refresh)
    pear.on('circle:writer:added', refresh)
    pear.on('ready', refresh)
    return () => clearInterval(id)
  }, [refresh])

  // If a circle the user filtered to gets removed (left), drop the filter.
  useEffect(() => {
    if (!selectedCircleId) return
    if (!circles.some(c => c.circleId === selectedCircleId)) setSelectedCircleId(null)
  }, [circles, selectedCircleId])

  // If the focused member disappears from the active set (circle filter
  // changed, member left), drop focus so we don't strand a top bar
  // pointing at no one.
  useEffect(() => {
    if (!selectedPubkey) return
    const active = selectedCircleId
      ? circles.filter(c => c.circleId === selectedCircleId)
      : circles
    const present = active.some(c =>
      (c.members ?? []).some(m => m.value?.pubkey === selectedPubkey),
    ) || selectedPubkey === identity?.publicKey
    if (!present) setSelectedPubkey(null)
  }, [circles, selectedCircleId, selectedPubkey, identity])

  // Pick the active subset based on the current filter.
  const activeCircles = selectedCircleId
    ? circles.filter(c => c.circleId === selectedCircleId)
    : circles
  const merged = mergeCircleSnapshots(activeCircles)

  // Inject self into the map even when the user has no circles yet
  // (zero-circle empty state) or hasn't appeared in any circle's lastSeen
  // yet, so the map is never blank.
  const myPubkey = identity?.publicKey
  const data = useMemo(() => {
    const out = { ...merged, lastSeen: { ...merged.lastSeen } }
    if (myPubkey && selfSeen && !out.lastSeen[myPubkey]) {
      out.lastSeen[myPubkey] = selfSeen
    }
    if (myPubkey && !out.members.some(m => m.value?.pubkey === myPubkey)) {
      out.members.push({
        key: 'member:' + myPubkey,
        value: {
          pubkey: myPubkey,
          displayName: profile?.displayName ?? 'You',
          avatar: profile?.avatar ?? null,
          joinedAt: 0,
        },
      })
    }
    return out
  }, [merged, myPubkey, selfSeen, profile])

  const placesById = {}
  for (const p of data.places ?? []) placesById[p.id] = p

  const latestTransition = {}
  for (const t of data.transitions ?? []) {
    if (t?.pubkey && !latestTransition[t.pubkey]) latestTransition[t.pubkey] = t
  }

  const memberCount = data.members.length
  const placeCount = data.places.length
  const isSingleCircle = activeCircles.length === 1
  // Where to write per-place / per-circle actions. With "All" selected
  // and multiple circles we don't have a single target, so write
  // actions are hidden until the user filters down.
  const actionTargetCircleId = isSingleCircle ? activeCircles[0]?.circleId : null
  const actionTargetWritable = isSingleCircle ? !!activeCircles[0]?.writable : false

  const fireTransition = useCallback(async (place, kind) => {
    setTransitionError(null)
    try {
      const seen = myPubkey ? data?.lastSeen?.[myPubkey] : null
      // Each place carries its own circleId from the merge step, so
      // transitions land on the right autobase even in "All" mode.
      await pear.call('geofence:transition', {
        circleId: place.circleId,
        placeId: place.id,
        kind,
        lat: seen?.lat ?? place.lat,
        lon: seen?.lon ?? place.lon,
      })
      await refresh()
    } catch (e) {
      setTransitionError(String(e?.message ?? e))
    }
  }, [data, myPubkey, refresh])

  const claimMembership = async () => {
    if (!actionTargetCircleId) return
    setClaiming(true)
    setClaimError(null)
    try {
      await pear.call('circle:append:member', { circleId: actionTargetCircleId })
      await refresh()
    } catch (e) {
      setClaimError(String(e?.message ?? e))
    }
    setClaiming(false)
  }

  const focusMember = useCallback((pubkey) => {
    if (!pubkey) return
    setSelectedPubkey(pubkey)
    setMenuOpen(false)
    setSheetOpen(false)
    const seen = data.lastSeen?.[pubkey]
    if (seen) {
      mapApiRef.current?.flyTo({
        center: [seen.lon, seen.lat], zoom: 16, duration: 1100,
      })
    }
  }, [data])

  const clearFocus = useCallback(() => {
    setSelectedPubkey(null)
    mapApiRef.current?.fitAll()
  }, [])

  // Resolve the focused member's display fields from whichever circle
  // carries the freshest row. Falls back to "you" when the user has
  // focused themselves but no circle row exists yet.
  const selectedMember = (() => {
    if (!selectedPubkey) return null
    const m = data.members.find(x => x.value?.pubkey === selectedPubkey)
    const seen = data.lastSeen?.[selectedPubkey]
    return {
      pubkey: selectedPubkey,
      displayName: m?.value?.displayName ?? (selectedPubkey === myPubkey ? 'You' : short(selectedPubkey)),
      avatar: m?.value?.avatar,
      seen,
    }
  })()

  // Title is the current filter label.
  const filterLabel = selectedCircleId
    ? (activeCircles[0]?.circle?.name ?? '...')
    : (circles.length === 0 ? 'PearCircle' : circles.length === 1 ? (circles[0]?.circle?.name ?? '...') : 'All circles')

  return (
    <div style={s.mapFirstRoot}>
      <div style={s.mapFill}>
        <CircleMap
          ref={mapApiRef}
          data={data}
          selectedPubkey={selectedPubkey}
          onMemberClick={focusMember}
        />
      </div>

      <header style={s.mapTopBar}>
        {selectedMember ? (
          <>
            <button
              type='button'
              style={s.iconBtn}
              onClick={clearFocus}
              aria-label='Back to all'
            >‹</button>
            <Avatar base64={selectedMember.avatar} label={selectedMember.displayName} size={32} />
            <div style={s.focusTextCol}>
              <div style={s.focusName}>{selectedMember.displayName}</div>
              <div style={s.focusSub}>
                {selectedMember.seen
                  ? 'updated ' + ageLabel(selectedMember.seen.ts)
                  : 'no location yet'}
              </div>
            </div>
          </>
        ) : (
          <button
            type='button'
            style={s.dropdownBtn}
            onClick={() => setMenuOpen((m) => !m)}
          >
            <span style={s.dropdownLabel}>{filterLabel}</span>
            <span style={s.dropdownChevron}>{menuOpen ? '▴' : '▾'}</span>
          </button>
        )}
        <span style={s.peerBadge}>
          <span style={{ ...s.peerDot, background: peerCount > 0 ? '#7ec77a' : '#555' }} />
          {peerCount}
        </span>
        <button
          type='button'
          style={s.avatarBtn}
          onClick={() => setView({ name: 'profile' })}
          aria-label='Profile'
        >
          <Avatar base64={profile?.avatar} label={profile?.displayName ?? '?'} size={32} />
        </button>
      </header>

      {menuOpen && !selectedMember && (
        <>
          <div style={s.menuScrim} onClick={() => setMenuOpen(false)} />
          <div style={s.menu}>
            {circles.length > 1 && (
              <button
                style={{ ...s.menuItem, ...(selectedCircleId === null ? s.menuItemActive : null) }}
                onClick={() => { setSelectedCircleId(null); setMenuOpen(false) }}
              >
                All circles
              </button>
            )}
            {circles.map((c) => (
              <button
                key={c.circleId}
                style={{ ...s.menuItem, ...(selectedCircleId === c.circleId ? s.menuItemActive : null) }}
                onClick={() => { setSelectedCircleId(c.circleId); setMenuOpen(false) }}
              >
                {c.circle?.name ?? '...'}
              </button>
            ))}
            {circles.length > 0 && <div style={s.menuDivider} />}
            <button
              style={s.menuItem}
              onClick={() => { setMenuOpen(false); setView({ name: 'create' }) }}
            >
              + Create circle
            </button>
            <button
              style={s.menuItem}
              onClick={() => { setMenuOpen(false); setView({ name: 'join' }) }}
            >
              + Join via link
            </button>
          </div>
        </>
      )}

      {circles.length === 0 ? (
        <div style={s.emptyHint}>
          You're not in any circles yet. Use the menu above to create one or join via an invite link.
        </div>
      ) : (
        <button style={s.fab} onClick={() => setSheetOpen(true)}>
          Members ({memberCount}) · Places ({placeCount})
        </button>
      )}

      {sheetOpen && (
        <BottomSheet onClose={() => setSheetOpen(false)}>
          <h3 style={s.h3}>Members ({memberCount})</h3>
          {memberCount === 0 ? (
            <p style={s.muted}>No members visible yet. Waiting for sync...</p>
          ) : (
            <ul style={s.memberList}>
              {data.members.map(m => {
                const pubkey = m.value?.pubkey ?? ''
                const displayName = m.value?.displayName ?? short(pubkey)
                const seen = data.lastSeen?.[pubkey]
                const t = latestTransition?.[pubkey]
                const tPlaceName = t ? placesById?.[t.placeId]?.name : null
                const focusable = !!seen
                return (
                  <li
                    key={m.key}
                    style={{ ...s.memberItem, cursor: focusable ? 'pointer' : 'default' }}
                    onClick={focusable ? () => focusMember(pubkey) : undefined}
                  >
                    <div style={s.memberRow}>
                      <Avatar base64={m.value?.avatar} label={displayName} size={36} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={s.memberName}>{displayName}</div>
                        {t ? (
                          <div style={s.status}>
                            {t.kind === 'enter' ? 'arrived at ' : 'left '}
                            {tPlaceName ?? '(unknown place)'}
                            {' · '}{ageLabel(t.ts)}
                          </div>
                        ) : seen ? (
                          <div style={s.lastSeen}>updated {ageLabel(seen.ts)}</div>
                        ) : (
                          <div style={s.lastSeenMuted}>no location yet</div>
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          <h3 style={s.h3}>Places ({placeCount})</h3>
          {placeCount === 0 ? (
            <p style={s.muted}>No places yet.</p>
          ) : (
            <ul style={s.memberList}>
              {data.places.map(p => {
                const placeCircle = circles.find(c => c.circleId === p.circleId)
                const placeWritable = !!placeCircle?.writable
                const focusOn = (e) => {
                  // Don't trigger if a debug button inside the row was tapped.
                  if (e.target.closest('button')) return
                  // Imperative call: avoids any state-batching weirdness
                  // around the same-render BottomSheet unmount.
                  mapApiRef.current?.flyTo({
                    center: [p.lon, p.lat], zoom: 16, duration: 1100,
                  })
                  setSheetOpen(false)
                }
                return (
                  <li key={p.circleId + ':' + p.id} style={{ ...s.memberItem, cursor: 'pointer' }} onClick={focusOn}>
                    <div style={s.placeRowHeader}>
                      <div style={s.memberName}>{p.name}</div>
                      {placeWritable && (
                        <button
                          style={{ ...s.smallBtn, flex: 'none', padding: '6px 12px' }}
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditingPlace({
                              circleId: p.circleId,
                              id: p.id,
                              name: p.name,
                              radiusMeters: p.radiusMeters,
                            })
                            setShowAddPlace(false)
                          }}
                        >
                          Edit
                        </button>
                      )}
                    </div>
                    <div style={s.placeRadiusLine}>{Math.round(p.radiusMeters)}m radius</div>
                    {placeWritable && (
                      <div style={s.transitionBtns}>
                        <button style={s.smallBtn} onClick={() => fireTransition(p, 'enter')}>
                          Fire enter (debug)
                        </button>
                        <button style={s.smallBtn} onClick={() => fireTransition(p, 'exit')}>
                          Fire exit (debug)
                        </button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {transitionError && <p style={s.error}>{transitionError}</p>}

          {editingPlace && (
            <EditPlaceForm
              key={editingPlace.circleId + ':' + editingPlace.id}
              initial={editingPlace}
              onCancel={() => setEditingPlace(null)}
              onSaved={async () => { setEditingPlace(null); await refresh() }}
            />
          )}
          {!editingPlace && actionTargetCircleId && actionTargetWritable && !showAddPlace && (
            <button style={s.secondaryBtn} onClick={() => setShowAddPlace(true)}>
              Add a place
            </button>
          )}
          {!editingPlace && actionTargetCircleId && actionTargetWritable && showAddPlace && (
            <AddPlaceForm
              circleId={actionTargetCircleId}
              myLastSeen={myPubkey ? data.lastSeen?.[myPubkey] : null}
              onCancel={() => setShowAddPlace(false)}
              onAdded={async () => { setShowAddPlace(false); await refresh() }}
            />
          )}
          {!actionTargetCircleId && circles.length > 1 && (
            <p style={s.muted}>Pick a single circle from the menu above to add a place or post your membership.</p>
          )}

          {actionTargetCircleId && actionTargetWritable && (
            <button style={s.primaryBtn} disabled={claiming} onClick={claimMembership}>
              {claiming ? 'Posting...' : 'Post my membership'}
            </button>
          )}
          {claimError && <p style={s.error}>{claimError}</p>}
          {actionTargetCircleId && !actionTargetWritable && (
            <p style={s.muted}>Read-only until owner adds you as a writer.</p>
          )}
        </BottomSheet>
      )}
    </div>
  )
}

function EditPlaceForm ({ initial, onCancel, onSaved }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [radius, setRadius] = useState(initial?.radiusMeters != null ? String(initial.radiusMeters) : '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const submit = async () => {
    setError(null)
    const radNum = parseFloat(radius)
    if (!name.trim()) { setError('Name is required'); return }
    if (!Number.isFinite(radNum) || radNum < 10 || radNum > 10000) { setError('Radius must be between 10 and 10000 metres'); return }
    setSubmitting(true)
    try {
      const r = await pear.call('place:update', {
        circleId: initial.circleId,
        placeId: initial.id,
        name: name.trim(),
        radiusMeters: radNum,
      })
      setSubmitting(false)
      if (r?.ok) onSaved()
      else setError('Could not save place')
    } catch (e) {
      setSubmitting(false)
      setError(String(e?.message ?? e))
    }
  }

  return (
    <div style={s.section}>
      <h3 style={{ ...s.h3, margin: '0 0 8px 0' }}>Edit place</h3>
      <label style={s.label}>Name</label>
      <input style={s.input} value={name} onChange={(e) => setName(e.target.value)} placeholder='Home' maxLength={64} autoFocus />
      <label style={s.label}>Radius (metres)</label>
      <input style={s.input} value={radius} onChange={(e) => setRadius(e.target.value)} inputMode='numeric' placeholder='100' />
      <button style={s.primaryBtn} disabled={submitting} onClick={submit}>
        {submitting ? 'Saving...' : 'Save changes'}
      </button>
      <button style={s.secondaryBtn} onClick={onCancel}>Cancel</button>
      {error && <p style={s.error}>{error}</p>}
    </div>
  )
}

function AddPlaceForm ({ circleId, myLastSeen, onCancel, onAdded }) {
  const [name, setName] = useState('')
  const [lat, setLat] = useState('')
  const [lon, setLon] = useState('')
  const [radius, setRadius] = useState('100')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const useCurrent = () => {
    if (myLastSeen?.lat != null && myLastSeen?.lon != null) {
      setLat(String(myLastSeen.lat))
      setLon(String(myLastSeen.lon))
    } else {
      setError('No current location yet — wait for a location update or enter manually.')
    }
  }

  const submit = async () => {
    setError(null)
    const latNum = parseFloat(lat)
    const lonNum = parseFloat(lon)
    const radNum = parseFloat(radius)
    if (!name.trim()) { setError('Name is required'); return }
    if (!Number.isFinite(latNum) || latNum < -90 || latNum > 90) { setError('Latitude must be between -90 and 90'); return }
    if (!Number.isFinite(lonNum) || lonNum < -180 || lonNum > 180) { setError('Longitude must be between -180 and 180'); return }
    if (!Number.isFinite(radNum) || radNum < 10 || radNum > 10000) { setError('Radius must be between 10 and 10000 metres'); return }
    setSubmitting(true)
    try {
      const r = await pear.call('place:create', {
        circleId,
        name: name.trim(),
        lat: latNum,
        lon: lonNum,
        radiusMeters: radNum,
      })
      setSubmitting(false)
      if (r?.ok) onAdded()
      else setError('Could not save place')
    } catch (e) {
      setSubmitting(false)
      setError(String(e?.message ?? e))
    }
  }

  return (
    <div style={s.section}>
      <label style={s.label}>Name</label>
      <input style={s.input} value={name} onChange={(e) => setName(e.target.value)} placeholder='Home' maxLength={64} />
      <label style={s.label}>Radius (metres)</label>
      <input style={s.input} value={radius} onChange={(e) => setRadius(e.target.value)} inputMode='numeric' placeholder='100' />
      <label style={s.label}>Latitude</label>
      <input style={s.input} value={lat} onChange={(e) => setLat(e.target.value)} inputMode='decimal' placeholder='37.42342' />
      <label style={s.label}>Longitude</label>
      <input style={s.input} value={lon} onChange={(e) => setLon(e.target.value)} inputMode='decimal' placeholder='-122.08453' />
      <button style={s.secondaryBtn} onClick={useCurrent}>Use my current location</button>
      <button style={s.primaryBtn} disabled={submitting} onClick={submit}>
        {submitting ? 'Saving...' : 'Save place'}
      </button>
      <button style={s.secondaryBtn} onClick={onCancel}>Cancel</button>
      {error && <p style={s.error}>{error}</p>}
    </div>
  )
}

// Approximate a geofence circle as a 64-vertex polygon in lat/lon space.
// Earth-as-sphere math is fine for radii up to a few km; the polygon
// would distort visibly at very high latitudes, but PearCircle places
// are home/work/park sized, not continental.
function circlePolygon (lat, lon, radiusMeters, steps = 64) {
  const dLat = radiusMeters / 111320
  const dLon = radiusMeters / (111320 * Math.cos(lat * Math.PI / 180))
  const ring = []
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * 2 * Math.PI
    ring.push([lon + dLon * Math.sin(a), lat + dLat * Math.cos(a)])
  }
  ring.push(ring[0])
  return ring
}

const CircleMap = React.forwardRef(function CircleMap (
  { data, selectedPubkey, onMemberClick },
  apiRef,
) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const fittedRef = useRef(false)
  const dataRef = useRef(data)
  const onMemberClickRef = useRef(onMemberClick)
  const markersRef = useRef(new Map())
  const [mapReadyTick, setMapReadyTick] = useState(0)

  // Keep refs current so the layer click handler (registered once on
  // load) and the imperative fitAll always see the latest props.
  useEffect(() => { onMemberClickRef.current = onMemberClick }, [onMemberClick])
  useEffect(() => { dataRef.current = data }, [data])

  // Expose imperative flyTo/fitAll to the parent. Direct camera moves
  // avoid state/effect round-trips that could be batched or dropped.
  React.useImperativeHandle(apiRef, () => ({
    flyTo: (opts) => {
      const m = mapRef.current
      if (!m) return
      // Reset bearing/pitch on every auto-camera move so the user
      // always lands north-up after focusing a member or place. The
      // spread lets callers override if a future feature wants to
      // preserve the current orientation.
      const full = { bearing: 0, pitch: 0, ...opts }
      try { m.flyTo(full) } catch { try { m.jumpTo({ center: full.center, zoom: full.zoom, bearing: 0, pitch: 0 }) } catch {} }
    },
    fitAll: () => {
      const m = mapRef.current
      const d = dataRef.current
      if (!m || !d) return
      const coords = []
      for (const mem of d.members ?? []) {
        const pubkey = mem.value?.pubkey
        const seen = pubkey ? d.lastSeen?.[pubkey] : null
        if (seen) coords.push([seen.lon, seen.lat])
      }
      if (coords.length > 0) fitTo(m, coords)
      else if (d.places?.length > 0) fitTo(m, d.places.map(p => [p.lon, p.lat]))
    },
  }), [])

  // One-time map init. Sources/layers are added on the 'load' event so
  // setData calls in the data-sync effect below always find them.
  useEffect(() => {
    ensureMapLibreCss()
    if (!containerRef.current) return

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: TILE_STYLE_URL,
      center: [0, 0],
      zoom: 1.5,
      attributionControl: false,
    })
    mapRef.current = map

    map.on('load', () => {
      map.addSource('places', { type: 'geojson', data: emptyFC() })
      // Place geofences only render at neighborhood-or-closer zoom.
      // Below that, a fixed-size pin is much larger than the place's
      // pixel radius, which made the pin look like it had drifted
      // outside the place. Fading the geofence out keeps the pin (the
      // persistent "where is X" indicator) the only thing the user
      // sees at city/country zoom; the geofence reappears as you zoom
      // back in to street level.
      map.addLayer({
        id: 'places-fill', type: 'fill', source: 'places',
        paint: {
          'fill-color': '#7ec4cf',
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0, 14, 0.18],
        },
      })
      map.addLayer({
        id: 'places-stroke', type: 'line', source: 'places',
        paint: {
          'line-color': '#7ec4cf',
          'line-width': 2,
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0, 14, 1],
        },
      })
      // Member pins are HTML markers (pear bubbles with avatar inside),
      // managed in the data-sync effect below. Markers handle their own
      // click events.
      setMapReadyTick(t => t + 1)
    })

    return () => {
      for (const m of markersRef.current.values()) m.remove()
      markersRef.current.clear()
      map.remove()
    }
  }, [])

  // Sync features and member markers whenever data or selection
  // changes. Wait for the style to finish loading on the first call.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !data) return
    const apply = () => {
      syncFeatures(map, data, fittedRef)
      syncMembers(map, data, selectedPubkey, markersRef.current, onMemberClickRef)
    }
    if (map.isStyleLoaded()) apply()
    else map.once('load', apply)
  }, [data, selectedPubkey])

  return (
    <div style={s.mapWrap}>
      <div ref={containerRef} style={s.mapCanvas} />
      <EdgeIndicators
        map={mapRef.current}
        ready={mapReadyTick > 0}
        members={data?.members ?? []}
        lastSeen={data?.lastSeen ?? {}}
        selectedPubkey={selectedPubkey}
        onSelect={onMemberClick}
      />
      <div style={s.mapAttribution}>© OpenStreetMap contributors</div>
    </div>
  )
})

// Off-screen members get a clamped avatar pinned to the viewport edge
// with a small arrow pointing outward in their direction. Subscribes to
// the map's move/zoom/resize events so positions track the camera.
// Top inset clears the floating top bar; bottom inset clears the FAB.
function EdgeIndicators ({ map, ready, members, lastSeen, selectedPubkey, onSelect }) {
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!map || !ready) return
    const rerender = () => setTick(t => (t + 1) % 1_000_000)
    map.on('move', rerender)
    map.on('zoom', rerender)
    map.on('resize', rerender)
    rerender()
    return () => {
      map.off('move', rerender)
      map.off('zoom', rerender)
      map.off('resize', rerender)
    }
  }, [map, ready])

  if (!map || !ready) return null
  const canvas = map.getCanvas()
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w === 0 || h === 0) return null

  const TOP = 80
  const BOTTOM = 96
  const SIDE = 32
  const cx = w / 2
  const cy = (TOP + (h - BOTTOM)) / 2
  const halfW = w / 2 - SIDE
  const halfH = (h - TOP - BOTTOM) / 2
  if (halfW <= 0 || halfH <= 0) return null

  const indicators = []
  for (const m of members) {
    const pubkey = m.value?.pubkey
    if (!pubkey) continue
    const seen = lastSeen?.[pubkey]
    if (!seen) continue
    let p
    try { p = map.project([seen.lon, seen.lat]) } catch { continue }
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    const onScreen = p.x >= SIDE && p.x <= w - SIDE && p.y >= TOP && p.y <= h - BOTTOM
    if (onScreen) continue

    const dx = p.x - cx
    const dy = p.y - cy
    if (dx === 0 && dy === 0) continue
    const t = Math.min(halfW / Math.max(Math.abs(dx), 1e-6), halfH / Math.max(Math.abs(dy), 1e-6))
    const ex = cx + dx * t
    const ey = cy + dy * t
    const angle = Math.atan2(dy, dx) * 180 / Math.PI
    indicators.push({
      pubkey,
      name: m.value?.displayName ?? short(pubkey),
      avatar: m.value?.avatar,
      x: ex, y: ey, angle,
      selected: pubkey === selectedPubkey,
    })
  }

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 4 }}>
      {indicators.map(i => (
        <button
          key={i.pubkey}
          onClick={() => onSelect?.(i.pubkey)}
          style={{
            position: 'absolute',
            left: i.x - 22, top: i.y - 22,
            width: 44, height: 44,
            border: 'none', padding: 0, background: 'transparent',
            pointerEvents: 'auto', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          aria-label={'Focus ' + i.name}
        >
          <div style={{
            width: 32, height: 32, borderRadius: '50%',
            border: '2px solid ' + (i.selected ? '#7ec4cf' : '#fc7'),
            boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
            background: '#1a1a1a',
            overflow: 'hidden',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Avatar base64={i.avatar} label={i.name} size={28} />
          </div>
          <div style={{
            position: 'absolute',
            // Place the arrow's base (its transform-origin at local 0,5)
            // 18px from button center in the angle direction, so the
            // notch sits just outside the 32px avatar ring.
            left: 22 + Math.cos(i.angle * Math.PI / 180) * 18,
            top: 17 + Math.sin(i.angle * Math.PI / 180) * 18,
            width: 0, height: 0,
            borderLeft: '7px solid ' + (i.selected ? '#7ec4cf' : '#fc7'),
            borderTop: '5px solid transparent',
            borderBottom: '5px solid transparent',
            transform: `rotate(${i.angle}deg)`,
            transformOrigin: '0 5px',
          }} />
        </button>
      ))}
    </div>
  )
}

function emptyFC () {
  return { type: 'FeatureCollection', features: [] }
}

function syncFeatures (map, data, fittedRef) {
  const placeFeatures = (data.places ?? []).map(p => ({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [circlePolygon(p.lat, p.lon, p.radiusMeters)] },
    properties: { name: p.name },
  }))
  map.getSource('places')?.setData({ type: 'FeatureCollection', features: placeFeatures })

  if (fittedRef.current) return
  // Fit to where the people are. Including places in the bounds drags
  // the view to anywhere a stale or far-away test place was set; the
  // map should center on members so "where is everyone" is the default
  // glance. Users can pan to see distant places. If no members have a
  // location yet, fall back to places so we at least show something
  // useful instead of a globe view.
  const memberCoords = []
  for (const m of data.members ?? []) {
    const pubkey = m.value?.pubkey
    const seen = pubkey ? data.lastSeen?.[pubkey] : null
    if (seen) memberCoords.push([seen.lon, seen.lat])
  }
  if (memberCoords.length > 0) {
    fittedRef.current = true
    fitTo(map, memberCoords)
  } else if (data.places && data.places.length > 0) {
    fittedRef.current = true
    fitTo(map, data.places.map(p => [p.lon, p.lat]))
  }
}

function escapeHtml (s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

function buildBubbleElement (clickRef) {
  const root = document.createElement('div')
  // MapLibre owns the transform that places the marker at the
  // projected lat/lon (set on every move/zoom event). The element
  // must be position: absolute with top/left at the canvas-container
  // origin so the transform offsets from (0, 0). MapLibre's
  // .maplibregl-marker CSS class sets these, but explicit inline
  // styles guard against CSS-load timing (and also override anything
  // the WebView's user-agent sheet might inject for divs).
  root.style.position = 'absolute'
  root.style.top = '0'
  root.style.left = '0'
  root.style.cursor = 'pointer'
  root.style.userSelect = 'none'
  root.style.webkitUserSelect = 'none'
  root.addEventListener('click', (e) => {
    e.stopPropagation()
    const pk = root.dataset.pubkey
    if (pk) clickRef.current?.(pk)
  })
  return root
}

// Circular avatar badge anchored at the lat/lon. We tried a pear /
// speech-bubble silhouette via inline SVG, an SVG positioned absolute
// inside the marker, an SVG sitting in normal flow, and an SVG used
// as a CSS background-image data URL. Every form caused a
// zoom-dependent southward drift in MapLibre Marker positioning. A
// plain div with the same dimensions and no SVG positions correctly
// at every zoom, so we ship the bubble as a flat circular badge: the
// avatar is the location indicator, with a colored ring for contrast
// and a drop-shadow for depth. Selected state grows the badge and
// swaps to a cyan ring with a glow halo.
function renderBubble (root, member, selected) {
  const pubkey = member.value?.pubkey ?? ''
  const size = selected ? 48 : 40
  const ring = selected ? 3 : 2
  const ringColor = selected ? '#7ec4cf' : '#1a1a1a'

  const avatar = member.value?.avatar
  const label = member.value?.displayName ?? '?'
  const inner = (typeof avatar === 'string' && avatar.length > 0)
    ? `<img src="data:image/jpeg;base64,${avatar}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;" />`
    : `<div style="width:100%;height:100%;background:#2a3a3f;color:#cfe;display:flex;align-items:center;justify-content:center;font-size:${Math.round(size * 0.42)}px;font-weight:600;font-family:system-ui;">${escapeHtml(initialsFor(label))}</div>`

  root.dataset.pubkey = pubkey
  root.style.width = size + 'px'
  root.style.height = size + 'px'
  root.style.borderRadius = '50%'
  root.style.overflow = 'hidden'
  root.style.boxSizing = 'border-box'
  root.style.border = `${ring}px solid ${ringColor}`
  root.style.background = '#fc7'
  root.style.filter = selected
    ? 'drop-shadow(0 0 10px rgba(126,196,207,0.7)) drop-shadow(0 2px 4px rgba(0,0,0,0.4))'
    : 'drop-shadow(0 2px 4px rgba(0,0,0,0.4))'
  root.innerHTML = inner
}

function syncMembers (map, data, selectedPubkey, markers, clickRef) {
  const seen = new Set()
  for (const m of data?.members ?? []) {
    const pubkey = m.value?.pubkey
    if (!pubkey) continue
    const last = data.lastSeen?.[pubkey]
    if (!last) continue
    seen.add(pubkey)

    let marker = markers.get(pubkey)
    if (!marker) {
      const el = buildBubbleElement(clickRef)
      marker = new maplibregl.Marker({ element: el, anchor: 'center' })
      marker.setLngLat([last.lon, last.lat]).addTo(map)
      markers.set(pubkey, marker)
    } else {
      marker.setLngLat([last.lon, last.lat])
    }
    renderBubble(marker.getElement(), m, pubkey === selectedPubkey)
  }

  for (const [pubkey, marker] of markers) {
    if (!seen.has(pubkey)) {
      marker.remove()
      markers.delete(pubkey)
    }
  }
}

function fitTo (map, lonLatPairs) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity
  for (const [lo, la] of lonLatPairs) {
    if (la < minLat) minLat = la; if (la > maxLat) maxLat = la
    if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo
  }
  if (!isFinite(minLat)) return
  // Use flyTo for a Life360-style cinematic descent: camera arcs up,
  // glides over, and settles. cameraForBounds gives us the destination
  // center/zoom; passing those to flyTo (rather than fitBounds with
  // animate: true) lets us tune the curve for the arc effect. Bearing
  // and pitch are reset so the auto-fit always settles north-up.
  const opts = { duration: 1400, curve: 1.42, essential: true, bearing: 0, pitch: 0 }
  if (minLat === maxLat && minLon === maxLon) {
    map.flyTo({ center: [minLon, minLat], zoom: 14, ...opts })
    return
  }
  const cam = map.cameraForBounds(
    [[minLon, minLat], [maxLon, maxLat]],
    { padding: 60, maxZoom: 16, bearing: 0 },
  )
  if (cam) map.flyTo({ center: cam.center, zoom: cam.zoom, ...opts })
}

function ProfileView ({ profile, setView, onSaved }) {
  const [name, setName] = useState(profile?.displayName ?? '')
  // null = unchanged from server; '' = explicitly cleared; string = new value
  const [avatar, setAvatar] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)
  const fileRef = useRef(null)

  const onPickFile = async (e) => {
    setError(null)
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    try {
      const dataUrl = await readFileDataUrl(file)
      const compressed = await compressToAvatar(dataUrl)
      // compressed is "data:image/jpeg;base64,..." — strip the prefix
      const comma = compressed.indexOf(',')
      const base64 = compressed.slice(comma + 1)
      if (base64.length > AVATAR_MAX_BASE64) {
        setError('Image is still too large after compression. Try a different photo.')
        return
      }
      setAvatar(base64)
    } catch (err) {
      setError('Could not load that image: ' + (err?.message ?? err))
    }
  }

  const submit = async () => {
    if (!name.trim()) return
    setSaving(true)
    setError(null)
    try {
      const args = { displayName: name.trim() }
      if (avatar !== null) args.avatar = avatar === '' ? null : avatar
      const r = await pear.call('profile:set', args)
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

  const previewBase64 = avatar !== null ? avatar : profile?.avatar
  const hasAvatar = typeof previewBase64 === 'string' && previewBase64.length > 0

  return (
    <div style={s.screen}>
      <BackBar onBack={() => setView({ name: 'home' })} title='Profile' />
      <div style={s.avatarRow}>
        <div style={s.avatarPreview}>
          {hasAvatar ? (
            <img src={'data:image/jpeg;base64,' + previewBase64} style={s.avatarImg} alt='Your avatar' />
          ) : (
            <span style={s.avatarFallback}>{initialsFor(name || profile?.displayName || '?')}</span>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
          <button style={s.secondaryBtn} onClick={() => fileRef.current?.click()}>
            {hasAvatar ? 'Change photo' : 'Choose photo'}
          </button>
          {hasAvatar && (
            <button style={s.secondaryBtn} onClick={() => setAvatar('')}>Remove photo</button>
          )}
          <input
            ref={fileRef}
            type='file'
            accept='image/*'
            style={{ display: 'none' }}
            onChange={onPickFile}
          />
        </div>
      </div>
      <label style={s.label}>Display name</label>
      <input
        style={s.input}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder='Your name'
        maxLength={64}
      />
      <button style={s.primaryBtn} disabled={!name.trim() || saving} onClick={submit}>
        {saving ? 'Saving...' : 'Save'}
      </button>
      {savedAt && <p style={s.muted}>Saved. Members in your circles will see the new profile shortly.</p>}
      {error && <p style={s.error}>{error}</p>}
    </div>
  )
}

// Roughly tracks bare's AVATAR_MAX_BASE64 so we surface the size error
// in the UI before the IPC call. Bare is the source of truth.
const AVATAR_MAX_BASE64 = 42000

function readFileDataUrl (file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error || new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

// Center-square-cover crop to 96x96 then JPEG-compress. Reduces quality
// in steps if the encoded result is over the byte budget; gives up at
// quality 0.4 and lets the caller surface a friendly error.
function compressToAvatar (dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const size = 96
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      const sw = img.naturalWidth
      const sh = img.naturalHeight
      const cropSize = Math.min(sw, sh)
      const sx = (sw - cropSize) / 2
      const sy = (sh - cropSize) / 2
      ctx.drawImage(img, sx, sy, cropSize, cropSize, 0, 0, size, size)
      const qualities = [0.85, 0.75, 0.65, 0.55, 0.45]
      for (const q of qualities) {
        const url = canvas.toDataURL('image/jpeg', q)
        const b64Len = url.length - (url.indexOf(',') + 1)
        if (b64Len <= AVATAR_MAX_BASE64) { resolve(url); return }
      }
      // Fall through: return the lowest-quality version even if oversized;
      // bare will reject and the UI will message the user.
      resolve(canvas.toDataURL('image/jpeg', 0.45))
    }
    img.onerror = () => reject(new Error('decode failed'))
    img.src = dataUrl
  })
}

function initialsFor (label) {
  const trimmed = (label || '').trim()
  if (!trimmed) return '?'
  const parts = trimmed.split(/\s+/).slice(0, 2)
  return parts.map(p => p[0].toUpperCase()).join('')
}

// Slide-up modal sheet, ported from pearcal-native/src/ui/App.jsx:5777.
// Tap-to-dismiss on the scrim; drag the handle down >60px to close.
// onClose runs after the slide-out finishes so the parent can unmount.
function BottomSheet ({ onClose, children, zIndex = 200 }) {
  const [visible, setVisible] = useState(false)
  const [closing, setClosing] = useState(false)
  const touchStartY = useRef(null)
  const DURATION = 280

  useEffect(() => {
    const id = setTimeout(() => setVisible(true), 20)
    return () => clearTimeout(id)
  }, [])

  const close = useCallback(() => {
    setClosing((c) => {
      if (c) return c
      setTimeout(() => onClose(), DURATION)
      return true
    })
  }, [onClose])

  const onHandleTouchStart = (e) => { touchStartY.current = e.touches[0].clientY }
  const onHandleTouchMove = (e) => {
    if (touchStartY.current === null) return
    const dy = e.touches[0].clientY - touchStartY.current
    if (dy > 60) { touchStartY.current = null; close() }
  }

  const translateY = (!visible || closing) ? '100%' : '0%'

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        background: visible && !closing ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0)',
        transition: `background ${DURATION}ms ease`,
      }}
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 600,
          background: '#1a1a1a',
          color: '#eee',
          borderRadius: '20px 20px 0 0',
          maxHeight: '85dvh', overflowY: 'auto', overflowX: 'hidden',
          padding: '0 16px 32px',
          transform: `translateY(${translateY})`,
          transition: `transform ${DURATION}ms cubic-bezier(0.32,0.72,0,1)`,
          WebkitOverflowScrolling: 'touch',
          boxSizing: 'border-box',
        }}
      >
        <div
          onTouchStart={onHandleTouchStart}
          onTouchMove={onHandleTouchMove}
          onClick={close}
          style={{ display: 'flex', justifyContent: 'center', padding: '12px 0 4px', cursor: 'pointer' }}
        >
          <div style={{ width: 36, height: 4, borderRadius: 2, background: '#444' }} />
        </div>
        {children}
      </div>
    </div>
  )
}

function Avatar ({ base64, label, size = 28 }) {
  const px = size + 'px'
  if (typeof base64 === 'string' && base64.length > 0) {
    return (
      <img
        src={'data:image/jpeg;base64,' + base64}
        alt=''
        style={{ width: px, height: px, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
      />
    )
  }
  return (
    <div style={{
      width: px, height: px, borderRadius: '50%', flexShrink: 0,
      background: '#2a3a3f', color: '#cfe', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      fontSize: Math.round(size * 0.42), fontWeight: 600, fontFamily: 'system-ui',
    }}>{initialsFor(label)}</div>
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

function QrImage ({ text, size = 240 }) {
  const [dataUrl, setDataUrl] = useState(null)
  useEffect(() => {
    let cancelled = false
    QRCode.toDataURL(text, { width: size * 2, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => { if (!cancelled) setDataUrl(url) })
      .catch(() => { if (!cancelled) setDataUrl(null) })
    return () => { cancelled = true }
  }, [text, size])
  return (
    <div style={s.qrWrap}>
      {dataUrl
        ? <img src={dataUrl} style={{ width: size, height: size, display: 'block' }} alt='Invite QR code' />
        : <div style={{ width: size, height: size, background: '#222' }} />}
    </div>
  )
}

function ShareButton ({ text, title = 'Join my PearCircle' }) {
  const click = async () => {
    // Route through the shell rather than the WebView's Web Share API.
    // The WebView runs with about:blank as the base URL and that isn't
    // reliably treated as a secure context, so navigator.share tends to
    // fail silently. The shell uses React Native's Share, which always
    // opens the OS share sheet.
    try { await pear.call('shell:share', { text, title }) } catch {}
  }
  return (
    <button style={s.secondaryBtn} onClick={click}>
      Share join link
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
  screen: { paddingLeft: 16, paddingRight: 16, paddingTop: 'calc(env(safe-area-inset-top, 24px) + 16px)', paddingBottom: 64, color: '#eee', background: '#111', minHeight: '100vh', fontFamily: '-apple-system, system-ui, Roboto, sans-serif', boxSizing: 'border-box' },
  header: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 },
  h1: { fontSize: 24, margin: 0, flex: 1, fontWeight: 600 },
  h2: { fontSize: 18, margin: '24px 0 8px 0', fontWeight: 600 },
  h3: { fontSize: 16, margin: '20px 0 8px 0', fontWeight: 600, color: '#bbb' },
  idLine: { color: '#888', margin: '4px 0 16px 0', fontSize: 13, fontFamily: 'monospace' },
  profileBtn: { display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '10px 12px', margin: '4px 0 16px 0', background: '#1c1c1c', border: '1px solid #2a2a2a', borderRadius: 8, color: '#eee', textAlign: 'left', cursor: 'pointer', fontSize: 13 },
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
  memberRow: { display: 'flex', alignItems: 'flex-start', gap: 12 },
  memberName: { fontSize: 15, fontWeight: 500 },
  placeRowHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  placeRadiusLine: { fontSize: 12, color: '#888', marginTop: 4, fontFamily: 'monospace' },
  avatarRow: { display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 },
  avatarPreview: { width: 96, height: 96, borderRadius: '50%', overflow: 'hidden', background: '#2a3a3f', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  avatarImg: { width: '100%', height: '100%', objectFit: 'cover' },
  avatarFallback: { color: '#cfe', fontSize: 36, fontWeight: 600, fontFamily: 'system-ui' },
  lastSeen: { fontSize: 12, color: '#9cf', marginTop: 4, fontFamily: 'monospace' },
  lastSeenMuted: { fontSize: 12, color: '#555', marginTop: 4, fontStyle: 'italic' },
  status: { fontSize: 13, color: '#cfc', marginTop: 4, fontWeight: 500 },
  transitionBtns: { display: 'flex', gap: 8, marginTop: 8 },
  smallBtn: { flex: 1, padding: '8px 10px', background: '#222', color: '#ccc', border: '1px solid #333', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  mapWrap: { position: 'relative', height: '100%', width: '100%', background: '#0a0a0a' },
  mapCanvas: { height: '100%', width: '100%' },
  mapAttribution: { position: 'absolute', bottom: 4, right: 6, fontSize: 10, color: '#fff', background: 'rgba(0,0,0,0.5)', padding: '2px 6px', borderRadius: 4, pointerEvents: 'none' },
  mapFirstRoot: { position: 'fixed', inset: 0, color: '#eee', background: '#111', fontFamily: '-apple-system, system-ui, Roboto, sans-serif', overflow: 'hidden' },
  mapFill: { position: 'absolute', inset: 0 },
  mapTopBar: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 5,
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 12px',
    paddingTop: 'calc(env(safe-area-inset-top, 24px) + 8px)',
    background: '#1a1a1a',
    borderBottom: '1px solid #2a2a2a',
  },
  mapTitle: { fontSize: 18, margin: 0, flex: 1, fontWeight: 600, color: '#eee' },
  peerBadge: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, color: '#bbb', padding: '4px 8px' },
  peerDot: { width: 8, height: 8, borderRadius: '50%' },
  fab: {
    position: 'absolute',
    bottom: 'calc(env(safe-area-inset-bottom, 0px) + 20px)',
    left: '50%', transform: 'translateX(-50%)',
    padding: '12px 18px',
    background: '#7ec4cf', color: '#0a1f23',
    border: 'none', borderRadius: 999,
    fontSize: 14, fontWeight: 600,
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    zIndex: 5, cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  dropdownBtn: {
    display: 'flex', alignItems: 'center', gap: 6, flex: 1,
    padding: '6px 10px', background: 'transparent', color: '#eee',
    border: 'none', borderRadius: 8, fontSize: 16, fontWeight: 600,
    cursor: 'pointer', textAlign: 'left',
  },
  dropdownLabel: { flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  dropdownChevron: { fontSize: 12, color: '#888' },
  focusTextCol: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' },
  focusName: { fontSize: 15, fontWeight: 600, color: '#eee', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  focusSub: { fontSize: 12, color: '#9cf', fontFamily: 'monospace' },
  avatarBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
  },
  menuScrim: {
    position: 'fixed', inset: 0, zIndex: 9, background: 'transparent',
  },
  menu: {
    position: 'absolute', top: 'calc(env(safe-area-inset-top, 24px) + 56px)', left: 12,
    background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 10,
    padding: 6, minWidth: 220, maxWidth: 'calc(100% - 24px)',
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 10,
  },
  menuItem: {
    display: 'block', width: '100%', padding: '10px 12px',
    background: 'transparent', color: '#eee', border: 'none', borderRadius: 6,
    fontSize: 14, textAlign: 'left', cursor: 'pointer',
  },
  menuItemActive: { background: '#243237', color: '#7ec4cf', fontWeight: 600 },
  menuDivider: { height: 1, background: '#2a2a2a', margin: '6px 4px' },
  qrWrap: { display: 'flex', justifyContent: 'center', padding: 12, background: '#fff', borderRadius: 12, marginBottom: 12 },
  emptyHint: {
    position: 'absolute', left: 16, right: 16,
    bottom: 'calc(env(safe-area-inset-bottom, 0px) + 20px)',
    padding: 14, background: 'rgba(26,26,26,0.92)',
    borderRadius: 10, color: '#ccc', fontSize: 14, lineHeight: 1.4,
    zIndex: 5,
  },
}
