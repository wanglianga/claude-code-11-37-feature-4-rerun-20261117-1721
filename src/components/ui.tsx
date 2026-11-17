import type { ReactNode } from 'react';
import { LINE_STATUS_TONE } from '@/lib/constants';

const toneColor: Record<string, string> = {
  gray: '#5b6675',
  blue: '#2f54eb',
  green: '#389e0d',
  orange: '#d46b08',
  red: '#cf1322',
  purple: '#722ed1',
};

export function Badge({ tone = 'gray', children, dot }: { tone?: string; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`badge ${tone}`}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: toneColor[tone] ?? toneColor.gray }} />}
      {children}
    </span>
  );
}

export function LineStatusBadge({ status, label }: { status: string; label: string }) {
  return <Badge tone={LINE_STATUS_TONE[status] ?? 'gray'}>{label}</Badge>;
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="sm" onClick={onClose}>关闭</button>
        </div>
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <>
      <div className="drawer-mask" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <h3>{title}</h3>
          <button className="sm" onClick={onClose}>关闭</button>
        </div>
        {children}
      </div>
    </>
  );
}

export function EmptyState({ text }: { text: string }) {
  return <div className="empty">— {text} —</div>;
}

export function KeyValue({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
