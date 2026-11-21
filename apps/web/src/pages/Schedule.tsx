import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CSSProperties, FormEvent, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { addDays, addMonths, dayOfMonth, labelDate, mondayOf, monthOf, weekday, zDate, zonedToUtc, zparts, zTime } from '../tz';
import { ErrorText, Field, fmtDate, fmtTime, Modal } from '../ui';
import { useRooms } from './Courses';
import { AttendanceModal } from './Journal';
import { useGroups, useTeachers } from './Groups';
import { useBranches } from './Leads';

export interface Lesson {
  id: string;
  groupId: string;
  startsAt: string;
  endsAt: string;
  status: string;
  topic: string | null;
  teacherId: string | null;
  roomId: string | null;
  teacher: { id: string; firstName: string; lastName: string } | null;
  room: { id: string; name: string; isOnline?: boolean } | null;
  group?: { id: string; name: string; branchId: string; course?: { name: string; level: string }; _count?: { students: number } };
}

type View = 'day' | 'week' | 'month';

const HOUR_PX = 48;

/** Период календаря — даты "YYYY-MM-DD" в поясе центра: [с, по). */
function range(view: View, anchor: string): [string, string] {
  if (view === 'day') return [anchor, addDays(anchor, 1)];
  if (view === 'week') {
    const m = mondayOf(anchor);
    return [m, addDays(m, 7)];
  }
  const first = mondayOf(`${monthOf(anchor)}-01`);
  return [first, addDays(first, 42)];
}

export function SchedulePage() {
  const { t, locale } = useI18n();
  const { can, activeRole } = useAuth();
  const nav = useNavigate();
  const branches = useBranches();
  const [view, setView] = useState<View>(() => (typeof window !== 'undefined' && window.innerWidth < 700 ? 'day' : 'week'));
  const [anchor, setAnchor] = useState(() => zDate(new Date()));
  const [f, setF] = useState<{ branchId?: string; roomId?: string; teacherId?: string; groupId?: string }>({});
  const branchId = activeRole?.branchId ?? f.branchId;
  const rooms = useRooms(branchId);
  const teachers = useTeachers(branchId);
  const groups = useGroups({ branchId });
  const [open, setOpen] = useState<Lesson | null>(null);
  const [extra, setExtra] = useState(false);
  const seeAll = can('schedule.read_all');

  const [from, to] = range(view, anchor);
  const lessons = useQuery({
    queryKey: ['lessons', view, from, f],
    queryFn: () =>
      api<Lesson[]>(`/lessons${qs({ from: zonedToUtc(from).toISOString(), to: zonedToUtc(to).toISOString(), ...f })}`),
  });

  const step = (dir: number) => {
    if (view === 'day') setAnchor(addDays(anchor, dir));
    else if (view === 'week') setAnchor(addDays(anchor, 7 * dir));
    else setAnchor(addMonths(anchor, dir));
  };

  const loc = locale === 'ky' ? 'ky-KG' : locale === 'de' ? 'de-DE' : locale === 'en' ? 'en-GB' : 'ru-RU';
  const title =
    view === 'month'
      ? labelDate(anchor, loc, { month: 'long', year: 'numeric' })
      : view === 'day'
        ? labelDate(anchor, loc, { weekday: 'long', day: 'numeric', month: 'long' })
        : `${labelDate(from, loc, { day: 'numeric', month: 'short' })} — ${labelDate(addDays(to, -1), loc, { day: 'numeric', month: 'short', year: 'numeric' })}`;

  return (
    <>
      <div className="toolbar">
        <h1 style={{ margin: 0, marginRight: 'auto' }}>{t('schedule')}</h1>
        {!activeRole?.branchId && seeAll && (
          <select value={f.branchId ?? ''} onChange={(e) => setF({ branchId: e.target.value || undefined })}>
            <option value="">{t('allBranches')}</option>
            {branches.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
        <select value={f.roomId ?? ''} onChange={(e) => setF({ ...f, roomId: e.target.value || undefined })}>
          <option value="">{t('allRooms')}</option>
          {rooms.data?.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
              {branchId ? '' : ` · ${r.branch?.name ?? ''}`}
            </option>
          ))}
        </select>
        {seeAll && (
          <select value={f.teacherId ?? ''} onChange={(e) => setF({ ...f, teacherId: e.target.value || undefined })}>
            <option value="">{t('allTeachers')}</option>
            {teachers.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.firstName} {p.lastName}
              </option>
            ))}
          </select>
        )}
        <select value={f.groupId ?? ''} onChange={(e) => setF({ ...f, groupId: e.target.value || undefined })}>
          <option value="">{t('allGroups')}</option>
          {groups.data?.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        {can('schedule.create') && (
          <button className="primary" onClick={() => setExtra(true)}>
            + {t('extraLesson')}
          </button>
        )}
      </div>
      <div className="cal-head">
        <div className="seg">
          {(['day', 'week', 'month'] as const).map((v) => (
            <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
              {t(v)}
            </button>
          ))}
        </div>
        <button onClick={() => step(-1)} aria-label="←">
          ←
        </button>
        <button onClick={() => setAnchor(zDate(new Date()))}>{t('today')}</button>
        <button onClick={() => step(1)} aria-label="→">
          →
        </button>
        <span className="title">{title}</span>
        {lessons.isFetching && <span className="muted">…</span>}
      </div>
      <ErrorText error={lessons.error} />
      {view === 'month' ? (
        <MonthGrid
          from={from}
          anchor={anchor}
          lessons={lessons.data ?? []}
          onOpen={setOpen}
          onDay={(d) => {
            setAnchor(d);
            setView('day');
          }}
        />
      ) : (
        <TimeGrid from={from} days={view === 'day' ? 1 : 7} lessons={lessons.data ?? []} onOpen={setOpen} />
      )}
      {open && <LessonModal lesson={open} onClose={() => setOpen(null)} onGroup={(id) => nav(`/groups/${id}`)} />}
      {extra && <ExtraLessonModal date={anchor} branchId={branchId} onClose={() => setExtra(false)} />}
    </>
  );
}

