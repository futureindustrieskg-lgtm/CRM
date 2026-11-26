/**
 * Преподаватель: занятия на сегодня / неделю и отметка посещаемости (сценарий S9 — «2 нажатия без интернета»):
 * «Все пришли» → «Сохранить». Без связи отметка ставится в очередь и уходит при появлении сети.
 * Журналы сегодняшних занятий загружаются заранее, чтобы открыть их и без интернета.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, TextInput } from 'react-native';
import { api } from '../api';
import { centerDateInput, centerDayStart, centerToUtc, fmtDay, fmtTime, useI18n } from '../i18n';
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
  lesson: { id: string; startsAt: string; endsAt: string; status: string; topic: string | null; courseTopicId: string | null; group: { name: string } };
  students: { id: string; firstName: string; lastName: string }[];
  attendance: { studentId: string; status: MarkStatus }[];
  grades: { studentId: string; skill: string; value: string }[];
  topics: { id: string; title: string; used: boolean }[];
  suggestedTopicId: string | null;
  settings: { gradeScale: 'percent' | 'points' | 'de_1_6'; gradeMax: number };
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
const SKILLS = ['hoeren', 'lesen', 'schreiben', 'sprechen', 'overall'] as const;
type Skill = (typeof SKILLS)[number];

/**
 * Журнал занятия: посещаемость в 2 нажатия (офлайн), тема из учебного плана, оценки по навыкам,
 * перенос и отмена (право schedule.update) или запрос на них администраторам.
 */
export function JournalScreen({ lessonId, canManage, onBack }: { lessonId: string; canManage: boolean; onBack: () => void }) {
  const { t, locale } = useI18n();
  const c = useColors();
  const q = useLoad<Journal>(journalKey(lessonId), () => api<Journal>(`/lessons/${lessonId}/journal`), [lessonId]);
  const [marks, setMarks] = useState<Record<string, MarkStatus>>({});
  const [topic, setTopic] = useState('');
  const [topicId, setTopicId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<'attendance' | 'grades' | 'lesson'>('attendance');
  const { queue } = usePending();
  const queued = queue.find((x) => x.lessonId === lessonId);

  useEffect(() => {
    if (!q.data) return;
    // Неотправленная отметка с телефона важнее данных сервера: показываем её.
    const base = Object.fromEntries(q.data.attendance.map((a) => [a.studentId, a.status]));
    const local = queued ? Object.fromEntries(queued.items.map((i) => [i.studentId, i.status])) : {};
    setMarks({ ...base, ...local });
    setTopic(queued?.topic ?? q.data.lesson.topic ?? '');
    setTopicId(queued?.courseTopicId ?? q.data.lesson.courseTopicId ?? null);
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
      const planTitle = j.topics.find((x) => x.id === topicId)?.title;
      const online = await submitMarks({
        lessonId,
        label: `${j.lesson.group.name}, ${fmtDay(j.lesson.startsAt, locale)} ${fmtTime(j.lesson.startsAt)}`,
        items,
        topic: topic.trim() || planTitle || undefined,
        courseTopicId: topicId ?? undefined,
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
          <Row>
            {(['attendance', 'grades', 'lesson'] as const).map((s) => (
              <Button key={s} small kind={section === s ? 'primary' : 'plain'} title={t(`j.${s}`)} onPress={() => setSection(s)} />
            ))}
          </Row>

          {section === 'attendance' && (
            <>
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
              {j.topics.length > 0 && (
                <Card>
                  <T bold>{t('planTopic')}</T>
                  <Row>
                    {j.topics.map((x) => (
                      <Button
                        key={x.id}
                        small
                        kind={topicId === x.id ? 'primary' : 'plain'}
                        title={`${x.used && topicId !== x.id ? '✓ ' : ''}${x.title}`}
                        onPress={() => setTopicId(topicId === x.id ? null : x.id)}
                      />
                    ))}
                  </Row>
                  {j.suggestedTopicId && !topicId && (
                    <Button small kind="plain" title={`${t('suggested')}: ${j.topics.find((x) => x.id === j.suggestedTopicId)?.title ?? ''}`} onPress={() => setTopicId(j.suggestedTopicId)} />
                  )}
                </Card>
              )}
              <TextInput
                value={topic}
                onChangeText={setTopic}
                placeholder={j.topics.length ? t('topicNote') : t('topic')}
                placeholderTextColor={c.muted}
                style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 10, color: c.text, backgroundColor: c.card }}
              />
              {queued && <T color={c.warn}>{t('pendingSync')}</T>}
              {msg && <T color={msg.ok ? c.ok : c.warn}>{msg.text}</T>}
              <ErrorBox error={err} />
              <Button title={`${t('save')} (${markedCount}/${j.students.length})`} onPress={save} disabled={busy || !j.canMark || markedCount === 0} />
            </>
          )}

          {section === 'grades' && <GradesPanel j={j} lessonId={lessonId} marks={marks} onSaved={q.reload} />}
          {section === 'lesson' && <LessonActions j={j} lessonId={lessonId} canManage={canManage} onDone={q.reload} />}
        </>
      )}
    </Screen>
  );
}

