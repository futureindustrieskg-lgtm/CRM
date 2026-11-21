import { ReactNode, useEffect } from 'react';
import { useI18n } from './i18n';

export const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
export const GOALS = ['exam', 'work', 'study', 'family', 'other'];
export const SOURCES = ['site', 'whatsapp', 'telegram', 'instagram', 'call', 'referral', 'manual'];
export const STATUSES = ['active', 'paused', 'finished', 'left'];

export function fmtDate(d?: string | null, withTime = true) {
  if (!d) return '—';
  return new Date(d).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

export function fmtMoney(v: number | string | null | undefined) {
  if (v === null || v === undefined) return '—';
  return `${Number(v).toLocaleString('ru-RU')} сом`;
}

export function fmtPhone(p?: string | null) {
  if (!p) return '—';
  const m = p.match(/^996(\d{3})(\d{3})(\d{3})$/);
  return m ? `+996 ${m[1]} ${m[2]} ${m[3]}` : p;
}

function useEsc(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
}

export function Drawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEsc(onClose);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer">{children}</div>
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEsc(onClose);
  return (
    <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

/** Выпадающий список значений справочника с переводом. */
export function EnumSelect({
  value,
  onChange,
  options,
  prefix,
  empty = true,
}: {
  value?: string | null;
  onChange: (v: string | undefined) => void;
  options: string[];
  prefix?: string;
  empty?: boolean | string;
}) {
  const { t } = useI18n();
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
      {empty && <option value="">{typeof empty === 'string' ? empty : '—'}</option>}
      {options.map((o) => (
        <option key={o} value={o}>
          {prefix ? t(`${prefix}.${o}`) : o}
        </option>
      ))}
    </select>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="error">{error instanceof Error ? error.message : String(error)}</div>;
}
