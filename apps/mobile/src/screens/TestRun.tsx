/**
 * Прохождение ДЗ-теста в приложении (ТЗ 3.6): выбор ответа, артикль, сопоставление, вписать слово;
 * аудирование и картинки к вопросам. Таймер с автосдачей; ответы сохраняются на телефоне,
 * поэтому закрытие приложения или потеря связи не обнуляют прогресс.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Pressable, TextInput, View } from 'react-native';
import { api, testFileUri } from '../api';
import { useI18n } from '../i18n';
import { AudioPlayer, mmss } from '../media';
import { getJson, setJson } from '../storage';
import { Button, Card, ErrorBox, Loading, Row, Screen, T, Title, useColors } from '../ui';

interface Question {
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
interface Attempt {
  title: string;
  description: string | null;
  timeLimitMin: number | null;
  questionsCount: number;
  startedAt: string | null;
  deadlineAt: string | null;
  finishedAt: string | null;
  questions?: Question[];
  result?: { score: number; maxScore: number; percent: number; timedOut: boolean };
}
type Answers = Record<string, unknown>;

const draftKey = (token: string) => `test-draft:${token}`;

export function TestRunScreen({ token, onBack }: { token: string; onBack: () => void }) {
  const { t } = useI18n();
  const c = useColors();
  const [a, setA] = useState<Attempt | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [i, setI] = useState(0);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  const submitted = useRef(false);

  const load = useCallback(async () => {
    try {
      setErr(null);
      setA(await api<Attempt>(`/public/attempts/${token}`));
      setAnswers(await getJson<Answers>(draftKey(token), {}));
    } catch (e) {
      setErr(e);
    }
  }, [token]);
  useEffect(() => {
    load();
  }, [load]);

  const save = (next: Answers) => {
    setAnswers(next);
    setJson(draftKey(token), next);
  };

  const finish = useCallback(async () => {
    if (submitted.current) return;
    submitted.current = true;
    setBusy(true);
    try {
      await api(`/public/attempts/${token}/submit`, { method: 'POST', body: { answers } });
      setJson(draftKey(token), {});
      setA(await api<Attempt>(`/public/attempts/${token}`));
    } catch (e) {
      submitted.current = false;
      setErr(e);
    } finally {
      setBusy(false);
    }
  }, [answers, token]);

  // Таймер: по истечении времени ответы отправляются автоматически.
  useEffect(() => {
    if (!a?.deadlineAt || a.finishedAt) return setLeft(null);
    const tick = () => {
      const s = Math.max(0, Math.floor((+new Date(a.deadlineAt!) - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) finish();
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [a?.deadlineAt, a?.finishedAt, finish]);

  const start = async () => {
    setBusy(true);
    try {
      setA(await api<Attempt>(`/public/attempts/${token}/start`, { method: 'POST' }));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  if (!a && !err) return <Loading />;
  const qs = a?.questions ?? [];
  const q = qs[i];
  const answered = qs.filter((x) => isAnswered(x, answers[x.id])).length;

  return (
    <Screen>
      <Button small kind="plain" title={`← ${t('back')}`} onPress={onBack} />
      <ErrorBox error={err} onRetry={load} />
      {a && (
        <Card>
          <Title>{a.title}</Title>
          {a.description ? <T muted>{a.description}</T> : null}
          {left !== null && (
            <T bold color={left < 60 ? c.danger : c.text}>
              ⏱ {mmss(left)}
            </T>
          )}
        </Card>
      )}

      {a?.result && (
        <Card style={{ borderColor: c.ok }}>
          <T bold size={24} color={c.ok}>
            {Math.round(a.result.percent)} %
          </T>
          <T>
            {t('score')}: {a.result.score} / {a.result.maxScore}
          </T>
          {a.result.timedOut && <T color={c.warn}>{t('timedOut')}</T>}
        </Card>
      )}

      {a && !a.startedAt && !a.finishedAt && (
        <Card>
          <T>
            {t('questions')}: {a.questionsCount}
            {a.timeLimitMin ? ` · ${t('timeLimit')}: ${a.timeLimitMin} ${t('min')}` : ''}
          </T>
          <T muted size={13}>{t('testRules')}</T>
          <Button title={t('startTest')} onPress={start} disabled={busy} />
        </Card>
      )}

      {a && a.startedAt && !a.finishedAt && q && (
        <>
          <T muted>
            {t('question')} {i + 1} / {qs.length} · {t('answered')}: {answered}
          </T>
          <Card>
            <QuestionView q={q} token={token} value={answers[q.id]} onChange={(v) => save({ ...answers, [q.id]: v })} />
          </Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <Button small kind="plain" title={`← ${t('prev')}`} onPress={() => setI(i - 1)} disabled={i === 0} />
            {i < qs.length - 1 ? (
              <Button small title={`${t('next')} →`} onPress={() => setI(i + 1)} />
            ) : (
              <Button small title={t('finishTest')} onPress={finish} disabled={busy} />
            )}
          </Row>
          {/* Быстрый переход по вопросам: отвеченные отмечены. */}
          <Row>
            {qs.map((x, k) => (
              <Pressable key={x.id} onPress={() => setI(k)} accessibilityLabel={`${t('question')} ${k + 1}`}>
                <View
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 16,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderWidth: k === i ? 2 : 1,
                    borderColor: k === i ? c.primary : c.border,
                    backgroundColor: isAnswered(x, answers[x.id]) ? c.chip : 'transparent',
                  }}
                >
                  <T size={12}>{k + 1}</T>
                </View>
              </Pressable>
            ))}
          </Row>
          {i < qs.length - 1 && <Button kind="plain" title={t('finishTest')} onPress={finish} disabled={busy} />}
        </>
      )}
    </Screen>
  );
}

