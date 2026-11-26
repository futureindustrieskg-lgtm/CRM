import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { zDate, zonedToUtc } from '../tz';
import { EnumSelect, ErrorText, Field, fmtDate, fmtMoney, Modal } from '../ui';
import { useCourses } from './Courses';
import { PaymentLinkButton } from './Integrations';
import { useBranches } from './Leads';

export const PAY_METHODS = ['cash', 'transfer', 'qr', 'card_online'];
export const SUB_TYPES = ['month', 'level', 'package', 'installment'];
export const DISCOUNT_TYPES = ['family', 'friend', 'full_level', 'promo', 'other'];

interface Person {
  id: string;
  firstName: string;
  lastName: string;
}
interface Payment {
  id: string;
  amount: string;
  type: string;
  method: string;
  comment: string | null;
  paidAt: string;
  deleteReason: string | null;
  student: Person;
  branch: { name: string };
  subscription: { course: { name: string } } | null;
}
export interface Subscription {
  id: string;
  type: string;
  status: string;
  lessonsTotal: number;
  used: number;
  remaining: number;
  price: string;
  basePrice: string;
  discountPercent: string;
  discountType: string | null;
  lessonPrice: number;
  startDate: string;
  closeReason: string | null;
  student: Person;
  course: { id: string; name: string };
  group: { id: string; name: string } | null;
}
interface Tariff {
  id: string;
  name: string;
  type: string;
  lessons: number;
  price: string;
  installments: number;
  isActive: boolean;
  courseId: string | null;
  course: { id: string; name: string } | null;
}

/** Месяц "YYYY-MM" → границы периода в поясе центра. */
export function monthRange(month: string) {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { from: zonedToUtc(`${month}-01`).toISOString(), to: zonedToUtc(`${next}-01`).toISOString() };
}

function useInvalidateFinance() {
  const qc = useQueryClient();
  return () => ['payments', 'subscriptions', 'debtors', 'summary', 'students', 'student', 'dashboard', 'group'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
}

export function FinancePage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'payments' | 'subscriptions' | 'debtorsTab' | 'summary' | 'tariffs'>('payments');
  return (
    <>
      <h1>{t('finance')}</h1>
      <div className="tabs" role="tablist">
        {(['payments', 'subscriptions', 'debtorsTab', 'summary', 'tariffs'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {t(k)}
          </button>
        ))}
      </div>
      {tab === 'payments' && <PaymentsTab />}
      {tab === 'subscriptions' && <SubscriptionsTab />}
      {tab === 'debtorsTab' && <DebtorsTab />}
      {tab === 'summary' && <SummaryTab />}
      {tab === 'tariffs' && <TariffsTab />}
    </>
  );
}

function BranchFilter({ value, onChange }: { value?: string; onChange: (v?: string) => void }) {
  const { t } = useI18n();
  const { activeRole } = useAuth();
  const branches = useBranches();
  if (activeRole?.branchId) return null;
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">{t('allBranches')}</option>
      {branches.data?.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </select>
  );
}

// ───────────── Оплаты ─────────────

