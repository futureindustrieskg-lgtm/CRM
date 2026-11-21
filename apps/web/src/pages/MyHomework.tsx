/** Кабинет студента: мои задания, сдача (текст, фото, файл, голос до 5 минут), тесты, проверка. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, FileRef } from '../api';
import { FileList, FilePicker, VoiceRecorder } from '../files';
import { useI18n } from '../i18n';
import { ErrorText, fmtDate, Modal } from '../ui';
import { isOverdue, mmss, StatusBadge } from './Homework';
import { TestRunner } from './TestRun';

interface MyHw {
  id: string;
  title: string;
  description: string | null;
  links: { url: string; title?: string }[] | null;
  skill: string | null;
  dueAt: string | null;
  group: { name: string };
  test: { id: string; title: string; timeLimitMin: number | null } | null;
  files: FileRef[];
  submission: {
    id: string;
    text: string | null;
    status: 'submitted' | 'checked' | 'returned';
    grade: string | null;
    feedback: string | null;
    audioSeconds: number | null;
    submittedAt: string;
    files: FileRef[];
  } | null;
}

export function MyHomeworkPage() {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['myHomework'], queryFn: () => api<MyHw[]>('/my/homework') });
  const [filter, setFilter] = useState<'todo' | 'all'>('todo');
  const rows = (q.data ?? []).filter((h) => filter === 'all' || !h.submission || h.submission.status === 'returned');
  return (
    <>
      <div className="toolbar">
        <h1 style={{ margin: 0, marginRight: 'auto' }}>{t('myHomework')}</h1>
        <div className="seg">
          {(['todo', 'all'] as const).map((k) => (
            <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
              {t(k === 'todo' ? 'toDo' : 'allTasks')}
            </button>
          ))}
        </div>
      </div>
      <ErrorText error={q.error} />
      <div style={{ maxWidth: 760 }}>
        {rows.map((h) => (
          <HomeworkCard key={h.id} h={h} />
        ))}
        {q.data && rows.length === 0 && <div className="card muted">{t('noTasks')}</div>}
      </div>
    </>
  );
}

function HomeworkCard({ h }: { h: MyHw }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const s = h.submission;
  const [open, setOpen] = useState(!s || s.status === 'returned');
  const [text, setText] = useState(s?.text ?? '');
  const [files, setFiles] = useState<FileRef[]>([]);
  const [audioSeconds, setAudioSeconds] = useState<number | undefined>();
  const [testToken, setTestToken] = useState<string | null>(null);
  const submit = useMutation({
    mutationFn: () => api(`/my/homework/${h.id}/submit`, { method: 'POST', body: { text: text || undefined, fileIds: files.map((f) => f.id), audioSeconds } }),
    onSuccess: () => {
      setFiles([]);
      qc.invalidateQueries({ queryKey: ['myHomework'] });
    },
  });
  const startTest = useMutation({
    mutationFn: () => api<{ token: string }>(`/my/homework/${h.id}/test`, { method: 'POST' }),
    onSuccess: (r) => setTestToken(r.token),
  });
  const canSubmit = !s || s.status !== 'checked';
  const studentFiles = s?.files.filter((f) => !f.isFeedback) ?? [];
  const reply = s?.files.filter((f) => f.isFeedback) ?? [];

  return (
    <div className="card hw-card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b style={{ fontSize: 15 }}>{h.title}</b>
        {s ? <StatusBadge status={s.status} /> : <span className={`badge hw-status ${isOverdue(h.dueAt) ? 'overdue' : ''}`}>{t('notSubmitted')}</span>}
      </div>
      <div className="meta">
        {h.group.name} · {t('dueAt')}: <span className={isOverdue(h.dueAt) && !s ? 'neg' : ''}>{fmtDate(h.dueAt)}</span>
        {h.skill ? ` · ${t(`sk.${h.skill}`)}` : ''}
      </div>
      {h.description && <div className="hw-desc">{h.description}</div>}
      {h.links?.map((l) => (
        <div key={l.url}>
          <a href={l.url} target="_blank" rel="noreferrer">
            🔗 {l.title || l.url}
          </a>
        </div>
      ))}
      <FileList files={h.files} />

      {s && (s.status === 'checked' || s.status === 'returned') && (
        <div className="card" style={{ marginTop: 8, borderColor: s.status === 'checked' ? 'var(--success)' : 'var(--warning)' }}>
          {s.grade != null && (
            <div>
              {t('grade')}: <b>{Number(s.grade)}</b>
            </div>
          )}
          {s.feedback && <div className="hw-desc">{s.feedback}</div>}
          <FileList files={reply} />
        </div>
      )}

      {h.test ? (
        s?.status === 'checked' ? null : (
          <div style={{ marginTop: 8 }}>
            <button className="primary" onClick={() => startTest.mutate()} disabled={startTest.isPending}>
              🧪 {t('takeTest')}
              {h.test.timeLimitMin ? ` · ${h.test.timeLimitMin} ${t('minutes')}` : ''}
            </button>
            <ErrorText error={startTest.error} />
          </div>
        )
      ) : (
        <>
          {s && !open && (
            <div style={{ marginTop: 8 }}>
              {s.text && <div className="hw-desc muted">{s.text}</div>}
              <FileList files={studentFiles} />
              {canSubmit && (
                <button className="small" onClick={() => setOpen(true)}>
                  {t('edit')}
                </button>
              )}
            </div>
          )}
          {open && canSubmit && (
            <div style={{ marginTop: 10 }}>
              <textarea placeholder={t('yourAnswer')} value={text} onChange={(e) => setText(e.target.value)} />
              <div className="row" style={{ margin: '8px 0' }}>
                <VoiceRecorder
                  maxSeconds={300}
                  onRecorded={(f, sec) => {
                    setFiles([...files, f]);
                    setAudioSeconds(sec);
                  }}
                />
                <FilePicker value={files} onChange={setFiles} capture={false} />
              </div>
              {audioSeconds ? <div className="muted">🎙 {mmss(audioSeconds)} / 5:00</div> : null}
              <ErrorText error={submit.error} />
              <button className="primary" disabled={submit.isPending || (!text.trim() && !files.length)} onClick={() => submit.mutate()}>
                {s ? t('resubmit') : t('submitHomework')}
              </button>
            </div>
          )}
        </>
      )}
      {testToken && (
        <Modal
          title={h.test!.title}
          wide
          onClose={() => {
            setTestToken(null);
            qc.invalidateQueries({ queryKey: ['myHomework'] });
          }}
        >
          <TestRunner token={testToken} onDone={() => qc.invalidateQueries({ queryKey: ['myHomework'] })} />
        </Modal>
      )}
    </div>
  );
}
