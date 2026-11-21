/** Конструктор тестов (ТЗ 3.6): выбор ответа, артикль der/die/das, сопоставление, вписать слово, аудирование. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, FileRef } from '../api';
import { FilePicker } from '../files';
import { useI18n } from '../i18n';
import { Drawer, EnumSelect, ErrorText, Field, fmtDate, fmtPhone, Modal } from '../ui';

const Q_TYPES = ['choice', 'article', 'matching', 'text'] as const;
type QType = (typeof Q_TYPES)[number];
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'];

interface TestRow {
  id: string;
  title: string;
  kind: 'quiz' | 'placement';
  level: string | null;
  timeLimitMin: number | null;
  isPublished: boolean;
  publicToken: string | null;
  createdAt: string;
  _count: { questions: number; attempts: number };
}
interface Question {
  id?: string;
  type: QType;
  prompt: string;
  level?: string | null;
  points: number;
  data: any;
  files?: FileRef[];
}
interface TestFull extends Omit<TestRow, '_count'> {
  description: string | null;
  questions: Question[];
}

const emptyData = (type: QType) =>
  type === 'choice'
    ? { options: ['', ''], correct: [0] }
    : type === 'article'
      ? { noun: '', correct: 'der' }
      : type === 'matching'
        ? { pairs: [{ left: '', right: '' }, { left: '', right: '' }] }
        : { answers: [''] };

export const publicUrl = (path: string) => `${window.location.origin}${path}`;

export function TestsPage() {
  const { t } = useI18n();
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['tests'], queryFn: () => api<TestRow[]>('/tests') });
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ title: '', kind: 'quiz' });
  const create = useMutation({
    mutationFn: () => api<TestRow>('/tests', { method: 'POST', body: f }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['tests'] });
      setCreating(false);
      nav(`/tests/${r.id}`);
    },
  });
  return (
    <>
      <div className="toolbar">
        <h1 style={{ margin: 0, marginRight: 'auto' }}>{t('testsTitle')}</h1>
        <button className="primary" onClick={() => setCreating(true)}>
          + {t('newTest')}
        </button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('name')}</th>
              <th>{t('type')}</th>
              <th>{t('questionsN')}</th>
              <th>{t('timeLimit')}</th>
              <th>{t('results')}</th>
              <th>{t('status')}</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((x) => (
              <tr key={x.id} className="click" onClick={() => nav(`/tests/${x.id}`)}>
                <td>
                  <b>{x.title}</b>
                </td>
                <td>{t(`tk.${x.kind}`)}</td>
                <td>{x._count.questions}</td>
                <td>{x.timeLimitMin ? `${x.timeLimitMin} ${t('minutes')}` : '—'}</td>
                <td>{x._count.attempts}</td>
                <td>
                  <span className={`badge ${x.isPublished ? 'ok' : ''}`}>{x.isPublished ? t('published') : t('draft')}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {creating && (
        <Modal title={t('newTest')} onClose={() => setCreating(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Field label={t('name')}>
              <input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
            </Field>
            <Field label={t('type')}>
              <EnumSelect value={f.kind} onChange={(v) => setF({ ...f, kind: v! })} options={['quiz', 'placement']} prefix="tk" empty={false} />
            </Field>
            <ErrorText error={create.error} />
            <button className="primary" disabled={create.isPending}>
              {t('create')}
            </button>
          </form>
        </Modal>
      )}
      {id && <TestDrawer id={id} onClose={() => nav('/tests')} />}
    </>
  );
}

function TestDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['test', id], queryFn: () => api<TestFull>(`/tests/${id}`) });
  const [tab, setTab] = useState<'questions' | 'results'>('questions');
  const [meta, setMeta] = useState<Partial<TestFull> | null>(null);
  const [qs, setQs] = useState<Question[] | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (q.data) {
      setMeta({ title: q.data.title, description: q.data.description, timeLimitMin: q.data.timeLimitMin, level: q.data.level });
      setQs(q.data.questions.map((x) => ({ ...x, data: JSON.parse(JSON.stringify(x.data)) })));
    }
  }, [q.data]);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['test', id] });
    qc.invalidateQueries({ queryKey: ['tests'] });
  };
  const save = useMutation({
    mutationFn: async () => {
      await api(`/tests/${id}`, { method: 'PATCH', body: { title: meta!.title, description: meta!.description || undefined, timeLimitMin: meta!.timeLimitMin || null, level: meta!.level || undefined } });
      return api(`/tests/${id}/questions`, {
        method: 'PUT',
        body: { questions: qs!.map((x) => ({ id: x.id, type: x.type, prompt: x.prompt, level: x.level || undefined, points: x.points, data: x.data, fileIds: (x.files ?? []).map((f) => f.id) })) },
      });
    },
    onSuccess: () => {
      setSaved(true);
      refresh();
    },
  });
  const publish = useMutation({
    mutationFn: (isPublished: boolean) => api(`/tests/${id}`, { method: 'PATCH', body: { isPublished } }),
    onSuccess: refresh,
  });
  const d = q.data;
  const set = (i: number, patch: Partial<Question>) => {
    setSaved(false);
    setQs(qs!.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  };

  return (
    <Drawer onClose={onClose}>
      {!d || !meta || !qs ? (
        <ErrorText error={q.error} />
      ) : (
        <>
          <div className="drawer-head">
            <h1>{d.title}</h1>
            <button className={d.isPublished ? '' : 'primary'} disabled={publish.isPending} onClick={() => publish.mutate(!d.isPublished)}>
              {d.isPublished ? t('unpublish') : t('publish')}
            </button>
            <button onClick={onClose} aria-label={t('close')}>
              ✕
            </button>
          </div>
          <ErrorText error={publish.error} />
          {d.kind === 'placement' && d.publicToken && d.isPublished && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="muted" style={{ fontSize: 12 }}>
                {t('publicLink')}
              </div>
              <CopyLink url={publicUrl(`/test/${d.publicToken}`)} />
            </div>
          )}
          <div className="tabs" role="tablist">
            {(['questions', 'results'] as const).map((k) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                {t(k === 'questions' ? 'questionsN' : 'results')}
              </button>
            ))}
          </div>
          {tab === 'results' ? (
            <Results testId={id} placement={d.kind === 'placement'} />
          ) : (
            <>
              <div className="grid2">
                <Field label={t('name')}>
                  <input value={meta.title ?? ''} onChange={(e) => setMeta({ ...meta, title: e.target.value })} />
                </Field>
                <Field label={`${t('timeLimit')}, ${t('minutes')}`}>
                  <input type="number" min={1} value={meta.timeLimitMin ?? ''} onChange={(e) => setMeta({ ...meta, timeLimitMin: e.target.value ? Number(e.target.value) : null })} />
                </Field>
              </div>
              <Field label={t('description')}>
                <textarea value={meta.description ?? ''} onChange={(e) => setMeta({ ...meta, description: e.target.value })} />
              </Field>
              {d.kind === 'placement' && <p className="muted">{t('placementHint')}</p>}
              {qs.map((x, i) => (
                <QuestionEditor
                  key={x.id ?? `n${i}`}
                  n={i + 1}
                  q={x}
                  placement={d.kind === 'placement'}
                  onChange={(p) => set(i, p)}
                  onRemove={() => setQs(qs.filter((_, j) => j !== i))}
                  onUp={i > 0 ? () => setQs([...qs.slice(0, i - 1), qs[i], qs[i - 1], ...qs.slice(i + 1)]) : undefined}
                />
              ))}
              <div className="row" style={{ marginBottom: 12 }}>
                {Q_TYPES.map((type) => (
                  <button key={type} type="button" onClick={() => setQs([...qs, { type, prompt: type === 'article' ? t('chooseArticle') : '', points: type === 'matching' ? 3 : 1, data: emptyData(type), level: d.kind === 'placement' ? 'A1' : null, files: [] }])}>
                    + {t(`qt.${type}`)}
                  </button>
                ))}
              </div>
              <ErrorText error={save.error} />
              {saved && <div className="ok-box">{t('saved')}</div>}
              <button className="primary" disabled={save.isPending} onClick={() => save.mutate()}>
                {t('save')}
              </button>
            </>
          )}
        </>
      )}
    </Drawer>
  );
}

export function CopyLink({ url }: { url: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="row" style={{ flexWrap: 'nowrap' }}>
      <input readOnly value={url} onFocus={(e) => e.target.select()} />
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
          } catch {
            /* без доступа к буферу — ссылку можно выделить вручную */
          }
        }}
      >
        {copied ? '✓' : t('copy')}
      </button>
    </div>
  );
}

