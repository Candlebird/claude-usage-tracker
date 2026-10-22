import { Icon } from '../../components';
import { fmtInt } from '../../format';
import { pageInfo } from './sessionsQuery';

export interface PaginationProps {
  total: number;
  page: number;
  size: number;
  onPage: (page: number) => void;
  /** Rows shown after the in-page text filter, when it hides some. */
  visible?: number;
}

export function Pagination({ total, page, size, onPage, visible }: PaginationProps) {
  const p = pageInfo(total, page, size);
  const pageRows = p.last - p.first + 1;
  return (
    <nav className="sess-pager" aria-label="Pagination">
      <span>
        {total === 0 ? 'No sessions' : `Showing ${fmtInt(p.first)}–${fmtInt(p.last)} of ${fmtInt(total)}`}
        {visible != null && total > 0 && visible < pageRows ? ` (${fmtInt(visible)} match the filter)` : ''}
      </span>
      {p.pages > 1 && (
        <span className="sess-pager-btns">
          <button type="button" className="btn btn-ghost btn-sm" disabled={!p.hasPrev} onClick={() => onPage(p.page - 1)} aria-label="Previous page">
            <Icon name="chevronLeft" size={14} /> Prev
          </button>
          <span className="muted">
            {p.page} / {p.pages}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!p.hasNext} onClick={() => onPage(p.page + 1)} aria-label="Next page">
            Next <Icon name="chevronRight" size={14} />
          </button>
        </span>
      )}
    </nav>
  );
}
