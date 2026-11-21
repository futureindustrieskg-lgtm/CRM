import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { zparts } from '../tz';
import { Conflict, ConflictList, Drawer, EnumSelect, ErrorText, Field, fmtDate, fmtMoney, fmtTime, Modal } from '../ui';
import { Course, useCourses, useRooms } from './Courses';
import { useBranches } from './Leads';
import { GroupJournal } from './Journal';
import { LessonModal, Lesson } from './Schedule';

export const GROUP_STATUSES = ['recruiting', 'running', 'finished'];

interface Person {
  id: string;
  firstName: string;
  lastName: string;
}

export interface ScheduleRule {
  days: number[];
  start: string;
  end: string;
}

interface GroupRow {
  id: string;
  name: string;
  status: string;
  minStudents: number;
  maxStudents: number;
  startDate: string | null;
  endDate: string | null;
  scheduleRule: ScheduleRule | null;
  course: { id: string; name: string; level: string; academicHours: number };
  teacher: Person | null;
  room: { id: string; name: string } | null;
  branch: { id: string; name: string };
  activeCount: number;
  waitlistCount: number;
  lessonsTotal: number;
  lessonsDone: number;
  nextLessonAt: string | null;
}

interface GroupFull extends Omit<GroupRow, 'activeCount' | 'waitlistCount' | 'lessonsTotal' | 'lessonsDone' | 'nextLessonAt' | 'course'> {
  branchId: string;
  teacherId: string | null;
  roomId: string | null;
  course: Course;
  students: {
    studentId: string;
    joinedAt: string;
    waitlist: boolean;
    student: Person & { currentLevel: string | null; status: string; balance: string | null };
  }[];
  lessons: Lesson[];
}

export const useTeachers = (branchId?: string) =>
  useQuery({
    queryKey: ['teachers', branchId],
    queryFn: () => api<Person[]>(`/groups/teachers${qs({ branchId })}`),
    staleTime: 300_000,
  });

export const useGroups = (f: Record<string, string | undefined> = {}) =>
  useQuery({ queryKey: ['groups', f], queryFn: () => api<GroupRow[]>(`/groups${qs(f)}`) });

const fullName = (p?: Person | null) => (p ? `${p.firstName} ${p.lastName}` : '—');

export function ruleText(r: ScheduleRule | null, t: (k: string) => string) {
  if (!r?.days?.length) return '—';
  return `${r.days.map((d) => t(`wd.${d}`)).join('/')} ${r.start}–${r.end}`;
}