/** Оценки за занятие по навыку: шкала центра (проценты, баллы или 1–6). Нужна связь с сервером. */
function GradesPanel({ j, lessonId, marks, onSaved }: { j: Journal; lessonId: string; marks: Record<string, MarkStatus>; onSaved: () => void }) {
  const { t } = useI18n();
  const c = useColors();
  const [skill, setSkill] = useState<Skill>('overall');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [ok, setOk] = useState(false);

  // Текущие оценки по выбранному навыку.
  useEffect(() => {
    setValues(Object.fromEntries(j.grades.filter((g) => g.skill === skill).map((g) => [g.studentId, String(Number(g.value))])));
  }, [skill, j.grades]);
  // «Сохранено» гаснет при смене навыка, но не при перезагрузке журнала после сохранения.
  useEffect(() => setOk(false), [skill]);

  const scale = j.settings.gradeScale;
  const hint = scale === 'de_1_6' ? t('scale16') : scale === 'points' ? `${t('scalePoints')} 0–${j.settings.gradeMax}` : t('scalePercent');
  // Оценивают пришедших; отсутствующим оценку не ставят.
  const students = j.students.filter((s) => marks[s.id] !== 'absent' && marks[s.id] !== 'excused');
  const save = async () => {
    setBusy(true);
    setErr(null);
    setOk(false);
    try {
      const items = students
        .filter((s) => values[s.id] !== undefined)
        .map((s) => ({ studentId: s.id, skill, value: values[s.id].trim() === '' ? null : Number(values[s.id].replace(',', '.')) }));
      if (items.some((i) => i.value !== null && Number.isNaN(i.value))) throw new Error(t('badNumber'));
      await api(`/lessons/${lessonId}/grades`, { method: 'POST', body: { items } });
      setOk(true);
      onSaved();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Row>
        {SKILLS.map((s) => (
          <Button key={s} small kind={skill === s ? 'primary' : 'plain'} title={t(`sk.${s}`)} onPress={() => setSkill(s)} />
        ))}
      </Row>
      <T muted size={13}>{hint}</T>
      {students.map((s) => (
        <Card key={s.id} style={{ padding: 10 }}>
          <Row style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
            <T style={{ flexShrink: 1 }}>
              {s.lastName} {s.firstName}
            </T>
            <TextInput
              value={values[s.id] ?? ''}
              onChangeText={(v) => setValues({ ...values, [s.id]: v })}
              keyboardType="decimal-pad"
              placeholder="—"
              placeholderTextColor={c.muted}
              accessibilityLabel={`${t('grade')}: ${s.lastName} ${s.firstName}`}
              style={{ width: 70, textAlign: 'center', borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 8, color: c.text }}
            />
          </Row>
        </Card>
      ))}
      {ok && <T color={c.ok}>{t('saved')}</T>}
      <ErrorBox error={err} />
      <Button title={t('saveGrades')} onPress={save} disabled={busy || j.lesson.status === 'cancelled'} />
    </>
  );
}

/** Перенос и отмена: с правом schedule.update — сразу, иначе запрос администраторам филиала. */
function LessonActions({ j, lessonId, canManage, onDone }: { j: Journal; lessonId: string; canManage: boolean; onDone: () => void }) {
  const { t } = useI18n();
  const c = useColors();
  const [kind, setKind] = useState<'move' | 'cancel'>('move');
  const [date, setDate] = useState(centerDateInput(j.lesson.startsAt));
  const [time, setTime] = useState(fmtTime(j.lesson.startsAt));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const input = { borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 10, color: c.text, backgroundColor: c.card } as const;

  if (j.lesson.status === 'cancelled') return <T color={c.warn}>{t('cancelled')}</T>;
  if (new Date(j.lesson.endsAt) < new Date()) return <T muted>{t('lessonPast')}</T>;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      if (!reason.trim()) throw new Error(t('needReason'));
      const start = centerToUtc(date, time);
      if (kind === 'move' && !start) throw new Error(t('badDateTime'));
      if (!canManage) {
        await api(`/lessons/${lessonId}/change-request`, { method: 'POST', body: { kind, reason, proposed: kind === 'move' ? `${date} ${time}` : undefined } });
        setDone(t('requestSent'));
      } else if (kind === 'cancel') {
        await api(`/lessons/${lessonId}/cancel`, { method: 'POST', body: { reason } });
        setDone(t('lessonCancelled'));
        onDone();
      } else {
        const len = +new Date(j.lesson.endsAt) - +new Date(j.lesson.startsAt);
        await api(`/lessons/${lessonId}`, { method: 'PATCH', body: { startsAt: start!.toISOString(), endsAt: new Date(+start! + len).toISOString(), reason } });
        setDone(t('lessonMoved'));
        onDone();
      }
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Row>
        <Button small kind={kind === 'move' ? 'primary' : 'plain'} title={t('moveLesson')} onPress={() => setKind('move')} />
        <Button small kind={kind === 'cancel' ? 'primary' : 'plain'} title={t('cancelLesson')} onPress={() => setKind('cancel')} />
      </Row>
      {!canManage && <T muted size={13}>{t('requestHint')}</T>}
      {kind === 'move' && (
        <Row style={{ flexWrap: 'nowrap' }}>
          <TextInput value={date} onChangeText={setDate} placeholder="ДД.ММ.ГГГГ" placeholderTextColor={c.muted} style={[input, { flex: 2 }]} accessibilityLabel={t('date')} />
          <TextInput value={time} onChangeText={setTime} placeholder="ЧЧ:ММ" placeholderTextColor={c.muted} style={[input, { flex: 1 }]} accessibilityLabel={t('time')} />
        </Row>
      )}
      <TextInput value={reason} onChangeText={setReason} placeholder={t('reason')} placeholderTextColor={c.muted} style={input} />
      {done && <T color={c.ok}>{done}</T>}
      <ErrorBox error={err} />
      <Button
        kind={kind === 'cancel' ? 'danger' : 'primary'}
        title={canManage ? (kind === 'move' ? t('moveLesson') : t('cancelLesson')) : t('sendRequest')}
        onPress={submit}
        disabled={busy || !!done}
      />
    </Card>
  );
}
