import { PRESET_LABEL, RANGE_PRESETS, dateInputToUnix, unixToDateInput, type RangePreset } from '../state/range';
import { useControls } from '../state/controls';
import { Segmented } from './Segmented';

const OPTIONS = [...RANGE_PRESETS, 'custom' as const].map((v) => ({ value: v as RangePreset, label: PRESET_LABEL[v] }));

/** The global range control: presets plus a custom from/to (browser-local dates, inclusive). */
export function DateRangeControl() {
  const { preset, range, setPreset, setCustom } = useControls();
  return (
    <div className="range-control">
      <Segmented label="Date range" options={OPTIONS} value={preset} onChange={setPreset} size="sm" />
      {preset === 'custom' && (
        <div className="range-custom">
          <label>
            <span className="sr-only">From</span>
            <input
              type="date"
              value={unixToDateInput(range.from)}
              max={unixToDateInput(range.to)}
              onChange={(e) => {
                const from = dateInputToUnix(e.target.value);
                if (from != null && from < range.to) setCustom({ from, to: range.to });
              }}
            />
          </label>
          <span aria-hidden="true">to</span>
          <label>
            <span className="sr-only">To</span>
            <input
              type="date"
              value={unixToDateInput(range.to - 1)}
              min={unixToDateInput(range.from)}
              onChange={(e) => {
                const to = dateInputToUnix(e.target.value, true);
                if (to != null && to > range.from) setCustom({ from: range.from, to });
              }}
            />
          </label>
        </div>
      )}
    </div>
  );
}
