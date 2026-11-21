/** Прохождение теста: студентом (ДЗ-тест) и лидом/гостем по ссылке (входной тест уровня). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { FileList } from '../files';
import { LOCALES, Locale, useI18n } from '../i18n';
import { ErrorText, Field } from '../ui';

interface TakerQuestion {
  id: string;
  type: 'choice' | 'article' | 'matching' | 'text';
  prompt: string;
  points: number;
  files: { id: string; name: string; mime: string }[];
  options?: string[];
  multiple?: boolean;
  noun?: string;
  left?: string[];
  right?: string[];
}
interface AttemptView {
  title: string;
  description: string | null;
  kind: 'quiz' | 'placement';
  timeLimitMin: number | null;
  questionsCount: number;
  startedAt: string | null;
  deadlineAt: string | null;
  finishedAt: string | null;
  questions?: TakerQuestion[];
  result?: { score: string; maxScore: string; percent: string; level: string | null; timedOut: boolean };
}

const store = {
  get(k: string) {
    try {
      return JSON.parse(localStorage.getItem(k) ?? 'null');
    } catch {
      return null;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* приватный режим */
    }
  },
};

export function TestRunner({ token, onDone }: { token: string; onDone?: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const key = ['attempt', token];
  const q = useQuery({ queryKey: key, queryFn: () => api<AttemptView>(`/public/attempts/${token}`) });
  // Ответы сохраняются в браузере, чтобы не потерять их при обновлении страницы.
  const saveKey = `crm.attempt.${token}`;
  const [answers, setAnswers] = useState<Record<string, unknown>>(() => store.get(saveKey) ?? {});
  useEffect(() => store.set(saveKey, answers), [answers, saveKey]);

  const start = useMutation({
    mutationFn: () => api<AttemptView>(`/public/attempts/${token}/start`, { method: 'POST' }),
    onSuccess: (d) => qc.setQueryData(key, d),
  });
  const submit = useMutation({
    mutationFn: () => api(`/public/attempts/${token}/submit`, { method: 'POST', body: { answers } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key });
      onDone?.();
    },
  });
  const submitRef = useRef(submit.mutate);
  submitRef.current = submit.mutate;
  const autoSubmit = useCallback(() => !submit.isPending && !submit.isSuccess && submitRef.current(), [submit.isPending, submit.isSuccess]);

  const d = q.data;
  if (!d) return <ErrorText error={q.error} />;

  if (d.finishedAt && d.result) {
    const r = d.result;
    return (
      <div className="card taker" style={{ textAlign: 'center' }}>
        <h2>{d.title}</h2>
        {d.kind === 'placement' ? (
          <>
            <div className="muted">{t('yourLevel')}</div>
            <div className="result-big">{r.level === 'A0' ? t('belowA1') : r.level}</div>
            <p>{t('placementThanks')}</p>
          </>
        ) : (
          <div className="result-big">{Number(r.percent)}%</div>
        )}
        <div className="muted">
          {t('score')}: {Number(r.score)} / {Number(r.maxScore)}
          {r.timedOut ? ` · ${t('timedOut')}` : ''}
        </div>
      </div>
    );
  }

  if (!d.startedAt || !d.questions) {
    return (
      <div className="card taker">
        <h2>{d.title}</h2>
        {d.description && <p className="hw-desc">{d.description}</p>}
        <p className="muted">
          {t('questionsN')}: {d.questionsCount}
          {d.timeLimitMin ? ` · ${t('timeLimit')}: ${d.timeLimitMin} ${t('minutes')}` : ''}
        </p>
        <ErrorText error={start.error} />
        <button className="primary" onClick={() => start.mutate()} disabled={start.isPending}>
          {t('startTest')}
        </button>
      </div>
    );
  }

  const answered = d.questions.filter((x) => answers[x.id] !== undefined && answers[x.id] !== '').length;
  return (
    <div className="taker">
      {d.deadlineAt && <Timer deadline={d.deadlineAt} onExpire={autoSubmit} />}
      <h2>{d.title}</h2>
      {d.questions.map((qq, i) => (
        <div key={qq.id} className="card q">
          <div className="q-prompt">
            {i + 1}. {qq.prompt}
          </div>
          <FileList files={qq.files} publicToken={token} />
          <QuestionInput q={qq} value={answers[qq.id]} onChange={(v) => setAnswers({ ...answers, [qq.id]: v })} />
        </div>
      ))}
      <ErrorText error={submit.error} />
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="muted">
          {answered} / {d.questions.length}
        </span>
        <button
          className="primary"
          disabled={submit.isPending}
          onClick={() => (answered === d.questions!.length || window.confirm(t('confirmUnanswered'))) && submit.mutate()}
        >
          {t('finishTest')}
        </button>
      </div>
    </div>
  );
}

