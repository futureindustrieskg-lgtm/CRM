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
/** Для фильтра реестра: плюс договоры и акты по шаблонам. */
const ALL_DOC_TYPES = [...DOC_TYPES, 'custom', 'custom_act'];
type DocType = (typeof DOC_TYPES)[number] | 'custom' | 'custom_act';

interface TemplateName {
  id: string;
  name: string;
  hasAct: boolean;
  defaultPrice: string | null;
  isActive: boolean;
}

const useTemplateNames = (enabled = true) =>
  useQuery({ queryKey: ['template-names'], queryFn: () => api<TemplateName[]>('/documents/template-names'), enabled });

/** «Договор 873 (FerienJob…)» / «Акт 873-А». */
function docLabel(d: Issued, t: (k: string) => string, names?: TemplateName[]) {
  const tpl = d.type === 'custom' && d.templateId ? names?.find((n) => n.id === d.templateId)?.name : undefined;
  return `${t(`doc.${d.type}`)} ${d.number}${tpl ? ` · ${tpl}` : ''}`;
}

interface Issued {
  id: string;
  type: DocType;
  number: string;
  amount: string | null;
  createdAt: string;
  templateId?: string | null;
  parentId?: string | null;
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
  ['registration', 'registration'],
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
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['documents', type], queryFn: () => api<Issued[]>(`/documents${qs({ type })}`) });
  const names = useTemplateNames();
  const [err, setErr] = useState<unknown>(null);
  return (
    <>
      <div className="toolbar">
        <h1 style={{ margin: 0, marginRight: 'auto' }}>{t('documentsTitle')}</h1>
        <EnumSelect value={type} onChange={setType} options={ALL_DOC_TYPES} prefix="doc" empty={t('type')} />
        {can('documents.update') && (
          <Link to="/documents/templates" className="btn">
            {t('docTemplates')}
          </Link>
        )}
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
                <td>{d.type === 'custom' ? (names.data?.find((n) => n.id === d.templateId)?.name ?? t('doc.custom')) : t(`doc.${d.type}`)}</td>
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
  const names = useTemplateNames(can('documents.read'));
  const [issuing, setIssuing] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const issueAct = useMutation({
    mutationFn: (parentId: string) => api<{ id: string }>('/documents', { method: 'POST', body: { type: 'custom_act', parentId } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['documents'] });
      openFile(`/documents/${r.id}/pdf`).catch(setErr);
    },
    onError: setErr,
  });
  // Договор по шаблону с текстом акта, к которому акт ещё не выдан.
  const needsAct = (d: Issued) =>
    d.type === 'custom' && names.data?.find((n) => n.id === d.templateId)?.hasAct && !docs.data?.some((x) => x.parentId === d.id);
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
            <span key={d.id} className="row" style={{ gap: 2 }}>
              <button className="small" onClick={() => openFile(`/documents/${d.id}/pdf`).catch(setErr)} title={fmtDate(d.createdAt)}>
                📄 {docLabel(d, t, names.data)}
              </button>
              {can('documents.create') && needsAct(d) && (
                <button className="small" disabled={issueAct.isPending} onClick={() => issueAct.mutate(d.id)}>
                  + {t('issueAct')}
                </button>
              )}
            </span>
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
  const templates = (useTemplateNames().data ?? []).filter((x) => x.isActive);
  const [templateId, setTemplateId] = useState('');
  const tpl = templates.find((x) => x.id === templateId) ?? templates[0];
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
          ...(type === 'custom' ? { templateId: tpl?.id, ...(amount ? { amount: Number(amount) } : {}) } : {}),
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
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value as DocType);
            setAmount('');
          }}
        >
          {DOC_TYPES.map((d) => (
            <option key={d} value={d}>
              {t(`doc.${d}`)}
            </option>
          ))}
          {templates.length > 0 && <option value="custom">{t('byTemplate')}</option>}
        </select>
      </Field>
      {type === 'custom' ? (
        <>
          <Field label={t('template')}>
            <select value={tpl?.id ?? ''} onChange={(e) => setTemplateId(e.target.value)}>
              {templates.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('amount')}>
            <input type="number" min={0} value={amount} placeholder={tpl?.defaultPrice ? String(Number(tpl.defaultPrice)) : ''} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        </>
      ) : bySub ? (
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
        <button className="primary" disabled={m.isPending || (bySub && !subId) || (type === 'certificate' && !groupId) || (type === 'custom' && (!tpl || (!amount && !tpl.defaultPrice)))} onClick={() => m.mutate()}>
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

// ───────────── Шаблоны договоров ─────────────

interface DocTemplate {
  id: string;
  name: string;
  body: string;
  actBody: string | null;
  defaultPrice: string | null;
  isActive: boolean;
}
type TplForm = { id?: string; name: string; body: string; actBody: string; defaultPrice: string; isActive: boolean };

export function TemplatesPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['document-templates'],
    queryFn: () => api<{ templates: DocTemplate[]; placeholders: [string, string][]; nextNumber: number }>('/document-templates'),
  });
  const [f, setF] = useState<TplForm | null>(null);
  const [next, setNext] = useState('');
  const [field, setField] = useState<'body' | 'actBody'>('body');
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['document-templates'] });
    qc.invalidateQueries({ queryKey: ['template-names'] });
  };
  const save = useMutation({
    mutationFn: () => {
      const body = { name: f!.name, body: f!.body, actBody: f!.actBody, defaultPrice: f!.defaultPrice ? Number(f!.defaultPrice) : undefined, isActive: f!.isActive };
      return f!.id ? api(`/document-templates/${f!.id}`, { method: 'PATCH', body }) : api('/document-templates', { method: 'POST', body });
    },
    onSuccess: () => {
      setF(null);
      refresh();
    },
  });
  const off = useMutation({ mutationFn: (id: string) => api(`/document-templates/${id}`, { method: 'DELETE' }), onSuccess: refresh });
  const numbering = useMutation({
    mutationFn: () => api('/document-templates/numbering', { method: 'PUT', body: { next: Number(next) } }),
    onSuccess: () => {
      setNext('');
      refresh();
    },
  });
  const edit = can('documents.update');
  /** Вставить поле в позицию курсора последнего активного текста (договор или акт). */
  const insert = (key: string) => {
    if (!f) return;
    const el = document.getElementById(`tpl-${field}`) as HTMLTextAreaElement | null;
    const text = f[field];
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? start;
    setF({ ...f, [field]: `${text.slice(0, start)}{{${key}}}${text.slice(end)}` });
  };

  return (
    <>
      <div className="toolbar">
        <h1 style={{ margin: 0, marginRight: 'auto' }}>{t('docTemplates')}</h1>
        <Link to="/documents" className="btn">
          ← {t('documentsTitle')}
        </Link>
        {edit && !f && (
          <button className="primary" onClick={() => setF({ name: '', body: '', actBody: '', defaultPrice: '', isActive: true })}>
            + {t('newTemplate')}
          </button>
        )}
      </div>
      <p className="muted">{t('docTemplatesHint')}</p>
      <ErrorText error={q.error ?? off.error} />

      {q.data && (
        <div className="card row" style={{ marginBottom: 12, alignItems: 'flex-end' }}>
          <Field label={t('nextContractNumber')}>
            <input type="number" min={1} value={next} placeholder={String(q.data.nextNumber)} disabled={!edit} onChange={(e) => setNext(e.target.value)} />
          </Field>
          {edit && (
            <button disabled={!next || numbering.isPending} onClick={() => numbering.mutate()}>
              {t('setNumber')}
            </button>
          )}
          <ErrorText error={numbering.error} />
        </div>
      )}

      {f ? (
        <div className="card">
          <div className="grid2">
            <Field label={t('templateName') + ' *'}>
              <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </Field>
            <Field label={t('defaultPrice')}>
              <input type="number" min={0} value={f.defaultPrice} onChange={(e) => setF({ ...f, defaultPrice: e.target.value })} />
            </Field>
          </div>
          <div className="tpl-editor">
            <div>
              <Field label={t('templateBody') + ' *'}>
                <textarea id="tpl-body" rows={18} value={f.body} onFocus={() => setField('body')} onChange={(e) => setF({ ...f, body: e.target.value })} className="mono" />
              </Field>
              <Field label={t('templateActBody')}>
                <textarea id="tpl-actBody" rows={8} value={f.actBody} onFocus={() => setField('actBody')} onChange={(e) => setF({ ...f, actBody: e.target.value })} className="mono" />
              </Field>
            </div>
            <div>
              <b>{t('placeholders')}</b>
              <p className="muted" style={{ fontSize: 12 }}>
                {t('placeholdersHint')}
              </p>
              <div className="tpl-fields">
                {q.data?.placeholders.map(([k, label]) => (
                  <div key={k} className="row" style={{ gap: 4, marginBottom: 2 }}>
                    <button type="button" className="small" title={t('insert')} onClick={() => insert(k)}>
                      {`{{${k}}}`}
                    </button>
                    <span className="muted">{label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <ErrorText error={save.error} />
          <div className="row">
            <button onClick={() => setF(null)}>{t('cancel')}</button>
            <button className="primary" disabled={!f.name.trim() || !f.body.trim() || save.isPending} onClick={() => save.mutate()}>
              {t('save')}
            </button>
          </div>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('templateName')}</th>
                <th>{t('defaultPrice')}</th>
                <th>{t('doc.custom_act')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data?.templates.map((x) => (
                <tr key={x.id} className={x.isActive ? '' : 'muted'}>
                  <td>
                    <b>{x.name}</b> {!x.isActive && <span className="badge">{t('templateDisabled')}</span>}
                  </td>
                  <td>{x.defaultPrice ? fmtMoney(x.defaultPrice) : '—'}</td>
                  <td>{x.actBody?.trim() ? '✓' : '—'}</td>
                  <td>
                    <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                      {edit && (
                        <button
                          className="small"
                          onClick={() =>
                            setF({ id: x.id, name: x.name, body: x.body, actBody: x.actBody ?? '', defaultPrice: x.defaultPrice ? String(Number(x.defaultPrice)) : '', isActive: x.isActive })
                          }
                        >
                          {t('edit')}
                        </button>
                      )}
                      {x.isActive && can('documents.delete') && (
                        <button className="small" disabled={off.isPending} onClick={() => off.mutate(x.id)}>
                          {t('disableTemplate')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {q.data?.templates.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    {t('noData')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
