/** Интеграции (ТЗ 5): webhook-и, статус провайдеров, чеки, оплата по ссылке, онлайн-уроки. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { ErrorText, Field, fmtDate, fmtMoney, fmtTime, Modal } from '../ui';
import { CopyLink, publicUrl } from './Tests';

const EVENTS = ['lead.created', 'lead.converted', 'payment.received', 'student.enrolled', 'subscription.created'];

interface Status {
  channels: { channel: string; configured: boolean; simulated: boolean }[];
  online: { provider: string; zoom: boolean };
  payments: { gateway: boolean; testMode: boolean };
  fiscal: { configured: boolean };
  push: { fcm: boolean; note: string };
}

export function IntegrationsPage() {
  const { t } = useI18n();
  const st = useQuery({ queryKey: ['integrationsStatus'], queryFn: () => api<Status>('/integrations/status') });
  const s = st.data;
  const badge = (on: boolean, label: string) => <span className={`badge ${on ? 'ok' : ''}`}>{label}</span>;
  return (
    <>
      <h1>{t('integrations')}</h1>
      <ErrorText error={st.error} />
      {s && (
        <div className="stats">
          <div className="card">
            <h3>{t('onlineLessons')}</h3>
            {badge(s.online.zoom, s.online.zoom ? 'Zoom' : 'Jitsi Meet')}
            <p className="muted" style={{ fontSize: 12 }}>{s.online.zoom ? t('zoomOn') : t('jitsiHint')}</p>
          </div>
          <div className="card">
            <h3>{t('onlinePayment')}</h3>
            {badge(s.payments.gateway, s.payments.gateway ? t('connected') : s.payments.testMode ? t('testMode') : t('off'))}
            <p className="muted" style={{ fontSize: 12 }}>{t('gatewayHint')}</p>
          </div>
          <div className="card">
            <h3>{t('fiscalTitle')}</h3>
            {badge(s.fiscal.configured, s.fiscal.configured ? t('connected') : t('ns.simulated'))}
            <p className="muted" style={{ fontSize: 12 }}>{t('fiscalHint')}</p>
          </div>
          <div className="card">
            <h3>{t('channelsTitle')}</h3>
            <div className="row" style={{ gap: 4 }}>
              {s.channels.map((c) => (
                <span key={c.channel}>{badge(c.configured, t(`ch.${c.channel}`))}</span>
              ))}
            </div>
            <p className="muted" style={{ fontSize: 12 }}>{s.push.note}</p>
          </div>
        </div>
      )}
      <Webhooks />
      <FiscalList />
    </>
  );
}

function Webhooks() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => api<{ id: string; url: string; events: string[]; description: string | null; isActive: boolean; secretHint: string; stats: Record<string, number> }[]>('/integrations/webhooks'),
  });
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['webhooks'] });
  const toggle = useMutation({ mutationFn: (h: { id: string; isActive: boolean }) => api(`/integrations/webhooks/${h.id}`, { method: 'PATCH', body: { isActive: !h.isActive } }), onSuccess: refresh });
  const test = useMutation({
    mutationFn: (id: string) => api<{ status: string; responseCode: number | null; error: string | null }>(`/integrations/webhooks/${id}/test`, { method: 'POST' }),
    onSuccess: () => {
      refresh();
      qc.invalidateQueries({ queryKey: ['deliveries'] });
    },
  });
  const del = useMutation({ mutationFn: (id: string) => api(`/integrations/webhooks/${id}`, { method: 'DELETE' }), onSuccess: refresh });
  return (
    <>
      <div className="row" style={{ margin: '8px 0' }}>
        <h3 style={{ margin: 0, marginRight: 'auto' }}>{t('webhooksTitle')}</h3>
        <button className="small primary" onClick={() => setCreating(true)}>
          + {t('add')}
        </button>
      </div>
      <p className="muted">{t('webhooksHint')}</p>
      <ErrorText error={list.error ?? test.error ?? del.error} />
      {test.data && (
        <div className={test.data.status === 'sent' ? 'ok-box' : 'error'}>
          ping: {test.data.status} {test.data.responseCode ?? ''} {test.data.error ?? ''}
        </div>
      )}
      <div className="table-wrap" style={{ marginBottom: 20 }}>
        <table>
          <tbody>
            {list.data?.map((h) => (
              <tr key={h.id} style={h.isActive ? undefined : { opacity: 0.5 }}>
                <td style={{ whiteSpace: 'normal' }}>
                  <b>{h.url}</b>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {h.description} · {h.events.join(', ')} · {t('secret')}: {h.secretHint}
                  </div>
                </td>
                <td>
                  {Object.entries(h.stats).map(([k, v]) => (
                    <span key={k} className={`badge ns-${k === 'pending' ? 'queued' : k}`} style={{ marginRight: 4 }}>
                      {k}: {v}
                    </span>
                  ))}
                </td>
                <td style={{ textAlign: 'right' }}>
                  <button className="small" onClick={() => test.mutate(h.id)} disabled={test.isPending}>
                    ping
                  </button>{' '}
                  <button className="small" onClick={() => setOpen(open === h.id ? null : h.id)}>
                    {t('log')}
                  </button>{' '}
                  <button className="small" onClick={() => toggle.mutate(h)}>
                    {h.isActive ? t('disable') : t('enable')}
                  </button>{' '}
                  <button className="small danger" onClick={() => window.confirm(t('confirmDelete')) && del.mutate(h.id)} aria-label="✕">
                    ✕
                  </button>
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
      {open && <Deliveries id={open} />}
      {creating && <WebhookModal onClose={() => setCreating(false)} />}
    </>
  );
}

function Deliveries({ id }: { id: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['deliveries', id],
    queryFn: () => api<{ id: string; event: string; status: string; attempts: number; responseCode: number | null; error: string | null; createdAt: string }[]>(`/integrations/webhooks/${id}/deliveries`),
    refetchInterval: 10_000,
  });
  const retry = useMutation({ mutationFn: (d: string) => api(`/integrations/webhooks/deliveries/${d}/retry`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['deliveries', id] }) });
  return (
    <div className="table-wrap" style={{ marginBottom: 20 }}>
      <table>
        <thead>
          <tr>
            <th>{t('when')}</th>
            <th>{t('event')}</th>
            <th>{t('status')}</th>
            <th>{t('attempts')}</th>
            <th>HTTP</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {q.data?.map((d) => (
            <tr key={d.id}>
              <td className="muted">{fmtDate(d.createdAt)}</td>
              <td>{d.event}</td>
              <td>
                <span className={`badge ns-${d.status === 'pending' ? 'queued' : d.status}`} title={d.error ?? ''}>
                  {d.status}
                </span>
              </td>
              <td>{d.attempts}</td>
              <td>{d.responseCode ?? '—'}</td>
              <td>
                {d.status !== 'sent' && (
                  <button className="small" onClick={() => retry.mutate(d.id)}>
                    ↻
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WebhookModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [f, setF] = useState({ url: 'https://', description: '', events: ['lead.created', 'payment.received'] });
  const m = useMutation({
    mutationFn: () => api<{ secret: string }>('/integrations/webhooks', { method: 'POST', body: f }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
  });
  return (
    <Modal title={t('newWebhook')} onClose={onClose}>
      {m.data ? (
        <>
          <p>{t('secretOnce')}</p>
          <CopyLink url={m.data.secret} />
          <p className="muted" style={{ fontSize: 12 }}>{t('signatureHint')}</p>
          <button className="primary" onClick={onClose}>
            {t('close')}
          </button>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
        >
          <Field label="URL">
            <input required type="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
          </Field>
          <Field label={t('description')}>
            <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </Field>
          <Field label={t('events')}>
            {EVENTS.map((ev) => (
              <label key={ev} className="row" style={{ margin: '2px 0', gap: 6, color: 'var(--text)' }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={f.events.includes(ev)}
                  onChange={(e) => setF({ ...f, events: e.target.checked ? [...f.events, ev] : f.events.filter((x) => x !== ev) })}
                />
                <code>{ev}</code> — {t(`ev.${ev}`)}
              </label>
            ))}
          </Field>
          <ErrorText error={m.error} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose}>
              {t('cancel')}
            </button>
            <button className="primary" disabled={m.isPending || !f.events.length}>
              {t('create')}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function FiscalList() {
  const { t } = useI18n();
  const q = useQuery({
    queryKey: ['fiscal'],
    queryFn: () =>
      api<{ id: string; status: string; fiscalNumber: string | null; error: string | null; createdAt: string; payment: { amount: string; type: string; method: string; student: { firstName: string; lastName: string } } }[]>('/integrations/fiscal'),
  });
  return (
    <>
      <h3>{t('fiscalTitle')}</h3>
      <div className="table-wrap">
        <table>
          <tbody>
            {q.data?.map((r) => (
              <tr key={r.id}>
                <td className="muted">{fmtDate(r.createdAt)}</td>
                <td>
                  {r.payment.student.lastName} {r.payment.student.firstName}
                </td>
                <td className={Number(r.payment.amount) < 0 ? 'neg' : ''}>{fmtMoney(r.payment.amount)}</td>
                <td>{t(`pm.${r.payment.method}`)}</td>
                <td>
                  <span className={`badge ns-${r.status === 'pending' ? 'queued' : r.status}`} title={r.error ?? ''}>
                    {t(`ns.${r.status === 'pending' ? 'queued' : r.status}`)}
                  </span>
                </td>
                <td>{r.fiscalNumber ?? '—'}</td>
              </tr>
            ))}
            {q.data?.length === 0 && (
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

// ───────────── Оплата по ссылке ─────────────

/** Кнопка в карточке студента: ссылка на онлайн-оплату для WhatsApp/SMS. */
export function PaymentLinkButton({ studentId, balance }: { studentId: string; balance: number }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(balance < 0 ? String(-balance) : '');
  const m = useMutation({ mutationFn: () => api<{ path: string; amount: string }>('/payment-links', { method: 'POST', body: { studentId, amount: amount ? Number(amount) : undefined } }) });
  return (
    <>
      <button className="small" onClick={() => setOpen(true)}>
        🔗 {t('paymentLink')}
      </button>
      {open && (
        <Modal title={t('paymentLink')} onClose={() => setOpen(false)}>
          {m.data ? (
            <>
              <p className="muted">
                {fmtMoney(m.data.amount)} · {t('paymentLinkHint')}
              </p>
              <CopyLink url={publicUrl(m.data.path)} />
            </>
          ) : (
            <>
              <Field label={`${t('amount')}, сом`}>
                <input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
              </Field>
              <ErrorText error={m.error} />
              <button className="primary" disabled={m.isPending} onClick={() => m.mutate()}>
                {t('createLink')}
              </button>
            </>
          )}
        </Modal>
      )}
    </>
  );
}

