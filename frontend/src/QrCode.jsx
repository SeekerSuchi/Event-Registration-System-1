import { useState, useEffect, useRef, useCallback } from 'react';
import './QrCode.css';

const TOKEN_INTERVAL_MS = 10000; // 10 seconds

export default function QrCode() {
  const [error, setError]         = useState(false);
  const [eventId, setEventId]     = useState(null);
  const [timeLeft, setTimeLeft]   = useState(TOKEN_INTERVAL_MS / 1000);
  const [libLoaded, setLibLoaded] = useState(false);
  const [status, setStatus]       = useState('loading'); // 'loading' | 'ready' | 'error'

  const qrCodeRef      = useRef(null);
  const qrInstanceRef  = useRef(null);   // holds QRCode instance
  const intervalRef    = useRef(null);   // QR refresh timer
  const countdownRef   = useRef(null);   // countdown timer
  const eidRef         = useRef(null);   // stable ref for eventId

  // ── 1. Parse URL params & load QR lib ──────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const eid    = params.get('eventId');

    if (!eid) { setError(true); setStatus('error'); return; }

    setEventId(eid);
    eidRef.current = eid;

    const script    = document.createElement('script');
    script.src      = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    script.async    = true;
    script.onload   = () => setLibLoaded(true);
    script.onerror  = () => { setError(true); setStatus('error'); };
    document.body.appendChild(script);

    return () => {
      clearInterval(intervalRef.current);
      clearInterval(countdownRef.current);
      if (document.body.contains(script)) document.body.removeChild(script);
    };
  }, []);

  // ── 2. Fetch a fresh token from the server ──────────────────────────────────
  const fetchToken = useCallback(async (eid) => {
    const res  = await fetch(`/api/events/${eid}/qr-token`, { credentials: 'include' });
    if (!res.ok) throw new Error('Token fetch failed');
    const { token, timestamp } = await res.json();
    return { token, timestamp };
  }, []);

  // ── 3. Render / refresh the QR code ────────────────────────────────────────
  const refreshQR = useCallback(async () => {
    const eid = eidRef.current;
    if (!eid || !window.QRCode || !qrCodeRef.current) return;

    try {
      const { token, timestamp } = await fetchToken(eid);
      const qrText = `eventId:${eid}:${token}:${timestamp}`;

      if (qrInstanceRef.current) {
        // Update existing instance
        qrInstanceRef.current.clear();
        qrInstanceRef.current.makeCode(qrText);
      } else {
        // Create fresh instance
        qrInstanceRef.current = new window.QRCode(qrCodeRef.current, {
          text:         qrText,
          width:        256,
          height:       256,
          colorDark:    '#000000',
          colorLight:   '#ffffff',
          correctLevel: window.QRCode.CorrectLevel.H,
        });
      }

      setTimeLeft(TOKEN_INTERVAL_MS / 1000);
      setStatus('ready');
    } catch (err) {
      console.error('QR refresh error:', err);
      setStatus('error');
    }
  }, [fetchToken]);

  // ── 4. Start rotation once lib is ready ────────────────────────────────────
  useEffect(() => {
    if (!libLoaded || !eventId) return;

    // Initial render
    refreshQR();

    // Refresh every 10 s
    intervalRef.current = setInterval(refreshQR, TOKEN_INTERVAL_MS);

    // Countdown tick every 1 s
    countdownRef.current = setInterval(() => {
      setTimeLeft(prev => (prev <= 1 ? TOKEN_INTERVAL_MS / 1000 : prev - 1));
    }, 1000);

    return () => {
      clearInterval(intervalRef.current);
      clearInterval(countdownRef.current);
    };
  }, [libLoaded, eventId, refreshQR]);

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const progressPct = (timeLeft / (TOKEN_INTERVAL_MS / 1000)) * 100;

  const urgencyColor =
    timeLeft <= 3 ? '#ef4444' :
    timeLeft <= 6 ? '#f59e0b' :
    '#22c55e';

  return (
    <div className="qr-code-page">
      <div className="qr-container">

        {/* Header */}
        <div className="qr-header">
          <h1>Event Check-in QR Code</h1>
          <p className="subtitle">This code refreshes every 10 seconds for security</p>
          {eventId && <p className="event-id-display">Event ID: {eventId}</p>}
        </div>

        {error ? (
          <div className="error-message">
            <h3>⚠️ Error</h3>
            <p>Unable to generate QR code. Make sure you're signed in and have a valid Event ID.</p>
          </div>
        ) : (
          <div className="card">
            <div className="card-header">
              <h2>Attendance QR Code</h2>
              <p className="card-subtitle">For organizer display only — do not screenshot</p>
            </div>

            {/* QR Code area */}
            <div className="qr-wrapper">
              <div
                ref={qrCodeRef}
                className={`qr-code ${status === 'loading' ? 'qr-loading' : ''}`}
              />
              {status === 'loading' && (
                <div className="qr-overlay">
                  <div className="spinner" />
                  <span>Generating…</span>
                </div>
              )}
            </div>

            {/* Countdown ring */}
            {status === 'ready' && (
              <div className="countdown-section">
                <svg className="countdown-ring" viewBox="0 0 60 60">
                  <circle cx="30" cy="30" r="26" fill="none" stroke="#e5e7eb" strokeWidth="4" />
                  <circle
                    cx="30" cy="30" r="26"
                    fill="none"
                    stroke={urgencyColor}
                    strokeWidth="4"
                    strokeDasharray={`${2 * Math.PI * 26}`}
                    strokeDashoffset={`${2 * Math.PI * 26 * (1 - progressPct / 100)}`}
                    strokeLinecap="round"
                    transform="rotate(-90 30 30)"
                    style={{ transition: 'stroke-dashoffset 0.9s linear, stroke 0.3s' }}
                  />
                  <text x="30" y="35" textAnchor="middle" fontSize="14" fontWeight="bold" fill={urgencyColor}>
                    {timeLeft}s
                  </text>
                </svg>
                <span className="countdown-label">Refreshes in {timeLeft}s</span>
              </div>
            )}

            <div className="qr-instructions">
              <p>📱 Participants and volunteers scan this code</p>
              <p>🔒 Each code is valid for 10 seconds only</p>
              <p>✅ Scanning marks attendance automatically</p>
            </div>
          </div>
        )}

        <button onClick={() => window.history.back()} className="back-btn">
          ← Back to Event
        </button>
      </div>
    </div>
  );
}
