/** Экраны студента и родителя: главная (баланс, оплата, абонементы), расписание, успехи, домашние задания. */
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Linking, Platform, Pressable, TextInput, View } from 'react-native';
import { api, FileRef } from '../api';
import { Attachments, FileView } from '../media';
import { fmtDay, fmtMoney, fmtTime, useI18n } from '../i18n';
import { Button, Card, Chip, ErrorBox, Loading, Row, Screen, T, Title, useColors } from '../ui';
import { useLoad } from '../useLoad';

export interface Lesson {
  id: string;
  startsAt: string;
  endsAt: string;
  group: string;
  room: string | null;
  teacher: string | null;
  topic: string | null;
  online: boolean;
  onlineUrl: string | null;
}
export interface StudentCard {
  id: string;
  name: string;
  level: string | null;
  balance: number;
  groups: string[];
  subscriptions: { id: string; name: string; type: string; price: number; lessonsTotal: number; lessonsLeft: number }[];
  upcoming: Lesson[];
  attendance: { date: string; group: string; status: string }[];
  grades: { date: string; skill: string; value: number; scale: string; maxValue: number | null }[];
}
export interface Cabinet {
  role: string;
  students: StudentCard[];
}

export const useCabinet = () => useLoad<Cabinet>('cabinet', () => api<Cabinet>('/me/cabinet'));

const open = (url: string) => (Platform.OS === 'web' ? Linking.openURL(url) : WebBrowser.openBrowserAsync(url));

/** Переключатель ребёнка для родителя с несколькими детьми. */
function StudentTabs({ students, index, onChange }: { students: StudentCard[]; index: number; onChange: (i: number) => void }) {
  if (students.length < 2) return null;
  return (
    <Row>
      {students.map((s, i) => (
        <Button key={s.id} small kind={i === index ? 'primary' : 'plain'} title={s.name} onPress={() => onChange(i)} />
      ))}
    </Row>
  );
}

function StaleNote({ stale }: { stale: boolean }) {
  const { t } = useI18n();
  const c = useColors();
  return stale ? <T color={c.warn}>{t('offline')}</T> : null;
}

export function HomeScreen({ onProgress }: { onProgress?: () => void }) {
  const { t } = useI18n();
  const c = useColors();
  const q = useCabinet();
  const [i, setI] = useState(0);
  const [payErr, setPayErr] = useState<unknown>(null);
  const [paying, setPaying] = useState(false);
  if (q.loading && !q.data) return <Loading />;
  const s = q.data?.students[i] ?? q.data?.students[0];
  const pay = async () => {
    if (!s) return;
    setPaying(true);
    setPayErr(null);
    try {
      const r = await api<{ url: string }>(`/me/students/${s.id}/pay`, { method: 'POST' });
      await open(r.url);
      q.reload();
    } catch (e) {
      setPayErr(e);
    } finally {
      setPaying(false);
    }
  };
  return (
    <Screen refreshing={q.loading} onRefresh={q.reload}>
      <ErrorBox error={q.error} onRetry={q.reload} />
      <StaleNote stale={q.stale} />
      {q.data && <StudentTabs students={q.data.students} index={i} onChange={setI} />}
      {!s && q.data && <T muted>{t('noData')}</T>}
      {s && (
        <>
          <Card>
            <T muted>{s.name}{s.level ? ` · ${s.level}` : ''}</T>
            <T muted>{s.balance < 0 ? t('debt') : t('balance')}</T>
            <T bold size={28} color={s.balance < 0 ? c.danger : c.ok}>
              {fmtMoney(Math.abs(s.balance))}
            </T>
            {s.balance < 0 && <Button title={t('pay')} onPress={pay} disabled={paying || q.stale} />}
            <ErrorBox error={payErr} />
          </Card>
          <Card>
            <Title>{t('subscriptions')}</Title>
            {s.subscriptions.length === 0 && <T muted>{t('noSubscriptions')}</T>}
            {s.subscriptions.map((x) => (
              <Row key={x.id} style={{ justifyContent: 'space-between' }}>
                <T>{x.name}</T>
                <T bold color={x.lessonsLeft <= 2 ? c.warn : c.text}>
                  {x.lessonsLeft} / {x.lessonsTotal} {t('lessonsLeft')}
                </T>
              </Row>
            ))}
          </Card>
          {onProgress && <Button kind="plain" title={`📈 ${t('progress')}: ${t('grades').toLowerCase()}, ${t('attendance').toLowerCase()}`} onPress={onProgress} />}
          <Card>
            <Title>{t('upcoming')}</Title>
            {s.upcoming.slice(0, 3).map((l) => (
              <LessonRow key={l.id} l={l} />
            ))}
            {s.upcoming.length === 0 && <T muted>{t('noLessons')}</T>}
          </Card>
        </>
      )}
    </Screen>
  );
}