export function GroupsPage() {
  const { t } = useI18n();
  const { can, activeRole } = useAuth();
  const { id } = useParams();
  const nav = useNavigate();
  const branches = useBranches();
  const courses = useCourses();
  const [f, setF] = useState<{ branchId?: string; status?: string; courseId?: string; search?: string }>({});
  const groups = useGroups(f);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className="toolbar">
        <h1 style={{ margin: 0, marginRight: 'auto' }}>{t('groups')}</h1>
        <input placeholder={t('search')} value={f.search ?? ''} onChange={(e) => setF({ ...f, search: e.target.value || undefined })} />
        <EnumSelect value={f.status} onChange={(v) => setF({ ...f, status: v })} options={GROUP_STATUSES} prefix="gs" empty={t('status')} />
        <select value={f.courseId ?? ''} onChange={(e) => setF({ ...f, courseId: e.target.value || undefined })}>
          <option value="">{t('course')}</option>
          {courses.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
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
        {can('groups.create') && (
          <button className="primary" onClick={() => setCreating(true)}>
            + {t('newGroup')}
          </button>
        )}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('group')}</th>
              <th>{t('course')}</th>
              <th>{t('teacher')}</th>
              <th>{t('scheduleRule')}</th>
              <th>{t('filled')}</th>
              <th>{t('lessons')}</th>
              <th>{t('nextLesson')}</th>
              <th>{t('status')}</th>
            </tr>
          </thead>
          <tbody>
            {groups.data?.map((g) => {
              const pct = Math.min(100, Math.round((g.activeCount / g.maxStudents) * 100));
              return (
                <tr key={g.id} className="click" onClick={() => nav(`/groups/${g.id}`)}>
                  <td>
                    <b>{g.name}</b>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {g.branch.name}
                      {g.room ? ` · ${g.room.name}` : ''}
                    </div>
                  </td>
                  <td>{g.course.name}</td>
                  <td>{fullName(g.teacher)}</td>
                  <td>{ruleText(g.scheduleRule, t)}</td>
                  <td>
                    <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                      <div className={`bar ${g.activeCount >= g.minStudents ? 'full' : ''}`} title={`min ${g.minStudents}`}>
                        <i style={{ width: `${pct}%` }} />
                      </div>
                      {g.activeCount}/{g.maxStudents}
                      {g.waitlistCount > 0 && <span className="badge">+{g.waitlistCount}</span>}
                    </div>
                  </td>
                  <td>
                    {g.lessonsDone}/{g.lessonsTotal}
                  </td>
                  <td>{fmtDate(g.nextLessonAt)}</td>
                  <td>
                    <span className="badge">{t(`gs.${g.status}`)}</span>
                  </td>
                </tr>
              );
            })}
            {groups.data?.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  {t('noData')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {creating && (
        <Modal title={t('newGroup')} onClose={() => setCreating(false)} wide>
          <GroupForm
            onDone={(gid) => {
              setCreating(false);
              if (gid) nav(`/groups/${gid}`);
            }}
          />
        </Modal>
      )}
      {id && <GroupDrawer id={id} onClose={() => nav('/groups')} />}
    </>
  );
}

// ───────────── Форма группы ─────────────

function GroupForm({ group, onDone }: { group?: GroupFull; onDone: (id?: string) => void }) {
  const { t } = useI18n();
  const { activeRole } = useAuth();
  const qc = useQueryClient();
  const branches = useBranches();
  const courses = useCourses();
  const [f, setF] = useState({
    name: group?.name ?? '',
    branchId: group?.branchId ?? activeRole?.branchId ?? '',
    courseId: group?.course.id ?? '',
    teacherId: group?.teacherId ?? '',
    roomId: group?.roomId ?? '',
    minStudents: group?.minStudents ?? 4,
    maxStudents: group?.maxStudents ?? 12,
    startDate: group?.startDate?.slice(0, 10) ?? '',
    status: group?.status ?? 'recruiting',
    days: group?.scheduleRule?.days ?? [],
    start: group?.scheduleRule?.start ?? '19:00',
    end: group?.scheduleRule?.end ?? '20:30',
  });
  const branchId = f.branchId || branches.data?.[0]?.id;
  const teachers = useTeachers(branchId);
  const rooms = useRooms(branchId);
  const [info, setInfo] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name,
        courseId: f.courseId,
        teacherId: f.teacherId || null,
        roomId: f.roomId || null,
        minStudents: f.minStudents,
        maxStudents: f.maxStudents,
        startDate: f.startDate || null,
        status: f.status,
        scheduleRule: f.days.length ? { days: [...f.days].sort(), start: f.start, end: f.end } : null,
      };
      return group
        ? api<{ id: string; lessonsUpdated: number }>(`/groups/${group.id}`, { method: 'PATCH', body })
        : api<{ id: string }>('/groups', { method: 'POST', body: { ...body, branchId } });
    },
    onSuccess: (r: { id: string; lessonsUpdated?: number }) => {
      qc.invalidateQueries({ queryKey: ['groups'] });
      qc.invalidateQueries({ queryKey: ['group'] });
      qc.invalidateQueries({ queryKey: ['lessons'] });
      if (group) setInfo(r.lessonsUpdated ? `${t('lessonsUpdated')}: ${r.lessonsUpdated}` : t('save') + ' ✓');
      else onDone(r.id);
    },
  });

  const toggleDay = (d: number) => setF({ ...f, days: f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d] });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setInfo(null);
    save.mutate();
  };

  return (
    <form onSubmit={submit}>
      <div className="grid2">
        <Field label={t('name')}>
          <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        {!group && !activeRole?.branchId ? (
          <Field label={t('branch')}>
            <select value={branchId ?? ''} onChange={(e) => setF({ ...f, branchId: e.target.value, teacherId: '', roomId: '' })}>
              {branches.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label={t('status')}>
            <EnumSelect value={f.status} onChange={(v) => setF({ ...f, status: v! })} options={GROUP_STATUSES} prefix="gs" empty={false} />
          </Field>
        )}
        <Field label={t('course')}>
          <select required value={f.courseId} onChange={(e) => setF({ ...f, courseId: e.target.value })}>
            <option value="">—</option>
            {courses.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.academicHours} ч)
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('startDate')}>
          <input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
        </Field>
        <Field label={t('teacher')}>
          <select value={f.teacherId} onChange={(e) => setF({ ...f, teacherId: e.target.value })}>
            <option value="">—</option>
            {teachers.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {fullName(p)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('room')}>
          <select value={f.roomId} onChange={(e) => setF({ ...f, roomId: e.target.value })}>
            <option value="">—</option>
            {rooms.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} ({r.capacity})
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('minStudents')}>
          <input type="number" min={1} value={f.minStudents} onChange={(e) => setF({ ...f, minStudents: Number(e.target.value) })} />
        </Field>
        <Field label={t('maxStudents')}>
          <input type="number" min={1} value={f.maxStudents} onChange={(e) => setF({ ...f, maxStudents: Number(e.target.value) })} />
        </Field>
      </div>
      <h3 style={{ marginTop: 8 }}>{t('scheduleRule')}</h3>
      <div className="row" style={{ alignItems: 'flex-end', marginBottom: 12 }}>
        <div>
          <label>{t('days')}</label>
          <div className="days">
            {[1, 2, 3, 4, 5, 6, 7].map((d) => (
              <button type="button" key={d} className={f.days.includes(d) ? 'on' : ''} onClick={() => toggleDay(d)} aria-pressed={f.days.includes(d)}>
                {t(`wd.${d}`)}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label>{t('timeFrom')}</label>
          <input type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
        </div>
        <div>
          <label>{t('timeTo')}</label>
          <input type="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} />
        </div>
      </div>
      <ErrorText error={save.error} />
      {info && <div className="ok-box">{info}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {!group && (
          <button type="button" onClick={() => onDone()}>
            {t('cancel')}
          </button>
        )}
        <button className="primary" disabled={save.isPending}>
          {t('save')}
        </button>
      </div>
    </form>
  );
}

// ───────────── Карточка группы ─────────────

function GroupDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const [tab, setTab] = useState<'members' | 'journal' | 'lessons' | 'params'>('members');
  const [nextLevel, setNextLevel] = useState(false);
  const q = useQuery({ queryKey: ['group', id], queryFn: () => api<GroupFull>(`/groups/${id}`) });
  const g = q.data;

  return (
    <Drawer onClose={onClose}>
      {!g ? (
        <div className="muted">{q.error ? <ErrorText error={q.error} /> : '…'}</div>
      ) : (
        <>
          <div className="drawer-head">
            <h1>{g.name}</h1>
            {can('groups.create') && g.status !== 'finished' && (
              <button onClick={() => setNextLevel(true)}>{t('nextLevel')} →</button>
            )}
            <button onClick={onClose} aria-label={t('close')}>
              ✕
            </button>
          </div>
          <dl className="kv">
            <dt>{t('course')}</dt>
            <dd>
              {g.course.name} · {g.course.academicHours} ч · {fmtMoney(g.course.price)}
            </dd>
            <dt>{t('teacher')}</dt>
            <dd>{fullName(g.teacher)}</dd>
            <dt>{t('room')}</dt>
            <dd>
              {g.room?.name ?? '—'} · {g.branch.name}
            </dd>
            <dt>{t('scheduleRule')}</dt>
            <dd>{ruleText(g.scheduleRule, t)}</dd>
            <dt>
              {t('startDate')} — {t('endDate')}
            </dt>
            <dd>
              {fmtDate(g.startDate, false)} — {fmtDate(g.endDate, false)}
            </dd>
            <dt>{t('status')}</dt>
            <dd>
              <span className="badge">{t(`gs.${g.status}`)}</span>
            </dd>
          </dl>
          <div className="tabs" role="tablist">
            {(['members', 'journal', 'lessons', 'params'] as const)
              .filter((k) => (k !== 'params' || can('groups.update')) && (k !== 'journal' || can('attendance.read')))
              .map((k) => (
                <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                  {t(k)}
                  {k === 'members' && ` (${g.students.filter((s) => !s.waitlist).length}/${g.maxStudents})`}
                  {k === 'lessons' && ` (${g.lessons.filter((l) => l.status !== 'cancelled').length})`}
                </button>
              ))}
          </div>
          {tab === 'members' && <Members g={g} />}
          {tab === 'journal' && <GroupJournal groupId={g.id} />}
          {tab === 'lessons' && <Lessons g={g} />}
          {tab === 'params' && <GroupForm group={g} onDone={() => undefined} />}
          {nextLevel && <NextLevelModal g={g} onClose={() => setNextLevel(false)} />}
        </>
      )}
    </Drawer>
  );
}

function useGroupMutation(groupId: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['group', groupId] });
    qc.invalidateQueries({ queryKey: ['groups'] });
    qc.invalidateQueries({ queryKey: ['tasks'] });
  };
}

