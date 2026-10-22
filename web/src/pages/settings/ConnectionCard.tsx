import { useState, type FormEvent } from 'react';
import { validateConnection } from '../../api';
import { Card, Icon } from '../../components';
import { normalizeApiUrl, saveConnection, type Connection } from '../../connection';
import { useApi } from '../../hooks/useApi';
import { useApiContext } from '../../state/api';
import { browserTimeZone } from '../../state/controls';
import { connectErrorMessage } from '../Connect';

interface Props {
  /** Injected for tests; defaults to a full reload so every provider picks up the new connection. */
  onSaved?: (c: Connection) => void;
}

function reloadWith(c: Connection) {
  saveConnection(c);
  window.location.reload();
}

function Reachability() {
  const ping = useApi(
    async (c, signal) => {
      const t0 = performance.now();
      const h = await c.health({ signal });
      return { version: h.version, ms: Math.round(performance.now() - t0) };
    },
    [],
    { auto: false },
  );
  if (ping.loading) return <span className="muted small">Checking…</span>;
  if (!ping.data) {
    return (
      <span className="status-badge status-critical">
        <Icon name="octagon" size={14} /> Unreachable
      </span>
    );
  }
  return (
    <span className="settings-row">
      <span className="status-badge status-ok">
        <Icon name="check" size={14} /> Reachable
      </span>
      <span className="muted small">
        v{ping.data.version} · {ping.data.ms} ms
      </span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={ping.reload} disabled={ping.refreshing}>
        <Icon name="refresh" size={14} /> Check again
      </button>
    </span>
  );
}

function ChangeForm({ initialUrl, onCancel, onSaved }: { initialUrl: string; onCancel: () => void; onSaved: (c: Connection) => void }) {
  const [apiUrl, setApiUrl] = useState(initialUrl);
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
      await validateConnection(conn, browserTimeZone());
      onSaved(conn);
    } catch (err) {
      setError(connectErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form className="settings-form" onSubmit={submit} noValidate>
      <label className="field">
        <span className="field-label">API URL</span>
        <input type="url" inputMode="url" autoComplete="url" spellCheck={false} value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} />
        <span className="field-hint">The Worker root, without /api.</span>
      </label>
      <label className="field">
        <span className="field-label">Read token</span>
        <input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
        <span className="field-hint">Checked against the API before it replaces the saved one.</span>
      </label>
      {error && (
        <p className="form-status form-error" role="alert">
          <Icon name="alert" size={14} /> {error}
        </p>
      )}
      <div className="settings-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Checking…' : 'Save connection'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function ConnectionCard({ onSaved = reloadWith }: Props) {
  const { demo, connection, disconnect } = useApiContext();
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm-forget'>('view');

  if (demo || !connection) {
    return (
      <Card id="settings-connection" title="API connection">
        <div className="notice">
          <p>
            You are viewing <strong>synthetic demo data</strong>. Nothing is read from or sent to any server, and settings changes last until you
            reload.
          </p>
        </div>
        <div className="settings-actions">
          <a className="btn" href="./#/">
            <Icon name="plug" size={16} /> Leave demo and connect
          </a>
        </div>
      </Card>
    );
  }

  return (
    <Card id="settings-connection" title="API connection" subtitle="Stored in this browser only">
      <dl className="kv">
        <dt>API</dt>
        <dd className="mono break">{connection.apiUrl}</dd>
        <dt>Read token</dt>
        <dd>Saved (hidden)</dd>
        <dt>Status</dt>
        <dd>
          <Reachability />
        </dd>
      </dl>
      {mode === 'edit' && <ChangeForm initialUrl={connection.apiUrl} onCancel={() => setMode('view')} onSaved={onSaved} />}
      {mode === 'view' && (
        <div className="settings-actions">
          <button type="button" className="btn" onClick={() => setMode('edit')}>
            Change connection
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setMode('confirm-forget')}>
            <Icon name="plug" size={16} /> Forget connection
          </button>
        </div>
      )}
      {mode === 'confirm-forget' && (
        <div className="notice notice-warning" role="alert">
          <p>Remove the API URL and token from this browser? You will need the read token to connect again.</p>
          <div className="settings-actions">
            <button type="button" className="btn btn-primary" onClick={disconnect}>
              Forget it
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setMode('view')}>
              Keep it
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
