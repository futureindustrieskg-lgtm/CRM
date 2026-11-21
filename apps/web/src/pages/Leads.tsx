import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import {
  Drawer,
  EnumSelect,
  ErrorText,
  Field,
  fmtDate,
  fmtPhone,
  GOALS,
  LEVELS,
  Modal,
  SOURCES,
} from '../ui';

export interface Stage {
  id: string;
  code: string;
  name: string;
  color: string;
  sort: number;
  isWon: boolean;
  isLost: boolean;
}

export interface Lead {
  id: string;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  source: string;
  stageId: string;
  stage: Stage;
  branchId: string | null;
  branch: { id: string; name: string } | null;
  managerId: string | null;
  manager: { id: string; firstName: string; lastName: string } | null;
  currentLevel: string | null;
  targetLevel: string | null;
  goal: string | null;
  preferredTime: string | null;
  lostReason: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  levelTestScore: number | null;
  firstContactAt: string | null;
  createdAt: string;
  student: { id: string } | null;
}

interface LeadFull extends Lead {
  activities: { id: string; type: string; text: string; createdAt: string; user: { firstName: string; lastName: string } | null }[];
  tasks: { id: string; title: string; dueAt: string; doneAt: string | null }[];
}

interface Staff {
  id: string;
  firstName: string;
  lastName: string;
}

const useStages = () => useQuery({ queryKey: ['stages'], queryFn: () => api<Stage[]>('/pipeline/stages'), staleTime: 300_000 });
export const useBranches = () =>
  useQuery({ queryKey: ['branches'], queryFn: () => api<{ id: string; name: string }[]>('/branches'), staleTime: 300_000 });
const useStaff = () => useQuery({ queryKey: ['staff'], queryFn: () => api<Staff[]>('/users/staff'), staleTime: 300_000 });

