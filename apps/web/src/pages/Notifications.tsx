/** Уведомления (ТЗ 3.8): колокольчик пользователя и раздел администрирования. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { EnumSelect, ErrorText, Field, fmtDate, fmtPhone, Modal } from '../ui';
import { useGroups } from './Groups';
import { useBranches } from './Leads';

const CHANNELS = ['push', 'telegram', 'whatsapp', 'sms', 'email'] as const;
type Channel = (typeof CHANNELS)[number];
const STATUSES = ['queued', 'sent', 'simulated', 'failed', 'skipped'];

interface InboxItem {
  id: string;
  type: string;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
}

// ───────────── Колокольчик ─────────────

export function NotificationBell() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const q = useQuery({
    queryKey: ['inbox'],
    queryFn: () => api<{ items: InboxItem[]; unread: number }>('/notifications/inbox'),
    refetchInterval: 30_000,
  });
  const tg = useQuery({
    queryKey: ['telegramLink'],
    queryFn: () => api<{ linked: boolean; configured: boolean; url: string | null }>('/notifications/telegram-link'),
    enabled: open,
    staleTime: 300_000,
  });
  const read = useMutation({
    mutationFn: (ids?: string[]) => api('/notifications/inbox/read', { method: 'POST', body: { ids } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inbox'] }),
  });
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const unread = q.data?.unread ?? 0;
  return (
    <div className="bell" ref={ref}>
      <button onClick={() => setOpen(!open)} aria-label={`${t('notifications')}: ${unread}`} aria-expanded={open}>
        🔔{unread > 0 && <span className="count-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="bell-panel" role="dialog" aria-label={t('notifications')}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <b>{t('notifications')}</b>
            {unread > 0 && (
              <button className="small" onClick={() => read.mutate(undefined)}>
                {t('markAllRead')}
              </button>
            )}
          </div>
          <div className="bell-list">
            {q.data?.items.map((n) => (
              <div
                key={n.id}
                className={`bell-item ${n.readAt ? '' : 'unread'}`}
                onClick={() => !n.readAt && read.mutate([n.id])}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && !n.readAt && read.mutate([n.id])}
              >
                <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
                  <b>{n.title}</b>
                  <span className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                    {fmtDate(n.createdAt)}
                  </span>
                </div>
                <div className="body">{n.body}</div>
              </div>
            ))}
            {q.data?.items.length === 0 && <div className="muted">{t('noData')}</div>}
          </div>
          {tg.data?.configured && !tg.data.linked && tg.data.url && (
            <a className="btn small" href={tg.data.url} target="_blank" rel="noreferrer" style={{ marginTop: 8 }}>
              ✈ {t('connectTelegram')}
            </a>
          )}
          {tg.data?.linked && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>✈ {t('telegramLinked')}</div>}
        </div>
      )}
    </div>
  );
}

// ───────────── Администрирование ─────────────

export function NotificationsPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'log' | 'templates' | 'rules' | 'broadcasts'>('log');
  return (
    <>
      <h1>{t('notifications')}</h1>
      <div className="tabs" role="tablist">
        {(['log', 'templates', 'rules', 'broadcasts'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {t(`ntab.${k}`)}
          </button>
        ))}
      </div>
      {tab === 'log' && <LogTab />}
      {tab === 'templates' && <TemplatesTab />}
      {tab === 'rules' && <RulesTab />}
      {tab === 'broadcasts' && <BroadcastsTab />}
    </>
  );
}

function useTypeNames() {
  return useQuery({
    queryKey: ['notifSettings'],
    queryFn: () =>
      api<{
        settings: { reminderHours: number; dailyHour: number; types: Record<string, { enabled: boolean; channels: Channel[]; parents: boolean }> };
        types: Record<string, { name: string; vars: string[] }>;
      }>('/notifications/settings'),
  });
}

function LogTab() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const names = useTypeNames();
  const [f, setF] = useState<{ status?: string; type?: string; search?: string }>({});
  const q = useQuery({
    queryKey: ['notifLog', f],
    queryFn: () =>
      api<
        {
          id: string;
          type: string;
          title: string;
          body: string;
          status: string;
          channel: string | null;
          error: string | null;
          phone: string | null;
          email: string | null;
          createdAt: string;
          sentAt: string | null;
          user: { firstName: string; lastName: string } | null;
        }[]
      >(`/notifications/log${qs(f)}`),
    refetchInterval: 15_000,
  });
  const run = useMutation({
    mutationFn: () => api<{ reminders: number; daily: number; sent: number }>('/notifications/run', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifLog'] }),
  });
  const typeNames = names.data?.types ?? {};
  return (
    <>
      <ChannelsStatus />
      <div className="toolbar">
        <input placeholder={t('search')} value={f.search ?? ''} onChange={(e) => setF({ ...f, search: e.target.value || undefined })} />
        <select value={f.type ?? ''} onChange={(e) => setF({ ...f, type: e.target.value || undefined })}>
          <option value="">{t('type')}</option>
          {Object.entries(typeNames).map(([k, v]) => (
            <option key={k} value={k}>
              {v.name}
            </option>
          ))}
        </select>
        <EnumSelect value={f.status} onChange={(v) => setF({ ...f, status: v })} options={STATUSES} prefix="ns" empty={t('status')} />
        <button style={{ marginLeft: 'auto' }} disabled={run.isPending} onClick={() => run.mutate()}>
          ▶ {t('processQueue')}
        </button>
      </div>
      <ErrorText error={q.error ?? run.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('when')}</th>
              <th>{t('type')}</th>
              <th>{t('recipient')}</th>
              <th>{t('message')}</th>
              <th>{t('channel')}</th>
              <th>{t('status')}</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((n) => (
              <tr key={n.id}>
                <td className="muted">{fmtDate(n.createdAt)}</td>
                <td>{typeNames[n.type]?.name ?? n.type}</td>
                <td>{n.user ? `${n.user.firstName} ${n.user.lastName}` : n.phone ? fmtPhone(n.phone) : n.email ?? '—'}</td>
                <td style={{ whiteSpace: 'normal', minWidth: 260 }}>
                  <b>{n.title}</b>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {n.body}
                  </div>
                </td>
                <td>{n.channel ? t(`ch.${n.channel}`) : '—'}</td>
                <td>
                  <span className={`badge ns-${n.status}`} title={n.error ?? ''}>
                    {t(`ns.${n.status}`)}
                  </span>
                  {n.error && n.status !== 'sent' && (
                    <div className="muted" style={{ fontSize: 11, whiteSpace: 'normal', maxWidth: 220 }}>
                      {n.error}
                    </div>
                  )}
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

function ChannelsStatus() {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['channels'], queryFn: () => api<{ channel: Channel; configured: boolean; simulated: boolean }[]>('/notifications/channels') });
  if (!q.data) return null;
  return (
    <div className="card row" style={{ marginBottom: 12, gap: 14 }}>
      <b>{t('channelsTitle')}:</b>
      {q.data.map((c) => (
        <span key={c.channel} className={`badge ${c.configured ? 'ok' : ''}`} title={c.simulated ? t('simulatedHint') : ''}>
          {t(`ch.${c.channel}`)}: {c.configured ? t('connected') : c.simulated ? t('ns.simulated') : t('off')}
        </span>
      ))}
      {q.data.some((c) => c.simulated) && <span className="muted" style={{ fontSize: 12 }}>{t('simulatedHint')}</span>}
    </div>
  );
}

function TemplatesTab() {
  const { t } = useI18n();
  const { activeRole } = useAuth();
  const q = useQuery({
    queryKey: ['templates'],
    queryFn: () =>
      api<{ type: string; name: string; vars: string[]; locales: Record<'ru' | 'ky', { title: string; body: string; custom: boolean }> }[]>('/notifications/templates'),
  });
  const [edit, setEdit] = useState<{ type: string; name: string; vars: string[]; locale: 'ru' | 'ky'; title: string; body: string } | null>(null);
  return (
    <>
      <ErrorText error={q.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('type')}</th>
              <th>Рус</th>
              <th>Кыр</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((tpl) => (
              <tr key={tpl.type}>
                <td>
                  <b>{tpl.name}</b>
                </td>
                {(['ru', 'ky'] as const).map((l) => (
                  <td
                    key={l}
                    className={activeRole?.branchId ? '' : 'click'}
                    style={{ whiteSpace: 'normal', maxWidth: 360 }}
                    onClick={() => !activeRole?.branchId && setEdit({ type: tpl.type, name: tpl.name, vars: tpl.vars, locale: l, ...tpl.locales[l] })}
                  >
                    <b>{tpl.locales[l].title}</b> {tpl.locales[l].custom && <span className="badge">✎</span>}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {tpl.locales[l].body}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <TemplateModal tpl={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function TemplateModal({
  tpl,
  onClose,
}: {
  tpl: { type: string; name: string; vars: string[]; locale: 'ru' | 'ky'; title: string; body: string };
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [f, setF] = useState({ title: tpl.title, body: tpl.body });
  const m = useMutation({
    mutationFn: () => api(`/notifications/templates/${tpl.type}/${tpl.locale}`, { method: 'PUT', body: f }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['templates'] });
      onClose();
    },
  });
  return (
    <Modal title={`${tpl.name} · ${tpl.locale === 'ru' ? 'Рус' : 'Кыр'}`} onClose={onClose}>
      <Field label={t('messageTitle')}>
        <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
      </Field>
      <Field label={t('messageBody')}>
        <textarea rows={5} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
      </Field>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        {t('placeholders')}:{' '}
        {tpl.vars.map((v) => (
          <button key={v} type="button" className="small" style={{ margin: 2 }} onClick={() => setF({ ...f, body: `${f.body}{{${v}}}` })}>
            {`{{${v}}}`}
          </button>
        ))}
      </div>
      <ErrorText error={m.error} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button onClick={onClose}>{t('cancel')}</button>
        <button className="primary" disabled={m.isPending} onClick={() => m.mutate()}>
          {t('save')}
        </button>
      </div>
    </Modal>
  );
}

function RulesTab() {
  const { t } = useI18n();
  const { activeRole } = useAuth();
  const qc = useQueryClient();
  const q = useTypeNames();
  const [s, setS] = useState(q.data?.settings);
  useEffect(() => {
    if (q.data) setS(q.data.settings);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api('/notifications/settings', { method: 'PUT', body: s }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifSettings'] }),
  });
  if (!s || !q.data) return <ErrorText error={q.error} />;
  const readOnly = !!activeRole?.branchId;
  const setType = (k: string, patch: Partial<(typeof s.types)[string]>) => setS({ ...s, types: { ...s.types, [k]: { ...s.types[k], ...patch } } });
  const move = (k: string, i: number, dir: -1 | 1) => {
    const ch = [...s.types[k].channels];
    const j = i + dir;
    if (j < 0 || j >= ch.length) return;
    [ch[i], ch[j]] = [ch[j], ch[i]];
    setType(k, { channels: ch });
  };
  return (
    <>
      <p className="muted">{t('rulesHint')}</p>
      <div className="row" style={{ marginBottom: 12 }}>
        <label className="row" style={{ margin: 0, gap: 6, color: 'var(--text)' }}>
          {t('reminderHours')}
          <input type="number" min={1} max={24} style={{ width: 70 }} disabled={readOnly} value={s.reminderHours} onChange={(e) => setS({ ...s, reminderHours: Number(e.target.value) })} />
        </label>
        <label className="row" style={{ margin: 0, gap: 6, color: 'var(--text)' }}>
          {t('dailyHour')}
          <input type="number" min={0} max={23} style={{ width: 70 }} disabled={readOnly} value={s.dailyHour} onChange={(e) => setS({ ...s, dailyHour: Number(e.target.value) })} />
        </label>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('type')}</th>
              <th>{t('active')}</th>
              <th>{t('channelOrder')}</th>
              <th>{t('parents')}</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(s.types).map(([k, r]) => (
              <tr key={k}>
                <td>{q.data.types[k]?.name ?? k}</td>
                <td>
                  <input type="checkbox" style={{ width: 'auto' }} disabled={readOnly} checked={r.enabled} onChange={(e) => setType(k, { enabled: e.target.checked })} aria-label={t('active')} />
                </td>
                <td style={{ whiteSpace: 'normal' }}>
                  <div className="row" style={{ gap: 4 }}>
                    {r.channels.map((c, i) => (
                      <span key={c} className="badge chan">
                        {i + 1}. {t(`ch.${c}`)}
                        {!readOnly && (
                          <>
                            <button className="small" disabled={i === 0} onClick={() => move(k, i, -1)} aria-label="←">
                              ←
                            </button>
                            <button className="small" onClick={() => r.channels.length > 1 && setType(k, { channels: r.channels.filter((x) => x !== c) })} aria-label="✕">
                              ✕
                            </button>
                          </>
                        )}
                      </span>
                    ))}
                    {!readOnly &&
                      CHANNELS.filter((c) => !r.channels.includes(c)).map((c) => (
                        <button key={c} className="small" onClick={() => setType(k, { channels: [...r.channels, c] })}>
                          + {t(`ch.${c}`)}
                        </button>
                      ))}
                  </div>
                </td>
                <td>
                  <input type="checkbox" style={{ width: 'auto' }} disabled={readOnly} checked={r.parents} onChange={(e) => setType(k, { parents: e.target.checked })} aria-label={t('parents')} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ErrorText error={save.error} />
      {save.isSuccess && <div className="ok-box">{t('saved')}</div>}
      {!readOnly && (
        <button className="primary" style={{ marginTop: 12 }} disabled={save.isPending} onClick={() => save.mutate()}>
          {t('save')}
        </button>
      )}
    </>
  );
}

interface Segment {
  audience: 'students' | 'leads';
  branchId?: string;
  status?: string;
  level?: string;
  groupId?: string;
  finishedLevel?: string;
  debtOnly?: boolean;
  includeParents?: boolean;
}

function BroadcastsTab() {
  const { t } = useI18n();
  const { activeRole } = useAuth();
  const qc = useQueryClient();
  const branches = useBranches();
  const groups = useGroups();
  const list = useQuery({
    queryKey: ['broadcasts'],
    queryFn: () => api<{ id: string; title: string; body: string; total: number; createdAt: string; stats: Record<string, number> }[]>('/notifications/broadcasts'),
  });
  const [seg, setSeg] = useState<Segment>({ audience: 'students', status: 'active' });
  const [msg, setMsg] = useState({ title: '', body: '' });
  const clean = Object.fromEntries(Object.entries(seg).filter(([, v]) => v !== undefined && v !== '' && v !== false));
  const preview = useQuery({
    queryKey: ['broadcastPreview', clean],
    queryFn: () => api<{ count: number; reachable: number; sample: string[] }>('/notifications/broadcasts/preview', { method: 'POST', body: { segment: clean } }),
  });
  const send = useMutation({
    mutationFn: () => api<{ queued: number }>('/notifications/broadcasts', { method: 'POST', body: { ...msg, segment: clean } }),
    onSuccess: () => {
      setMsg({ title: '', body: '' });
      qc.invalidateQueries({ queryKey: ['broadcasts'] });
    },
  });
  const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <h3>{t('newBroadcast')}</h3>
        <div className="grid2">
          <Field label={t('audience')}>
            <EnumSelect value={seg.audience} onChange={(v) => setSeg({ audience: (v as Segment['audience']) ?? 'students' })} options={['students', 'leads']} prefix="aud" empty={false} />
          </Field>
          {!activeRole?.branchId && (
            <Field label={t('branch')}>
              <select value={seg.branchId ?? ''} onChange={(e) => setSeg({ ...seg, branchId: e.target.value || undefined })}>
                <option value="">{t('allBranches')}</option>
                {branches.data?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label={t('currentLevel')}>
            <EnumSelect value={seg.level} onChange={(v) => setSeg({ ...seg, level: v })} options={LEVELS} />
          </Field>
          {seg.audience === 'students' && (
            <>
              <Field label={t('status')}>
                <EnumSelect value={seg.status} onChange={(v) => setSeg({ ...seg, status: v })} options={['active', 'paused', 'finished', 'left']} prefix="st" />
              </Field>
              <Field label={t('finishedLevel')}>
                <EnumSelect value={seg.finishedLevel} onChange={(v) => setSeg({ ...seg, finishedLevel: v })} options={LEVELS} />
              </Field>
              <Field label={t('group')}>
                <select value={seg.groupId ?? ''} onChange={(e) => setSeg({ ...seg, groupId: e.target.value || undefined })}>
                  <option value="">—</option>
                  {groups.data?.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
        </div>
        {seg.audience === 'students' && (
          <div className="row" style={{ marginBottom: 10 }}>
            <label className="row" style={{ margin: 0, gap: 6, color: 'var(--text)' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={!!seg.debtOnly} onChange={(e) => setSeg({ ...seg, debtOnly: e.target.checked })} />
              {t('onlyDebt')}
            </label>
            <label className="row" style={{ margin: 0, gap: 6, color: 'var(--text)' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={!!seg.includeParents} onChange={(e) => setSeg({ ...seg, includeParents: e.target.checked })} />
              {t('includeParents')}
            </label>
          </div>
        )}
        <div className="muted" style={{ marginBottom: 10 }}>
          {t('recipients')}: <b>{preview.data?.count ?? '…'}</b>
          {preview.data ? ` · ${t('reachable')}: ${preview.data.reachable}` : ''}
          {preview.data?.sample.length ? ` · ${preview.data.sample.join(', ')}${preview.data.count > preview.data.sample.length ? '…' : ''}` : ''}
        </div>
        <Field label={t('messageTitle')}>
          <input value={msg.title} onChange={(e) => setMsg({ ...msg, title: e.target.value })} placeholder={t('broadcastTitleExample')} />
        </Field>
        <Field label={t('messageBody')}>
          <textarea rows={4} value={msg.body} onChange={(e) => setMsg({ ...msg, body: e.target.value })} placeholder={t('broadcastBodyExample')} />
        </Field>
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          {t('placeholders')}: {'{{name}} {{student}} {{center}}'}
        </div>
        <ErrorText error={send.error ?? preview.error} />
        {send.data && <div className="ok-box">{t('queuedN')}: {send.data.queued}</div>}
        <button
          className="primary"
          disabled={send.isPending || !msg.title.trim() || !msg.body.trim() || !preview.data?.count}
          onClick={() => window.confirm(`${t('sendBroadcastConfirm')} ${preview.data?.count}?`) && send.mutate()}
        >
          {t('sendBroadcast')}
        </button>
      </div>
      <h3>{t('history')}</h3>
      <div className="table-wrap">
        <table>
          <tbody>
            {list.data?.map((b) => (
              <tr key={b.id}>
                <td className="muted">{fmtDate(b.createdAt)}</td>
                <td style={{ whiteSpace: 'normal' }}>
                  <b>{b.title}</b>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {b.body}
                  </div>
                </td>
                <td>{b.total}</td>
                <td>
                  {Object.entries(b.stats).map(([k, v]) => (
                    <span key={k} className={`badge ns-${k}`} style={{ marginRight: 4 }}>
                      {t(`ns.${k}`)}: {v}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
            {list.data?.length === 0 && (
              <tr>
                <td className="muted">{t('noData')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
