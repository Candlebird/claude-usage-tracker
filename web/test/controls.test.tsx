import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlsProvider, nextClock, useControls } from '../src/state/controls';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('nextClock', () => {
  const c0 = { tick: 0, now: 1000, dataTick: 0, dataNow: 1000 };
  it('advances only the live clock before the aggregate interval has passed', () => {
    expect(nextClock(c0, 1060, false, 270)).toEqual({ tick: 1, now: 1060, dataTick: 0, dataNow: 1000 });
  });
  it('advances the aggregate clock once enough time has passed', () => {
    expect(nextClock(c0, 1270, false, 270)).toEqual({ tick: 1, now: 1270, dataTick: 1, dataNow: 1270 });
  });
  it('always advances both on a forced (manual) refresh', () => {
    expect(nextClock(c0, 1001, true, 270)).toEqual({ tick: 1, now: 1001, dataTick: 1, dataNow: 1001 });
  });
});

function Probe() {
  const { tick, dataTick, range, dataNow } = useControls();
  return <output>{`${tick}/${dataTick}/${range.to === Math.floor(dataNow / 60) * 60}`}</output>;
}

describe('ControlsProvider refresh cadence', () => {
  it('refreshes aggregates five times less often than live data', () => {
    vi.useFakeTimers();
    let t = 1_790_000_000;
    render(
      <ControlsProvider now={() => t} refreshMs={60_000} aggregateMs={300_000}>
        <Probe />
      </ControlsProvider>,
    );
    for (let i = 0; i < 10; i++) {
      t += 60;
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
    }
    expect(screen.getByRole('status').textContent).toBe('10/2/true');
  });
});
