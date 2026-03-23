import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './style.css';

import { apiFetch } from './api.js';

export default function ForgotPassword() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState({ text: '', isError: false, show: false });

  const showMessage = (text, isError = false) => {
    setMessage({ text, isError, show: true });
    setTimeout(() => {
      setMessage(prev => ({ ...prev, show: false }));
    }, 5000);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!email) {
      showMessage('Please enter your email address', true);
      return;
    }

    if (!/\S+@\S+\.\S+/.test(email)) {
      showMessage('Please enter a valid email address', true);
      return;
    }

    setLoading(true);

    try {
      const response = await apiFetch('/api/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });

      const data = await response.json();

      if (response.ok && data.success) {
        showMessage(data.message || 'Link sent! Check your email (and Spam folder).');
        setEmail('');
        setTimeout(() => { navigate('/'); }, 3000);
      } else {
        showMessage(data.error || 'Failed to send reset link', true);
      }
    } catch (error) {
      console.error('Forgot password error:', error);
      showMessage('Network error. Please check your connection and try again.', true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="forgot-password-page">
      <link
        rel="stylesheet"
        href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.2/css/all.min.css"
      />

      {/* Toast — uses the same flo-toast system as Login */}
      {message.show && (
        <div className={`flo-toast ${message.isError ? 'flo-toast--error' : 'flo-toast--success'}`}>
          <span className="flo-toast-icon">{message.isError ? '✕' : '✓'}</span>
          {message.text}
        </div>
      )}

      <div className="forgot-card">
        <i className="fa-solid fa-lock" style={{
          fontSize: 28,
          color: 'var(--forest)',
          marginBottom: 12,
          display: 'block'
        }}></i>

        <h1>Forgot Password?</h1>

        <div className="divider" />

        <p>
          Enter your email address and we'll send you a link to reset your password.
          <br />
          <span style={{ fontSize: '0.88em', color: 'var(--gold)', fontWeight: 600 }}>
            Check your Spam/Junk folder if not found.
          </span>
        </p>

        <form className="forgot-form" onSubmit={handleSubmit}>
          <input
            type="email"
            placeholder="Enter your email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={loading}
            autoComplete="email"
          />

          <button type="submit" disabled={loading} className="submit-button">
            {loading ? 'Sending...' : 'Send Reset Link'}
          </button>

          <button
            type="button"
            onClick={() => navigate('/')}
            className="back-link"
            disabled={loading}
          >
            <i className="fa-solid fa-arrow-left" style={{ fontSize: 10 }}></i>
            Back to Sign In
          </button>
        </form>

        <div style={{
          marginTop: 20,
          padding: '12px 14px',
          background: 'var(--sand-deep)',
          border: '1.5px solid var(--sand-border)',
          fontSize: 12,
          color: 'var(--ink-muted)',
          fontFamily: 'DM Mono, monospace',
          letterSpacing: '0.03em'
        }}>
          <strong style={{ color: 'var(--ink)' }}>💡 TIP:</strong> Use the email you registered with.
        </div>
      </div>
    </div>
  );
}
