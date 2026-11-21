import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, FileRef, qs } from '../api';
import { useAuth } from '../auth';
import { FileList, FilePicker, VoiceRecorder } from '../files';
import { useI18n } from '../i18n';
import { zonedToUtc } from '../tz';
import { Drawer, EnumSelect, ErrorText, Field, fmtDate, Modal } from '../ui';
import { useGroups } from './Groups';
import type { LearningSettings } from './Journal';

export const HW_SKILLS = ['hoeren', 'lesen', 'schreiben', 'sprechen', 'overall'];

interface Person {
  id: string;
  firstName: string;
  lastName: string;
}
interface HomeworkRow {
  id: string;
  title: string;
  dueAt: string | null;
  createdAt: string;
  skill: string | null;
  group: { id: string; name: string };
  student: Person | null;
  test: { id: string; title: string } | null;
  total: number;
  submitted: number;
  checked: number;
  returned: number;
}
interface Submission {
  id: string;
  studentId: string;
  text: string | null;
  audioSeconds: number | null;
  submittedAt: string;
  status: 'submitted' | 'checked' | 'returned';
  grade: string | null;
  feedback: string | null;
  student: Person;
  files: FileRef[];
  testAttempt: { score: string; maxScore: string; percent: string; timedOut: boolean } | null;
}
interface HomeworkFull extends Omit<HomeworkRow, 'total' | 'submitted' | 'checked' | 'returned'> {
  description: string | null;
  links: { url: string; title?: string }[] | null;
  files: FileRef[];
  submissions: Submission[];
  students: Person[];
  settings: LearningSettings;
}

