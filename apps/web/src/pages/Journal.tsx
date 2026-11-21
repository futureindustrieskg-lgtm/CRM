import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { addDays, zDate, zonedToUtc } from '../tz';
import { ErrorText, Field, fmtDate, fmtTime, Modal } from '../ui';
import type { Lesson } from './Schedule';

export const AT_STATUSES = ['present', 'late', 'excused', 'absent'] as const;
type AtStatus = (typeof AT_STATUSES)[number];
export const SKILLS = ['hoeren', 'lesen', 'schreiben', 'sprechen'] as const;
const AT_ICON: Record<AtStatus, string> = { present: '✓', late: '◷', excused: 'У', absent: '✕' };

export interface LearningSettings {
  charge: Record<AtStatus, boolean>;
  absenceThreshold: number;
  countExcusedInStreak: boolean;
  gradeScale: 'percent' | 'points' | 'de_1_6';
  gradeMax: number;
}

interface Journal {
  lesson: Lesson & { topic: string | null; courseTopicId: string | null };
  course: { id: string; name: string };
  topics: { id: string; title: string; chapter: string | null; sort: number; used: boolean }[];
  suggestedTopicId: string | null;
  students: { id: string; firstName: string; lastName: string; status: string; leftAt: string | null }[];
  attendance: { studentId: string; status: AtStatus; charged: boolean }[];
  grades: { studentId: string; skill: string; value: string }[];
  settings: LearningSettings;
  canMark: boolean;
}

interface MarkResult {
  saved: number;
  alerts: { studentId: string; name: string; streak: number; tasks: number; parentsNotified: number }[];
}

export function AtBadge({ s }: { s?: string | null }) {
  const { t } = useI18n();
  if (!s) return <span className="at at-none">·</span>;
  return (
    <span className={`at at-${s}`} title={t(`at.${s}`)}>
      {AT_ICON[s as AtStatus]}
    </span>
  );
}

function scaleHint(s: LearningSettings) {
  return s.gradeScale === 'percent' ? '0–100' : s.gradeScale === 'points' ? `0–${s.gradeMax}` : '1–6';
}

/**
 * Отметка посещаемости (ТЗ 3.5): все по умолчанию «был», меняется одним нажатием,
 * тема урока из учебного плана, оценки по навыкам Goethe.
 */