function Timer({ deadline, onExpire }: { deadline: string; onExpire: () => void }) {
  const { t } = useI18n();
  const [left, setLeft] = useState(() => +new Date(deadline) - Date.now());
  const fired = useRef(false);
  useEffect(() => {
    const id = window.setInterval(() => {
      const l = +new Date(deadline) - Date.now();
      setLeft(l);
      if (l <= 0 && !fired.current) {
        fired.current = true;
        onExpire();
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [deadline, onExpire]);
  const s = Math.max(0, Math.round(left / 1000));
  return (
    <div className={`timer ${s < 60 ? 'low' : ''}`} role="timer" aria-live="polite">
      ⏱ {t('timeLeft')}: {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}
    </div>
  );
}

function QuestionInput({ q, value, onChange }: { q: TakerQuestion; value: unknown; onChange: (v: unknown) => void }) {
  const { t } = useI18n();
  if (q.type === 'choice') {
    const sel = (value as number[]) ?? [];
    return (
      <div className="opt-btns" role={q.multiple ? 'group' : 'radiogroup'}>
        {q.options!.map((o, i) => (
          <button
            key={i}
            type="button"
            role={q.multiple ? 'checkbox' : 'radio'}
            aria-checked={sel.includes(i)}
            className={sel.includes(i) ? 'on' : ''}
            onClick={() => onChange(q.multiple ? (sel.includes(i) ? sel.filter((x) => x !== i) : [...sel, i]) : [i])}
          >
            {o}
          </button>
        ))}
        {q.multiple && <span className="muted" style={{ alignSelf: 'center' }}>{t('severalAnswers')}</span>}
      </div>
    );
  }
  if (q.type === 'article') {
    return (
      <div className="row">
        <div className="opt-btns" role="radiogroup">
          {q.options!.map((o) => (
            <button key={o} type="button" role="radio" aria-checked={value === o} className={value === o ? 'on' : ''} onClick={() => onChange(o)}>
              {o}
            </button>
          ))}
        </div>
        <b style={{ fontSize: 18 }}>{q.noun}</b>
      </div>
    );
  }
  if (q.type === 'matching') {
    const sel = (value as number[]) ?? q.left!.map(() => -1);
    return (
      <div>
        {q.left!.map((l, i) => (
          <div key={i} className="row" style={{ marginBottom: 6, flexWrap: 'nowrap' }}>
            <span style={{ minWidth: 120 }}>{l}</span>
            <span>→</span>
            <select value={sel[i] ?? -1} onChange={(e) => onChange(sel.map((x, j) => (j === i ? Number(e.target.value) : x)))} aria-label={l}>
              <option value={-1}>—</option>
              {q.right!.map((r, j) => (
                <option key={j} value={j}>
                  {r}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
    );
  }
  return <input value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} aria-label={q.prompt} autoComplete="off" />;
}

// ───────────── Публичные страницы (без входа) ─────────────

function PublicShell({ children }: { children: React.ReactNode }) {
  const { t, locale, setLocale } = useI18n();
  return (
    <div className="public-page">
      <div className="taker row" style={{ marginBottom: 16 }}>
        <span className="logo" style={{ background: 'linear-gradient(#111 0 33%, #dd0000 33% 66%, #ffce00 66%)', width: 28, height: 28, borderRadius: 7, display: 'inline-block' }} />
        <b style={{ flex: 1 }}>{t('appName')}</b>
        <select style={{ width: 'auto' }} value={locale} onChange={(e) => setLocale(e.target.value as Locale)} aria-label="Language">
          {Object.entries(LOCALES).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      {children}
    </div>
  );
}

/** /test/a/:token — личная ссылка на попытку. */
export function PublicAttemptPage() {
  const { token } = useParams();
  return (
    <PublicShell>
      <TestRunner token={token!} />
    </PublicShell>
  );
}

/** /test/:token — общая ссылка входного теста: имя и телефон, затем тест. */
export function PublicTestPage() {
  const { t } = useI18n();
  const { token } = useParams();
  const nav = useNavigate();
  const info = useQuery({
    queryKey: ['publicTest', token],
    queryFn: () => api<{ title: string; description: string | null; timeLimitMin: number | null; questions: number }>(`/public/tests/${token}`),
  });
  const [f, setF] = useState({ name: '', phone: '' });
  const start = useMutation({
    mutationFn: () => api<{ token: string }>(`/public/tests/${token}/start`, { method: 'POST', body: f }),
    onSuccess: (r) => nav(`/test/a/${r.token}`),
  });
  const d = info.data;
  return (
    <PublicShell>
      {!d ? (
        <div className="taker">
          <ErrorText error={info.error} />
        </div>
      ) : (
        <form
          className="card taker"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            start.mutate();
          }}
        >
          <h2>{d.title}</h2>
          {d.description && <p className="hw-desc">{d.description}</p>}
          <p className="muted">
            {t('questionsN')}: {d.questions}
            {d.timeLimitMin ? ` · ${t('timeLimit')}: ${d.timeLimitMin} ${t('minutes')}` : ''}
          </p>
          <Field label={t('name')}>
            <input required autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label={t('phone')}>
            <input required type="tel" autoComplete="tel" placeholder="+996 …" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          </Field>
          <p className="muted" style={{ fontSize: 12 }}>
            {t('consentTest')}
          </p>
          <ErrorText error={start.error} />
          <button className="primary" disabled={start.isPending}>
            {t('startTest')}
          </button>
        </form>
      )}
    </PublicShell>
  );
}