function LessonRow({ l }: { l: Lesson }) {
  const { t, locale } = useI18n();
  return (
    <Card style={{ padding: 10 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T bold>
          {fmtDay(l.startsAt, locale)} · {fmtTime(l.startsAt)}–{fmtTime(l.endsAt)}
        </T>
        {l.online && <Chip label={t('online')} />}
      </Row>
      <T>{l.group}</T>
      <T muted>{[l.room, l.teacher, l.topic].filter(Boolean).join(' · ')}</T>
      {l.online && (l.onlineUrl ? <Button small title={t('join')} onPress={() => open(l.onlineUrl!)} /> : <T muted size={12}>{t('linkSoon')}</T>)}
    </Card>
  );
}

export function ScheduleScreen() {
  const { t } = useI18n();
  const q = useCabinet();
  const [i, setI] = useState(0);
  if (q.loading && !q.data) return <Loading />;
  const s = q.data?.students[i] ?? q.data?.students[0];
  return (
    <Screen refreshing={q.loading} onRefresh={q.reload}>
      <ErrorBox error={q.error} onRetry={q.reload} />
      <StaleNote stale={q.stale} />
      {q.data && <StudentTabs students={q.data.students} index={i} onChange={setI} />}
      {s?.upcoming.map((l) => <LessonRow key={l.id} l={l} />)}
      {s && s.upcoming.length === 0 && <T muted>{t('noLessons')}</T>}
    </Screen>
  );
}

const fmtGrade = (g: StudentCard['grades'][number]) =>
  g.scale === 'percent' ? `${g.value} %` : g.scale === 'points' && g.maxValue ? `${g.value} / ${g.maxValue}` : String(g.value);

export function ProgressScreen() {
  const { t, locale } = useI18n();
  const c = useColors();
  const q = useCabinet();
  const [i, setI] = useState(0);
  if (q.loading && !q.data) return <Loading />;
  const s = q.data?.students[i] ?? q.data?.students[0];
  const color = (st: string) => (st === 'present' ? c.ok : st === 'absent' ? c.danger : c.warn);
  return (
    <Screen refreshing={q.loading} onRefresh={q.reload}>
      <ErrorBox error={q.error} onRetry={q.reload} />
      <StaleNote stale={q.stale} />
      {q.data && <StudentTabs students={q.data.students} index={i} onChange={setI} />}
      {s && (
        <>
          <Card>
            <Title>{t('grades')}</Title>
            {s.grades.length === 0 && <T muted>{t('noData')}</T>}
            {s.grades.map((g, k) => (
              <Row key={k} style={{ justifyContent: 'space-between' }}>
                <T muted>{fmtDay(g.date, locale)}</T>
                <T>{t(`sk.${g.skill}`)}</T>
                <T bold>{fmtGrade(g)}</T>
              </Row>
            ))}
          </Card>
          <Card>
            <Title>{t('attendance')}</Title>
            {s.attendance.length === 0 && <T muted>{t('noData')}</T>}
            {s.attendance.map((a, k) => (
              <Row key={k} style={{ justifyContent: 'space-between' }}>
                <T muted>{fmtDay(a.date, locale)}</T>
                <T>{a.group}</T>
                <T bold color={color(a.status)}>
                  {t(`st.${a.status}`)}
                </T>
              </Row>
            ))}
          </Card>
        </>
      )}
    </Screen>
  );
}


interface MyHw {
  id: string;
  title: string;
  description: string | null;
  links: { url: string; title?: string }[] | null;
  dueAt: string | null;
  group: { name: string };
  test: { id: string; title: string; timeLimitMin: number | null } | null;
  files: FileRef[];
  submission: {
    id: string;
    status: 'submitted' | 'checked' | 'returned';
    text: string | null;
    grade: string | null;
    feedback: string | null;
    audioSeconds: number | null;
    files: (FileRef & { isFeedback?: boolean })[];
  } | null;
}

/**
 * ДЗ студента: задание с файлами и ссылками, ответ текстом + фото тетради, файл, голос до 5 минут;
 * оценка и комментарий преподавателя; ДЗ-тест проходится прямо в приложении.
 */
export function HomeworkScreen({ onTest }: { onTest: (token: string, title: string) => void }) {
  const { t, locale } = useI18n();
  const c = useColors();
  const q = useLoad<MyHw[]>('my-homework', () => api<MyHw[]>('/my/homework'));
  const [filter, setFilter] = useState<'todo' | 'all'>('todo');
  const [openId, setOpenId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<FileRef[]>([]);
  const [audioSeconds, setAudioSeconds] = useState<number | undefined>();
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (q.loading && !q.data) return <Loading />;

  const openAnswer = (h: MyHw) => {
    setOpenId(h.id);
    setText(h.submission?.text ?? '');
    setFiles([]);
    setAudioSeconds(undefined);
    setErr(null);
  };
  const submit = async (id: string) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/my/homework/${id}/submit`, { method: 'POST', body: { text: text.trim() || undefined, fileIds: files.map((f) => f.id), audioSeconds } });
      setOpenId(null);
      q.reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const startTest = async (h: MyHw) => {
    setErr(null);
    try {
      const r = await api<{ token: string }>(`/my/homework/${h.id}/test`, { method: 'POST' });
      onTest(r.token, h.test?.title ?? h.title);
    } catch (e) {
      setErr(e);
    }
  };
  const rows = (q.data ?? []).filter((h) => filter === 'all' || !h.submission || h.submission.status === 'returned');

  return (
    <Screen refreshing={q.loading} onRefresh={q.reload}>
      <Row>
        <Button small kind={filter === 'todo' ? 'primary' : 'plain'} title={t('toDo')} onPress={() => setFilter('todo')} />
        <Button small kind={filter === 'all' ? 'primary' : 'plain'} title={t('allTasks')} onPress={() => setFilter('all')} />
      </Row>
      <ErrorBox error={q.error} onRetry={q.reload} />
      {q.stale && <T color={c.warn}>{t('offline')}</T>}
      {q.data && rows.length === 0 && <T muted>{t('noData')}</T>}
      {rows.map((h) => {
        const s = h.submission;
        const st = s?.status;
        const overdue = !s && h.dueAt && new Date(h.dueAt) < new Date();
        const teacherFiles = s?.files.filter((f) => f.isFeedback) ?? [];
        return (
          <Card key={h.id}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T bold style={{ flexShrink: 1 }}>
                {h.title}
              </T>
              <Chip
                label={st === 'checked' ? t('checked') : st === 'returned' ? t('returned') : st ? t('submitted') : overdue ? t('overdue') : t('toDo')}
                color={st === 'checked' ? c.ok : st === 'returned' || overdue ? c.danger : st ? c.primary : c.warn}
              />
            </Row>
            <T muted>
              {h.group.name}
              {h.dueAt ? ` · ${t('due')}: ${fmtDay(h.dueAt, locale)} ${fmtTime(h.dueAt)}` : ''}
            </T>
            {h.description ? <T>{h.description}</T> : null}
            <FileView files={h.files} />
            {h.links?.map((l) => (
              <Pressable key={l.url} onPress={() => open(l.url)}>
                <T color={c.primary}>🔗 {l.title || l.url}</T>
              </Pressable>
            ))}

            {s && (st === 'checked' || st === 'returned') && (
              <Card style={{ padding: 10, borderColor: st === 'checked' ? c.ok : c.danger }}>
                {s.grade !== null && (
                  <T bold>
                    {t('grade')}: {Number(s.grade)}
                  </T>
                )}
                {s.feedback ? <T>{s.feedback}</T> : null}
                <FileView files={teacherFiles} />
              </Card>
            )}

            {h.test ? (
              <>
                <T muted>
                  📝 {h.test.title}
                  {h.test.timeLimitMin ? ` · ${h.test.timeLimitMin} ${t('min')}` : ''}
                </T>
                {!s && <Button small title={t('startTest')} onPress={() => startTest(h)} />}
              </>
            ) : st !== 'checked' && openId !== h.id ? (
              <Button small kind="plain" title={st ? t('resubmit') : t('answer')} onPress={() => openAnswer(h)} />
            ) : null}

            {openId === h.id && (
              <View style={{ gap: 8 }}>
                <TextInput
                  value={text}
                  onChangeText={setText}
                  multiline
                  placeholder={t('answerText')}
                  placeholderTextColor={c.muted}
                  style={{ minHeight: 90, borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 8, color: c.text, textAlignVertical: 'top' }}
                />
                <Attachments files={files} onChange={setFiles} audioSeconds={audioSeconds} onAudio={setAudioSeconds} />
                {st && <T muted size={12}>{t('resubmitHint')}</T>}
                <ErrorBox error={err} />
                <Row>
                  <Button small kind="plain" title={t('back')} onPress={() => setOpenId(null)} />
                  <Button small title={t('send')} disabled={busy || (!text.trim() && !files.length)} onPress={() => submit(h.id)} />
                </Row>
              </View>
            )}
          </Card>
        );
      })}
      {!openId && <ErrorBox error={err} />}
    </Screen>
  );
}