function PaymentsTab() {
  const { t } = useI18n();
  const { can } = useAuth();
  const invalidate = useInvalidateFinance();
  const [month, setMonth] = useState(() => zDate(new Date()).slice(0, 7));
  const [f, setF] = useState<{ branchId?: string; method?: string; deleted?: string }>({});
  const [adding, setAdding] = useState(false);
  const list = useQuery({
    queryKey: ['payments', month, f],
    queryFn: () => api<Payment[]>(`/payments${qs({ ...monthRange(month), ...f })}`),
  });
  const del = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api(`/payments/${id}/delete`, { method: 'POST', body: { reason } }),
    onSuccess: invalidate,
  });
  const total = (list.data ?? []).reduce((s, p) => s + Number(p.amount), 0);
  return (
    <>
      <div className="toolbar">
        <input type="month" style={{ width: 'auto' }} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label={t('period')} />
        <BranchFilter value={f.branchId} onChange={(v) => setF({ ...f, branchId: v })} />
        <EnumSelect value={f.method} onChange={(v) => setF({ ...f, method: v })} options={PAY_METHODS} prefix="pm" empty={t('method')} />
        <label className="row" style={{ margin: 0, gap: 6, color: 'var(--text)' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={!!f.deleted} onChange={(e) => setF({ ...f, deleted: e.target.checked ? '1' : undefined })} />
          {t('deleted')}
        </label>
        <b style={{ marginLeft: 'auto' }}>
          {t('total')}: {fmtMoney(total)}
        </b>
        {can('finance.create') && (
          <button className="primary" onClick={() => setAdding(true)}>
            + {t('newPayment')}
          </button>
        )}
      </div>
      <ErrorText error={list.error ?? del.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('paidAt')}</th>
              <th>{t('students')}</th>
              <th>{t('amount')}</th>
              <th>{t('method')}</th>
              <th>{t('course')}</th>
              <th>{t('branch')}</th>
              <th>{t('comment')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data?.map((p) => (
              <tr key={p.id}>
                <td>{fmtDate(p.paidAt)}</td>
                <td>
                  <Link to={`/students/${p.student.id}`}>
                    {p.student.lastName} {p.student.firstName}
                  </Link>
                </td>
                <td className={Number(p.amount) < 0 ? 'neg' : ''}>
                  {fmtMoney(p.amount)} {p.type === 'refund' && <span className="badge">{t('ptype.refund')}</span>}
                </td>
                <td>{t(`pm.${p.method}`)}</td>
                <td>{p.subscription?.course.name ?? '—'}</td>
                <td>{p.branch.name}</td>
                <td className="muted" style={{ whiteSpace: 'normal' }}>
                  {p.deleteReason ? `✕ ${p.deleteReason}` : p.comment ?? ''}
                </td>
                <td>
                  {can('finance.delete_records') && !f.deleted && (
                    <button
                      className="small danger"
                      onClick={() => {
                        const reason = window.prompt(t('deleteReason'));
                        if (reason?.trim()) del.mutate({ id: p.id, reason });
                      }}
                      aria-label={t('deleteReason')}
                    >
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {list.data?.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  {t('noData')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {adding && <PaymentModal onClose={() => setAdding(false)} />}
    </>
  );
}

/** Приём оплаты или возврат. studentId — когда открыто из карточки студента. */
export function PaymentModal({ studentId, onClose }: { studentId?: string; onClose: () => void }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const invalidate = useInvalidateFinance();
  const [search, setSearch] = useState('');
  const students = useQuery({
    queryKey: ['students', { search }],
    queryFn: () => api<(Person & { balance: string })[]>(`/students${qs({ search })}`),
    enabled: !studentId,
  });
  const subs = useQuery({
    queryKey: ['subscriptions', { studentId }],
    queryFn: () => api<Subscription[]>(`/subscriptions${qs({ studentId })}`),
    enabled: !!studentId,
  });
  const [f, setF] = useState({ studentId: studentId ?? '', amount: '', method: 'cash', type: 'payment', comment: '', subscriptionId: '' });
  const m = useMutation({
    mutationFn: () =>
      api('/payments', {
        method: 'POST',
        body: { ...f, amount: Number(f.amount), comment: f.comment || undefined, subscriptionId: f.subscriptionId || undefined },
      }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  return (
    <Modal title={f.type === 'refund' ? t('refund') : t('newPayment')} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        {!studentId && (
          <Field label={t('students')}>
            <input placeholder={t('search')} value={search} onChange={(e) => setSearch(e.target.value)} style={{ marginBottom: 6 }} />
            <select required value={f.studentId} onChange={(e) => setF({ ...f, studentId: e.target.value })} size={5}>
              {students.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.lastName} {s.firstName} · {fmtMoney(s.balance)}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="grid2">
          <Field label={`${t('amount')}, сом`}>
            <input type="number" min={0.01} step="0.01" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          </Field>
          <Field label={t('method')}>
            <EnumSelect value={f.method} onChange={(v) => setF({ ...f, method: v! })} options={PAY_METHODS} prefix="pm" empty={false} />
          </Field>
          {can('finance.update') && (
            <Field label={t('type')}>
              <EnumSelect value={f.type} onChange={(v) => setF({ ...f, type: v! })} options={['payment', 'refund']} prefix="ptype" empty={false} />
            </Field>
          )}
          {studentId && (
            <Field label={t('subscriptions')}>
              <select value={f.subscriptionId} onChange={(e) => setF({ ...f, subscriptionId: e.target.value })}>
                <option value="">—</option>
                {subs.data
                  ?.filter((s) => ['active', 'finished'].includes(s.status))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.group?.name ?? s.course.name} · {fmtMoney(s.price)}
                    </option>
                  ))}
              </select>
            </Field>
          )}
        </div>
        <Field label={t('comment')}>
          <input value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} />
        </Field>
        <ErrorText error={m.error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="primary" disabled={m.isPending || !f.studentId}>
            {t('save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ───────────── Абонементы ─────────────

function SubscriptionsTab() {
  const { t } = useI18n();
  const [f, setF] = useState<{ branchId?: string; status?: string }>({ status: 'active' });
  const list = useQuery({ queryKey: ['subscriptions', f], queryFn: () => api<Subscription[]>(`/subscriptions${qs(f)}`) });
  return (
    <>
      <div className="toolbar">
        <BranchFilter value={f.branchId} onChange={(v) => setF({ ...f, branchId: v })} />
        <EnumSelect value={f.status} onChange={(v) => setF({ ...f, status: v })} options={['active', 'finished', 'cancelled', 'transferred']} prefix="subs" empty={t('status')} />
      </div>
      <SubscriptionsTable rows={list.data} showStudent />
    </>
  );
}

export function SubscriptionsTable({ rows, showStudent }: { rows?: Subscription[]; showStudent?: boolean }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const [cancel, setCancel] = useState<Subscription | null>(null);
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {showStudent && <th>{t('students')}</th>}
              <th>{t('courseOrGroup')}</th>
              <th>{t('type')}</th>
              <th>
                {t('used')} / {t('lessonsShort')}
              </th>
              <th>{t('price')}</th>
              <th>{t('lessonPrice')}</th>
              <th>{t('status')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows?.map((s) => (
              <tr key={s.id}>
                {showStudent && (
                  <td>
                    <Link to={`/students/${s.student.id}`}>
                      {s.student.lastName} {s.student.firstName}
                    </Link>
                  </td>
                )}
                <td>
                  {s.group?.name ?? s.course.name}
                  <div className="muted" style={{ fontSize: 12 }}>
                    {fmtDate(s.startDate, false)}
                  </div>
                </td>
                <td>{t(`subt.${s.type}`)}</td>
                <td>
                  <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                    <div className={`bar ${s.remaining <= 2 && s.status === 'active' ? '' : 'full'}`}>
                      <i style={{ width: `${s.lessonsTotal ? Math.min(100, (s.used / s.lessonsTotal) * 100) : 100}%` }} />
                    </div>
                    {s.used}/{s.lessonsTotal}
                  </div>
                </td>
                <td>
                  {fmtMoney(s.price)}
                  {Number(s.discountPercent) > 0 && (
                    <div className="muted" style={{ fontSize: 12 }}>
                      −{Number(s.discountPercent)}% {s.discountType ? t(`disc.${s.discountType}`) : ''}
                    </div>
                  )}
                </td>
                <td>{fmtMoney(s.lessonPrice)}</td>
                <td>
                  <span className="badge" title={s.closeReason ?? ''}>
                    {t(`subs.${s.status}`)}
                  </span>
                </td>
                <td>
                  {can('finance.update') && ['active', 'finished'].includes(s.status) && (
                    <button className="small danger" onClick={() => setCancel(s)}>
                      {t('cancelSubscription')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rows?.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  {t('noData')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {cancel && <CancelSubscriptionModal sub={cancel} onClose={() => setCancel(null)} />}
    </>
  );
}

function CancelSubscriptionModal({ sub, onClose }: { sub: Subscription; onClose: () => void }) {
  const { t } = useI18n();
  const invalidate = useInvalidateFinance();
  const [f, setF] = useState({ reason: '', refund: '', method: 'cash' });
  const usedValue = Math.round(sub.used * sub.lessonPrice * 100) / 100;
  const m = useMutation({
    mutationFn: () =>
      api(`/subscriptions/${sub.id}/cancel`, {
        method: 'POST',
        body: { reason: f.reason, refund: f.refund ? Number(f.refund) : undefined, method: f.method },
      }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  return (
    <Modal title={`${t('cancelSubscription')}: ${sub.student.lastName} ${sub.student.firstName}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <dl className="kv">
          <dt>{t('used')}</dt>
          <dd>
            {sub.used} × {fmtMoney(sub.lessonPrice)} = {fmtMoney(usedValue)}
          </dd>
          <dt>{t('price')}</dt>
          <dd>
            {fmtMoney(sub.price)} → {fmtMoney(usedValue)}
          </dd>
        </dl>
        <Field label={`${t('reason')} *`}>
          <input required value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        </Field>
        <div className="grid2">
          <Field label={t('refundNow')}>
            <input type="number" min={0} step="0.01" value={f.refund} onChange={(e) => setF({ ...f, refund: e.target.value })} />
          </Field>
          <Field label={t('method')}>
            <EnumSelect value={f.method} onChange={(v) => setF({ ...f, method: v! })} options={PAY_METHODS} prefix="pm" empty={false} />
          </Field>
        </div>
        <ErrorText error={m.error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="primary danger" disabled={m.isPending}>
            {t('cancelSubscription')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Продажа абонемента из карточки студента. */
export function SellSubscriptionModal({
  student,
  onClose,
}: {
  student: { id: string; groups: { leftAt: string | null; group: { id: string; name: string; course: { id: string; name: string } } }[] };
  onClose: () => void;
}) {
  const { t } = useI18n();
  const invalidate = useInvalidateFinance();
  const groups = student.groups.filter((g) => !g.leftAt);
  const [f, setF] = useState({
    groupId: groups[0]?.group.id ?? '',
    tariffId: '',
    type: 'package',
    lessonsTotal: '',
    basePrice: '',
    discountPercent: '',
    discountType: '',
    promoCode: '',
  });
  // Курс берём из карточки студента: у бухгалтера может не быть права на просмотр групп.
  const courseId = groups.find((g) => g.group.id === f.groupId)?.group.course.id;
  const tariffs = useQuery({
    queryKey: ['tariffs', courseId],
    queryFn: () => api<Tariff[]>(`/tariffs${qs({ courseId })}`),
    enabled: !!courseId,
  });
  const tariff = tariffs.data?.find((x) => x.id === f.tariffId);
  const base = tariff ? Number(tariff.price) : Number(f.basePrice || 0);
  const price = Math.round(base * (1 - Number(f.discountPercent || 0) / 100) * 100) / 100;
  const m = useMutation({
    mutationFn: () =>
      api('/subscriptions', {
        method: 'POST',
        body: {
          studentId: student.id,
          groupId: f.groupId,
          tariffId: f.tariffId || undefined,
          type: f.tariffId ? undefined : f.type,
          lessonsTotal: f.tariffId ? undefined : Number(f.lessonsTotal),
          basePrice: f.tariffId ? undefined : Number(f.basePrice),
          discountPercent: f.discountPercent ? Number(f.discountPercent) : undefined,
          discountType: f.discountType || undefined,
          promoCode: f.promoCode || undefined,
        },
      }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  return (
    <Modal title={t('sellSubscription')} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label={t('group')}>
          <select required value={f.groupId} onChange={(e) => setF({ ...f, groupId: e.target.value, tariffId: '' })}>
            {groups.map((g) => (
              <option key={g.group.id} value={g.group.id}>
                {g.group.name} · {g.group.course.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('tariffs')}>
          <select value={f.tariffId} onChange={(e) => setF({ ...f, tariffId: e.target.value })}>
            <option value="">{t('manualPrice')}</option>
            {tariffs.data?.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} · {x.lessons} · {fmtMoney(x.price)}
              </option>
            ))}
          </select>
        </Field>
        {!f.tariffId && (
          <div className="grid2">
            <Field label={t('type')}>
              <EnumSelect value={f.type} onChange={(v) => setF({ ...f, type: v! })} options={SUB_TYPES} prefix="subt" empty={false} />
            </Field>
            <Field label={t('lessonsShort')}>
              <input type="number" min={1} required value={f.lessonsTotal} onChange={(e) => setF({ ...f, lessonsTotal: e.target.value })} />
            </Field>
            <Field label={`${t('basePrice')}, сом`}>
              <input type="number" min={0} required value={f.basePrice} onChange={(e) => setF({ ...f, basePrice: e.target.value })} />
            </Field>
          </div>
        )}
        <div className="grid2">
          <Field label={`${t('discount')}, %`}>
            <input type="number" min={0} max={100} value={f.discountPercent} onChange={(e) => setF({ ...f, discountPercent: e.target.value })} />
          </Field>
          <Field label={t('discountType')}>
            <EnumSelect value={f.discountType} onChange={(v) => setF({ ...f, discountType: v ?? '' })} options={DISCOUNT_TYPES} prefix="disc" />
          </Field>
          {f.discountType === 'promo' && (
            <Field label={t('promoCode')}>
              <input value={f.promoCode} onChange={(e) => setF({ ...f, promoCode: e.target.value })} />
            </Field>
          )}
        </div>
        <div className="card" style={{ margin: '4px 0 12px' }}>
          {t('price')}: <b>{fmtMoney(price)}</b>
          {tariff && ` · ${tariff.lessons} × ${fmtMoney(Math.round((price / tariff.lessons) * 100) / 100)}`}
        </div>
        <ErrorText error={m.error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="primary" disabled={m.isPending || !f.groupId}>
            {t('sellSubscription')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Блок «Абонементы и баланс» в карточке студента. */
export function StudentFinance({ student }: { student: Parameters<typeof SellSubscriptionModal>[0]['student'] & { balance: string } }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const [sell, setSell] = useState(false);
  const [pay, setPay] = useState(false);
  const subs = useQuery({
    queryKey: ['subscriptions', { studentId: student.id }],
    queryFn: () => api<Subscription[]>(`/subscriptions${qs({ studentId: student.id })}`),
    enabled: can('finance.read'),
  });
  if (!can('finance.read')) return null;
  const balance = Number(student.balance);
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0, marginRight: 'auto' }}>{t('subscriptions')}</h3>
        <span className={balance < 0 ? 'neg' : ''}>
          {t('balance')}: {fmtMoney(balance)} {balance > 0 && <span className="muted">({t('overpay')})</span>}
        </span>
        {can('finance.create') && (
          <>
            <button className="small" onClick={() => setPay(true)}>
              + {t('newPayment')}
            </button>
            <PaymentLinkButton studentId={student.id} balance={balance} />
            <button className="small primary" onClick={() => setSell(true)} disabled={!student.groups.some((g) => !g.leftAt)}>
              + {t('sellSubscription')}
            </button>
          </>
        )}
      </div>
      <div style={{ marginBottom: 16 }}>
        <SubscriptionsTable rows={subs.data} />
      </div>
      {sell && <SellSubscriptionModal student={student} onClose={() => setSell(false)} />}
      {pay && <PaymentModal studentId={student.id} onClose={() => setPay(false)} />}
    </>
  );
}

// ───────────── Должники ─────────────

function DebtorsTab() {
  const { t } = useI18n();
  const [branchId, setBranchId] = useState<string>();
  const q = useQuery({
    queryKey: ['debtors', branchId],
    queryFn: () =>
      api<{
        negative: (Person & { balance: string; phone: string | null; status: string; branch: { name: string } })[];
        unpaidLessons: { student: Person; lessons: number }[];
        ending: (Subscription & { group: { name: string } | null })[];
      }>(`/finance/debtors${qs({ branchId })}`),
  });
  const d = q.data;
  return (
    <>
      <div className="toolbar">
        <BranchFilter value={branchId} onChange={setBranchId} />
      </div>
      <ErrorText error={q.error} />
      {d && (
        <>
          <h3>
            {t('negativeBalance')} ({d.negative.length})
          </h3>
          <div className="table-wrap" style={{ marginBottom: 18 }}>
            <table>
              <tbody>
                {d.negative.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link to={`/students/${s.id}`}>
                        {s.lastName} {s.firstName}
                      </Link>
                    </td>
                    <td className="neg">{fmtMoney(s.balance)}</td>
                    <td>{s.phone ?? ''}</td>
                    <td className="muted">{s.branch.name}</td>
                    <td>{t(`st.${s.status}`)}</td>
                  </tr>
                ))}
                {d.negative.length === 0 && (
                  <tr>
                    <td className="muted">{t('noData')}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <h3>
            {t('unpaidLessons')} ({d.unpaidLessons.length})
          </h3>
          <div className="table-wrap" style={{ marginBottom: 18 }}>
            <table>
              <tbody>
                {d.unpaidLessons.map((u) => (
                  <tr key={u.student.id}>
                    <td>
                      <Link to={`/students/${u.student.id}`}>
                        {u.student.lastName} {u.student.firstName}
                      </Link>
                    </td>
                    <td className="neg">{u.lessons}</td>
                  </tr>
                ))}
                {d.unpaidLessons.length === 0 && (
                  <tr>
                    <td className="muted">{t('noData')}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <h3>
            {t('endingSubs')} ({d.ending.length})
          </h3>
          <div className="table-wrap">
            <table>
              <tbody>
                {d.ending.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link to={`/students/${s.student.id}`}>
                        {s.student.lastName} {s.student.firstName}
                      </Link>
                    </td>
                    <td>{s.group?.name ?? '—'}</td>
                    <td>
                      {t('remaining')}: <b>{s.remaining}</b> / {s.lessonsTotal}
                    </td>
                  </tr>
                ))}
                {d.ending.length === 0 && (
                  <tr>
                    <td className="muted">{t('noData')}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

// ───────────── Сводка ─────────────

function SummaryTab() {
  const { t } = useI18n();
  const [month, setMonth] = useState(() => zDate(new Date()).slice(0, 7));
  const [branchId, setBranchId] = useState<string>();
  const q = useQuery({
    queryKey: ['summary', month, branchId],
    queryFn: () =>
      api<{
        income: number;
        refunds: number;
        net: number;
        byMethod: { name: string; amount: number }[];
        byBranch: { name: string; amount: number }[];
        byCourse: { name: string; amount: number }[];
        subscriptionsSold: number;
        subscriptionsAmount: number;
      }>(`/finance/summary${qs({ ...monthRange(month), branchId })}`),
  });
  const d = q.data;
  const list = (title: string, rows: { name: string; amount: number }[], prefix?: string) => (
    <div className="card">
      <h3>{title}</h3>
      {rows.length === 0 && <div className="muted">{t('noData')}</div>}
      {rows.map((r) => (
        <div key={r.name} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
          <span>{prefix ? t(`${prefix}.${r.name}`) : r.name}</span>
          <b>{fmtMoney(r.amount)}</b>
        </div>
      ))}
    </div>
  );
  return (
    <>
      <div className="toolbar">
        <input type="month" style={{ width: 'auto' }} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label={t('period')} />
        <BranchFilter value={branchId} onChange={setBranchId} />
      </div>
      <ErrorText error={q.error} />
      {d && (
        <>
          <div className="stats">
            <div className="card stat">
              <div className="v">{fmtMoney(d.income)}</div>
              <div className="l">{t('income')}</div>
            </div>
            <div className="card stat">
              <div className="v neg">{fmtMoney(d.refunds)}</div>
              <div className="l">{t('refunds')}</div>
            </div>
            <div className="card stat">
              <div className="v">{fmtMoney(d.net)}</div>
              <div className="l">{t('net')}</div>
            </div>
            <div className="card stat">
              <div className="v">{d.subscriptionsSold}</div>
              <div className="l">
                {t('soldSubs')} · {fmtMoney(d.subscriptionsAmount)}
              </div>
            </div>
          </div>
          <div className="stats">
            {list(t('byMethod'), d.byMethod, 'pm')}
            {list(t('byBranch'), d.byBranch)}
            {list(t('byCourse'), d.byCourse)}
          </div>
        </>
      )}
    </>
  );
}

// ───────────── Прайс-лист ─────────────

function TariffsTab() {
  const { t } = useI18n();
  const { can } = useAuth();
  const list = useQuery({ queryKey: ['tariffs', 'all'], queryFn: () => api<Tariff[]>('/tariffs?all=1') });
  const [edit, setEdit] = useState<Partial<Tariff> | null>(null);
  return (
    <>
      <div className="toolbar">
        {can('finance.update') && (
          <button className="primary" style={{ marginLeft: 'auto' }} onClick={() => setEdit({ type: 'level', lessons: 24, installments: 1, isActive: true })}>
            + {t('newTariff')}
          </button>
        )}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('name')}</th>
              <th>{t('course')}</th>
              <th>{t('type')}</th>
              <th>{t('lessonsShort')}</th>
              <th>{t('price')}</th>
              <th>{t('lessonPrice')}</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((x) => (
              <tr key={x.id} className="click" onClick={() => can('finance.update') && setEdit(x)} style={x.isActive ? undefined : { opacity: 0.5 }}>
                <td>{x.name}</td>
                <td>{x.course?.name ?? '—'}</td>
                <td>
                  {t(`subt.${x.type}`)}
                  {x.installments > 1 ? ` × ${x.installments}` : ''}
                </td>
                <td>{x.lessons}</td>
                <td>{fmtMoney(x.price)}</td>
                <td>{fmtMoney(Math.round((Number(x.price) / x.lessons) * 100) / 100)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <TariffModal tariff={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function TariffModal({ tariff, onClose }: { tariff: Partial<Tariff>; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const courses = useCourses();
  const [f, setF] = useState({
    name: tariff.name ?? '',
    courseId: tariff.courseId ?? '',
    type: tariff.type ?? 'level',
    lessons: tariff.lessons ?? 24,
    price: tariff.price ? Number(tariff.price) : 0,
    installments: tariff.installments ?? 1,
    isActive: tariff.isActive ?? true,
  });
  const m = useMutation({
    mutationFn: () =>
      api(tariff.id ? `/tariffs/${tariff.id}` : '/tariffs', {
        method: tariff.id ? 'PATCH' : 'POST',
        body: { ...f, courseId: f.courseId || undefined },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tariffs'] });
      onClose();
    },
  });
  return (
    <Modal title={tariff.id ? tariff.name! : t('newTariff')} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label={t('name')}>
          <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <div className="grid2">
          <Field label={t('course')}>
            <select value={f.courseId} onChange={(e) => setF({ ...f, courseId: e.target.value })}>
              <option value="">—</option>
              {courses.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('type')}>
            <EnumSelect value={f.type} onChange={(v) => setF({ ...f, type: v! })} options={SUB_TYPES} prefix="subt" empty={false} />
          </Field>
          <Field label={t('lessonsShort')}>
            <input type="number" min={1} required value={f.lessons} onChange={(e) => setF({ ...f, lessons: Number(e.target.value) })} />
          </Field>
          <Field label={`${t('price')}, сом`}>
            <input type="number" min={0} required value={f.price} onChange={(e) => setF({ ...f, price: Number(e.target.value) })} />
          </Field>
          {f.type === 'installment' && (
            <Field label={t('installmentsN')}>
              <input type="number" min={1} max={24} value={f.installments} onChange={(e) => setF({ ...f, installments: Number(e.target.value) })} />
            </Field>
          )}
        </div>
        <label className="row" style={{ color: 'var(--text)', gap: 6 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />
          {t('active')}
        </label>
        <ErrorText error={m.error} />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="primary" disabled={m.isPending}>
            {t('save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