/** /pay/:token — страница оплаты для клиента (без входа). */
export function PayPage() {
  const { t } = useI18n();
  const { token } = useParams();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['pay', token],
    queryFn: () =>
      api<{ amount: number; description: string; status: string; expiresAt: string; paidAt: string | null; recipient: string; methods: { gateway: boolean; test: boolean } }>(`/public/pay/${token}`),
  });
  const [mode, setMode] = useState<'test' | null>(null);
  const start = useMutation({
    mutationFn: (method: 'card' | 'qr') => api<{ mode: 'test' | 'redirect'; url?: string }>(`/public/pay/${token}/start`, { method: 'POST', body: { method } }),
    onSuccess: (r) => (r.mode === 'redirect' && r.url ? (window.location.href = r.url) : setMode('test')),
  });
  const complete = useMutation({
    mutationFn: () => api(`/public/pay/${token}/test-complete`, { method: 'POST', body: { method: 'qr' } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pay', token] }),
  });
  const d = q.data;
  return (
    <div className="public-page">
      <div className="card taker" style={{ textAlign: 'center' }}>
        {!d ? (
          <ErrorText error={q.error} />
        ) : (
          <>
            <div className="muted">{d.recipient}</div>
            <h2 style={{ margin: '8px 0' }}>{d.description}</h2>
            <div className="result-big">{fmtMoney(d.amount)}</div>
            {d.status === 'paid' ? (
              <div className="ok-box">
                ✓ {t('paidThanks')} {d.paidAt ? `${fmtDate(d.paidAt, false)} ${fmtTime(d.paidAt)}` : ''}
              </div>
            ) : d.status !== 'pending' ? (
              <div className="error">{t(`pl.${d.status}`)}</div>
            ) : mode === 'test' ? (
              <>
                <p className="muted">{t('testPaymentHint')}</p>
                <ErrorText error={complete.error} />
                <button className="primary" disabled={complete.isPending} onClick={() => complete.mutate()}>
                  ✓ {t('testPay')}
                </button>
              </>
            ) : (
              <>
                <p className="muted">
                  {t('payUntil')} {fmtDate(d.expiresAt)}
                </p>
                <ErrorText error={start.error} />
                <div className="row" style={{ justifyContent: 'center' }}>
                  <button className="primary" disabled={start.isPending} onClick={() => start.mutate('card')}>
                    💳 {t('payByCard')}
                  </button>
                  <button disabled={start.isPending} onClick={() => start.mutate('qr')}>
                    ▦ {t('payByQr')}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ───────────── Онлайн-уроки ─────────────

/** Ближайшие занятия студента с кнопкой «Войти в урок». */
export function MyLessons() {
  const { t } = useI18n();
  const q = useQuery({
    queryKey: ['myLessons'],
    queryFn: () => api<{ id: string; startsAt: string; endsAt: string; group: string; room: string | null; teacher: string | null; topic: string | null; online: boolean; onlineUrl: string | null }[]>('/my/lessons'),
    refetchInterval: 60_000,
  });
  if (!q.data?.length) return null;
  const now = Date.now();
  return (
    <div className="card" style={{ maxWidth: 760, marginBottom: 16 }}>
      <h3>{t('upcomingLessons')}</h3>
      {q.data.slice(0, 4).map((l) => {
        const live = +new Date(l.startsAt) - now < 15 * 60_000 && +new Date(l.endsAt) > now;
        return (
          <div key={l.id} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            <b style={{ minWidth: 150 }}>
              {fmtDate(l.startsAt, false)} {fmtTime(l.startsAt)}
            </b>
            <span className="grow">
              {l.group}
              <span className="muted"> · {l.online ? t('online') : l.room ?? ''}{l.topic ? ` · ${l.topic}` : ''}</span>
            </span>
            {l.onlineUrl ? (
              <a className={`btn ${live ? 'primary' : ''}`} href={l.onlineUrl} target="_blank" rel="noreferrer" style={live ? { background: 'var(--primary)', color: '#fff' } : undefined}>
                ▶ {t('joinLesson')}
              </a>
            ) : l.online ? (
              <span className="muted" style={{ fontSize: 12 }}>{t('linkSoon')}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** В окне занятия: ссылка на онлайн-урок или кнопка её создания. */
export function OnlineLink({ lessonId, url }: { lessonId: string; url: string | null }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => api<{ url: string }>(`/lessons/${lessonId}/online-link`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lessons'] });
      qc.invalidateQueries({ queryKey: ['group'] });
    },
  });
  const link = m.data?.url ?? url;
  if (link)
    return (
      <a className="btn small" href={link} target="_blank" rel="noreferrer">
        ▶ {t('joinLesson')}
      </a>
    );
  if (!can('schedule.read')) return null;
  return (
    <>
      <button type="button" className="small" disabled={m.isPending} onClick={() => m.mutate()}>
        🎥 {t('createOnlineLink')}
      </button>
      <ErrorText error={m.error} />
    </>
  );
}

