/** Every dollar figure is an API-equivalent estimate: the plan is flat-rate, not metered. */
export const COST_NOTE = 'API-equivalent cost at list prices; your subscription is flat-rate, not billed per token.';

export function CostNote({ compact }: { compact?: boolean }) {
  return <p className="cost-note">{compact ? 'API-equivalent cost, not a bill' : COST_NOTE}</p>;
}
