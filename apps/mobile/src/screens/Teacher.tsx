/**
 * Преподаватель: занятия на сегодня / неделю и отметка посещаемости (сценарий S9 — «2 нажатия без интернета»):
 * «Все пришли» → «Сохранить». Без связи отметка ставится в очередь и уходит при появлении сети.
 * Журналы сегодняшних занятий загружаются заранее, чтобы открыть их и без интернета.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, TextInput } from 'react-native';
import { api } from '../api';
import { centerDayStart, fmtDay, fmtTime, useI18n } from '../i18n';
import { lastFailures, MarkStatus, pending, clearFailures, submitMarks, subscribe, sync } from '../offline';
import { setJson } from '../storage';
import { Button, Card, Chip, ErrorBox, Loading, Row, Screen, T, Title, useColors } from '../ui';
import { useLoad } from '../useLoad';

interface LessonItem {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  topic: string | null;
  group: { id: string; name: string; _count: { students: number } };
  room: { name: string } | null;
  _count: { attendance: number };
}
interface Journal {
  lesson: { id: string; startsAt: string; endsAt: string; status: string; topic: string | null; group: { name: string } };
  students: { id: string; firstName: string; lastName: string }[];
  attendance: { studentId: string; status: MarkStatus }[];
  canMark: boolean;
}

const startOfDay = () => centerDayStart();
const journalKey = (id: string) => `journal:${id}`;

/** Очередь офлайн-отметок для экрана. */
function usePending() {
  const q = useSyncExternalStore(subscribe, pending, pending);
  const f = useSyncExternalStore(subscribe, lastFailures, lastFailures);
  return { queue: q, failures: f };
}

function PendingCard() {
  const { t } = useI18n();
  const c = useColors();
  const { queue, failures } = usePending();
  if (!queue.length && !failures.length) return null;
  return (
    <Card style={{ borderColor: queue.length ? c.warn : c.danger }}>
      {queue.length > 0 && (
        <>
          <T bold color={c.warn}>
            {t('pendingSync')}: {queue.length}
          </T>
          {queue.map((q) => (
            <T key={q.id} muted>
              {q.label}
            </T>
          ))}
          <Button small kind="plain" title={t('syncNow')} onPress={() => sync().catch(() => {})} />
        </>
      )}
      {failures.map((f, i) => (
        <T key={i} color={c.danger}>
          {t('syncFailed')}: {f.label} — {f.error}
        </T>
      ))}
      {failures.length > 0 && <Button small kind="plain" title="OK" onPress={clearFailures} />}
    </Card>
  );
}

