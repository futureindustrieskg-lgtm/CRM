import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import {
  Drawer,
  EnumSelect,
  ErrorText,
  Field,
  fmtDate,
  fmtMoney,
  fmtPhone,
  GOALS,
  LEVELS,
  Modal,
  STATUSES,
} from '../ui';
import { StudentFinance } from './Finance';
import { StudentProgress } from './Journal';
import { useBranches } from './Leads';

interface Student {
  id: string;
  firstName: string;
  lastName: string;
  birthDate: string | null;
  phone: string | null;
  email: string | null;
  currentLevel: string | null;
  targetLevel: string | null;
  goal: string | null;
  preferredTime: string | null;
  status: string;
  balance: string;
  consentAt: string | null;
  branch: { id: string; name: string };
}

interface StudentFull extends Student {
  parents: { isPayer: boolean; parent: { id: string; firstName: string; lastName: string; phone: string | null } }[];
  groups: { joinedAt: string; leftAt: string | null; group: { id: string; name: string; status: string; course: { id: string; name: string } } }[];
  payments: { id: string; amount: string; method: string; paidAt: string }[];
  lead: { id: string; source: string; utmSource: string | null; utmCampaign: string | null; createdAt: string } | null;
}

export function StudentsPage() {
  const { t } = useI18n();
  const { can, activeRole } = useAuth();
  const { id } = useParams();
  const nav = useNavigate();
  const branches = useBranches();
  const [f, setF] = useState<{ search?: string; status?: string; level?: string; branchId?: string; debt?: string }>({});
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ['students', f], queryFn: () => api<Student[]>(`/students${qs(f)}`) });

  return (
    <>
      <div className="toolbar">
        <h1 style={{ margin: 0, marginRight: 'auto' }}>{t('students')}</h1>
        <input placeholder={t('search')} value={f.search ?? ''} onChange={(e) => setF({ ...f, search: e.target.value || undefined })} />
        <EnumSelect value={f.status} onChange={(v) => setF({ ...f, status: v })} options={STATUSES} prefix="st" empty={t('status')} />
        <EnumSelect value={f.level} onChange={(v) => setF({ ...f, level: v })} options={LEVELS} empty={t('level')} />
        {!activeRole?.branchId && (
          <select value={f.branchId ?? ''} onChange={(e) => setF({ ...f, branchId: e.target.value || undefined })}>
            <option value="">{t('allBranches')}</option>
            {branches.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0, color: 'var(--text)' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={!!f.debt} onChange={(e) => setF({ ...f, debt: e.target.checked ? '1' : undefined })} />
          {t('onlyDebt')}
        </label>
        {can('students.create') && (
          <button className="primary" onClick={() => setCreating(true)}>
            + {t('newStudent')}
          </button>
        )}
      </div>
      <ErrorText error={list.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('name')}</th>
              <th>{t('phone')}</th>
              <th>{t('level')}</th>
              <th>{t('goal')}</th>
              <th>{t('status')}</th>
              <th>{t('balance')}</th>
              <th>{t('branch')}</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((s) => (
              <tr key={s.id} className="click" onClick={() => nav(`/students/${s.id}`)}>
                <td>
                  {s.lastName} {s.firstName}
                </td>
                <td>{fmtPhone(s.phone)}</td>
                <td>
                  {s.currentLevel ?? '—'} → {s.targetLevel ?? '—'}
                </td>
                <td>{s.goal ? t(`goal.${s.goal}`) : '—'}</td>
                <td>
                  <span className="badge">{t(`st.${s.status}`)}</span>
                </td>
                <td className={Number(s.balance) < 0 ? 'neg' : ''}>{fmtMoney(s.balance)}</td>
                <td>{s.branch.name}</td>
              </tr>
            ))}
            {list.data?.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  {t('noData')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {creating && <StudentModal onClose={() => setCreating(false)} onSaved={(sid) => nav(`/students/${sid}`)} />}
      {id && <StudentDrawer id={id} onClose={() => nav('/students')} />}
    </>
  );
}

type SForm = Partial<Omit<Student, 'branch' | 'balance'>> & { branchId?: string };

function StudentModal({ initial, onClose, onSaved }: { initial?: StudentFull; onClose: () => void; onSaved: (id: string) => void }) {
  const { t } = useI18n();
  const { activeRole } = useAuth();
  const branches = useBranches();
  const qc = useQueryClient();
  const [form, setForm] = useState<SForm>(
    initial
      ? {
          firstName: initial.firstName,
          lastName: initial.lastName,
          phone: initial.phone,
          email: initial.email,
          birthDate: initial.birthDate?.slice(0, 10) ?? null,
          currentLevel: initial.currentLevel,
          targetLevel: initial.targetLevel,
          goal: initial.goal,
          preferredTime: initial.preferredTime,
          status: initial.status,
          branchId: initial.branch.id,
        }
      : { status: 'active' },
  );
  const save = useMutation({
    mutationFn: () => {
      const body = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v === '' || v === null ? undefined : v]));
      return initial
        ? api<Student>(`/students/${initial.id}`, { method: 'PATCH', body })
        : api<Student>('/students', { method: 'POST', body });
    },
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ['students'] });
      qc.invalidateQueries({ queryKey: ['student'] });
      onClose();
      onSaved(s.id);
    },
  });
  const inp = (k: keyof SForm) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const v = (k: keyof SForm) => (form[k] as string | null | undefined) ?? '';

  return (
    <Modal title={initial ? `${initial.lastName} ${initial.firstName}` : t('newStudent')} onClose={onClose}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid2">
          <Field label={t('firstName') + ' *'}>
            <input autoFocus value={v('firstName')} onChange={inp('firstName')} />
          </Field>
          <Field label={t('lastName') + ' *'}>
            <input value={v('lastName')} onChange={inp('lastName')} />
          </Field>
          <Field label={t('phone')}>
            <input value={v('phone')} onChange={inp('phone')} />
          </Field>
          <Field label={t('email')}>
            <input type="email" value={v('email')} onChange={inp('email')} />
          </Field>
          <Field label="Дата рождения">
            <input type="date" value={v('birthDate')} onChange={inp('birthDate')} />
          </Field>
          {!activeRole?.branchId && (
            <Field label={t('branch') + ' *'}>
              <select value={v('branchId')} onChange={inp('branchId')}>
                <option value="">—</option>
                {branches.data?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label={t('currentLevel')}>
            <EnumSelect value={form.currentLevel} onChange={(x) => setForm({ ...form, currentLevel: x })} options={LEVELS} />
          </Field>
          <Field label={t('targetLevel')}>
            <EnumSelect value={form.targetLevel} onChange={(x) => setForm({ ...form, targetLevel: x })} options={LEVELS} />
          </Field>
          <Field label={t('goal')}>
            <EnumSelect value={form.goal} onChange={(x) => setForm({ ...form, goal: x })} options={GOALS} prefix="goal" />
          </Field>
          <Field label={t('status')}>
            <EnumSelect value={form.status} onChange={(x) => setForm({ ...form, status: x })} options={STATUSES} prefix="st" empty={false} />
          </Field>
          <Field label={t('preferredTime')}>
            <input value={v('preferredTime')} onChange={inp('preferredTime')} />
          </Field>
        </div>
        <ErrorText error={save.error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="primary" disabled={!form.firstName || !form.lastName || save.isPending}>
            {t('save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function StudentDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['student', id], queryFn: () => api<StudentFull>(`/students/${id}`) });
  const [editing, setEditing] = useState(false);
  const consent = useMutation({
    mutationFn: () => api(`/students/${id}`, { method: 'PATCH', body: { consentAt: new Date().toISOString() } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['student', id] }),
  });
  const s = q.data;

  return (
    <Drawer onClose={onClose}>
      {!s ? (
        <ErrorText error={q.error} />
      ) : (
        <>
          <div className="drawer-head">
            <h1>
              {s.lastName} {s.firstName}
            </h1>
            {can('students.update') && <button onClick={() => setEditing(true)}>{t('edit')}</button>}
            <button onClick={onClose}>✕</button>
          </div>
          <dl className="kv">
            <dt>{t('status')}</dt>
            <dd>
              <span className="badge">{t(`st.${s.status}`)}</span>
            </dd>
            <dt>{t('balance')}</dt>
            <dd className={Number(s.balance) < 0 ? 'neg' : ''}>{fmtMoney(s.balance)}</dd>
            <dt>{t('phone')}</dt>
            <dd>{fmtPhone(s.phone)}</dd>
            <dt>{t('email')}</dt>
            <dd>{s.email ?? '—'}</dd>
            <dt>Дата рождения</dt>
            <dd>{fmtDate(s.birthDate, false)}</dd>
            <dt>{t('branch')}</dt>
            <dd>{s.branch.name}</dd>
            <dt>{t('level')}</dt>
            <dd>
              {s.currentLevel ?? '—'} → {s.targetLevel ?? '—'}
            </dd>
            <dt>{t('goal')}</dt>
            <dd>{s.goal ? t(`goal.${s.goal}`) : '—'}</dd>
            <dt>{t('preferredTime')}</dt>
            <dd>{s.preferredTime ?? '—'}</dd>
            <dt>{t('consent')}</dt>
            <dd>
              {s.consentAt ? (
                fmtDate(s.consentAt)
              ) : (
                <>
                  <span className="neg">{t('no')}</span>{' '}
                  {can('students.update') && (
                    <button className="small" onClick={() => consent.mutate()}>
                      Отметить получение
                    </button>
                  )}
                </>
              )}
            </dd>
            {s.lead && (
              <>
                <dt>{t('leads')}</dt>
                <dd>
                  <Link to={`/leads/${s.lead.id}`}>
                    {t(`src.${s.lead.source}`)} · {fmtDate(s.lead.createdAt, false)}
                  </Link>
                </dd>
              </>
            )}
          </dl>

          <StudentProgress studentId={s.id} />
          <h3>{t('groups')}</h3>
          {s.groups.length ? (
            <ul>
              {s.groups.map((g) => (
                <li key={g.group.id}>
                  {g.group.name} <span className="muted">({g.group.course.name})</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t('noData')}</p>
          )}

          <h3>{t('parents')}</h3>
          {s.parents.length ? (
            <ul>
              {s.parents.map((p) => (
                <li key={p.parent.id}>
                  {p.parent.firstName} {p.parent.lastName} · {fmtPhone(p.parent.phone)} {p.isPayer && <span className="badge">плательщик</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t('noData')}</p>
          )}

          <StudentFinance student={s} />
          <h3>{t('payments')}</h3>
          {s.payments.length ? (
            <table>
              <tbody>
                {s.payments.map((p) => (
                  <tr key={p.id}>
                    <td>{fmtDate(p.paidAt)}</td>
                    <td>{fmtMoney(p.amount)}</td>
                    <td className="muted">{t(`pm.${p.method}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">{t('noData')}</p>
          )}
          {editing && <StudentModal initial={s} onClose={() => setEditing(false)} onSaved={() => {}} />}
        </>
      )}
    </Drawer>
  );
}