function isAnswered(q: Question, v: unknown) {
  if (q.type === 'choice') return Array.isArray(v) && v.length > 0;
  if (q.type === 'matching') return Array.isArray(v) && v.some((x) => x !== null && x !== undefined);
  return typeof v === 'string' && v.trim() !== '';
}

function QuestionView({ q, token, value, onChange }: { q: Question; token: string; value: unknown; onChange: (v: unknown) => void }) {
  const { t } = useI18n();
  const c = useColors();
  const option = (label: string, selected: boolean, onPress: () => void) => (
    <Pressable key={label} onPress={onPress} accessibilityRole="button" accessibilityState={{ selected }}>
      <View style={{ borderWidth: selected ? 2 : 1, borderColor: selected ? c.primary : c.border, borderRadius: 10, padding: 12, backgroundColor: selected ? c.chip : 'transparent' }}>
        <T>{label}</T>
      </View>
    </Pressable>
  );
  return (
    <View style={{ gap: 10 }}>
      {q.prompt ? <T bold>{q.prompt}</T> : null}
      {q.files.map((f) =>
        f.mime.startsWith('audio/') ? (
          <AudioPlayer key={f.id} uri={testFileUri(f.id, token)} name={f.name} />
        ) : f.mime.startsWith('image/') ? (
          <Image key={f.id} source={{ uri: testFileUri(f.id, token) }} style={{ width: '100%', height: 200, borderRadius: 8 }} resizeMode="contain" />
        ) : null,
      )}
      {q.type === 'choice' && (
        <>
          {q.multiple && <T muted size={12}>{t('severalAnswers')}</T>}
          {q.options!.map((o, k) => {
            const cur = (Array.isArray(value) ? value : []) as number[];
            const sel = cur.includes(k);
            return option(o, sel, () => onChange(q.multiple ? (sel ? cur.filter((x) => x !== k) : [...cur, k]) : [k]));
          })}
        </>
      )}
      {q.type === 'article' && (
        <>
          <T size={18}>
            ___ {q.noun}
          </T>
          <Row>{q.options!.map((o) => option(o, value === o, () => onChange(o)))}</Row>
        </>
      )}
      {q.type === 'text' && (
        <TextInput
          value={(value as string) ?? ''}
          onChangeText={onChange}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t('yourAnswer')}
          placeholderTextColor={c.muted}
          style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 10, color: c.text, fontSize: 16 }}
        />
      )}
      {q.type === 'matching' && <Matching q={q} value={value} onChange={onChange} />}
    </View>
  );
}

/** Сопоставление: для каждой левой части выбрать правую (касанием). */
function Matching({ q, value, onChange }: { q: Question; value: unknown; onChange: (v: unknown) => void }) {
  const c = useColors();
  const cur = (Array.isArray(value) ? value : q.left!.map(() => null)) as (number | null)[];
  const [active, setActive] = useState(0);
  const set = (rightIdx: number) => {
    const next = cur.map((x) => (x === rightIdx ? null : x));
    next[active] = rightIdx;
    onChange(next);
    const free = next.findIndex((x, k) => x === null && k > active);
    if (free >= 0) setActive(free);
  };
  return (
    <View style={{ gap: 8 }}>
      {q.left!.map((l, k) => (
        <Pressable key={k} onPress={() => setActive(k)}>
          <View style={{ borderWidth: k === active ? 2 : 1, borderColor: k === active ? c.primary : c.border, borderRadius: 10, padding: 10 }}>
            <T>
              {l} → <T bold>{cur[k] !== null && cur[k] !== undefined ? q.right![cur[k]!] : '…'}</T>
            </T>
          </View>
        </Pressable>
      ))}
      <Row>
        {q.right!.map((r, k) => (
          <Button key={k} small kind={cur.includes(k) ? 'primary' : 'plain'} title={r} onPress={() => set(k)} />
        ))}
      </Row>
    </View>
  );
}
