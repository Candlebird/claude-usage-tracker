import { Card, Segmented } from '../../components';
import { useTheme, type ThemeChoice } from '../../theme';

const THEMES = [
  { value: 'system' as const, label: 'System' },
  { value: 'dark' as const, label: 'Dark' },
  { value: 'light' as const, label: 'Light' },
];

export function AppearanceCard({ tz }: { tz: string }) {
  const { choice, setChoice } = useTheme();
  return (
    <Card id="settings-appearance" title="Appearance" subtitle="Saved in this browser">
      <div className="settings-stack">
        <Segmented<ThemeChoice> label="Theme" options={THEMES} value={choice} onChange={setChoice} />
        <dl className="kv">
          <dt>Time zone</dt>
          <dd>
            {tz} <span className="muted">(from this browser; days and hours are bucketed in it)</span>
          </dd>
        </dl>
      </div>
    </Card>
  );
}
