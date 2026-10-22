import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { SettingsResponse } from '@ccu/shared';
import { AsyncView, Card, CostNote, Icon } from '../../components';
import type { ApiState } from '../../hooks/useApi';
import { useApiContext } from '../../state/api';
import { buildUpdate, hasErrors, parseThresholds, toDraft, type DraftErrors, type SettingsDraft } from './logic';

type SaveState = { kind: 'idle' | 'saving' | 'saved' | 'unchanged' } | { kind: 'error'; message: string };
type TestState = { kind: 'idle' | 'sending' } | { kind: 'done'; sent: boolean; message: string };

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/** Where the thresholds sit on a 0-100 track: a quick check that "75, 90" means what you think. */
function ThresholdTicks({ text, label }: { text: string; label: string }) {
  const parsed = parseThresholds(text);
  if (typeof parsed === 'string') return null;
  return (
    <span className="threshold-track" role="img" aria-label={`${label} alerts at ${parsed.join('%, ')}%`}>
      {parsed.map((p) => (
        <span key={p} className="threshold-tick" style={{ left: `${p}%` }}>
          <span className="threshold-tick-label">{p}%</span>
        </span>
      ))}
    </span>
  );
}

function FieldError({ id, text }: { id: string; text?: string }) {
  if (!text) return null;
  return (
    <span className="field-hint form-error" id={id}>
      <Icon name="alert" size={13} /> {text}
    </span>
  );
}

/** Whether the Worker has an NTFY_TOPIC secret. Older Workers don't report it, so say nothing then. */
function NtfyStatus({ configured }: { configured: boolean | undefined }) {
  if (configured === undefined) return null;
  return configured ? (
    <span className="field-hint" data-testid="ntfy-status">
      <Icon name="check" size={13} /> The Worker has an ntfy topic.
    </span>
  ) : (
    <span className="field-hint form-error" data-testid="ntfy-status">
      <Icon name="alert" size={13} /> ntfy is not configured: the Worker has no NTFY_TOPIC secret, so nothing will be sent.
    </span>
  );
}