export function LeadsPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [view, setView] = useState<'kanban' | 'list'>(() => {
    try {
      return (localStorage.getItem('crm.leadsView') as 'kanban' | 'list') || 'kanban';
    } catch {
      return 'kanban';
    }
  });
  const [filters, setFilters] = useState<{ search?: string; source?: string; managerId?: string }>({});
  const [creating, setCreating] = useState(false);
  const [lostFor, setLostFor] = useState<{ lead: Lead; stage: Stage } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const stages = useStages();
  const staff = useStaff();
  const leads = useQuery({ queryKey: ['leads', filters], queryFn: () => api<Lead[]>(`/leads${qs(filters)}`) });

  const move = useMutation({
    mutationFn: (v: { id: string; stageId: string; lostReason?: string }) =>
      api(`/leads/${v.id}/stage`, { method: 'POST', body: { stageId: v.stageId, lostReason: v.lostReason } }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['lead'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  function setViewSaved(v: 'kanban' | 'list') {
    setView(v);
    try {
      localStorage.setItem('crm.leadsView', v);
    } catch {
      /* нет доступа к хранилищу */
    }
  }

  function drop(stage: Stage, leadId: string) {
    setDragOver(null);
    const lead = leads.data?.find((l) => l.id === leadId);
    if (!lead || lead.stageId === stage.id) return;
    if (stage.isLost) setLostFor({ lead, stage });
    else move.mutate({ id: lead.id, stageId: stage.id });
  }

  return (
    <>
      <div className="toolbar">
        <h1 style={{ margin: 0, marginRight: 'auto' }}>{t('leads')}</h1>
        <input
          placeholder={t('search')}
          value={filters.search ?? ''}
          onChange={(e) => setFilters({ ...filters, search: e.target.value || undefined })}
        />
        <EnumSelect
          value={filters.source}
          onChange={(v) => setFilters({ ...filters, source: v })}
          options={SOURCES}
          prefix="src"
          empty={t('source')}
        />
        {can('leads.read_all') && (
          <select value={filters.managerId ?? ''} onChange={(e) => setFilters({ ...filters, managerId: e.target.value || undefined })}>
            <option value="">{t('manager')}</option>
            {staff.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.firstName} {s.lastName}
              </option>
            ))}
          </select>
        )}
        <div className="seg">
          <button className={view === 'kanban' ? 'on' : ''} onClick={() => setViewSaved('kanban')}>
            {t('kanban')}
          </button>
          <button className={view === 'list' ? 'on' : ''} onClick={() => setViewSaved('list')}>
            {t('list')}
          </button>
        </div>
        {can('leads.create') && (
          <button className="primary" onClick={() => setCreating(true)}>
            + {t('newLead')}
          </button>
        )}
      </div>
      <ErrorText error={leads.error ?? move.error} />

      {view === 'kanban' ? (
        <div className="kanban">
          {stages.data?.map((s) => {
            const items = leads.data?.filter((l) => l.stageId === s.id) ?? [];
            return (
              <div
                key={s.id}
                className={`column ${dragOver === s.id ? 'over' : ''}`}
                onDragOver={(e) => {
                  if (!can('leads.update')) return;
                  e.preventDefault();
                  setDragOver(s.id);
                }}
                onDragLeave={() => setDragOver(null)}
                onDrop={(e) => drop(s, e.dataTransfer.getData('text/plain'))}
              >
                <div className="column-head">
                  <span className="dot" style={{ background: s.color }} />
                  {s.name}
                  <span className="count">{items.length}</span>
                </div>
                <div className="column-body">
                  {items.map((l) => (
                    <div
                      key={l.id}
                      className="lead-card"
                      draggable={can('leads.update')}
                      onDragStart={(e) => e.dataTransfer.setData('text/plain', l.id)}
                      onClick={() => nav(`/leads/${l.id}`)}
                    >
                      <div className="t">
                        {l.firstName} {l.lastName}
                      </div>
                      <div className="s">{fmtPhone(l.phone)}</div>
                      <div className="s">
                        {t(`src.${l.source}`)}
                        {l.currentLevel && ` · ${l.currentLevel}`}
                        {l.manager && ` · ${l.manager.firstName}`}
                      </div>
                      {l.lostReason && <div className="s neg">{l.lostReason}</div>}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('name')}</th>
                <th>{t('phone')}</th>
                <th>{t('stage')}</th>
                <th>{t('source')}</th>
                <th>{t('level')}</th>
                <th>{t('manager')}</th>
                <th>{t('branch')}</th>
                <th>{t('createdAt')}</th>
              </tr>
            </thead>
            <tbody>
              {leads.data?.map((l) => (
                <tr key={l.id} className="click" onClick={() => nav(`/leads/${l.id}`)}>
                  <td>
                    {l.firstName} {l.lastName}
                  </td>
                  <td>{fmtPhone(l.phone)}</td>
                  <td>
                    <span className="dot" style={{ background: l.stage.color }} /> {l.stage.name}
                  </td>
                  <td>{t(`src.${l.source}`)}</td>
                  <td>{l.currentLevel ?? '—'}</td>
                  <td>{l.manager ? `${l.manager.firstName} ${l.manager.lastName}` : '—'}</td>
                  <td>{l.branch?.name ?? '—'}</td>
                  <td className="muted">{fmtDate(l.createdAt)}</td>
                </tr>
              ))}
              {leads.data?.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    {t('noData')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {creating && <NewLeadModal onClose={() => setCreating(false)} onCreated={(lid) => nav(`/leads/${lid}`)} />}
      {lostFor && (
        <LostReasonModal
          onClose={() => setLostFor(null)}
          onSubmit={(reason) => {
            move.mutate({ id: lostFor.lead.id, stageId: lostFor.stage.id, lostReason: reason });
            setLostFor(null);
          }}
        />
      )}
      {id && <LeadDrawer id={id} onClose={() => nav('/leads')} />}
    </>
  );
}

function LostReasonModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (r: string) => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const presets = ['Дорого', 'Неудобное время', 'Выбрал другой центр', 'Передумал', 'Не отвечает'];
  return (
    <Modal title={t('lostReasonPrompt')} onClose={onClose}>
      <div className="row" style={{ marginBottom: 10 }}>
        {presets.map((p) => (
          <button key={p} className="small" onClick={() => setReason(p)}>
            {p}
          </button>
        ))}
      </div>
      <textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button onClick={onClose}>{t('cancel')}</button>
        <button className="primary" disabled={!reason.trim()} onClick={() => onSubmit(reason.trim())}>
          {t('save')}
        </button>
      </div>
    </Modal>
  );
}

type LeadForm = Partial<
  Pick<Lead, 'firstName' | 'lastName' | 'phone' | 'email' | 'source' | 'branchId' | 'managerId' | 'currentLevel' | 'targetLevel' | 'goal' | 'preferredTime'>
>;

function LeadFormFields({ form, set, isNew }: { form: LeadForm; set: (f: LeadForm) => void; isNew?: boolean }) {
  const { t } = useI18n();
  const { activeRole, can } = useAuth();
  const branches = useBranches();
  const staff = useStaff();
  const v = (k: keyof LeadForm) => (form[k] as string | undefined) ?? '';
  const inp = (k: keyof LeadForm) => (e: { target: { value: string } }) => set({ ...form, [k]: e.target.value || undefined });
  return (
    <div className="grid2">
      <Field label={t('firstName') + ' *'}>
        <input autoFocus={isNew} value={v('firstName')} onChange={inp('firstName')} />
      </Field>
      <Field label={t('lastName')}>
        <input value={v('lastName')} onChange={inp('lastName')} />
      </Field>
      <Field label={t('phone')}>
        <input value={v('phone')} onChange={inp('phone')} placeholder="+996 …" />
      </Field>
      <Field label={t('email')}>
        <input type="email" value={v('email')} onChange={inp('email')} />
      </Field>
      {isNew && (
        <Field label={t('source')}>
          <EnumSelect value={form.source} onChange={(x) => set({ ...form, source: x })} options={SOURCES} prefix="src" empty={false} />
        </Field>
      )}
      {!activeRole?.branchId && (
        <Field label={t('branch')}>
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
      {can('leads.read_all') && (
        <Field label={t('manager')}>
          <select value={v('managerId')} onChange={inp('managerId')}>
            <option value="">{isNew ? 'авто (по очереди)' : '—'}</option>
            {staff.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.firstName} {s.lastName}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label={t('currentLevel')}>
        <EnumSelect value={form.currentLevel} onChange={(x) => set({ ...form, currentLevel: x })} options={LEVELS} />
      </Field>
      <Field label={t('targetLevel')}>
        <EnumSelect value={form.targetLevel} onChange={(x) => set({ ...form, targetLevel: x })} options={LEVELS} />
      </Field>
      <Field label={t('goal')}>
        <EnumSelect value={form.goal} onChange={(x) => set({ ...form, goal: x })} options={GOALS} prefix="goal" />
      </Field>
      <Field label={t('preferredTime')}>
        <input value={v('preferredTime')} onChange={inp('preferredTime')} placeholder="вечер, пн/ср/пт" />
      </Field>
    </div>
  );
}

function NewLeadModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [form, setForm] = useState<LeadForm>({ source: 'manual' });
  const create = useMutation({
    mutationFn: () => api<Lead>('/leads', { method: 'POST', body: form }),
    onSuccess: (lead) => {
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      onClose();
      onCreated(lead.id);
    },
  });
  return (
    <Modal title={t('newLead')} onClose={onClose}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <LeadFormFields form={form} set={setForm} isNew />
        <ErrorText error={create.error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="primary" disabled={!form.firstName || create.isPending}>
            {t('save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function LeadDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const stages = useStages();
  const lead = useQuery({ queryKey: ['lead', id], queryFn: () => api<LeadFull>(`/leads/${id}`) });
  const l = lead.data;
  const dups = useQuery({
    queryKey: ['lead-dups', id, l?.phone, l?.email],
    queryFn: () => api<Lead[]>(`/leads/duplicates${qs({ phone: l?.phone, email: l?.email })}`),
    enabled: !!l && !!(l.phone || l.email),
  });
  const [editing, setEditing] = useState<LeadForm | null>(null);
  const [note, setNote] = useState({ type: 'comment', text: '' });
  const [task, setTask] = useState({ title: '', dueAt: '' });
  const [lostStage, setLostStage] = useState<Stage | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['lead', id] });
    qc.invalidateQueries({ queryKey: ['leads'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    qc.invalidateQueries({ queryKey: ['tasks'] });
  };
  const m = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(), onSuccess: refresh });

  const otherDups = dups.data?.filter((d) => d.id !== id) ?? [];
  const canEdit = can('leads.update');

  return (
    <Drawer onClose={onClose}>
      {!l ? (
        <ErrorText error={lead.error} />
      ) : (
        <>
          <div className="drawer-head">
            <h1>
              {l.firstName} {l.lastName}
            </h1>
            <button onClick={onClose}>✕</button>
          </div>

          <div className="row" style={{ marginBottom: 16 }}>
            <select
              style={{ width: 'auto', borderColor: l.stage.color }}
              value={l.stageId}
              disabled={!canEdit}
              onChange={(e) => {
                const s = stages.data!.find((x) => x.id === e.target.value)!;
                if (s.isLost) setLostStage(s);
                else m.mutate(() => api(`/leads/${id}/stage`, { method: 'POST', body: { stageId: s.id } }));
              }}
            >
              {stages.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {canEdit && !editing && (
              <button onClick={() => setEditing({ ...l, lastName: l.lastName ?? undefined } as LeadForm)}>{t('edit')}</button>
            )}
            {l.phone && (
              <>
                <a className="btn" href={`tel:+${l.phone}`}>
                  📞 {t('call')}
                </a>
                <a className="btn" href={`https://wa.me/${l.phone}`} target="_blank" rel="noreferrer">
                  WhatsApp
                </a>
              </>
            )}
            {l.student ? (
              <button onClick={() => nav(`/students/${l.student!.id}`)}>→ {t('students')}</button>
            ) : (
              canEdit &&
              can('students.create') && (
                <button className="primary" onClick={() => m.mutate(() => api(`/leads/${id}/convert`, { method: 'POST' }))}>
                  {t('convert')}
                </button>
              )
            )}
          </div>
          <ErrorText error={m.error} />

          {otherDups.length > 0 && (
            <div className="card" style={{ borderColor: 'var(--warning)', marginBottom: 16 }}>
              <h3>{t('duplicates')}</h3>
              {otherDups.map((d) => (
                <div key={d.id} className="row" style={{ marginBottom: 6 }}>
                  <span className="grow">
                    {d.firstName} {d.lastName} · {fmtPhone(d.phone)} · {d.stage.name} · {fmtDate(d.createdAt, false)}
                  </span>
                  {canEdit && (
                    <button
                      className="small"
                      onClick={() => m.mutate(() => api(`/leads/${id}/merge`, { method: 'POST', body: { sourceId: d.id } }))}
                    >
                      {t('merge')}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const { firstName, lastName, phone, email, branchId, managerId, currentLevel, targetLevel, goal, preferredTime } = editing;
                m.mutate(
                  () =>
                    api(`/leads/${id}`, {
                      method: 'PATCH',
                      body: { firstName, lastName, phone, email, branchId, managerId, currentLevel, targetLevel, goal, preferredTime },
                    }),
                  { onSuccess: () => setEditing(null) },
                );
              }}
            >
              <LeadFormFields form={editing} set={setEditing} />
              <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 16 }}>
                <button type="button" onClick={() => setEditing(null)}>
                  {t('cancel')}
                </button>
                <button className="primary">{t('save')}</button>
              </div>
            </form>
          ) : (
            <dl className="kv">
              <dt>{t('phone')}</dt>
              <dd>{fmtPhone(l.phone)}</dd>
              <dt>{t('email')}</dt>
              <dd>{l.email ?? '—'}</dd>
              <dt>{t('source')}</dt>
              <dd>{t(`src.${l.source}`)}</dd>
              {(l.utmSource || l.utmCampaign) && (
                <>
                  <dt>{t('utm')}</dt>
                  <dd>{[l.utmSource, l.utmMedium, l.utmCampaign].filter(Boolean).join(' / ')}</dd>
                </>
              )}
              <dt>{t('branch')}</dt>
              <dd>{l.branch?.name ?? '—'}</dd>
              <dt>{t('manager')}</dt>
              <dd>{l.manager ? `${l.manager.firstName} ${l.manager.lastName}` : '—'}</dd>
              <dt>{t('level')}</dt>
              <dd>
                {l.currentLevel ?? '—'} → {l.targetLevel ?? '—'}
              </dd>
              <dt>{t('goal')}</dt>
              <dd>{l.goal ? t(`goal.${l.goal}`) : '—'}</dd>
              <dt>{t('preferredTime')}</dt>
              <dd>{l.preferredTime ?? '—'}</dd>
              {l.lostReason && (
                <>
                  <dt>{t('lostReason')}</dt>
                  <dd className="neg">{l.lostReason}</dd>
                </>
              )}
              <dt>{t('createdAt')}</dt>
              <dd>{fmtDate(l.createdAt)}</dd>
            </dl>
          )}

          <h3>{t('tasks')}</h3>
          <div style={{ marginBottom: 16 }}>
            {l.tasks.map((tk) => {
              const overdue = !tk.doneAt && new Date(tk.dueAt) < new Date();
              return (
                <div key={tk.id} className="row" style={{ marginBottom: 4 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={!!tk.doneAt}
                    disabled={!canEdit}
                    onChange={() => m.mutate(() => api(`/tasks/${tk.id}/done`, { method: 'POST' }))}
                  />
                  <span className="grow" style={{ textDecoration: tk.doneAt ? 'line-through' : undefined }}>
                    {tk.title}
                  </span>
                  <span className={overdue ? 'neg' : 'muted'}>{fmtDate(tk.dueAt)}</span>
                </div>
              );
            })}
            {canEdit && (
              <form
                className="row"
                style={{ marginTop: 8 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  m.mutate(
                    () =>
                      api('/tasks', {
                        method: 'POST',
                        body: { title: task.title, dueAt: new Date(task.dueAt).toISOString(), leadId: id },
                      }),
                    { onSuccess: () => setTask({ title: '', dueAt: '' }) },
                  );
                }}
              >
                <input className="grow" placeholder={t('newTask')} value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })} />
                <input type="datetime-local" style={{ width: 'auto' }} value={task.dueAt} onChange={(e) => setTask({ ...task, dueAt: e.target.value })} />
                <button disabled={!task.title || !task.dueAt}>+</button>
              </form>
            )}
          </div>

          <h3>{t('history')}</h3>
          {canEdit && (
            <form
              style={{ marginBottom: 12 }}
              onSubmit={(e) => {
                e.preventDefault();
                m.mutate(() => api(`/leads/${id}/activities`, { method: 'POST', body: note }), {
                  onSuccess: () => setNote({ ...note, text: '' }),
                });
              }}
            >
              <div className="row" style={{ marginBottom: 6 }}>
                {(['comment', 'call', 'message'] as const).map((k) => (
                  <label key={k} style={{ display: 'flex', gap: 4, alignItems: 'center', margin: 0 }}>
                    <input type="radio" style={{ width: 'auto' }} checked={note.type === k} onChange={() => setNote({ ...note, type: k })} />
                    {t(k)}
                  </label>
                ))}
              </div>
              <textarea value={note.text} onChange={(e) => setNote({ ...note, text: e.target.value })} />
              <button className="primary" style={{ marginTop: 6 }} disabled={!note.text.trim()}>
                {t('addComment')}
              </button>
            </form>
          )}
          <div className="feed">
            {l.activities.map((a) => (
              <div key={a.id} className={`feed-item ${a.type}`}>
                <div>{a.text}</div>
                <div className="meta">
                  {fmtDate(a.createdAt)} · {a.user ? `${a.user.firstName} ${a.user.lastName}` : 'система'} · {t(a.type)}
                </div>
              </div>
            ))}
          </div>

          {lostStage && (
            <LostReasonModal
              onClose={() => setLostStage(null)}
              onSubmit={(reason) => {
                m.mutate(() => api(`/leads/${id}/stage`, { method: 'POST', body: { stageId: lostStage.id, lostReason: reason } }));
                setLostStage(null);
              }}
            />
          )}
        </>
      )}
    </Drawer>
  );
}
