import { useEffect, useState } from 'react';
import { nowSeconds } from '@ccu/shared';

/** Unix seconds, re-rendering every `ms` (for countdowns). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(nowSeconds);
  useEffect(() => {
    const id = setInterval(() => setNow(nowSeconds()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