// ───────────── Сетка по часам (день / неделя) ─────────────

function layout(items: Lesson[]) {
  // Раскладка пересекающихся занятий по дорожкам, чтобы они не накрывали друг друга.
  const sorted = [...items].sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt));
  const lanes: number[] = [];
  const pos = new Map<string, { lane: number; lanes: number }>();
  let cluster: Lesson[] = [];
  let clusterEnd = 0;
  const flush = () => {
    const n = Math.max(1, ...cluster.map((l) => pos.get(l.id)!.lane + 1));
    cluster.forEach((l) => (pos.get(l.id)!.lanes = n));
    cluster = [];
    lanes.length = 0;
  };
  for (const l of sorted) {
    const s = +new Date(l.startsAt);
    const e = +new Date(l.endsAt);
    if (cluster.length && s >= clusterEnd) flush();
    let lane = lanes.findIndex((end) => end <= s);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = e;
    pos.set(l.id, { lane, lanes: 1 });
    cluster.push(l);
    clusterEnd = Math.max(clusterEnd, e);
  }
  if (cluster.length) flush();
  return pos;
}

function TimeGrid({ from, days, lessons, onOpen }: { from: string; days: number; lessons: Lesson[]; onOpen: (l: Lesson) => void }) {
  const { t } = useI18n();
  const cols = Array.from({ length: days }, (_, i) => addDays(from, i));
  const today = zDate(new Date());
  // Рабочие часы по умолчанию 8–22, расширяются под фактические занятия.
  let h0 = 8;
  let h1 = 22;
  for (const l of lessons) {
    h0 = Math.min(h0, zparts(l.startsAt).h);
    const e = zparts(l.endsAt);
    h1 = Math.max(h1, e.h + (e.min ? 1 : 0));
  }
  const height = (h1 - h0) * HOUR_PX;
  const byDay = useMemo(() => {
    const m = new Map<string, Lesson[]>();
    for (const l of lessons) {
      const k = zDate(l.startsAt);
      m.set(k, [...(m.get(k) ?? []), l]);
    }
    return m;
  }, [lessons]);

  return (
    <div className="week" style={{ '--cols': days, '--hour': `${HOUR_PX}px` } as CSSProperties}>
      <div className="dh" />
      {cols.map((d) => (
        <div key={d} className={`dh ${d === today ? 'today' : ''}`}>
          {t(`wd.${weekday(d)}`)} {d.slice(8, 10)}.{d.slice(5, 7)}
        </div>
      ))}
      <div className="hours" style={{ height }}>
        {Array.from({ length: h1 - h0 }, (_, i) => (
          <span key={i} style={{ top: i * HOUR_PX + (i === 0 ? 8 : 0) }}>
            {String(h0 + i).padStart(2, '0')}:00
          </span>
        ))}
      </div>
      {cols.map((d) => {
        const items = byDay.get(d) ?? [];
        const pos = layout(items);
        return (
          <div key={d} className={`col ${d === today ? 'today' : ''}`} style={{ height }}>
            {items.map((l) => {
              const s = new Date(l.startsAt);
              const e = new Date(l.endsAt);
              const sp = zparts(s);
              const top = ((sp.h - h0) * 60 + sp.min) * (HOUR_PX / 60);
              const h = Math.max(22, ((+e - +s) / 60_000) * (HOUR_PX / 60) - 2);
              const p = pos.get(l.id)!;
              return (
                <div
                  key={l.id}
                  className={`ev ${l.status}`}
                  style={{ top, height: h, left: `calc(${(p.lane / p.lanes) * 100}% + 3px)`, width: `calc(${100 / p.lanes}% - 6px)`, right: 'auto' }}
                  onClick={() => onOpen(l)}
                  title={`${l.group?.name} · ${fmtTime(s)}–${fmtTime(e)}`}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(ev) => ev.key === 'Enter' && onOpen(l)}
                >
                  <b>
                    {fmtTime(s)}–{fmtTime(e)}
                  </b>{' '}
                  {l.group?.name}
                  <div className="s">
                    {[l.room?.name, l.teacher ? `${l.teacher.firstName} ${l.teacher.lastName[0]}.` : null].filter(Boolean).join(' · ')}
                    {l.group?._count ? ` · 👥 ${l.group._count.students}` : ''}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ───────────── Месяц ─────────────

function MonthGrid({
  from,
  anchor,
  lessons,
  onOpen,
  onDay,
}: {
  from: string;
  anchor: string;
  lessons: Lesson[];
  onOpen: (l: Lesson) => void;
  onDay: (d: string) => void;
}) {
  const { t } = useI18n();
  const today = zDate(new Date());
  const byDay = new Map<string, Lesson[]>();
  for (const l of lessons) {
    const k = zDate(l.startsAt);
    byDay.set(k, [...(byDay.get(k) ?? []), l]);
  }
  const cells = Array.from({ length: 42 }, (_, i) => addDays(from, i));
  return (
    <div className="month">
      {[1, 2, 3, 4, 5, 6, 7].map((d) => (
        <div key={d} className="mh">
          {t(`wd.${d}`)}
        </div>
      ))}
      {cells.map((d) => {
        const items = byDay.get(d) ?? [];
        return (
          <div key={d} className={`md ${monthOf(d) !== monthOf(anchor) ? 'other' : ''} ${d === today ? 'today' : ''}`}>
            <span className="n" onClick={() => onDay(d)} style={{ cursor: 'pointer' }}>
              {dayOfMonth(d)}
            </span>
            {items.slice(0, 4).map((l) => (
              <span key={l.id} className={`mev ${l.status}`} onClick={() => onOpen(l)} title={l.group?.name}>
                {fmtTime(l.startsAt)} {l.group?.name}
              </span>
            ))}
            {items.length > 4 && (
              <span className="muted" style={{ cursor: 'pointer' }} onClick={() => onDay(d)}>
                +{items.length - 4}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ───────────── Занятие: перенос, замена, отмена ─────────────

export function LessonModal({ lesson, onClose, onGroup }: { lesson: Lesson; onClose: () => void; onGroup?: (id: string) => void }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const qc = useQueryClient();
  const branchId = lesson.group?.branchId;
  const teachers = useTeachers(branchId);
  const rooms = useRooms(branchId);
  const s = new Date(lesson.startsAt);
  const e = new Date(lesson.endsAt);
  const [f, setF] = useState({
    date: zDate(s),
    start: zTime(s),
    end: zTime(e),
    teacherId: lesson.teacherId ?? lesson.teacher?.id ?? '',
    roomId: lesson.roomId ?? lesson.room?.id ?? '',
    topic: lesson.topic ?? '',
    reason: '',
  });
  const [cancelReason, setCancelReason] = useState<string | null>(null);
  const [journal, setJournal] = useState(false);
  const editable = can('schedule.update') && lesson.status !== 'cancelled';
  const done = () => {
    qc.invalidateQueries({ queryKey: ['lessons'] });
    qc.invalidateQueries({ queryKey: ['group'] });
    qc.invalidateQueries({ queryKey: ['groups'] });
    onClose();
  };

  const save = useMutation({
    mutationFn: () =>
      api(`/lessons/${lesson.id}`, {
        method: 'PATCH',
        body: {
          startsAt: zonedToUtc(f.date, f.start).toISOString(),
          endsAt: zonedToUtc(f.date, f.end).toISOString(),
          teacherId: f.teacherId || null,
          roomId: f.roomId || null,
          topic: f.topic || undefined,
          reason: f.reason || undefined,
        },
      }),
    onSuccess: done,
  });
  const cancel = useMutation({
    mutationFn: () => api(`/lessons/${lesson.id}/cancel`, { method: 'POST', body: { reason: cancelReason } }),
    onSuccess: done,
  });
  const restore = useMutation({ mutationFn: () => api(`/lessons/${lesson.id}/restore`, { method: 'POST' }), onSuccess: done });

  const changedTime = f.date !== zDate(s) || f.start !== zTime(s) || f.end !== zTime(e);
  const changedTeacher = (f.teacherId || null) !== (lesson.teacherId ?? lesson.teacher?.id ?? null);
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    save.mutate();
  };

  if (journal) return <AttendanceModal lessonId={lesson.id} onClose={() => setJournal(false)} />;

  return (
    <Modal title={`${t('lesson')}: ${lesson.group?.name ?? ''}`} onClose={onClose}>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="badge">{t(`ls.${lesson.status}`)}</span>
        <span>
          {fmtDate(lesson.startsAt, false)} {fmtTime(s)}–{fmtTime(e)}
        </span>
        {lesson.group?.course && <span className="muted">{lesson.group.course.name}</span>}
        {can('attendance.read') && lesson.status !== 'cancelled' && (
          <button type="button" className="small" style={{ marginLeft: 'auto' }} onClick={() => setJournal(true)}>
            {t('journal')}
          </button>
        )}
        {onGroup && lesson.group && (
          <button type="button" className="small" onClick={() => onGroup(lesson.group!.id)}>
            {t('group')} →
          </button>
        )}
      </div>
      {editable ? (
        <form onSubmit={submit}>
          <div className="grid2">
            <Field label={t('date')}>
              <input type="date" required value={f.date} onChange={(ev) => setF({ ...f, date: ev.target.value })} />
            </Field>
            <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
              <Field label={t('timeFrom')}>
                <input type="time" required value={f.start} onChange={(ev) => setF({ ...f, start: ev.target.value })} />
              </Field>
              <Field label={t('timeTo')}>
                <input type="time" required value={f.end} onChange={(ev) => setF({ ...f, end: ev.target.value })} />
              </Field>
            </div>
            <Field label={t('teacher')}>
              <select value={f.teacherId} onChange={(ev) => setF({ ...f, teacherId: ev.target.value })}>
                <option value="">—</option>
                {teachers.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.firstName} {p.lastName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('room')}>
              <select value={f.roomId} onChange={(ev) => setF({ ...f, roomId: ev.target.value })}>
                <option value="">—</option>
                {rooms.data?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label={t('topic')}>
            <input value={f.topic} onChange={(ev) => setF({ ...f, topic: ev.target.value })} />
          </Field>
          {(changedTime || changedTeacher) && (
            <Field label={`${t('reason')} *`}>
              <input required value={f.reason} onChange={(ev) => setF({ ...f, reason: ev.target.value })} placeholder={t('reasonRequired')} />
            </Field>
          )}
          <ErrorText error={save.error ?? cancel.error} />
          {cancelReason !== null && (
            <div className="card" style={{ margin: '8px 0' }}>
              <Field label={`${t('reason')} *`}>
                <input autoFocus value={cancelReason} onChange={(ev) => setCancelReason(ev.target.value)} />
              </Field>
              <div className="row">
                <button type="button" onClick={() => setCancelReason(null)}>
                  {t('cancel')}
                </button>
                <button type="button" className="danger" disabled={!cancelReason.trim() || cancel.isPending} onClick={() => cancel.mutate()}>
                  {t('cancelLesson')}
                </button>
              </div>
            </div>
          )}
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
            {cancelReason === null ? (
              <button type="button" className="danger" onClick={() => setCancelReason('')}>
                {t('cancelLesson')}
              </button>
            ) : (
              <span />
            )}
            <div className="row">
              <button type="button" onClick={onClose}>
                {t('close')}
              </button>
              <button className="primary" disabled={save.isPending}>
                {changedTime ? t('move') : t('save')}
              </button>
            </div>
          </div>
        </form>
      ) : (
        <>
          <dl className="kv">
            <dt>{t('teacher')}</dt>
            <dd>{lesson.teacher ? `${lesson.teacher.firstName} ${lesson.teacher.lastName}` : '—'}</dd>
            <dt>{t('room')}</dt>
            <dd>{lesson.room?.name ?? '—'}</dd>
            <dt>{t('topic')}</dt>
            <dd>{lesson.topic ?? '—'}</dd>
          </dl>
          <ErrorText error={restore.error} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            {lesson.status === 'cancelled' && can('schedule.update') && (
              <button onClick={() => restore.mutate()} disabled={restore.isPending}>
                {t('restore')}
              </button>
            )}
            <button onClick={onClose}>{t('close')}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

function ExtraLessonModal({ date, branchId, onClose }: { date: string; branchId?: string; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const groups = useGroups({ branchId });
  const [f, setF] = useState({ groupId: '', date, start: '19:00', end: '20:30', topic: '' });
  const m = useMutation({
    mutationFn: () =>
      api('/lessons', {
        method: 'POST',
        body: {
          groupId: f.groupId,
          startsAt: zonedToUtc(f.date, f.start).toISOString(),
          endsAt: zonedToUtc(f.date, f.end).toISOString(),
          topic: f.topic || undefined,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lessons'] });
      qc.invalidateQueries({ queryKey: ['groups'] });
      onClose();
    },
  });
  return (
    <Modal title={t('extraLesson')} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label={t('group')}>
          <select required value={f.groupId} onChange={(e) => setF({ ...f, groupId: e.target.value })}>
            <option value="">—</option>
            {groups.data
              ?.filter((g) => g.status !== 'finished')
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
          </select>
        </Field>
        <div className="grid2">
          <Field label={t('date')}>
            <input type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
            <Field label={t('timeFrom')}>
              <input type="time" required value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
            </Field>
            <Field label={t('timeTo')}>
              <input type="time" required value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} />
            </Field>
          </div>
        </div>
        <Field label={t('topic')}>
          <input value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })} />
        </Field>
        <ErrorText error={m.error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="primary" disabled={m.isPending}>
            {t('create')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
