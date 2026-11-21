import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useState } from 'react';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { zDate } from '../tz';
import { ErrorText, fmtDate, fmtMoney, fmtTime } from '../ui';
import { monthRange } from './Finance';
import { AtBadge } from './Journal';
import { useBranches } from './Leads';

interface PayrollSettings {
  rates: { new: number; experienced: number };
  paidStatuses: string[];
}
interface PayrollTeacher {
  teacher: { id: string; firstName: string; lastName: string };
  category: 'new' | 'experienced';
  rate: number;
  lessons: number;
  visits: number;
  missed: number;
  amount: number;
  lines: { lessonId: string; startsAt: string; group: string; amount: number; students: { name: string; status: string; lessonPrice: number; amount: number }[] }[];
}
interface Payroll {
  settings: PayrollSettings;
  teachers: PayrollTeacher[];
  total: number;
}

/**
 * Оплата преподавателей (решение заказчика): за каждого пришедшего студента —
 * 30 % (новый) или 50 % (опытный) от цены занятия по абонементу; за пропуски — 0.
 * Бухгалтер и директор видят ведомость по всем, преподаватель — только свой расчёт.
 */
export function PayrollPage() {
  const { t } = useI18n();
  const { can, activeRole } = useAuth();
  const all = can('finance.salaries');
  const branches = useBranches();
  const [month, setMonth] = useState(() => zDate(new Date()).slice(0, 7));
  const [branchId, setBranchId] = useState<string>();
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['payroll', all, month, branchId],
    queryFn: () => api<Payroll>(all ? `/payroll${qs({ ...monthRange(month), branchId })}` : `/payroll/my${qs(monthRange(month))}`),
  });
  const d = q.data;

  return (
    <>
      <div className="toolbar">
        <h1 style={{ margin: 0, marginRight: 'auto' }}>{all ? t('payroll') : t('myPayroll')}</h1>
        <input type="month" style={{ width: 'auto' }} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label={t('period')} />
        {all && !activeRole?.branchId && (
          <select value={branchId ?? ''} onChange={(e) => setBranchId(e.target.value || undefined)}>
            <option value="">{t('allBranches')}</option>
            {branches.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="muted" style={{ marginTop: -6 }}>
        {t('payrollRule')}
      </p>
      {all && d && <RatesEditor settings={d.settings} />}
      <ErrorText error={q.error} />
      {d && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('teacher')}</th>
                <th>{t('category')}</th>
                <th>{t('rateShort')}</th>
                <th>{t('lessons')}</th>
                <th>{t('visits')}</th>
                <th>{t('missedPaid')}</th>
                <th>{t('accrued')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.teachers.map((x) => (
                <Fragment key={x.teacher.id}>
                  <tr>
                    <td>
                      <b>
                        {x.teacher.lastName} {x.teacher.firstName}
                      </b>
                    </td>
                    <td>{all ? <CategorySelect teacherId={x.teacher.id} value={x.category} /> : t(`cat.${x.category}`)}</td>
                    <td>{x.rate}%</td>
                    <td>{x.lessons}</td>
                    <td>{x.visits}</td>
                    <td className="muted">{x.missed}</td>
                    <td>
                      <b>{fmtMoney(x.amount)}</b>
                    </td>
                    <td>
                      <button className="small" onClick={() => setOpen(open === x.teacher.id ? null : x.teacher.id)} aria-expanded={open === x.teacher.id}>
                        {t('details')} {open === x.teacher.id ? '▴' : '▾'}
                      </button>
                    </td>
                  </tr>
                </Fragment>
              ))}
              {d.teachers.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    {t('noData')}
                  </td>
                </tr>
              )}
            </tbody>
            {d.teachers.length > 1 && (
              <tfoot>
                <tr>
                  <td colSpan={6}>
                    <b>{t('total')}</b>
                  </td>
                  <td colSpan={2}>
                    <b>{fmtMoney(d.total)}</b>
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {d && open && <PayrollDetails x={d.teachers.find((x) => x.teacher.id === open)} />}
    </>
  );
}

/** Расшифровка начислений преподавателя по занятиям и студентам. */
function PayrollDetails({ x }: { x?: PayrollTeacher }) {
  const { t } = useI18n();
  if (!x) return null;
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h3>
        {x.teacher.lastName} {x.teacher.firstName} · {x.rate}% · {fmtMoney(x.amount)}
      </h3>
      {x.lines.map((l) => (
        <div key={l.lessonId} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              <b>
                {fmtDate(l.startsAt, false)} {fmtTime(l.startsAt)}
              </b>{' '}
              · {l.group}
            </span>
            <b>{fmtMoney(l.amount)}</b>
          </div>
          <div className="payroll-students">
            {l.students.map((s, i) => (
              <span key={i} className={s.amount ? '' : 'muted'}>
                <AtBadge s={s.status} /> {s.name}:{' '}
                {s.amount ? `${x.rate}% × ${fmtMoney(s.lessonPrice)} = ${fmtMoney(s.amount)}` : `0 (${t(`at.${s.status}`)})`}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function CategorySelect({ teacherId, value }: { teacherId: string; value: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (category: string) => api(`/payroll/teachers/${teacherId}`, { method: 'PATCH', body: { category } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payroll'] }),
  });
  return (
    <select style={{ width: 'auto' }} value={value} disabled={m.isPending} onChange={(e) => m.mutate(e.target.value)} aria-label={t('category')}>
      {(['new', 'experienced'] as const).map((c) => (
        <option key={c} value={c}>
          {t(`cat.${c}`)}
        </option>
      ))}
    </select>
  );
}

function RatesEditor({ settings }: { settings: PayrollSettings }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [rates, setRates] = useState(settings.rates);
  useEffect(() => setRates(settings.rates), [settings.rates]);
  const m = useMutation({
    mutationFn: () => api('/payroll/settings', { method: 'PUT', body: { ...settings, rates } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payroll'] }),
  });
  const changed = rates.new !== settings.rates.new || rates.experienced !== settings.rates.experienced;
  return (
    <div className="card row" style={{ marginBottom: 14, alignItems: 'flex-end' }}>
      <b style={{ alignSelf: 'center' }}>{t('ratesTitle')}:</b>
      {(['new', 'experienced'] as const).map((c) => (
        <div key={c}>
          <label>{t(`cat.${c}`)}</label>
          <input type="number" min={0} max={100} style={{ width: 90 }} value={rates[c]} onChange={(e) => setRates({ ...rates, [c]: Number(e.target.value) })} />
        </div>
      ))}
      <button className="primary" disabled={!changed || m.isPending} onClick={() => m.mutate()}>
        {t('save')}
      </button>
      <ErrorText error={m.error} />
    </div>
  );
}