export function AttendanceModal({ lessonId, onClose }: { lessonId: string; onClose: () => void }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['journal', lessonId], queryFn: () => api<Journal>(`/lessons/${lessonId}/journal`) });
  const j = q.data;
  const [marks, setMarks] = useState<Record<string, AtStatus>>({});
  const [topicId, setTopicId] = useState('');
  const [topic, setTopic] = useState('');
  const [grades, setGrades] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<'attendance' | 'grades'>('attendance');
  const [result, setResult] = useState<MarkResult | null>(null);
  const [gradesSaved, setGradesSaved] = useState(false);

  useEffect(() => {
    if (!j) return;
    const existing = Object.fromEntries(j.attendance.map((a) => [a.studentId, a.status]));
    setMarks(Object.fromEntries(j.students.map((s) => [s.id, existing[s.id] ?? 'present'])));
    setTopicId(j.lesson.courseTopicId ?? j.suggestedTopicId ?? '');
    setTopic(j.lesson.topic ?? '');
    setGrades(Object.fromEntries(j.grades.map((g) => [`${g.studentId}:${g.skill}`, String(Number(g.value))])));
  }, [j]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['journal', lessonId] });
    qc.invalidateQueries({ queryKey: ['lessons'] });
    qc.invalidateQueries({ queryKey: ['group'] });
    qc.invalidateQueries({ queryKey: ['groupJournal'] });
  };
  const save = useMutation({
    mutationFn: () =>
      api<MarkResult>(`/lessons/${lessonId}/attendance`, {
        method: 'PUT',
        body: {
          items: Object.entries(marks).map(([studentId, status]) => ({ studentId, status })),
          courseTopicId: topicId || null,
          topic,
        },
      }),
    onSuccess: (r) => {
      setResult(r);
      refresh();
    },
  });
  const saveGrades = useMutation({
    mutationFn: () =>
      api(`/lessons/${lessonId}/grades`, {
        method: 'POST',
        body: {
          items: Object.entries(grades).map(([k, v]) => {
            const [studentId, skill] = k.split(':');
            return { studentId, skill, value: v.trim() === '' ? null : Number(v.replace(',', '.')) };
          }),
        },
      }),
    onSuccess: () => {
      setGradesSaved(true);
      refresh();
    },
  });

  const editable = !!j?.canMark && can('attendance.create');
  const marked = new Set(j?.attendance.map((a) => a.studentId));

  return (
    <Modal title={`${t('journal')}: ${j?.lesson.group?.name ?? '…'}`} onClose={onClose} wide>
      {!j ? (
        <ErrorText error={q.error} />
      ) : (
        <>
          <div className="row muted" style={{ marginBottom: 10 }}>
            <span>
              {fmtDate(j.lesson.startsAt, false)} {fmtTime(j.lesson.startsAt)}–{fmtTime(j.lesson.endsAt)}
            </span>
            <span>· {j.course.name}</span>
            {j.lesson.room && <span>· {j.lesson.room.name}</span>}
            <span className="badge">{t(`ls.${j.lesson.status}`)}</span>
          </div>
          {!j.canMark && j.lesson.status !== 'cancelled' && <div className="muted" style={{ marginBottom: 10 }}>{t('notStarted')}</div>}
          <div className="tabs" role="tablist">
            {(['attendance', 'grades'] as const).map((k) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                {t(k)}
              </button>
            ))}
          </div>

          {tab === 'attendance' && (
            <>
              <div className="marks">
                {j.students.map((s) => (
                  <div key={s.id} className="mark-row">
                    <div className="who">
                      {s.lastName} {s.firstName}
                      {s.status !== 'active' && <span className="badge" style={{ marginLeft: 6 }}>{t(`st.${s.status}`)}</span>}
                      {!marked.has(s.id) && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{t('notMarked')}</span>}
                    </div>
                    <div className="seg at-seg" role="radiogroup" aria-label={`${s.lastName} ${s.firstName}`}>
                      {AT_STATUSES.map((st) => (
                        <button
                          key={st}
                          type="button"
                          role="radio"
                          aria-checked={marks[s.id] === st}
                          disabled={!editable}
                          className={`${marks[s.id] === st ? `on at-on-${st}` : ''}`}
                          onClick={() => setMarks({ ...marks, [s.id]: st })}
                        >
                          {AT_ICON[st]} <span className="lbl">{t(`at.${st}`)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                {j.students.length === 0 && <div className="muted">{t('noData')}</div>}
              </div>
              <div className="grid2" style={{ marginTop: 14 }}>
                <Field label={t('topicPlan')}>
                  <select value={topicId} disabled={!editable} onChange={(e) => setTopicId(e.target.value)}>
                    <option value="">—</option>
                    {j.topics.map((tp) => (
                      <option key={tp.id} value={tp.id}>
                        {tp.sort}. {tp.chapter ? `${tp.chapter}: ` : ''}
                        {tp.title}
                        {tp.used && tp.id !== j.lesson.courseTopicId ? ' ✓' : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('topicFree')}>
                  <input value={topic} disabled={!editable} onChange={(e) => setTopic(e.target.value)} />
                </Field>
              </div>
              <ErrorText error={save.error} />
              {result && (
                <div className="ok-box">
                  {t('saved')}: {result.saved}
                  {result.alerts.map((a) => (
                    <div key={a.studentId} style={{ color: 'var(--warning)' }}>
                      ⚠ {t('streakAlert')}: {a.name} ({a.streak})
                      {a.parentsNotified ? `, ${t('parentsNotified')}` : ''}
                    </div>
                  ))}
                </div>
              )}
              <div className="row" style={{ justifyContent: 'space-between' }}>
                {editable ? (
                  <button type="button" onClick={() => setMarks(Object.fromEntries(j.students.map((s) => [s.id, 'present'])))}>
                    {t('allPresent')}
                  </button>
                ) : (
                  <span />
                )}
                <div className="row">
                  <button type="button" onClick={onClose}>
                    {t('close')}
                  </button>
                  {editable && (
                    <button className="primary" disabled={save.isPending} onClick={() => save.mutate()}>
                      {t('save')}
                    </button>
                  )}
                </div>
              </div>
            </>
          )}

          {tab === 'grades' && (
            <>
              <div className="muted" style={{ marginBottom: 8 }}>
                {t('gradeScale')}: {t(`scale.${j.settings.gradeScale}`)}
                {j.settings.gradeScale === 'points' ? ` (${scaleHint(j.settings)})` : ''}
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t('students')}</th>
                      {SKILLS.map((sk) => (
                        <th key={sk}>{t(`sk.${sk}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {j.students.map((s) => (
                      <tr key={s.id}>
                        <td>
                          {s.lastName} {s.firstName}
                        </td>
                        {SKILLS.map((sk) => (
                          <td key={sk} style={{ padding: 4 }}>
                            <input
                              inputMode="decimal"
                              style={{ width: 70 }}
                              disabled={!editable}
                              aria-label={`${s.lastName} ${t(`sk.${sk}`)}`}
                              value={grades[`${s.id}:${sk}`] ?? ''}
                              onChange={(e) => {
                                setGradesSaved(false);
                                setGrades({ ...grades, [`${s.id}:${sk}`]: e.target.value });
                              }}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ErrorText error={saveGrades.error} />
              {gradesSaved && <div className="ok-box">{t('saved')}</div>}
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
                <button type="button" onClick={onClose}>
                  {t('close')}
                </button>
                {editable && (
                  <button className="primary" disabled={saveGrades.isPending} onClick={() => saveGrades.mutate()}>
                    {t('saveGrades')}
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

// ───────────── Занятия на сегодня (экран преподавателя) ─────────────

export function TodayPage() {
  const { t } = useI18n();
  const [day, setDay] = useState(() => zDate(new Date()));
  const [open, setOpen] = useState<string | null>(null);
  const lessons = useQuery({
    queryKey: ['lessons', 'today', day],
    queryFn: () =>
      api<(Lesson & { _count: { attendance: number } })[]>(
        `/lessons${qs({ from: zonedToUtc(day).toISOString(), to: zonedToUtc(addDays(day, 1)).toISOString() })}`,
      ),
  });
  return (
    <>
      <div className="toolbar">
        <h1 style={{ margin: 0, marginRight: 'auto' }}>{t('myLessons')}</h1>
        <button onClick={() => setDay(addDays(day, -1))} aria-label="←">
          ←
        </button>
        <input type="date" style={{ width: 'auto' }} value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
        <button onClick={() => setDay(addDays(day, 1))} aria-label="→">
          →
        </button>
      </div>
      <ErrorText error={lessons.error} />
      <div className="today">
        {lessons.data?.map((l) => {
          const done = l._count.attendance > 0;
          return (
            <button key={l.id} className={`card lesson-card ${l.status}`} onClick={() => setOpen(l.id)} disabled={l.status === 'cancelled'}>
              <div className="time">
                {fmtTime(l.startsAt)}–{fmtTime(l.endsAt)}
              </div>
              <div className="grow">
                <b>{l.group?.name}</b>
                <div className="muted">
                  {[l.group?.course?.name, l.room?.name, l.group?._count ? `👥 ${l.group._count.students}` : null].filter(Boolean).join(' · ')}
                </div>
              </div>
              <span className={`badge ${done ? 'ok' : ''}`}>
                {l.status === 'cancelled' ? t('ls.cancelled') : done ? `✓ ${t('marked')}` : t('notMarked')}
              </span>
            </button>
          );
        })}
        {lessons.data?.length === 0 && <div className="card muted">{t('noLessonsToday')}</div>}
      </div>
      {open && <AttendanceModal lessonId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

// ───────────── Журнал группы ─────────────

interface GroupJournalData {
  lessons: { id: string; startsAt: string; status: string; topic: string | null; courseTopic: { title: string } | null; marks: Record<string, AtStatus> }[];
  students: {
    id: string;
    firstName: string;
    lastName: string;
    leftAt: string | null;
    stats: { present: number; late: number; excused: number; absent: number; charged: number; rate: number | null };
    avg: Record<string, number | null>;
  }[];
}

export function GroupJournal({ groupId }: { groupId: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['groupJournal', groupId], queryFn: () => api<GroupJournalData>(`/groups/${groupId}/journal`) });
  const d = q.data;
  if (!d) return <ErrorText error={q.error} />;
  const now = Date.now();
  // Прошедшие занятия и ближайшие 3 будущих — чтобы таблица не была бесконечной.
  const past = d.lessons.filter((l) => +new Date(l.startsAt) <= now);
  const lessons = [...past, ...d.lessons.filter((l) => +new Date(l.startsAt) > now).slice(0, 3)];
  return (
    <>
      <div className="row muted" style={{ fontSize: 12, marginBottom: 8 }}>
        {t('legend')}:
        {AT_STATUSES.map((s) => (
          <span key={s}>
            <AtBadge s={s} /> {t(`at.${s}`)}
          </span>
        ))}
      </div>
      <div className="table-wrap">
        <table className="journal">
          <thead>
            <tr>
              <th className="sticky">{t('students')}</th>
              {lessons.map((l) => (
                <th key={l.id} title={l.courseTopic?.title ?? l.topic ?? ''} className="click" onClick={() => setOpen(l.id)}>
                  {fmtDate(l.startsAt, false).slice(0, 5)}
                </th>
              ))}
              <th>{t('rate')}</th>
              <th>{t('charged')}</th>
              {SKILLS.map((sk) => (
                <th key={sk}>{t(`sk.${sk}`).slice(0, 2)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.students.map((s) => (
              <tr key={s.id} style={s.leftAt ? { opacity: 0.5 } : undefined}>
                <td className="sticky">
                  {s.lastName} {s.firstName[0]}.
                </td>
                {lessons.map((l) => (
                  <td key={l.id} style={{ textAlign: 'center' }}>
                    <AtBadge s={l.marks[s.id]} />
                  </td>
                ))}
                <td className={s.stats.rate !== null && s.stats.rate < 70 ? 'neg' : ''}>{s.stats.rate === null ? '—' : `${s.stats.rate}%`}</td>
                <td>{s.stats.charged}</td>
                {SKILLS.map((sk) => (
                  <td key={sk}>{s.avg[sk] ?? '—'}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && <AttendanceModal lessonId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

// ───────────── Успеваемость студента ─────────────

export function StudentProgress({ studentId }: { studentId: string }) {
  const { t } = useI18n();
  const q = useQuery({
    queryKey: ['progress', studentId],
    queryFn: () =>
      api<{
        bySkill: Record<string, number | null>;
        attendance: { groupId: string; name: string; total: number; attended: number; absent: number; charged: number }[];
      }>(`/students/${studentId}/progress`),
  });
  if (!q.data) return null;
  const { bySkill, attendance } = q.data;
  return (
    <>
      <h3>{t('progress')}</h3>
      <div className="skills">
        {SKILLS.map((sk) => (
          <div key={sk} className="skill">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span>{t(`sk.${sk}`)}</span>
              <b>{bySkill[sk] === null ? '—' : `${bySkill[sk]}%`}</b>
            </div>
            <div className="bar">
              <i style={{ width: `${bySkill[sk] ?? 0}%` }} />
            </div>
          </div>
        ))}
      </div>
      {attendance.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 16 }}>
          <table>
            <thead>
              <tr>
                <th>{t('group')}</th>
                <th>{t('rate')}</th>
                <th>{t('at.absent')}</th>
                <th>{t('charged')}</th>
              </tr>
            </thead>
            <tbody>
              {attendance.map((a) => (
                <tr key={a.groupId}>
                  <td>{a.name}</td>
                  <td>
                    {Math.round((a.attended / a.total) * 100)}% ({a.attended}/{a.total})
                  </td>
                  <td>{a.absent}</td>
                  <td>{a.charged}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ───────────── Правила обучения центра ─────────────

export function LearningSettingsPage() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['learningSettings'], queryFn: () => api<LearningSettings>('/settings/learning') });
  const [f, setF] = useState<LearningSettings | null>(null);
  useEffect(() => {
    if (q.data) setF(q.data);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api<LearningSettings>('/settings/learning', { method: 'PUT', body: f }),
    onSuccess: (r) => qc.setQueryData(['learningSettings'], r),
  });
  if (!f) return <ErrorText error={q.error} />;
  return (
    <>
      <h1>{t('learningRules')}</h1>
      <form
        className="card"
        style={{ maxWidth: 620 }}
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <h3>{t('chargeRules')}</h3>
        <div className="row" style={{ marginBottom: 16 }}>
          {AT_STATUSES.map((s) => (
            <label key={s} className="row" style={{ color: 'var(--text)', margin: 0, gap: 6 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={f.charge[s]} onChange={(e) => setF({ ...f, charge: { ...f.charge, [s]: e.target.checked } })} />
              <AtBadge s={s} /> {t(`at.${s}`)}
            </label>
          ))}
        </div>
        <Field label={t('absenceThreshold')}>
          <input type="number" min={1} max={10} style={{ width: 100 }} value={f.absenceThreshold} onChange={(e) => setF({ ...f, absenceThreshold: Number(e.target.value) })} />
        </Field>
        <label className="row" style={{ color: 'var(--text)', marginBottom: 16, gap: 6 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={f.countExcusedInStreak} onChange={(e) => setF({ ...f, countExcusedInStreak: e.target.checked })} />
          {t('countExcused')}
        </label>
        <div className="grid2">
          <Field label={t('gradeScale')}>
            <select value={f.gradeScale} onChange={(e) => setF({ ...f, gradeScale: e.target.value as LearningSettings['gradeScale'] })}>
              {(['percent', 'points', 'de_1_6'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`scale.${s}`)}
                </option>
              ))}
            </select>
          </Field>
          {f.gradeScale === 'points' && (
            <Field label={t('gradeMax')}>
              <input type="number" min={1} value={f.gradeMax} onChange={(e) => setF({ ...f, gradeMax: Number(e.target.value) })} />
            </Field>
          )}
        </div>
        <ErrorText error={save.error} />
        {save.isSuccess && <div className="ok-box">{t('saved')}</div>}
        <button className="primary" disabled={save.isPending}>
          {t('save')}
        </button>
      </form>
    </>
  );
}

// ───────────── Учебный план курса ─────────────

export function TopicsModal({ course, onClose }: { course: { id: string; name: string }; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['topics', course.id],
    queryFn: () => api<{ id: string; title: string; chapter: string | null }[]>(`/courses/${course.id}/topics`),
  });
  const [rows, setRows] = useState<{ id?: string; title: string; chapter: string }[] | null>(null);
  useEffect(() => {
    if (q.data) setRows(q.data.map((x) => ({ id: x.id, title: x.title, chapter: x.chapter ?? '' })));
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api(`/courses/${course.id}/topics`, { method: 'PUT', body: { topics: rows!.filter((r) => r.title.trim()) } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['topics', course.id] });
      qc.invalidateQueries({ queryKey: ['journal'] });
      onClose();
    },
  });
  const set = (i: number, patch: Partial<{ title: string; chapter: string }>) => setRows(rows!.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Modal title={`${t('curriculum')}: ${course.name}`} onClose={onClose} wide>
      {!rows ? (
        <ErrorText error={q.error} />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="topics">
            {rows.map((r, i) => (
              <div key={r.id ?? `new-${i}`} className="row" style={{ flexWrap: 'nowrap', marginBottom: 6 }}>
                <span className="muted" style={{ width: 24, textAlign: 'right' }}>
                  {i + 1}
                </span>
                <input style={{ width: 140, flexShrink: 0 }} placeholder={t('chapter')} value={r.chapter} onChange={(e) => set(i, { chapter: e.target.value })} />
                <input placeholder={t('topic')} value={r.title} onChange={(e) => set(i, { title: e.target.value })} />
                <button type="button" className="small" disabled={i === 0} onClick={() => setRows([...rows.slice(0, i - 1), rows[i], rows[i - 1], ...rows.slice(i + 1)])} aria-label="↑">
                  ↑
                </button>
                <button type="button" className="small danger" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="✕">
                  ✕
                </button>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => setRows([...rows, { title: '', chapter: rows[rows.length - 1]?.chapter ?? '' }])}>
            + {t('addTopic')}
          </button>
          <ErrorText error={save.error} />
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button type="button" onClick={onClose}>
              {t('cancel')}
            </button>
            <button className="primary" disabled={save.isPending}>
              {t('save')}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