function QuestionEditor({
  n,
  q,
  placement,
  onChange,
  onRemove,
  onUp,
}: {
  n: number;
  q: Question;
  placement: boolean;
  onChange: (p: Partial<Question>) => void;
  onRemove: () => void;
  onUp?: () => void;
}) {
  const { t } = useI18n();
  const d = q.data;
  const setData = (patch: any) => onChange({ data: { ...d, ...patch } });
  return (
    <div className="q-card">
      <div className="q-head">
        <b>{n}.</b>
        <span className="badge">{t(`qt.${q.type}`)}</span>
        {placement && (
          <select style={{ width: 'auto' }} value={q.level ?? 'A1'} onChange={(e) => onChange({ level: e.target.value })} aria-label={t('level')}>
            {LEVELS.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        )}
        <label className="row" style={{ margin: 0, gap: 4 }}>
          {t('points')}
          <input type="number" min={1} style={{ width: 64 }} value={q.points} onChange={(e) => onChange({ points: Number(e.target.value) || 1 })} />
        </label>
        <span style={{ flex: 1 }} />
        {onUp && (
          <button type="button" className="small" onClick={onUp} aria-label="↑">
            ↑
          </button>
        )}
        <button type="button" className="small danger" onClick={onRemove} aria-label="✕">
          ✕
        </button>
      </div>
      <input placeholder={t('questionText')} value={q.prompt} onChange={(e) => onChange({ prompt: e.target.value })} style={{ marginBottom: 8 }} />
      {q.type === 'choice' && (
        <>
          {d.options.map((o: string, i: number) => (
            <div key={i} className="choice-opt">
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={d.correct.includes(i)}
                onChange={(e) => setData({ correct: e.target.checked ? [...d.correct, i] : d.correct.filter((x: number) => x !== i) })}
                aria-label={t('correct')}
              />
              <input value={o} placeholder={`${t('option')} ${i + 1}`} onChange={(e) => setData({ options: d.options.map((x: string, j: number) => (j === i ? e.target.value : x)) })} />
              {d.options.length > 2 && (
                <button
                  type="button"
                  className="small"
                  onClick={() => setData({ options: d.options.filter((_: string, j: number) => j !== i), correct: d.correct.filter((x: number) => x !== i).map((x: number) => (x > i ? x - 1 : x)) })}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <button type="button" className="small" onClick={() => setData({ options: [...d.options, ''] })}>
            + {t('option')}
          </button>
          <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
            {t('markCorrect')}
          </span>
        </>
      )}
      {q.type === 'article' && (
        <div className="row">
          <select style={{ width: 'auto' }} value={d.correct} onChange={(e) => setData({ correct: e.target.value })} aria-label={t('correct')}>
            {['der', 'die', 'das'].map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <input className="grow" placeholder={t('noun')} value={d.noun} onChange={(e) => setData({ noun: e.target.value })} />
        </div>
      )}
      {q.type === 'matching' && (
        <>
          {d.pairs.map((p: { left: string; right: string }, i: number) => (
            <div key={i} className="choice-opt">
              <input value={p.left} placeholder={t('left')} onChange={(e) => setData({ pairs: d.pairs.map((x: any, j: number) => (j === i ? { ...x, left: e.target.value } : x)) })} />
              <span>↔</span>
              <input value={p.right} placeholder={t('right')} onChange={(e) => setData({ pairs: d.pairs.map((x: any, j: number) => (j === i ? { ...x, right: e.target.value } : x)) })} />
              {d.pairs.length > 2 && (
                <button type="button" className="small" onClick={() => setData({ pairs: d.pairs.filter((_: any, j: number) => j !== i) })}>
                  ✕
                </button>
              )}
            </div>
          ))}
          <button type="button" className="small" onClick={() => setData({ pairs: [...d.pairs, { left: '', right: '' }] })}>
            + {t('pair')}
          </button>
        </>
      )}
      {q.type === 'text' && (
        <Field label={t('acceptedAnswers')}>
          <input value={d.answers.join('; ')} onChange={(e) => setData({ answers: e.target.value.split(';').map((s) => s.trim()) })} />
        </Field>
      )}
      <div style={{ marginTop: 8 }}>
        <FilePicker value={q.files ?? []} onChange={(files) => onChange({ files })} accept="audio/*,image/*" />
      </div>
    </div>
  );
}

function Results({ testId, placement }: { testId: string; placement: boolean }) {
  const { t } = useI18n();
  const q = useQuery({
    queryKey: ['testAttempts', testId],
    queryFn: () =>
      api<
        {
          id: string;
          finishedAt: string;
          percent: string;
          score: string;
          maxScore: string;
          level: string | null;
          timedOut: boolean;
          guestName: string | null;
          student: { firstName: string; lastName: string } | null;
          lead: { id: string; firstName: string; lastName: string | null; phone: string | null } | null;
        }[]
      >(`/tests/${testId}/attempts`),
  });
  return (
    <div className="table-wrap">
      <table>
        <tbody>
          {q.data?.map((a) => (
            <tr key={a.id}>
              <td>
                {a.student ? `${a.student.lastName} ${a.student.firstName}` : a.lead ? `${a.lead.firstName} ${a.lead.lastName ?? ''}` : a.guestName}
                {a.lead?.phone && <div className="muted" style={{ fontSize: 12 }}>{fmtPhone(a.lead.phone)}</div>}
              </td>
              <td className="muted">{fmtDate(a.finishedAt)}</td>
              {placement && <td><b>{a.level === 'A0' ? t('belowA1') : a.level}</b></td>}
              <td>
                {Number(a.percent)}% ({Number(a.score)}/{Number(a.maxScore)})
              </td>
              <td>{a.timedOut ? <span className="badge">{t('timedOut')}</span> : ''}</td>
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
  );
}

/** Кнопка в карточке лида: личная ссылка на входной тест. */
export function PlacementLinkButton({ leadId }: { leadId: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const tests = useQuery({
    queryKey: ['placementTests'],
    queryFn: () => api<{ id: string; title: string }[]>('/tests/placement'),
    enabled: open,
  });
  const [testId, setTestId] = useState('');
  const m = useMutation({
    mutationFn: () => api<{ path: string }>(`/leads/${leadId}/placement-link`, { method: 'POST', body: { testId: testId || tests.data?.[0]?.id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lead', leadId] }),
  });
  return (
    <>
      <button onClick={() => setOpen(true)}>🧪 {t('placementTest')}</button>
      {open && (
        <Modal title={t('placementTest')} onClose={() => setOpen(false)}>
          <Field label={t('testsTitle')}>
            <select value={testId} onChange={(e) => setTestId(e.target.value)}>
              {tests.data?.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title}
                </option>
              ))}
            </select>
          </Field>
          <ErrorText error={m.error ?? tests.error} />
          {m.data ? (
            <>
              <p className="muted">{t('sendLinkHint')}</p>
              <CopyLink url={publicUrl(m.data.path)} />
            </>
          ) : (
            <button className="primary" disabled={m.isPending || !tests.data?.length} onClick={() => m.mutate()}>
              {t('createLink')}
            </button>
          )}
        </Modal>
      )}
    </>
  );
}
