/** Отчёты (ТЗ 3.10): период и филиал, Excel, печать в PDF; план выручки. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, openFile, qs } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { addDays, zDate } from '../tz';
import { ErrorText, fmtDate, fmtMoney } from '../ui';
import { useBranches } from './Leads';

const REPORTS = ['funnel', 'revenue', 'debts', 'load', 'retention', 'performance', 'payroll'] as const;
type Name = (typeof REPORTS)[number];
type ColType = 'text' | 'int' | 'money' | 'percent' | 'date';

interface Report {
  title: string;
  from: string;
  to: string;
  kpis?: { label: string; value: number | string; type?: ColType }[];
  sections: { title: string; columns: { key: string; title: string; type?: ColType }[]; rows: Record<string, unknown>[]; total?: Record<string, unknown> }[];
}

export function cell(v: unknown, type?: ColType) {
  if (v === null || v === undefined || v === '') return '—';
  if (type === 'money') return fmtMoney(Number(v));
  if (type === 'percent') return `${Number(v).toLocaleString('ru-RU')} %`;
  if (type === 'int') return Number(v).toLocaleString('ru-RU');
  if (type === 'date') return fmtDate(String(v), false);
  return String(v);
}

export function ReportsPage() {
  const { t } = useI18n();
  const { can, activeRole } = useAuth();
  const branches = useBranches();
  const today = zDate(new Date());
  const [name, setName] = useState<Name>('funnel');
  const [f, setF] = useState({ from: `${today.slice(0, 8)}01`, to: today, branchId: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  // В интерфейсе «по» включительно, API ожидает границу «до» — следующий день.
  const params = { from: f.from, to: addDays(f.to, 1), branchId: f.branchId || undefined };
  const q = useQuery({ queryKey: ['report', name, params], queryFn: () => api<Report>(`/reports/${name}${qs(params)}`) });
  const list = REPORTS.filter((r) => r !== 'payroll' || can('finance.salaries'));
  const r = q.data;

  async function excel() {
    setBusy(true);
    setErr(null);
    try {
      await openFile(`/reports/${name}${qs({ ...params, format: 'xlsx' })}`, `${r?.title ?? name} ${f.from}—${f.to}.xlsx`);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="toolbar no-print">
        <h1 style={{ margin: 0, marginRight: 'auto' }}>{t('reports')}</h1>
        <input type="date" style={{ width: 'auto' }} value={f.from} onChange={(e) => e.target.value && setF({ ...f, from: e.target.value })} aria-label={t('fromDate')} />
        <span>—</span>
        <input type="date" style={{ width: 'auto' }} value={f.to} onChange={(e) => e.target.value && setF({ ...f, to: e.target.value })} aria-label={t('toDate')} />
        {!activeRole?.branchId && (
          <select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}>
            <option value="">{t('allBranches')}</option>
            {branches.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
        {can('reports.export') && (
          <button onClick={excel} disabled={busy || !r}>
            ⬇ Excel
          </button>
        )}
        <button onClick={() => window.print()} disabled={!r}>
          🖨 {t('printPdf')}
        </button>
      </div>
      <div className="tabs no-print" role="tablist">
        {list.map((k) => (
          <button key={k} role="tab" aria-selected={name === k} className={name === k ? 'on' : ''} onClick={() => setName(k)}>
            {t(`rep.${k}`)}
          </button>
        ))}
      </div>
      <ErrorText error={q.error ?? err} />
      {r && (
        <div className="report">
          <h2 className="print-only">
            {r.title} · {fmtDate(r.from, false)} — {fmtDate(r.to, false)}
          </h2>
          {!!r.kpis?.length && (
            <div className="stats">
              {r.kpis.map((k) => (
                <div key={k.label} className="card stat">
                  <div className="v">{cell(k.value, k.type)}</div>
                  <div className="l">{k.label}</div>
                </div>
              ))}
            </div>
          )}
          {name === 'revenue' && can('finance.update') && !activeRole?.branchId && <PlanEditor month={f.from.slice(0, 7)} />}
          {r.sections.map((s) => (
            <section key={s.title} className="report-section">
              <h3>{s.title}</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {s.columns.map((c) => (
                        <th key={c.key} className={c.type && c.type !== 'text' && c.type !== 'date' ? 'num' : ''}>
                          {c.title}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {s.rows.map((row, i) => (
                      <tr key={i}>
                        {s.columns.map((c) => (
                          <td key={c.key} className={c.type && c.type !== 'text' && c.type !== 'date' ? 'num' : ''}>
                            {cell(row[c.key], c.type)}
                          </td>
                        ))}
                      </tr>
                    ))}
                    {s.rows.length === 0 && (
                      <tr>
                        <td colSpan={s.columns.length} className="muted">
                          {t('noData')}
                        </td>
                      </tr>
                    )}
                    {s.total && (
                      <tr className="total">
                        {s.columns.map((c) => (
                          <td key={c.key} className={c.type && c.type !== 'text' && c.type !== 'date' ? 'num' : ''}>
                            {s.total![c.key] !== undefined ? cell(s.total![c.key], c.type) : ''}
                          </td>
                        ))}
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function PlanEditor({ month }: { month: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const m = useMutation({
    mutationFn: () => api('/reports/revenue-plan', { method: 'PUT', body: { month, amount: Number(amount) } }),
    onSuccess: () => {
      setAmount('');
      qc.invalidateQueries({ queryKey: ['report'] });
      qc.invalidateQueries({ queryKey: ['kpi'] });
    },
  });
  return (
    <div className="card row no-print" style={{ marginBottom: 14 }}>
      <b>
        {t('revenuePlan')} {month}:
      </b>
      <input type="number" min={0} style={{ width: 160 }} value={amount} placeholder={t('amount')} onChange={(e) => setAmount(e.target.value)} />
      <button className="primary" disabled={!amount || m.isPending} onClick={() => m.mutate()}>
        {t('save')}
      </button>
      <ErrorText error={m.error} />
    </div>
  );
}

/** Ключевые показатели директора на дашборде. */
export function DirectorKpi() {
  const { t } = useI18n();
  const q = useQuery({
    queryKey: ['kpi'],
    queryFn: () =>
      api<{ month: string; revenue: number; plan: number | null; planPercent: number | null; debtTotal: number; debtors: number; groupLoad: number | null; attendance: number | null }>('/reports/kpi'),
  });
  const k = q.data;
  if (!k) return null;
  return (
    <div className="stats">
      <div className="card stat">
        <div className="v">{fmtMoney(k.revenue)}</div>
        <div className="l">
          {t('revenueMonth')}
          {k.planPercent !== null ? ` · ${t('planShort')} ${k.planPercent} %` : ''}
        </div>
        {k.plan && (
          <div className="bar" style={{ marginTop: 6 }}>
            <i style={{ width: `${Math.min(100, k.planPercent ?? 0)}%` }} />
          </div>
        )}
      </div>
      <div className="card stat">
        <div className="v neg">{fmtMoney(k.debtTotal)}</div>
        <div className="l">
          {t('debtTotal')} · {k.debtors}
        </div>
      </div>
      <div className="card stat">
        <div className="v">{k.groupLoad ?? '—'} %</div>
        <div className="l">{t('groupLoad')}</div>
      </div>
      <div className="card stat">
        <div className="v">{k.attendance ?? '—'} %</div>
        <div className="l">{t('attendanceMonth')}</div>
      </div>
    </div>
  );
}