export const isOverdue = (dueAt: string | null) => !!dueAt && new Date(dueAt) < new Date();
export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export function HomeworkPage() {
  const { t } = useI18n();
  const { id } = useParams();
  const nav = useNavigate();
  const groups = useGroups();
  const [groupId, setGroupId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ['homework', groupId], queryFn: () => api<HomeworkRow[]>(`/homework${qs({ groupId })}`) });
  return (
    <>
      <div className="toolbar">
        <h1 style={{ margin: 0, marginRight: 'auto' }}>{t('homework')}</h1>
        <select value={groupId ?? ''} onChange={(e) => setGroupId(e.target.value || undefined)}>
          <option value="">{t('allGroups')}</option>
          {groups.data?.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <button className="primary" onClick={() => setCreating(true)}>
          + {t('newHomework')}
        </button>
      </div>
      <ErrorText error={list.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('task')}</th>
              <th>{t('group')}</th>
              <th>{t('dueAt')}</th>
              <th>{t('submittedShort')}</th>
              <th>{t('toCheck')}</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((h) => (
              <tr key={h.id} className="click" onClick={() => nav(`/homework/${h.id}`)}>
                <td>
                  <b>{h.title}</b>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {h.test ? `🧪 ${t('testTask')}` : ''} {h.skill ? t(`sk.${h.skill}`) : ''} {h.student ? `· 👤 ${h.student.lastName} ${h.student.firstName}` : ''}
                  </div>
                </td>
                <td>{h.group.name}</td>
                <td className={isOverdue(h.dueAt) ? 'neg' : ''}>{fmtDate(h.dueAt)}</td>
                <td>
                  {h.submitted + h.checked + h.returned} / {h.total}
                </td>
                <td>{h.submitted > 0 ? <span className="badge hw-status submitted">{h.submitted}</span> : '—'}</td>
              </tr>
            ))}
            {list.data?.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  {t('noData')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {creating && (
        <HomeworkModal
          groupId={groupId}
          onClose={(newId) => {
            setCreating(false);
            if (newId) nav(`/homework/${newId}`);
          }}
        />
      )}
      {id && <HomeworkDrawer id={id} onClose={() => nav('/homework')} />}
    </>
  );
}

function HomeworkModal({ groupId, onClose }: { groupId?: string; onClose: (id?: string) => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const groups = useGroups();
  const tests = useQuery({ queryKey: ['tests'], queryFn: () => api<{ id: string; title: string; kind: string; isPublished: boolean }[]>('/tests') });
  const [f, setF] = useState({ groupId: groupId ?? '', studentId: '', title: '', description: '', skill: '', testId: '', dueDate: '', dueTime: '20:00', links: '' });
  const [files, setFiles] = useState<FileRef[]>([]);
  const group = useQuery({
    queryKey: ['group', f.groupId],
    queryFn: () => api<{ students: { studentId: string; waitlist: boolean; student: Person }[] }>(`/groups/${f.groupId}`),
    enabled: !!f.groupId,
  });
  const m = useMutation({
    mutationFn: () =>
      api<{ id: string }>('/homework', {
        method: 'POST',
        body: {
          groupId: f.groupId,
          studentId: f.studentId || undefined,
          title: f.title,
          description: f.description || undefined,
          skill: f.skill || undefined,
          testId: f.testId || undefined,
          dueAt: f.dueDate ? zonedToUtc(f.dueDate, f.dueTime || '23:59').toISOString() : undefined,
          links: f.links
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((url) => ({ url })),
          fileIds: files.map((x) => x.id),
        },
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['homework'] });
      onClose(r.id);
    },
  });
  return (
    <Modal title={t('newHomework')} onClose={() => onClose()} wide>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <div className="grid2">
          <Field label={t('group')}>
            <select required value={f.groupId} onChange={(e) => setF({ ...f, groupId: e.target.value, studentId: '' })}>
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
          <Field label={t('recipient')}>
            <select value={f.studentId} onChange={(e) => setF({ ...f, studentId: e.target.value })}>
              <option value="">{t('wholeGroup')}</option>
              {group.data?.students
                .filter((s) => !s.waitlist)
                .map((s) => (
                  <option key={s.studentId} value={s.studentId}>
                    {s.student.lastName} {s.student.firstName}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        <Field label={t('task')}>
          <input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <Field label={t('description')}>
          <textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <div className="grid2">
          <Field label={t('skill')}>
            <EnumSelect value={f.skill} onChange={(v) => setF({ ...f, skill: v ?? '' })} options={HW_SKILLS} prefix="sk" />
          </Field>
          <Field label={t('testTask')}>
            <select value={f.testId} onChange={(e) => setF({ ...f, testId: e.target.value })}>
              <option value="">—</option>
              {tests.data
                ?.filter((x) => x.kind === 'quiz' && x.isPublished)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.title}
                  </option>
                ))}
            </select>
          </Field>
          <Field label={t('dueAt')}>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
              <input type="time" value={f.dueTime} onChange={(e) => setF({ ...f, dueTime: e.target.value })} style={{ width: 120 }} />
            </div>
          </Field>
        </div>
        <Field label={t('linksOnePerLine')}>
          <textarea value={f.links} placeholder="https://…" onChange={(e) => setF({ ...f, links: e.target.value })} />
        </Field>
        <Field label={t('files')}>
          <FilePicker value={files} onChange={setFiles} />
        </Field>
        <ErrorText error={m.error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={() => onClose()}>
            {t('cancel')}
          </button>
          <button className="primary" disabled={m.isPending}>
            {t('assign')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function HomeworkDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['homework', 'one', id], queryFn: () => api<HomeworkFull>(`/homework/${id}`) });
  const [checking, setChecking] = useState<Submission | null>(null);
  const h = q.data;
  return (
    <Drawer onClose={onClose}>
      {!h ? (
        <ErrorText error={q.error} />
      ) : (
        <>
          <div className="drawer-head">
            <h1>{h.title}</h1>
            <button onClick={onClose} aria-label={t('close')}>
              ✕
            </button>
          </div>
          <dl className="kv">
            <dt>{t('group')}</dt>
            <dd>
              {h.group.name}
              {h.student ? ` · 👤 ${h.student.lastName} ${h.student.firstName}` : ''}
            </dd>
            <dt>{t('dueAt')}</dt>
            <dd className={isOverdue(h.dueAt) ? 'neg' : ''}>{fmtDate(h.dueAt)}</dd>
            {h.skill && (
              <>
                <dt>{t('skill')}</dt>
                <dd>{t(`sk.${h.skill}`)}</dd>
              </>
            )}
            {h.test && (
              <>
                <dt>{t('testTask')}</dt>
                <dd>🧪 {h.test.title}</dd>
              </>
            )}
          </dl>
          {h.description && <p className="hw-desc">{h.description}</p>}
          {h.links?.map((l) => (
            <div key={l.url}>
              <a href={l.url} target="_blank" rel="noreferrer">
                🔗 {l.title || l.url}
              </a>
            </div>
          ))}
          <FileList files={h.files} />
          <h3 style={{ marginTop: 16 }}>{t('submissions')}</h3>
          <div className="table-wrap">
            <table>
              <tbody>
                {h.students.map((st) => {
                  const s = h.submissions.find((x) => x.studentId === st.id);
                  return (
                    <tr key={st.id} className={s && !h.test ? 'click' : ''} onClick={() => s && !h.test && setChecking(s)}>
                      <td>
                        {st.lastName} {st.firstName}
                      </td>
                      <td>{s ? <StatusBadge status={s.status} /> : <span className={`badge hw-status ${isOverdue(h.dueAt) ? 'overdue' : ''}`}>{t('notSubmitted')}</span>}</td>
                      <td className="muted">{s ? fmtDate(s.submittedAt) : ''}</td>
                      <td>
                        {s?.grade != null ? <b>{Number(s.grade)}</b> : ''}
                        {s?.testAttempt ? ` (${Number(s.testAttempt.percent)}%)` : ''}
                      </td>
                      <td>{s?.audioSeconds ? `🎙 ${mmss(s.audioSeconds)}` : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {checking && <CheckModal sub={checking} settings={h.settings} hwId={h.id} onClose={() => setChecking(null)} />}
        </>
      )}
    </Drawer>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  return <span className={`badge hw-status ${status}`}>{t(`hws.${status}`)}</span>;
}

function CheckModal({ sub, settings, hwId, onClose }: { sub: Submission; settings: LearningSettings; hwId: string; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [grade, setGrade] = useState(sub.grade != null ? String(Number(sub.grade)) : '');
  const [feedback, setFeedback] = useState(sub.feedback ?? '');
  const [files, setFiles] = useState<FileRef[]>([]);
  const m = useMutation({
    mutationFn: (status: 'checked' | 'returned') =>
      api(`/homework/submissions/${sub.id}/check`, {
        method: 'POST',
        body: { status, grade: grade.trim() ? Number(grade.replace(',', '.')) : null, feedback: feedback || undefined, fileIds: files.map((f) => f.id) },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['homework'] });
      onClose();
    },
  });
  const scale = settings.gradeScale === 'percent' ? '0–100' : settings.gradeScale === 'points' ? `0–${settings.gradeMax}` : '1–6';
  const studentFiles = sub.files.filter((f) => !f.isFeedback);
  const feedbackFiles = sub.files.filter((f) => f.isFeedback);
  return (
    <Modal title={`${sub.student.lastName} ${sub.student.firstName}`} onClose={onClose} wide>
      <div className="row muted" style={{ marginBottom: 8 }}>
        <StatusBadge status={sub.status} /> {fmtDate(sub.submittedAt)} {sub.audioSeconds ? `· 🎙 ${mmss(sub.audioSeconds)}` : ''}
      </div>
      {sub.text && <div className="card hw-desc">{sub.text}</div>}
      <FileList files={studentFiles} />
      {feedbackFiles.length > 0 && (
        <>
          <h3 style={{ marginTop: 12 }}>{t('teacherReply')}</h3>
          <FileList files={feedbackFiles} />
        </>
      )}
      <div className="grid2" style={{ marginTop: 12 }}>
        <Field label={`${t('grade')} (${scale})`}>
          <input inputMode="decimal" value={grade} onChange={(e) => setGrade(e.target.value)} />
        </Field>
      </div>
      <Field label={t('comment')}>
        <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} />
      </Field>
      <div className="row" style={{ marginBottom: 12 }}>
        <VoiceRecorder maxSeconds={300} onRecorded={(f) => setFiles([...files, f])} />
        <FilePicker value={files} onChange={setFiles} />
      </div>
      <ErrorText error={m.error} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" onClick={onClose}>
          {t('cancel')}
        </button>
        <button type="button" disabled={m.isPending} onClick={() => m.mutate('returned')}>
          ↩ {t('returnForRework')}
        </button>
        <button type="button" className="primary" disabled={m.isPending} onClick={() => m.mutate('checked')}>
          ✓ {t('markChecked')}
        </button>
      </div>
      <input type="hidden" value={hwId} />
    </Modal>
  );
}
