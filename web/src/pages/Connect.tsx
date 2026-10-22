import { useState, type FormEvent } from 'react';
import { Icon } from '../components/icons';
import { defaultApiUrl, normalizeApiUrl, type Connection } from '../connection';
import { ApiError, validateConnection } from '../api';
import { browserTimeZone } from '../state/controls';

export interface ConnectProps {
  onConnected(conn: Connection): void;
  /** Why we are here again (e.g. the token was rejected). */
  notice?: string | null;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

export function connectErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401 || e.status === 403) return 'The API rejected that token. Use the read token from your Worker setup.';
    if (e.status === 0) return 'Could not reach the API. Check the URL, and that the Worker allows this origin (CORS).';
    if (e.status === 404) return 'No API at that URL. It should be the Worker root, without /api.';
    return e.message;
  }
  return e instanceof Error ? e.message : 'Something went wrong.';
}

/** First-run screen: API URL + read token, validated with GET /api/summary before saving. */
export default function Connect({ onConnected, notice, fetchImpl }: ConnectProps) {
  const [apiUrl, setApiUrl] = useState(defaultApiUrl);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const conn = { apiUrl: normalizeApiUrl(apiUrl), token: token.trim() };
    if (!conn.apiUrl || !conn.token) {
      setError('Both the API URL and the read token are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await validateConnection(conn, browserTimeZone(), fetchImpl);
      onConnected(conn);
    } catch (err) {
      setError(connectErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connect">
      <form className="connect-card" onSubmit={submit} noValidate>
        <div className="brand brand-lg">
          <span className="brand-mark" aria-hidden="true" />
          <span>Claude Usage</span>
        </div>
        <h1 className="connect-title">Connect to your usage API</h1>
        <p className="connect-lede">
          The dashboard reads from your own Cloudflare Worker. The URL and token stay in this browser only.
        </p>
        {notice && (
          <p className="notice notice-warning" role="status">
            <Icon name="alert" size={16} /> {notice}
          </p>
        )}
        <label className="field">
          <span className="field-label">API URL</span>
          <input
            type="url"
            inputMode="url"
            autoComplete="url"
            placeholder="https://claude-usage-api.example.workers.dev"
            value={apiUrl}
            onChange={(e) => setApiUrl(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span className="field-label">Read token</span>
          <input type="password" autoComplete="current-password" value={token} onChange={(e) => setToken(e.target.value)} required />
          <span className="field-hint">The read-only token, not the sync write token.</span>
        </label>
        {error && (
          <p className="notice notice-error" role="alert">
            <Icon name="alert" size={16} /> {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Checking...' : 'Connect'}
        </button>
        <p className="connect-demo">
          Just looking? <a href="?demo#/">Open the demo</a> with synthetic data.
        </p>
      </form>
    </div>
  );
}