function Members({ g }: { g: GroupFull }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const refresh = useGroupMutation(g.id);
  const edit = can('groups.update');
  const [adding, setAdding] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<GroupFull['students'][number] | null>(null);
  const students = useQuery({
    queryKey: ['students', { branchId: g.branchId }],
    queryFn: () => api<(Person & { status: string; currentLevel: string | null })[]>(`/students${qs({ branchId: g.branchId })}`),
    enabled: edit,
  });
  const inGroup = new Set(g.students.map((s) => s.studentId));

  const add = useMutation({
    mutationFn: (studentId: string) => api<{ waitlist: boolean }>(`/groups/${g.id}/students`, { method: 'POST', body: { studentId } }),
    onSuccess: (r) => {
      setAdding('');
      setMsg(r.waitlist ? t('addedToWaitlist') : null);
      refresh();
    },
  });
  const act = useMutation({
    mutationFn: ({ studentId, op, reason }: { studentId: string; op: 'remove' | 'activate'; reason?: string }) =>
      api(`/groups/${g.id}/students/${studentId}/${op}`, { method: 'POST', body: { reason } }),
    onSuccess: refresh,
  });

  const active = g.students.filter((s) => !s.waitlist);
  const waiting = g.students.filter((s) => s.waitlist);

  const row = (s: GroupFull['students'][number], i: number) => (
    <tr key={s.studentId}>
      <td>{i + 1}</td>
      <td>{fullName(s.student)}</td>
      <td>{s.student.currentLevel ?? '—'}</td>
      <td>{t(`st.${s.student.status}`)}</td>
      {s.student.balance !== null && <td className={Number(s.student.balance) < 0 ? 'neg' : ''}>{fmtMoney(s.student.balance)}</td>}
      <td className="muted">{fmtDate(s.joinedAt, false)}</td>
      {edit && (
        <td style={{ textAlign: 'right' }}>
          {s.waitlist && (
            <button className="small" disabled={active.length >= g.maxStudents} onClick={() => act.mutate({ studentId: s.studentId, op: 'activate' })}>
              {t('activate')}
            </button>
          )}{' '}
          <button className="small" onClick={() => setTransfer(s)}>
            {t('transfer')}
          </button>{' '}
          <button
            className="small danger"
            onClick={() => {
              const reason = window.prompt(t('reason'));
              if (reason !== null) act.mutate({ studentId: s.studentId, op: 'remove', reason });
            }}
          >
            ✕
          </button>
        </td>
      )}
    </tr>
  );

  return (
    <>
      {edit && (
        <div className="row" style={{ marginBottom: 12 }}>
          <select className="grow" value={adding} onChange={(e) => setAdding(e.target.value)} aria-label={t('addStudent')}>
            <option value="">{t('addStudent')}…</option>
            {students.data
              ?.filter((s) => !inGroup.has(s.id) && s.status !== 'left' && s.status !== 'finished')
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.lastName} {s.firstName} {s.currentLevel ? `· ${s.currentLevel}` : ''}
                </option>
              ))}
          </select>
          <button className="primary" disabled={!adding || add.isPending} onClick={() => add.mutate(adding)}>
            {t('add')}
          </button>
        </div>
      )}
      <ErrorText error={add.error ?? act.error} />
      {msg && <div className="ok-box">{msg}</div>}
      <div className="table-wrap">
        <table>
          <tbody>
            {active.map(row)}
            {active.length === 0 && (
              <tr>
                <td className="muted">{t('noData')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {waiting.length > 0 && (
        <>
          <h3 style={{ marginTop: 16 }}>
            {t('waitlist')} ({waiting.length})
          </h3>
          <div className="table-wrap">
            <table>
              <tbody>{waiting.map(row)}</tbody>
            </table>
          </div>
        </>
      )}
      {transfer && <TransferModal g={g} s={transfer} onClose={() => setTransfer(null)} />}
    </>
  );
}

function TransferModal({ g, s, onClose }: { g: GroupFull; s: GroupFull['students'][number]; onClose: () => void }) {
  const { t } = useI18n();
  const refresh = useGroupMutation(g.id);
  const groups = useGroups({ branchId: g.branchId });
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api(`/groups/${g.id}/students/${s.studentId}/transfer`, { method: 'POST', body: { toGroupId: to, reason } }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  return (
    <Modal title={`${t('transfer')}: ${fullName(s.student)}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label={t('toGroup')}>
          <select required value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">—</option>
            {groups.data
              ?.filter((x) => x.id !== g.id && x.status !== 'finished')
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} · {x.activeCount}/{x.maxStudents}
                </option>
              ))}
          </select>
        </Field>
        <Field label={t('reason')}>
          <input required value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <p className="muted">{t('financeLater')}</p>
        <ErrorText error={m.error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="primary" disabled={m.isPending}>
            {t('transfer')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface GenResult {
  from: string;
  total: number;
  kept: number;
  replaced: number;
  count: number;
  conflicts: Conflict[];
}

function Lessons({ g }: { g: GroupFull }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const refresh = useGroupMutation(g.id);
  const qc = useQueryClient();
  const [f, setF] = useState({ from: '', count: '', skipDates: '' });
  const [preview, setPreview] = useState<GenResult | null>(null);
  const [open, setOpen] = useState<Lesson | null>(null);

  const gen = useMutation({
    mutationFn: (dryRun: boolean) =>
      api<GenResult>(`/groups/${g.id}/lessons/generate`, {
        method: 'POST',
        body: {
          dryRun,
          from: f.from || undefined,
          count: f.count ? Number(f.count) : undefined,
          skipDates: f.skipDates
            .split(/[,\s]+/)
            .map((x) => x.trim())
            .filter(Boolean),
        },
      }),
    onSuccess: (r, dryRun) => {
      setPreview(dryRun ? r : null);
      if (!dryRun) {
        refresh();
        qc.invalidateQueries({ queryKey: ['lessons'] });
      }
    },
  });

  return (
    <>
      {can('schedule.create') && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>{t('generateLessons')}</h3>
          {!g.scheduleRule ? (
            <div className="muted">{t('noRule')}</div>
          ) : (
            <>
              <div className="muted" style={{ marginBottom: 8 }}>
                {ruleText(g.scheduleRule, t)} · {g.course.academicHours} ч
              </div>
              <div className="grid2">
                <Field label={t('fromDate')}>
                  <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
                </Field>
                <Field label={t('lessonsCount')}>
                  <input type="number" min={1} placeholder="auto" value={f.count} onChange={(e) => setF({ ...f, count: e.target.value })} />
                </Field>
              </div>
              <Field label={t('skipDates')}>
                <input placeholder="2026-12-31, 2027-01-01" value={f.skipDates} onChange={(e) => setF({ ...f, skipDates: e.target.value })} />
              </Field>
              {preview && (
                <div style={{ marginBottom: 8 }}>
                  <div>
                    {t('willCreate')}: <b>{preview.count}</b> ({t('fromDate').toLowerCase()} {fmtDate(preview.from, false)}) · {t('willReplace')}:{' '}
                    {preview.replaced} · {t('kept')}: {preview.kept}
                  </div>
                  {preview.conflicts.length ? (
                    <ConflictList conflicts={preview.conflicts} />
                  ) : (
                    <div className="ok-box">{t('noConflicts')}</div>
                  )}
                </div>
              )}
              <ErrorText error={gen.error} />
              <div className="row">
                <button onClick={() => gen.mutate(true)} disabled={gen.isPending}>
                  {t('preview')}
                </button>
                <button className="primary" onClick={() => gen.mutate(false)} disabled={gen.isPending || !!preview?.conflicts.length}>
                  {t('create')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>{t('date')}</th>
              <th>{t('teacher')}</th>
              <th>{t('room')}</th>
              <th>{t('status')}</th>
            </tr>
          </thead>
          <tbody>
            {g.lessons.map((l, i) => (
              <tr key={l.id} className="click" onClick={() => setOpen(l)} style={l.status === 'cancelled' ? { opacity: 0.55 } : undefined}>
                <td>{i + 1}</td>
                <td>
                  {fmtDate(l.startsAt, false)} {t(`wd.${zparts(l.startsAt).wd}`)} {fmtTime(l.startsAt)}–
                  {fmtTime(l.endsAt)}
                </td>
                <td>{fullName(l.teacher)}</td>
                <td>{l.room?.name ?? '—'}</td>
                <td>{t(`ls.${l.status}`)}</td>
              </tr>
            ))}
            {g.lessons.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  {t('noData')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {open && (
        <LessonModal
          lesson={{ ...open, group: { id: g.id, name: g.name, branchId: g.branchId } }}
          onClose={() => {
            setOpen(null);
            refresh();
          }}
        />
      )}
    </>
  );
}

function NextLevelModal({ g, onClose }: { g: GroupFull; onClose: () => void }) {
  const { t } = useI18n();
  const nav = useNavigate();
  const qc = useQueryClient();
  const courses = useCourses();
  const [f, setF] = useState({ courseId: '', name: '', startDate: '' });
  const m = useMutation({
    mutationFn: () =>
      api<{ id: string }>(`/groups/${g.id}/next-level`, {
        method: 'POST',
        body: { ...f, startDate: f.startDate || undefined },
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['groups'] });
      qc.invalidateQueries({ queryKey: ['group'] });
      onClose();
      nav(`/groups/${r.id}`);
    },
  });
  return (
    <Modal title={`${t('nextLevel')}: ${g.name}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label={t('course')}>
          <select required value={f.courseId} onChange={(e) => setF({ ...f, courseId: e.target.value })}>
            <option value="">—</option>
            {courses.data
              ?.filter((c) => c.id !== g.course.id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label={t('newGroupName')}>
          <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label={t('startDate')}>
          <input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
        </Field>
        <p className="muted">
          {g.students.filter((s) => !s.waitlist).length} {t('students').toLowerCase()} → {t('newGroup').toLowerCase()}; «{g.name}» →{' '}
          {t('gs.finished').toLowerCase()}.
        </p>
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