export function TeacherLessonsScreen({ onOpen }: { onOpen: (lessonId: string) => void }) {
  const { t, locale } = useI18n();
  const c = useColors();
  const [range, setRange] = useState<'today' | 'week'>('today');
  const from = startOfDay();
  const to = new Date(+from + (range === 'today' ? 1 : 7) * 86_400_000);
  const q = useLoad<LessonItem[]>(
    `lessons:${range}`,
    () => api<LessonItem[]>(`/lessons?from=${from.toISOString()}&to=${to.toISOString()}`),
    [range],
  );

  // Заранее кладём в кэш журналы сегодняшних занятий — для отметки без интернета.
  useEffect(() => {
    if (range !== 'today' || !q.data || q.stale) return;
    for (const l of q.data) {
      if (l.status === 'cancelled') continue;
      api<Journal>(`/lessons/${l.id}/journal`)
        .then((j) => setJson(`cache:${journalKey(l.id)}`, j))
        .catch(() => {});
    }
  }, [q.data, q.stale, range]);

  // Очередь отправлена — обновляем список (отметки появились на сервере).
  const { queue } = usePending();
  const [hadQueue, setHadQueue] = useState(false);
  useEffect(() => {
    if (queue.length) setHadQueue(true);
    else if (hadQueue) {
      setHadQueue(false);
      q.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.length]);

  if (q.loading && !q.data) return <Loading />;
  return (
    <Screen refreshing={q.loading} onRefresh={q.reload}>
      <Row>
        <Button small kind={range === 'today' ? 'primary' : 'plain'} title={t('today')} onPress={() => setRange('today')} />
        <Button small kind={range === 'week' ? 'primary' : 'plain'} title={t('week')} onPress={() => setRange('week')} />
      </Row>
      <PendingCard />
      <ErrorBox error={q.error} onRetry={q.reload} />
      {q.stale && <T color={c.warn}>{t('offline')}</T>}
      {q.data?.length === 0 && <T muted>{t('noLessons')}</T>}
      {q.data?.map((l) => (
        <Pressable key={l.id} onPress={() => onOpen(l.id)} disabled={l.status === 'cancelled'}>
          <Card style={{ opacity: l.status === 'cancelled' ? 0.5 : 1 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T bold>
                {range === 'week' ? `${fmtDay(l.startsAt, locale)} · ` : ''}
                {fmtTime(l.startsAt)}–{fmtTime(l.endsAt)}
              </T>
              {l.status === 'cancelled' ? (
                <Chip label={t('cancelled')} color={c.danger} />
              ) : l._count.attendance > 0 ? (
                <Chip label={`✓ ${l._count.attendance}`} color={c.ok} />
              ) : null}
            </Row>
            <T>{l.group.name}</T>
            <T muted>{[l.room?.name, l.topic].filter(Boolean).join(' · ')}</T>
          </Card>
        </Pressable>
      ))}
    </Screen>
  );
}

const STATUSES: MarkStatus[] = ['present', 'late', 'excused', 'absent'];

export function JournalScreen({ lessonId, onBack }: { lessonId: string; onBack: () => void }) {
  const { t, locale } = useI18n();
  const c = useColors();
  const q = useLoad<Journal>(journalKey(lessonId), () => api<Journal>(`/lessons/${lessonId}/journal`), [lessonId]);
  const [marks, setMarks] = useState<Record<string, MarkStatus>>({});
  const [topic, setTopic] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const { queue } = usePending();
  const queued = queue.find((x) => x.lessonId === lessonId);

  useEffect(() => {
    if (!q.data) return;
    // Неотправленная отметка с телефона важнее данных сервера: показываем её.
    const base = Object.fromEntries(q.data.attendance.map((a) => [a.studentId, a.status]));
    const local = queued ? Object.fromEntries(queued.items.map((i) => [i.studentId, i.status])) : {};
    setMarks({ ...base, ...local });
    setTopic(queued?.topic ?? q.data.lesson.topic ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);

  if (q.loading && !q.data) return <Loading />;
  const j = q.data;
  const allPresent = () => j && setMarks(Object.fromEntries(j.students.map((s) => [s.id, marks[s.id] ?? 'present'])));
  const cycle = (id: string) => {
    const cur = marks[id];
    const next = cur ? STATUSES[(STATUSES.indexOf(cur) + 1) % STATUSES.length] : 'present';
    setMarks({ ...marks, [id]: next });
  };
  const save = async () => {
    if (!j) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const items = j.students.filter((s) => marks[s.id]).map((s) => ({ studentId: s.id, status: marks[s.id] }));
      const online = await submitMarks({
        lessonId,
        label: `${j.lesson.group.name}, ${fmtDay(j.lesson.startsAt, locale)} ${fmtTime(j.lesson.startsAt)}`,
        items,
        topic: topic.trim() || undefined,
      });
      setMsg({ ok: online, text: online ? t('saved') : t('savedOffline') });
      if (online) q.reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const color = (s?: MarkStatus) => (s === 'present' ? c.ok : s === 'absent' ? c.danger : s ? c.warn : c.muted);
  const markedCount = j ? j.students.filter((s) => marks[s.id]).length : 0;

  return (
    <Screen>
      <Button small kind="plain" title={`← ${t('back')}`} onPress={onBack} />
      <ErrorBox error={q.error} onRetry={q.reload} />
      {j && (
        <>
          <Card>
            <Title>{j.lesson.group.name}</Title>
            <T muted>
              {fmtDay(j.lesson.startsAt, locale)} · {fmtTime(j.lesson.startsAt)}–{fmtTime(j.lesson.endsAt)}
            </T>
            {q.stale && <T color={c.warn}>{t('offline')}</T>}
            {!j.canMark && <T color={c.warn}>{j.lesson.status === 'cancelled' ? t('cancelled') : t('notStarted')}</T>}
          </Card>
          <Button kind="plain" title={`✓ ${t('markAll')}`} onPress={allPresent} disabled={!j.canMark} />
          {j.students.map((s) => (
            <Pressable key={s.id} onPress={() => cycle(s.id)} disabled={!j.canMark} accessibilityRole="button">
              <Card style={{ padding: 12 }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <T>
                    {s.lastName} {s.firstName}
                  </T>
                  <T bold color={color(marks[s.id])}>
                    {marks[s.id] ? t(`st.${marks[s.id]}`) : '—'}
                  </T>
                </Row>
              </Card>
            </Pressable>
          ))}
          <TextInput
            value={topic}
            onChangeText={setTopic}
            placeholder={t('topic')}
            placeholderTextColor={c.muted}
            style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 10, color: c.text, backgroundColor: c.card }}
          />
          {queued && <T color={c.warn}>{t('pendingSync')}</T>}
          {msg && <T color={msg.ok ? c.ok : c.warn}>{msg.text}</T>}
          <ErrorBox error={err} />
          <Button title={`${t('save')} (${markedCount}/${j.students.length})`} onPress={save} disabled={busy || !j.canMark || markedCount === 0} />
        </>
      )}
    </Screen>
  );
}
