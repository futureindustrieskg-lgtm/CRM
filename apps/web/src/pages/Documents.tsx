/** Документы (ТЗ 3.9): реквизиты центра, выдача PDF, реестр, внешние экзамены. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, openFile, qs } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { zDate } from '../tz';
import { EnumSelect, ErrorText, Field, fmtDate, fmtMoney, Modal } from '../ui';
import type { Subscription } from './Finance';

const DOC_TYPES = ['contract', 'invoice', 'act', 'reference', 'certificate'] as const;
type DocType = (typeof DOC_TYPES)[number];

interface Issued {
  id: string;
  type: DocType;
  number: string;
  amount: string | null;
  createdAt: string;
  student?: { id: string; firstName: string; lastName: string };
}

// ───────────── Реквизиты ─────────────

const COMPANY_FIELDS: [string, string][] = [
  ['name', 'companyName'],
  ['brand', 'brand'],
  ['directorPosition', 'directorPosition'],
  ['director', 'directorName'],
  ['directorPositionGenitive', 'directorPositionGenitive'],
  ['directorGenitive', 'directorGenitive'],
  ['basis', 'basis'],
  ['city', 'city'],
  ['address', 'address'],
  ['inn', 'inn'],
  ['okpo', 'okpo'],
  ['bank', 'bank'],
  ['account', 'account'],
  ['bik', 'bik'],
  ['swift', 'swift'],
  ['phone', 'phone'],
  ['email', 'email'],
];

export function CompanyPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['company'], queryFn: () => api<Record<string, string>>('/settings/company') });
  const [f, setF] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (q.data) setF(q.data);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api('/settings/company', { method: 'PUT', body: f }),
    onSuccess: (r) => qc.setQueryData(['company'], r),
  });
  if (!f) return <ErrorText error={q.error} />;
  const edit = can('branches.update');
  return (
    <>
      <h1>{t('companyTitle')}</h1>
      <p className="muted">{t('companyHint')}</p>
      <form
        className="card"
        style={{ maxWidth: 760 }}
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid2">
          {COMPANY_FIELDS.map(([k, label]) => (
            <Field key={k} label={t(label)}>
              <input
                value={f[k] ?? ''}
                disabled={!edit}
                required={k === 'name'}
                placeholder={k === 'directorGenitive' || k === 'directorPositionGenitive' ? t('autoGenitive') : undefined}
                onChange={(e) => setF({ ...f, [k]: e.target.value })}
              />
            </Field>
          ))}
        </div>
        <ErrorText error={save.error} />
        {save.isSuccess && <div className="ok-box">{t('saved')}</div>}
        {edit && (
          <button className="primary" disabled={save.isPending}>
            {t('save')}
          </button>
        )}
      </form>
    </>
  );
}

// ───────────── Реестр ─────────────

export function DocumentsPage() {
  const { t } = useI18n();
  const [type, setType] = useState<string>();
  const q = useQuery({ queryKey: ['documents', type], queryFn: () => api<Issued[]>(`/documents${qs({ type })}`) });
  const [err, setErr] = useState<unknown>(null);
  return (
    <>
      <div className="toolbar">
        <h1 style={{ margin: 0, marginRight: 'auto' }}>{t('documentsTitle')}</h1>
        <EnumSelect value={type} onChange={setType} options={[...DOC_TYPES]} prefix="doc" empty={t('type')} />
      </div>
      <p className="muted">{t('documentsHint')}</p>
      <ErrorText error={q.error ?? err} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('number')}</th>
              <th>{t('type')}</th>
              <th>{t('students')}</th>
              <th>{t('amount')}</th>
              <th>{t('date')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data?.map((d) => (
              <tr key={d.id}>
                <td>
                  <b>{d.number}</b>
                </td>
                <td>{t(`doc.${d.type}`)}</td>
                <td>{d.student && <Link to={`/students/${d.student.id}`}>{`${d.student.lastName} ${d.student.firstName}`}</Link>}</td>
                <td>{d.amount ? fmtMoney(d.amount) : '—'}</td>
                <td className="muted">{fmtDate(d.createdAt)}</td>
                <td>
                  <button className="small" onClick={() => openFile(`/documents/${d.id}/pdf`).catch(setErr)}>
                    PDF
                  </button>
                </td>
              </tr>
            ))}
            {q.data?.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  {t('noData')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ───────────── Карточка студента: документы и экзамены ─────────────

export function StudentDocuments({ student }: { student: { id: string; groups: { leftAt: string | null; group: { id: string; name: string } }[] } }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const qc = useQueryClient();
  const docs = useQuery({ queryKey: ['documents', { studentId: student.id }], queryFn: () => api<Issued[]>(`/documents${qs({ studentId: student.id })}`), enabled: can('documents.read') });
  const subs = useQuery({
    queryKey: ['subscriptions', { studentId: student.id }],
    queryFn: () => api<Subscription[]>(`/subscriptions${qs({ studentId: student.id })}`),
    enabled: can('documents.create') && can('finance.read'),
  });
  const [issuing, setIssuing] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (!can('documents.read')) return null;
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0, marginRight: 'auto' }}>{t('documentsTitle')}</h3>
        {can('documents.create') && (
          <button className="small primary" onClick={() => setIssuing(true)}>
            + {t('issueDocument')}
          </button>
        )}
      </div>
      <ErrorText error={err} />
      {docs.data?.length ? (
        <div className="row" style={{ gap: 6, marginBottom: 16 }}>
          {docs.data.map((d) => (
            <button key={d.id} className="small" onClick={() => openFile(`/documents/${d.id}/pdf`).catch(setErr)} title={fmtDate(d.createdAt)}>
              📄 {t(`doc.${d.type}`)} {d.number}
            </button>
          ))}
        </div>
      ) : (
        <p className="muted">{t('noData')}</p>
      )}
      {issuing && (
        <IssueModal
          student={student}
          subs={subs.data ?? []}
          onClose={(id) => {
            setIssuing(false);
            qc.invalidateQueries({ queryKey: ['documents'] });
            if (id) openFile(`/documents/${id}/pdf`).catch(setErr);
          }}
        />
      )}
    </>
  );
}

function IssueModal({
  student,
  subs,
  onClose,
}: {
  student: { id: string; groups: { leftAt: string | null; group: { id: string; name: string } }[] };
  subs: Subscription[];
  onClose: (id?: string) => void;
}) {
  const { t } = useI18n();
  const [type, setType] = useState<DocType>('contract');
  const bySub = type === 'contract' || type === 'invoice' || type === 'act';
  const usable = subs.filter((s) => s.status !== 'transferred');
  const [subId, setSubId] = useState(usable[0]?.id ?? '');
  const [groupId, setGroupId] = useState(student.groups[0]?.group.id ?? '');
  const [amount, setAmount] = useState('');
  const m = useMutation({
    mutationFn: () =>
      api<{ id: string }>('/documents', {
        method: 'POST',
        body: {
          type,
          ...(bySub ? { subscriptionId: subId } : { studentId: student.id }),
          ...(type === 'certificate' || (type === 'reference' && groupId) ? { groupId: groupId || undefined } : {}),
          ...(type === 'invoice' && amount ? { amount: Number(amount) } : {}),
        },
      }),
    onSuccess: (r) => onClose(r.id),
  });
  return (
    <Modal title={t('issueDocument')} onClose={() => onClose()}>
      <Field label={t('type')}>
        <EnumSelect value={type} onChange={(v) => setType((v as DocType) ?? 'contract')} options={[...DOC_TYPES]} prefix="doc" empty={false} />
      </Field>
      {bySub ? (
        <Field label={t('subscriptions')}>
          <select value={subId} onChange={(e) => setSubId(e.target.value)}>
            {usable.map((s) => (
              <option key={s.id} value={s.id}>
                {s.group?.name ?? s.course.name} · {fmtMoney(s.price)} · {t(`subs.${s.status}`)}
              </option>
            ))}
          </select>
          {!usable.length && <div className="muted">{t('noSubscriptions')}</div>}
        </Field>
      ) : (
        <Field label={t('group')}>
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            {type === 'reference' && <option value="">{t('allGroups')}</option>}
            {student.groups.map((g) => (
              <option key={g.group.id} value={g.group.id}>
                {g.group.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {type === 'invoice' && (
        <Field label={t('invoiceAmountHint')}>
          <input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
      )}
      <ErrorText error={m.error} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button onClick={() => onClose()}>{t('cancel')}</button>
        <button className="primary" disabled={m.isPending || (bySub && !subId) || (type === 'certificate' && !groupId)} onClick={() => m.mutate()}>
          {t('issueAndOpen')}
        </button>
      </div>
    </Modal>
  );
}

const PROVIDERS = ['goethe', 'telc', 'osd', 'testdaf'];
const EXAM_STATUSES = ['registered', 'passed', 'failed'];
const EXAM_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

export function StudentExams({ studentId }: { studentId: string }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['exams', studentId],
    queryFn: () => api<{ id: string; provider: string; level: string; date: string; score: string | null; status: string; comment: string | null }[]>(`/students/${studentId}/exams`),
  });
  const [f, setF] = useState<{ provider: string; level: string; date: string; score: string; status: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['exams', studentId] });
  const add = useMutation({
    mutationFn: () => api(`/students/${studentId}/exams`, { method: 'POST', body: { ...f, score: f!.score ? Number(f!.score) : undefined } }),
    onSuccess: () => {
      setF(null);
      refresh();
    },
  });
  const upd = useMutation({ mutationFn: ({ id, status }: { id: string; status: string }) => api(`/exams/${id}`, { method: 'PATCH', body: { status } }), onSuccess: refresh });
  const edit = can('students.update');
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0, marginRight: 'auto' }}>{t('externalExams')}</h3>
        {edit && !f && (
          <button className="small" onClick={() => setF({ provider: 'goethe', level: 'B1', date: zToday(), score: '', status: 'registered' })}>
            + {t('add')}
          </button>
        )}
      </div>
      {f && (
        <div className="card" style={{ marginBottom: 8 }}>
          <div className="grid2">
            <Field label={t('examProvider')}>
              <EnumSelect value={f.provider} onChange={(v) => setF({ ...f, provider: v! })} options={PROVIDERS} prefix="prov" empty={false} />
            </Field>
            <Field label={t('level')}>
              <EnumSelect value={f.level} onChange={(v) => setF({ ...f, level: v! })} options={EXAM_LEVELS} empty={false} />
            </Field>
            <Field label={t('date')}>
              <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
            </Field>
            <Field label={t('score')}>
              <input type="number" value={f.score} onChange={(e) => setF({ ...f, score: e.target.value })} />
            </Field>
            <Field label={t('status')}>
              <EnumSelect value={f.status} onChange={(v) => setF({ ...f, status: v! })} options={EXAM_STATUSES} prefix="ex" empty={false} />
            </Field>
          </div>
          <ErrorText error={add.error} />
          <div className="row">
            <button onClick={() => setF(null)}>{t('cancel')}</button>
            <button className="primary" disabled={add.isPending} onClick={() => add.mutate()}>
              {t('save')}
            </button>
          </div>
        </div>
      )}
      {q.data?.length ? (
        <div className="table-wrap" style={{ marginBottom: 16 }}>
          <table>
            <tbody>
              {q.data.map((e) => (
                <tr key={e.id}>
                  <td>{fmtDate(e.date, false)}</td>
                  <td>
                    {t(`prov.${e.provider}`)} {e.level}
                  </td>
                  <td>{e.score !== null ? Number(e.score) : '—'}</td>
                  <td>
                    {edit ? (
                      <EnumSelect value={e.status} onChange={(v) => upd.mutate({ id: e.id, status: v! })} options={EXAM_STATUSES} prefix="ex" empty={false} />
                    ) : (
                      t(`ex.${e.status}`)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !f && <p className="muted">{t('noData')}</p>
      )}
    </>
  );
}

const zToday = () => zDate(new Date());