function AlertsForm({ settings }: { settings: SettingsResponse }) {
  const { client, demo } = useApiContext();
  const [draft, setDraft] = useState<SettingsDraft>(() => toDraft(settings));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [test, setTest] = useState<TestState>({ kind: 'idle' });

  // A background refresh brings new server values; adopt them only when the user has no edits in flight.
  const [base, setBase] = useState(settings);
  const seen = useRef(settings);
  useEffect(() => {
    if (settings === seen.current) return;
    seen.current = settings;
    const pristine = Object.keys(buildUpdate(base, draft).update).length === 0;
    setBase(settings);
    if (pristine) setDraft(toDraft(settings));
  }, [settings, base, draft]);

  const set = <K extends keyof SettingsDraft>(k: K, v: SettingsDraft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setSave((s) => (s.kind === 'saving' ? s : { kind: 'idle' }));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const { errors: errs, update } = buildUpdate(base, draft);
    setErrors(errs);
    if (hasErrors(errs)) {
      setSave({ kind: 'error', message: 'Fix the highlighted fields.' });
      return;
    }
    if (Object.keys(update).length === 0) {
      setSave({ kind: 'unchanged' });
      return;
    }
    setSave({ kind: 'saving' });
    try {
      const next = await client.putSettings(update);
      setBase(next);
      setDraft(toDraft(next));
      setSave({ kind: 'saved' });
    } catch (err) {
      setSave({ kind: 'error', message: errorText(err, 'Could not save.') });
    }
  }

  async function sendTest() {
    setTest({ kind: 'sending' });
    try {
      const r = await client.alertsTest();
      setTest({ kind: 'done', sent: r.sent, message: r.sent ? 'Test notification sent. Check your phone.' : (r.error ?? 'Nothing was sent.') });
    } catch (err) {
      setTest({ kind: 'done', sent: false, message: errorText(err, 'Test failed.') });
    }
  }

  const invalid = (k: keyof SettingsDraft) => (errors[k] ? { 'aria-invalid': true, 'aria-describedby': `alerts-${k}-err` } : {});

  return (
    <form className="settings-form" onSubmit={submit} noValidate aria-label="Budget and alert settings">
      <fieldset className="settings-fieldset">
        <legend className="settings-legend">Budget</legend>
        <label className="field">
          <span className="field-label">Daily budget (USD, API-equivalent)</span>
          <span className="settings-input-prefix">
            <span aria-hidden="true">$</span>
            <input
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={draft.dailyBudgetUsd}
              onChange={(e) => set('dailyBudgetUsd', e.target.value)}
              {...invalid('dailyBudgetUsd')}
            />
          </span>
          <span className="field-hint">Alerts once a day when API-equivalent spend passes this. 0 turns it off.</span>
          <FieldError id="alerts-dailyBudgetUsd-err" text={errors.dailyBudgetUsd} />
        </label>
      </fieldset>

      <fieldset className="settings-fieldset">
        <legend className="settings-legend">Plan limit thresholds</legend>
        <label className="field">
          <span className="field-label">5-hour window (%)</span>
          <input type="text" inputMode="decimal" spellCheck={false} value={draft.fiveHour} onChange={(e) => set('fiveHour', e.target.value)} {...invalid('fiveHour')} />
          <ThresholdTicks text={draft.fiveHour} label="5-hour" />
          <FieldError id="alerts-fiveHour-err" text={errors.fiveHour} />
        </label>
        <label className="field">
          <span className="field-label">Weekly windows (%)</span>
          <input type="text" inputMode="decimal" spellCheck={false} value={draft.weekly} onChange={(e) => set('weekly', e.target.value)} {...invalid('weekly')} />
          <ThresholdTicks text={draft.weekly} label="Weekly" />
          <FieldError id="alerts-weekly-err" text={errors.weekly} />
        </label>
        <p className="field-hint">Comma-separated, up to 4. Each fires once per window when utilization crosses it.</p>
        <label className="settings-check">
          <input type="checkbox" checked={draft.weeklyPaceAlert} onChange={(e) => set('weeklyPaceAlert', e.target.checked)} />
          <span>
            Weekly pace alert
            <span className="field-hint">Warn when the current pace would use up a weekly limit before it resets.</span>
          </span>
        </label>
      </fieldset>

      <fieldset className="settings-fieldset">
        <legend className="settings-legend">Delivery</legend>
        <label className="field">
          <span className="field-label">Stale sync after (minutes)</span>
          <input
            type="number"
            min={10}
            max={1440}
            step={1}
            inputMode="numeric"
            value={draft.staleSyncMinutes}
            onChange={(e) => set('staleSyncMinutes', e.target.value)}
            {...invalid('staleSyncMinutes')}
          />
          <FieldError id="alerts-staleSyncMinutes-err" text={errors.staleSyncMinutes} />
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={draft.ntfyEnabled} onChange={(e) => set('ntfyEnabled', e.target.checked)} />
          <span>
            Push notifications (ntfy)
            <span className="field-hint">The topic is a Worker secret and is never shown here.</span>
          </span>
        </label>
        <NtfyStatus configured={base.ntfyConfigured as boolean | undefined} />
      </fieldset>

      <div className="settings-actions">
        <button type="submit" className="btn btn-primary" disabled={save.kind === 'saving'}>
          {save.kind === 'saving' ? 'Saving…' : 'Save alerts'}
        </button>
        <button type="button" className="btn" onClick={sendTest} disabled={test.kind === 'sending'}>
          <Icon name="inbox" size={16} /> {test.kind === 'sending' ? 'Sending…' : 'Send test notification'}
        </button>
      </div>
      <div className="settings-feedback" aria-live="polite">
        {save.kind === 'saved' && (
          <span className="form-status">
            <Icon name="check" size={14} /> Saved{demo ? ' (demo: kept until reload)' : ''}
          </span>
        )}
        {save.kind === 'unchanged' && <span className="form-status muted">No changes to save.</span>}
        {save.kind === 'error' && (
          <span className="form-status form-error">
            <Icon name="alert" size={14} /> {save.message}
          </span>
        )}
        {test.kind === 'done' && (
          <span className={`form-status${test.sent ? '' : ' muted'}`}>
            <Icon name={test.sent ? 'check' : 'info'} size={14} /> {test.message}
          </span>
        )}
      </div>
    </form>
  );
}

export function AlertsCard({ state }: { state: ApiState<SettingsResponse> }) {
  return (
    <Card id="settings-alerts" title="Budget and alerts" subtitle="Checked by the Worker every 5 minutes" refreshing={state.refreshing} footer={<CostNote compact />}>
      <AsyncView state={state} skeletonHeight={260}>
        {(s) => <AlertsForm settings={s} />}
      </AsyncView>
    </Card>
  );
}
