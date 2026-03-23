const handleKeyDown = (e) => {
    if (e.key === "Enter") handleCommit();
    if (e.key === "Escape") { setEditing(false); setInputVal(""); }
    e.stopPropagation();
  };

  return (
    <div className={`re-gallery-counter ${editing ? 'editing' : ''}`}
      onClick={!editing ? handleActivate : undefined}
      title={editing ? "" : "Click to jump to event"}>
      {editing ? (
        <>
          <input ref={inputRef} className="re-counter-input" type="number" min={1} max={total}
            value={inputVal} onChange={e => setInputVal(e.target.value)}
            onBlur={handleCommit} onKeyDown={handleKeyDown} placeholder={String(current + 1)} autoFocus />
          <span className="divider">/</span>
          <span>{String(total).padStart(2, "0")}</span>
        </>
      ) : (
        <>
          <span>{String(current + 1).padStart(2, "0")}</span>
          <span className="divider">/</span>
          <span>{String(total).padStart(2, "0")}</span>
        </>
      )}
    </div>
  );
}

function SearchBar({ events, onSelect, currentIndex }) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef(null);
  const containerRef = useRef(null);

  const results = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return events.map((e, i) => ({ event: e, index: i }))
      .filter(({ event }) =>
        event.ename?.toLowerCase().includes(q) ||
        event.eventLoc?.toLowerCase().includes(q) ||
        event.organizerName?.toLowerCase().includes(q))
      .slice(0, 6);
  }, [query, events]);

  const handleSelect = (index) => { onSelect(index); setQuery(""); setFocused(false); inputRef.current?.blur(); };
  const handleKeyDown = (e) => {
    if (e.key === "Escape") { setQuery(""); setFocused(false); inputRef.current?.blur(); }
    e.stopPropagation();
  };

  return (
    <div ref={containerRef} className={`re-search-wrap ${focused ? 'expanded' : ''}`}>
      <button className="re-search-icon-btn"
        onClick={() => { setFocused(true); setTimeout(() => inputRef.current?.focus(), 50); }}
        tabIndex={focused ? -1 : 0} aria-label="Search events">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="13" height="13">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
        </svg>
      </button>
      <input ref={inputRef} className="re-search-inline-input" placeholder="Search…" value={query}
        onChange={e => setQuery(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => { setFocused(false); setQuery(""); }, 160)}
        onKeyDown={handleKeyDown} autoComplete="off" tabIndex={focused ? 0 : -1} />
      {query && focused && (
        <button className="re-search-clear-inline" onMouseDown={e => { e.preventDefault(); setQuery(""); }}>×</button>
      )}
      {focused && results.length > 0 && (
        <div className="re-search-dropdown">
          {results.map(({ event, index }) => (
            <button key={event.eid} className={`re-search-result ${index === currentIndex ? 'current' : ''}`}
              onMouseDown={e => { e.preventDefault(); handleSelect(index); }}>
              <div className="re-search-result-img"><img src={resolveBanner(event)} alt={event.ename} /></div>
              <div className="re-search-result-info">
                <span className="re-search-result-name">{event.ename}</span>
                <span className="re-search-result-meta">
                  {event.eventLoc} · <span className={`re-search-badge ${event.status}`}>{event.status}</span>
                </span>
              </div>
              <span className="re-search-result-num">#{index + 1}</span>
            </button>
          ))}
        </div>
      )}
      {focused && query && results.length === 0 && (
        <div className="re-search-dropdown">
          <div className="re-search-no-result">No matches for "{query}"</div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// BENTO GRID
// ============================================================================

function BentoGridCard({ event, onOpen, renderControls }) {
  return (
    <div className="re-bento-card" onClick={() => onOpen(event)}>
      <div className="re-bento-img"><img src={resolveBanner(event)} alt={event.ename} loading="lazy" /></div>
      <div className="re-bento-scrim" />
      <div className="re-bento-top">
        <span className={`re-bento-status ${event.status}`}>{event.status}</span>
        {event.is_team && <span className="re-bento-team-badge">Team</span>}
        {event.regFee > 0 ? <span className="re-bento-fee">₹{event.regFee}</span> : <span className="re-bento-free">Free</span>}
      </div>
      <div className="re-bento-bottom">
        <p className="re-bento-date">
          {new Date(event.eventDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
          {' · '}{formatTime12h(event.eventTime)}
        </p>
        <h3 className="re-bento-name">{event.ename}</h3>
        <p className="re-bento-loc">📍 {event.eventLoc}</p>
        <div className="re-bento-actions" onClick={e => e.stopPropagation()}>
          {renderControls(event, false)}
          <button className="re-bento-detail-btn" onClick={(e) => { e.stopPropagation(); onOpen(event); }}>Details ↗</button>
        </div>
      </div>
    </div>
  );
}

function BentoGrid({ events, onOpen, renderControls }) {
  return (
    <div className="re-bento-grid-container">
      <div className="re-bento-grid">
        {events.map(event => (
          <BentoGridCard key={event.eid} event={event} onOpen={onOpen} renderControls={renderControls} />
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// EVENT GALLERY CARD
// ============================================================================

function EventGalleryCard({ event, isActive, index, currentIndex, onOpen, renderControls }) {
  const distance = index - currentIndex;
  const scale = isActive ? 1 : 0.84;
  const opacity = isActive ? 1 : Math.max(0.3, 1 - Math.abs(distance) * 0.25);

  return (
    <div
      className={`re-gallery-card ${isActive ? 'active' : ''}`}
      style={{ transform: `scale(${scale}) translateZ(0)`, opacity, WebkitTransform: `scale(${scale}) translateZ(0)` }}
    >
      <div className="re-gallery-card-frame">
        <div className="re-gallery-image-container">
          <img src={resolveBanner(event)} alt={event.ename} style={{ transform: 'scale(1)' }}
            draggable={false} loading="lazy" />
          <div className={`re-gallery-status-badge ${event.status}`}>{event.status}</div>
          {event.is_team && <div className="re-gallery-team-badge">Team</div>}
          <div className="re-gallery-gradient" style={{ opacity: isActive ? 1 : 0.4, height: isActive ? '75%' : '40%' }} />
          {isActive && (
            <div className="re-gallery-info">
              <p className="re-gallery-year">
                {new Date(event.eventDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                {' · '}{formatTime12h(event.eventTime)}
              </p>
              <h2 className="re-gallery-title">{event.ename}</h2>
              <p className="re-gallery-artist">
                📍 {event.eventLoc}
                {event.regFee > 0 ? <span className="re-gallery-fee"> · ₹{event.regFee}</span> : <span className="re-gallery-free"> · Free</span>}
              </p>
              <div className="re-gallery-card-actions">
                {renderControls(event, false)}
                <button className="re-gallery-details-btn" onClick={(e) => { e.stopPropagation(); onOpen(event); }}>Details ↗</button>
              </div>
            </div>
          )}
        </div>
      </div>
      {!isActive && (
        <div className="re-gallery-click-hint" onClick={() => onOpen(event)}>
          <span>{event.ename}</span>
        </div>
      )}
      <div className="re-gallery-reflection" style={{ opacity: isActive ? 0.12 : 0.04 }} />
    </div>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export default function Registerevent() {
  const navigate = useNavigate()

  const [eventsData, setEventsData] = useState({ upcoming: [], ongoing: [], completed: [] })
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState("all")
  const [viewMode, setViewMode] = useState("gallery")
  const [teamStates, setTeamStates] = useState({})
  const [registeredEvents, setRegisteredEvents] = useState(new Set())

  const [flash, setFlash] = useState({ type: "", message: "" })
  const [modalFlash, setModalFlash] = useState({ type: "", message: "" })
  const [selectedEvent, setSelectedEvent] = useState(null)
  const [ticketInfo, setTicketInfo] = useState(null);

  const [showTeamModal, setShowTeamModal] = useState(null)
  const [teamFormData, setTeamFormData] = useState({ teamName: '', memberUSNs: [''] })
  const [teamInvites, setTeamInvites] = useState([])
  const [showUpiModal, setShowUpiModal] = useState(null)
  const [transactionId, setTransactionId] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState("")

  const timerRef = useRef(null)
  const modalTimerRef = useRef(null)
  const sliderRef = useRef(null)

  function showFlash(type, message) {
    if (timerRef.current) clearTimeout(timerRef.current)
    setFlash({ type, message })
    timerRef.current = setTimeout(() => setFlash({ type: "", message: "" }), 4000)
  }

  function showModalFlash(type, message) {
    if (modalTimerRef.current) clearTimeout(modalTimerRef.current)
    setModalFlash({ type, message })
    modalTimerRef.current = setTimeout(() => setModalFlash({ type: "", message: "" }), 4000)
  }

  function generateUpiUrl(upiId, eventName, amount, eventId) {
    const params = new URLSearchParams({ pa: upiId, pn: eventName, am: amount.toString(), cu: "INR", tn: `Event Registration - ${eventId}` })
    return `upi://pay?${params.toString()}`
  }

  const loadEvents = useCallback(async () => {
    try {
      setLoading(true)
      const response = await apiFetch('/api/events', { method: "GET" });
      if (response.status === 401) { navigate('/'); return }
      if (!response.ok) throw new Error("Failed")
      const data = await response.json()
      setEventsData({ upcoming: data?.events?.upcoming || [], ongoing: data?.events?.ongoing || [], completed: data?.events?.completed || [] })
    } catch (err) { showFlash("error", "Failed to load events") }
    finally { setLoading(false) }
  }, [navigate]);

  const fetchMyRegistrations = useCallback(async () => {
    try {
      const res = await apiFetch('/api/my-participant-events');
      if (res.ok) {
        const data = await res.json()
        setRegisteredEvents(new Set(data.participantEvents.map(ev => ev.eid)))
      }
    } catch (err) { console.error(err) }
  }, []);

  const loadTeamStatus = useCallback(async (eventId) => {
    try {
      const response = await apiFetch(`/api/events/${eventId}/team-status`);
      if (response.ok) {
        const data = await response.json()
        setTeamStates(prev => ({ ...prev, [eventId]: data }))
      } else {
        setTeamStates(prev => ({ ...prev, [eventId]: null }))
      }
    } catch (err) { console.error(err) }
  }, []);

  useEffect(() => { loadEvents(); fetchMyRegistrations(); }, [loadEvents, fetchMyRegistrations])

  useEffect(() => {
    const activeEvents = [...(eventsData.upcoming || []), ...(eventsData.ongoing || [])];
    if (activeEvents.length > 0) activeEvents.forEach(event => { loadTeamStatus(event.eid) })
  }, [eventsData, loadTeamStatus])

  useEffect(() => {
    const shouldLock = selectedEvent || showTeamModal || showUpiModal;
    const wrapper = document.querySelector('.registerevent-page');
    if (wrapper) wrapper.style.overflowY = shouldLock ? 'hidden' : 'auto';
  }, [selectedEvent, showTeamModal, showUpiModal]);

  const allEvents = useMemo(() => [
    ...(eventsData.upcoming || []).map(e => ({ ...e, status: "upcoming" })),
    ...(eventsData.ongoing || []).map(e => ({ ...e, status: "ongoing" })),
    ...(eventsData.completed || []).map(e => ({ ...e, status: "completed" })),
  ], [eventsData]);

  const statusCounts = useMemo(() => ({
    all: allEvents.length,
    upcoming: allEvents.filter(e => e.status === "upcoming").length,
    ongoing: allEvents.filter(e => e.status === "ongoing").length,
    completed: allEvents.filter(e => e.status === "completed").length,
  }), [allEvents]);

  const filteredEvents = useMemo(() => {
    const base = filter === "all" ? allEvents : allEvents.filter(e => e.status === filter)
    return base.filter(e => {
      if (e.status === 'completed') return true
      if (teamStates[e.eid] === null) return false
      return true
    })
  }, [allEvents, filter, teamStates])

  useEffect(() => {
    if (showUpiModal) {
      const { event } = showUpiModal
      const upiUrl = generateUpiUrl(event.upiId, event.ename, event.regFee, event.eid)
      QRCode.toDataURL(upiUrl, { width: 280, margin: 2, color: { dark: '#000000', light: '#ffffff' } }).then(setQrCodeDataUrl)
    } else { setQrCodeDataUrl("") }
  }, [showUpiModal])

  // ==================== GALLERY SLIDER ====================
  const { currentIndex, goToNext, goToPrev, goToSlide } = useSliderNavigation({
    totalSlides: filteredEvents.length,
    enableKeyboard: !selectedEvent && !showTeamModal && !showUpiModal && viewMode === "gallery",
  });

  const trackRef = useRef(null);
  const { snapPoints } = useSnapPoints(trackRef, filteredEvents.length);

  const wheelEnabled = !selectedEvent && !showTeamModal && !showUpiModal && viewMode === "gallery";

  const { isDragging, handleMouseDown, handleMouseMove, handleMouseUp, handleMouseLeave } = useSliderDrag({
    sliderRef,
    trackRef,
    currentIndex,
    snapPoints,
    onSwipeLeft: goToNext,
    onSwipeRight: goToPrev,
  });

  useEffect(() => {
    const el = trackRef.current;
    if (!el || snapPoints.length === 0) return;
    const base = snapPoints[currentIndex] ?? 0;
    el.style.transition = 'transform 0.45s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
    el.style.transform = `translateX(${base}px) translateZ(0)`;
  }, [currentIndex, snapPoints]);

  useSliderWheel({
    sliderRef,
    onScrollLeft: goToNext,
    onScrollRight: goToPrev,
    enabled: wheelEnabled,
  });

  const colorMap = useColorExtraction(filteredEvents);
  const currentColors = colorMap[filteredEvents[currentIndex]?.eid] || DEFAULT_COLORS;

  // ==================== ACTION HANDLERS ====================

  async function handleRegister(event) {
    const hasFee = (event.regFee || 0) > 0; const eventId = event.eid
    if (hasFee) {
      if (!event.upiId) { showFlash("error", "Payment not setup."); return }
      setTransactionId(""); setModalFlash({ type: "", message: "" }); setShowUpiModal({ event, isTeam: false }); return
    }
    try {
      const response = await apiFetch(`/api/events/${eventId}/join`, { method: "POST", headers: { "Content-Type": "application/json" } });
      const data = await response.json()
      if (!response.ok) { showFlash("error", data.error || "Failed"); return }
      showFlash("success", "Registered successfully!")
      setRegisteredEvents(prev => new Set(prev).add(eventId))
      setTicketInfo({ eventName: event.ename, eventDate: event.eventDate, userUSN: data.userUSN || "AUTHORIZED" })
      await loadEvents()
    } catch (err) { showFlash("error", "Network error") }
  }

  async function handleCreateTeam(eventId) {
    try {
      const { teamName, memberUSNs } = teamFormData
      if (!teamName.trim()) { showModalFlash('error', 'Team name required'); return }
      const validUSNs = memberUSNs.filter(usn => usn.trim() !== '')
      const response = await apiFetch(`/api/events/${eventId}/create-team`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamName: teamName.trim(), memberUSNs: validUSNs })
      });
      const data = await response.json()
      if (!response.ok) { showModalFlash('error', data.error); return }
      showModalFlash('success', 'Team created!'); showFlash('success', 'Team created!')
      setTimeout(() => { setShowTeamModal(null); setTeamFormData({ teamName: '', memberUSNs: [''] }); loadTeamStatus(eventId) }, 1500)
    } catch (err) { showModalFlash('error', 'Error creating team') }
  }

  async function handleViewInvites(eventId) {
    try {
      const response = await apiFetch(`/api/events/${eventId}/my-invites`);
      const data = await response.json()
      if (!response.ok) { showFlash('error', data.error); return }
      if (!data.invites?.length) { showFlash('error', 'No pending invites'); setTeamInvites([]) }
      else { setTeamInvites(data.invites); setShowTeamModal({ eventId, mode: 'invites' }) }
    } catch (err) { showFlash('error', 'Error loading invites') }
  }

  async function handleConfirmJoin(teamId, eventId) {
    try {
      const response = await apiFetch(`/api/teams/${teamId}/confirm-join`, { method: "POST" });
      if (!response.ok) { showModalFlash('error', 'Failed to join'); return }
      showModalFlash('success', 'Joined team!');
      setTimeout(() => { setShowTeamModal(null); setTeamInvites([]); loadTeamStatus(eventId) }, 1500)
    } catch (err) { showModalFlash('error', 'Error') }
  }

  async function handleRegisterTeam(event, teamState) {
    const eventId = event.eid
    try {
      const response = await apiFetch(`/api/events/${eventId}/register-team`, { method: "POST" });
      const data = await response.json()
      if (!response.ok) { showFlash('error', data.error); return }
      if (data.requiresPayment) {
        if (!event.upiId) { showFlash("error", "Payment not setup"); return }
        setTransactionId(""); setShowUpiModal({ event, isTeam: true, teamId: teamState.teamId }); return
      }
      showFlash('success', 'Team registered!');
      setTicketInfo({ eventName: event.ename, eventDate: event.eventDate, userUSN: data.userUSN });
      await loadTeamStatus(eventId); await loadEvents(); await fetchMyRegistrations()
    } catch (err) { showFlash('error', 'Error registering team') }
  }

  async function handleSubmitUpiPayment() {
    if (!transactionId.trim()) { showModalFlash('error', 'Enter Transaction ID'); return }
    if (isSubmitting) return; setIsSubmitting(true)
    const { event, isTeam } = showUpiModal; const eventId = event.eid;
    const url = isTeam ? `/api/events/${eventId}/register-team-upi` : `/api/events/${eventId}/register-upi`
    try {
      const response = await apiFetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transaction_id: transactionId.trim() })
      });
      const data = await response.json()
      if (!response.ok) { showModalFlash('error', data.error); return }
      showModalFlash('success', 'Submitted for verification!');
      setTimeout(async () => {
        setShowUpiModal(null); setTransactionId(""); showFlash('success', 'Submitted!');
        setTicketInfo({ eventName: event.ename, eventDate: event.eventDate, userUSN: data.userUSN || "PENDING" });
        await loadEvents(); await loadTeamStatus(eventId); await fetchMyRegistrations()
      }, 1500)
    } catch (err) { showModalFlash('error', 'Error submitting') } finally { setIsSubmitting(false) }
  }

  const handleOpenPoster = (e, url) => {
    e.stopPropagation();
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }

  function renderControls(event, isOverlay = false) {
    const teamState = teamStates[event.eid]
    const aboutBtn = (event.posterUrl && isOverlay) ? (
      <button className="registerevent-btn about" onClick={(e) => handleOpenPoster(e, event.posterUrl)}>View Poster ↗</button>
    ) : null;

    if (!teamState && (event.status !== 'completed')) return <button className="registerevent-btn disabled">Loading...</button>
    if (event.status === 'completed') return <button className="registerevent-btn disabled">Event Completed</button>

    if (!teamState?.isTeamEvent) {
      if (registeredEvents.has(event.eid)) {
        return (<div className="registerevent-btn-group"><button className="registerevent-btn success" disabled>✓ Registered</button>{aboutBtn}</div>)
      }
      return (
        <div className="registerevent-btn-group">
          <button className="registerevent-btn primary" onClick={(e) => { e.stopPropagation(); handleRegister(event); }}>
            {(event.regFee || 0) > 0 ? `Pay ₹${event.regFee}` : "Register"}
          </button>
          {aboutBtn}
        </div>
      )
    }

    if (teamState.registrationComplete) return (
      <div className="registerevent-btn-group"><button className="registerevent-btn success" disabled>✓ Team Registered</button>{aboutBtn}</div>
    )

    if (teamState.hasJoinedTeam) {
      const isLeader = teamState.isLeader
      return (
        <div className="registerevent-team-controls-group" style={{ width: '100%' }}>
          {isOverlay && (
            <div className="registerevent-hud-panel">
              <div className="registerevent-hud-header">
                <span className="registerevent-hud-label">Team: {teamState.teamName}</span>
                <span className="registerevent-hud-value" style={{ color: teamState.canRegister ? '#00ff9d' : '#ffbd00' }}>
                  {teamState.joinedCount}/{teamState.minSize} Members
                </span>
              </div>
              <div className="registerevent-member-stack">
                <span className="registerevent-hud-label">Member Status:</span>
                {teamState.members?.map((member, idx) => (
                  <div key={idx} className="registerevent-member-row">
                    <span>{member.student?.sname || member.student_usn}</span>
                    <span className={`registerevent-status-indicator ${member.join_status ? "joined" : "pending"}`}>
                      {member.join_status ? "Accepted" : "Pending"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="registerevent-btn-group" style={{ marginTop: isOverlay ? '16px' : '0' }}>
            {isLeader ? (
              <button className={`registerevent-btn ${teamState.canRegister ? "primary" : "disabled"}`}
                onClick={(e) => { e.stopPropagation(); teamState.canRegister && handleRegisterTeam(event, teamState); }}
                disabled={!teamState.canRegister}>
                {(teamState.regFee || 0) > 0 ? `Pay ₹${teamState.regFee}` : "Finalize Registration"}
              </button>
            ) : (
              <button className="registerevent-btn disabled">Waiting for Leader</button>
            )}
            {aboutBtn}
          </div>
        </div>
      )
    }

    return (
      <div className="registerevent-btn-group">
        <button className="registerevent-btn secondary" onClick={(e) => { e.stopPropagation(); setShowTeamModal({ eventId: event.eid, mode: 'create' }) }}>Create Team</button>
        <button className="registerevent-btn secondary" onClick={(e) => { e.stopPropagation(); handleViewInvites(event.eid) }}>View Invites</button>
        {aboutBtn}
      </div>
    )
  }

  // ==================== RENDER ====================

  return (
    <main className="registerevent-page">
      {ticketInfo && <TicketAnimation onClose={() => setTicketInfo(null)} {...ticketInfo} />}
      {flash.message && (
        <div className={`flo-toast ${flash.type === 'success' ? 'flo-toast--success' : 'flo-toast--error'}`}>
          <span className="flo-toast-icon">{flash.type === 'success' ? '✓' : '✕'}</span>
          {flash.message}
        </div>
      )}

      <div className="re-gallery-bg" style={{
        background: `
          radial-gradient(ellipse at 25% 20%, ${currentColors[0]}55 0%, transparent 50%),
          radial-gradient(ellipse at 75% 80%, ${currentColors[1]}55 0%, transparent 50%),
          radial-gradient(ellipse at 50% 50%, ${currentColors[2]}33 0%, transparent 65%),
          linear-gradient(180deg, #080808 0%, #0d0d0d 100%)
        `,
      }} />
      <div className="re-gallery-blur-bg" />

      <header className="re-gallery-header">
        <div className="re-gallery-header-left">
          <h1 className="re-gallery-headline">Events</h1>
          <p className="re-gallery-subline">Discover & join events happening around you.</p>
        </div>
        <div className="re-gallery-header-right">
          {filteredEvents.length > 0 && viewMode === "gallery" && (
            <JumpCounter current={currentIndex} total={filteredEvents.length} onJump={goToSlide} />
          )}
          {filteredEvents.length > 0 && viewMode === "grid" && (
            <div className="re-gallery-counter" style={{ cursor: 'default' }}>
              <span>{filteredEvents.length}</span>
              <span style={{ color: 'rgba(255,255,255,0.25)', margin: '0 3px' }}>·</span>
              <span>events</span>
            </div>
          )}
        </div>
      </header>

      <div className="re-view-toggle-desktop-centered">
        <button className={`re-view-tab ${viewMode === "gallery" ? "active" : ""}`} onClick={() => setViewMode("gallery")}>
          <svg viewBox="0 0 18 14" fill="none" stroke="currentColor" strokeWidth="1.6" width="14" height="11">
            <rect x="0.8" y="0.8" width="16.4" height="12.4" rx="2" />
            <line x1="0.8" y1="4" x2="17.2" y2="4" /><line x1="0.8" y1="10" x2="17.2" y2="10" />
          </svg>
          <span>Gallery</span>
        </button>
        <button className={`re-view-tab ${viewMode === "grid" ? "active" : ""}`} onClick={() => setViewMode("grid")}>
          <svg viewBox="0 0 16 16" fill="currentColor" width="13" height="13">
            <rect x="0" y="0" width="6" height="6" rx="1.2" /><rect x="8" y="0" width="6" height="6" rx="1.2" opacity="0.6" />
            <rect x="0" y="8" width="6" height="6" rx="1.2" opacity="0.6" /><rect x="8" y="8" width="6" height="6" rx="1.2" opacity="0.6" />
          </svg>
          <span>Grid</span>
        </button>
      </div>

      <div className="re-gallery-filter-strip">
        {!loading && filteredEvents.length > 0 && (
          <SearchBar events={filteredEvents} onSelect={(i) => { setViewMode("gallery"); goToSlide(i); }} currentIndex={currentIndex} />
        )}
        <div className="re-filter-divider" />
        {["all", "upcoming", "ongoing", "completed"].map(k => (
          <button key={k} className={`re-gallery-filter-btn ${filter === k ? 'active' : ''}`}
            onClick={() => { setFilter(k); goToSlide(0); }}>
            {k.charAt(0).toUpperCase() + k.slice(1)}
            {statusCounts[k] > 0 && <span className={`re-filter-count ${filter === k ? 'active' : ''}`}>{statusCounts[k]}</span>}
          </button>
        ))}
      </div>

      <div className="re-mobile-view-toggle">
        <button className={`re-mobile-view-btn ${viewMode === "gallery" ? "active" : ""}`} onClick={() => setViewMode("gallery")}>
          <svg viewBox="0 0 18 14" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="11">
            <rect x="0.8" y="0.8" width="16.4" height="12.4" rx="2" />
            <line x1="0.8" y1="4" x2="17.2" y2="4" /><line x1="0.8" y1="10" x2="17.2" y2="10" />
          </svg>
          Gallery
        </button>
        <button className={`re-mobile-view-btn ${viewMode === "grid" ? "active" : ""}`} onClick={() => setViewMode("grid")}>
          <svg viewBox="0 0 16 16" fill="currentColor" width="13" height="13">
            <rect x="0" y="0" width="6.5" height="6.5" rx="1.2" /><rect x="9.5" y="0" width="6.5" height="6.5" rx="1.2" />
            <rect x="0" y="9.5" width="6.5" height="6.5" rx="1.2" /><rect x="9.5" y="9.5" width="6.5" height="6.5" rx="1.2" />
          </svg>
          Grid
        </button>
      </div>

      {loading ? (
        <div className="re-gallery-loading"><div className="re-gallery-spinner"></div><p>Loading events...</p></div>
      ) : filteredEvents.length === 0 ? (
        <div className="re-gallery-empty"><span>No events found</span></div>
      ) : viewMode === "gallery" ? (
        <div
          ref={sliderRef}
          className={`re-gallery-slider ${isDragging ? 'dragging' : ''}`}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
        >
          <div ref={trackRef} className="re-gallery-track">
            {filteredEvents.map((event, index) => (
              <EventGalleryCard key={event.eid} event={event} isActive={index === currentIndex}
                index={index} currentIndex={currentIndex} onOpen={setSelectedEvent} renderControls={renderControls} />
            ))}
          </div>
        </div>
      ) : (
        <BentoGrid events={filteredEvents} onOpen={setSelectedEvent} renderControls={renderControls} />
      )}

      {!loading && filteredEvents.length > 1 && viewMode === "gallery" && (
        <NavigationDots total={filteredEvents.length} current={currentIndex} onSelect={goToSlide} colors={currentColors} />
      )}

      {viewMode === "gallery" && (
        <div className="re-gallery-keyboard-hint">
          <kbd>←</kbd><kbd>→</kbd><span>navigate</span>
        </div>
      )}

      {selectedEvent && (
        <div className="registerevent-overlay-container">
          <div className="registerevent-overlay-split">
            <div className="registerevent-split-top">
              <button className="registerevent-close-btn" onClick={() => setSelectedEvent(null)}>×</button>
              <div className="registerevent-image-wrapper">
                <img src={resolveBanner(selectedEvent)} alt={selectedEvent.ename} />
                <div className="registerevent-image-gradient"></div>
              </div>
            </div>
            <div className="registerevent-split-bottom">
              <div className="registerevent-detail-content">
                <div className="registerevent-detail-header-flex">
                  <div style={{ fontFamily: 'var(--nb-font-mono)', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#999', marginBottom: '6px' }}>Event Details</div>
                  <h2 className="registerevent-card-title" style={{ fontSize: '2rem', marginBottom: '8px' }}>{selectedEvent.ename}</h2>
                  <div className="registerevent-badges" style={{ marginTop: '8px' }}>
                    <span className="registerevent-badge registerevent-badge-upcoming">{new Date(selectedEvent.eventDate).toDateString()}</span>
                    <span className="registerevent-badge registerevent-badge-upcoming">{formatTime12h(selectedEvent.eventTime)}</span>
                    {selectedEvent.regFee > 0 ?
                      <span className="registerevent-badge registerevent-badge-upcoming" style={{ background: 'var(--nb-orange)', color: '#fff', borderColor: 'var(--nb-orange)' }}>₹{selectedEvent.regFee}</span> :
                      <span className="registerevent-badge registerevent-badge-ongoing">Free</span>
                    }
                  </div>
                </div>
                <div className="registerevent-description-box">
                  <h4>About Event</h4>
                  <p>{selectedEvent.eventdesc}</p>
                </div>
                <div className="registerevent-bento-grid">
                  <div className="registerevent-bento-item">
                    <span className="bento-label">Venue</span><span className="bento-value">{selectedEvent.eventLoc}</span>
                  </div>
                  <div className="registerevent-bento-item">
                    <span className="bento-label">Organizer</span><span className="bento-value">{selectedEvent.organizerName || "Club"}</span>
                  </div>
                  {selectedEvent.is_team && (
                    <div className="registerevent-bento-item">
                      <span className="bento-label">Team Size</span>
                      <span className="bento-value">{selectedEvent.min_team_size} - {selectedEvent.max_team_size} Members</span>
                    </div>
                  )}
                </div>
                <div style={{ height: '24px' }}></div>
              </div>
              <div className="registerevent-action-bar">{renderControls(selectedEvent, true)}</div>
            </div>
          </div>
        </div>
      )}

      {showTeamModal && (
        <div className="registerevent-modal-overlay" onClick={() => setShowTeamModal(null)}>
          <div className="registerevent-modal" onClick={e => e.stopPropagation()}>
            <div className="registerevent-modal-header">
              <h2 className="registerevent-modal-title">{showTeamModal.mode === 'create' ? 'Create Team' : 'Invites'}</h2>
              <button className="registerevent-modal-close" onClick={() => setShowTeamModal(null)}>×</button>
            </div>
            <div className="registerevent-modal-body">
              {modalFlash.message && (
                <div className={`flo-toast ${modalFlash.type === 'error' ? "flo-toast--error" : "flo-toast--success"}`} style={{ position: 'relative', top: 0, left: 0, transform: 'none', width: 'auto', marginBottom: '16px' }}>
                  <span className="flo-toast-icon">{modalFlash.type === 'error' ? "✕" : "✓"}</span>
                  {modalFlash.message}
                </div>
              )}
              {showTeamModal.mode === 'create' ? (
                <div className="registerevent-team-form">
                  <div className="registerevent-form-group">
                    <label className="registerevent-form-label">Team Name</label>
                    <input className="registerevent-form-input" placeholder="Enter Team Name" value={teamFormData.teamName} onChange={e => setTeamFormData({ ...teamFormData, teamName: e.target.value })} />
                  </div>
                  <div className="registerevent-form-group">
                    <label className="registerevent-form-label">Members (USNs)</label>
                    {teamFormData.memberUSNs.map((usn, i) => (
                      <div key={i} style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                        <input className="registerevent-form-input" placeholder="Member USN" value={usn} onChange={e => {
                          const newUsns = [...teamFormData.memberUSNs]; newUsns[i] = e.target.value; setTeamFormData({ ...teamFormData, memberUSNs: newUsns })
                        }} />
                        {i > 0 && <button className="registerevent-team-action-btn" style={{ background: 'var(--nb-red)', color: '#fff', borderColor: 'var(--nb-black)', padding: '0 10px', width: 'auto' }}
                          onClick={() => { const newUsns = teamFormData.memberUSNs.filter((_, idx) => idx !== i); setTeamFormData({ ...teamFormData, memberUSNs: newUsns }); }}>×</button>}
                      </div>
                    ))}
                    <button className="registerevent-team-action-btn" style={{ marginTop: '8px', fontSize: '0.85rem' }}
                      onClick={() => setTeamFormData(prev => ({ ...prev, memberUSNs: [...prev.memberUSNs, ''] }))}>+ Add Member</button>
                  </div>
                  <button className="registerevent-modal-submit-btn" onClick={() => handleCreateTeam(showTeamModal.eventId)}>Create Team</button>
                </div>
              ) : (
                <div className="registerevent-invites-list">
                  {!teamInvites.length ? <p style={{ color: 'var(--nb-black)', textAlign: 'center', fontFamily: 'var(--nb-font-mono)', fontSize: '12px', textTransform: 'uppercase' }}>No pending invites.</p>
                    : teamInvites.map((inv, i) => (
                      <div key={i} className="registerevent-hud-panel" style={{ marginBottom: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ color: 'var(--nb-black)', fontFamily: 'var(--nb-font-mono)', fontWeight: 700, fontSize: '13px' }}>{inv.teamName}</div>
                          <div style={{ fontSize: '11px', color: '#666', fontFamily: 'var(--nb-font-mono)', textTransform: 'uppercase' }}>Leader: {inv.leaderName}</div>
                        </div>
                        {!inv.registrationComplete && !inv.joinStatus && <button className="registerevent-invite-confirm-btn" style={{ width: 'auto', padding: '8px 16px' }} onClick={() => handleConfirmJoin(inv.teamId, showTeamModal.eventId)}>Join</button>}
                        {inv.joinStatus && <span style={{ color: 'var(--nb-green)', fontFamily: 'var(--nb-font-mono)', fontSize: '11px', fontWeight: 700 }}>Joined</span>}
                      </div>
                    ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showUpiModal && (
        <div className="registerevent-modal-overlay" onClick={() => !isSubmitting && setShowUpiModal(null)}>
          <div className="registerevent-modal" onClick={e => e.stopPropagation()}>
            <div className="registerevent-modal-header">
              <h2 className="registerevent-modal-title">Pay & Register</h2>
              <button className="registerevent-modal-close" disabled={isSubmitting} onClick={() => setShowUpiModal(null)}>×</button>
            </div>
            <div className="registerevent-modal-body" style={{ textAlign: 'center' }}>
              <div className="registerevent-qr-wrapper">
                {qrCodeDataUrl ? <img src={qrCodeDataUrl} alt="QR" style={{ display: 'block', maxWidth: '100%' }} /> : <div className="registerevent-spinner" style={{ margin: '40px auto' }}></div>}
              </div>
              <p style={{ color: 'var(--nb-black)', marginBottom: '20px', fontFamily: 'var(--nb-font-mono)', fontSize: '13px', fontWeight: 700 }}>Pay <strong>₹{showUpiModal.event.regFee}</strong></p>
              <div className="registerevent-payment-details">
                <div className="registerevent-payment-row"><span style={{ color: '#888' }}>UPI ID</span><span className="registerevent-payment-value">{showUpiModal.event.upiId}</span></div>
              </div>
              <input className="registerevent-form-input" placeholder="Transaction ID (UTR)" value={transactionId} onChange={e => setTransactionId(e.target.value)} disabled={isSubmitting} />
              <button className="registerevent-modal-submit-btn" style={{ marginTop: '16px' }} onClick={handleSubmitUpiPayment} disabled={isSubmitting}>
                {isSubmitting ? "Verifying..." : "Submit Payment"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
