/**
 * Чат в приложении (ТЗ 3.8): чат группы, личный «студент — преподаватель», обращение в администрацию филиала.
 * Телефоны в чате не показываются. Новые сообщения подгружаются каждые 5 секунд, пока чат открыт;
 * о сообщениях в закрытом приложении сообщает push.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, TextInput, View } from 'react-native';
import { api, ApiError, FileRef } from '../api';
import { fmtDay, fmtTime, useI18n } from '../i18n';
import { Attachments, FileView } from '../media';
import { Button, Card, Chip, ErrorBox, Loading, Row, Screen, T, Title, useColors } from '../ui';
import { useLoad } from '../useLoad';

interface Person {
  id: string;
  firstName: string;
  lastName: string;
}
interface Conversation {
  id: string;
  type: 'group' | 'direct' | 'support';
  title: string | null;
  members: number;
  unread: number;
  last: { text: string | null; createdAt: string; sender: Person | null; _count: { files: number } } | null;
}
interface Message {
  id: string;
  text: string | null;
  createdAt: string;
  sender: Person | null;
  files: FileRef[];
}

const POLL_MS = 5000;

export function convTitle(c: Pick<Conversation, 'type' | 'title'>, t: (k: string) => string) {
  if (c.type === 'support') return c.title || t('supportChat');
  return c.title || t('chat');
}

export function ChatListScreen({ onOpen }: { onOpen: (id: string, title: string) => void }) {
  const { t, locale } = useI18n();
  const c = useColors();
  const q = useLoad<Conversation[]>('chats', () => api<Conversation[]>('/chat/conversations'));
  const [picking, setPicking] = useState(false);

  // Список обновляется, пока экран открыт (новые чаты и счётчики).
  useEffect(() => {
    const id = setInterval(() => q.reload(), 15_000);
    return () => clearInterval(id);
  }, [q.reload]); // eslint-disable-line react-hooks/exhaustive-deps

  if (picking) return <NewChat onBack={() => setPicking(false)} onOpen={onOpen} />;
  if (q.loading && !q.data) return <Loading />;
  return (
    <Screen refreshing={false} onRefresh={q.reload}>
      <Button small kind="plain" title={`+ ${t('newChat')}`} onPress={() => setPicking(true)} />
      <ErrorBox error={q.error} onRetry={q.reload} />
      {q.stale && <T color={c.warn}>{t('offline')}</T>}
      {q.data?.length === 0 && <T muted>{t('noChats')}</T>}
      {q.data?.map((x) => {
        const title = convTitle(x, t);
        const preview = x.last ? x.last.text || (x.last._count.files ? `📎 ${t('file')}` : '') : '';
        return (
          <Pressable key={x.id} onPress={() => onOpen(x.id, title)} accessibilityRole="button">
            <Card style={x.unread ? { borderColor: c.primary } : undefined}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T bold style={{ flexShrink: 1 }}>
                  {x.type === 'group' ? '👥 ' : x.type === 'support' ? '🏫 ' : ''}
                  {title}
                </T>
                {x.unread > 0 && <Chip label={String(x.unread)} color={c.primary} />}
              </Row>
              {x.last && (
                <T muted numberOfLines={1}>
                  {x.last.sender ? `${x.last.sender.firstName}: ` : ''}
                  {preview}
                </T>
              )}
              {x.last && (
                <T muted size={12}>
                  {fmtDay(x.last.createdAt, locale)} {fmtTime(x.last.createdAt)}
                </T>
              )}
            </Card>
          </Pressable>
        );
      })}
    </Screen>
  );
}

/** Новый чат: студенту — его преподаватели и администрация, преподавателю — его студенты, родителю — администрация. */
function NewChat({ onBack, onOpen }: { onBack: () => void; onOpen: (id: string, title: string) => void }) {
  const { t } = useI18n();
  const q = useLoad<{ users: (Person & { hint: string })[]; support: boolean }>(null, () => api('/chat/contacts'));
  const [err, setErr] = useState<unknown>(null);
  const start = async (path: string, body: unknown, title: string) => {
    try {
      const conv = await api<{ id: string }>(path, { method: 'POST', body });
      onOpen(conv.id, title);
    } catch (e) {
      setErr(e);
    }
  };
  if (q.loading && !q.data) return <Loading />;
  // Один и тот же человек может быть в нескольких группах — показываем один раз.
  const users = (q.data?.users ?? []).filter((u, i, a) => a.findIndex((x) => x.id === u.id) === i);
  return (
    <Screen>
      <Button small kind="plain" title={`← ${t('back')}`} onPress={onBack} />
      <ErrorBox error={q.error ?? err} onRetry={q.reload} />
      {q.data?.support && (
        <Button title={`🏫 ${t('supportChat')}`} onPress={() => start('/chat/support', {}, t('supportChat'))} />
      )}
      {users.map((u) => (
        <Pressable key={u.id} onPress={() => start('/chat/direct', { userId: u.id }, `${u.firstName} ${u.lastName}`)} accessibilityRole="button">
          <Card>
            <T bold>
              {u.firstName} {u.lastName}
            </T>
            <T muted>{u.hint}</T>
          </Card>
        </Pressable>
      ))}
      {q.data && !users.length && !q.data.support && <T muted>{t('noContacts')}</T>}
    </Screen>
  );
}

export function ChatScreen({ id, title, meId, onBack }: { id: string; title: string; meId: string; onBack: () => void }) {
  const { t, locale } = useI18n();
  const c = useColors();
  const [msgs, setMsgs] = useState<Message[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<FileRef[]>([]);
  const [attach, setAttach] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [gone, setGone] = useState(false);
  const list = useRef<FlatList<Message>>(null);

  const merge = (prev: Message[] | null, next: Message[]) => {
    const map = new Map((prev ?? []).map((m) => [m.id, m]));
    for (const m of next) map.set(m.id, m);
    return [...map.values()].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
  };

  const poll = useCallback(async () => {
    try {
      const rows = await api<Message[]>(`/chat/conversations/${id}/messages`);
      setErr(null);
      setMsgs((prev) => {
        const fresh = rows.some((r) => !prev?.some((p) => p.id === r.id));
        if (fresh) api(`/chat/conversations/${id}/read`, { method: 'POST' }).catch(() => {});
        return merge(prev, rows);
      });
    } catch (e) {
      // Пользователь больше не участник (перевели в другую группу) — опрос прекращается.
      if (e instanceof ApiError && e.status === 404) setGone(true);
      setErr(e);
    }
  }, [id]);

  useEffect(() => {
    if (gone) return;
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => clearInterval(timer);
  }, [poll, gone]);

  const older = async () => {
    if (!msgs?.length) return;
    const rows = await api<Message[]>(`/chat/conversations/${id}/messages?before=${encodeURIComponent(msgs[0].createdAt)}`).catch(() => []);
    if (rows.length < 50) setHasMore(false);
    setMsgs((prev) => merge(prev, rows));
  };

  const send = async () => {
    if (!text.trim() && !files.length) return;
    setBusy(true);
    setErr(null);
    try {
      const m = await api<Message>(`/chat/conversations/${id}/messages`, { method: 'POST', body: { text: text.trim() || undefined, fileIds: files.map((f) => f.id) } });
      setMsgs((prev) => merge(prev, [m]));
      setText('');
      setFiles([]);
      setAttach(false);
      setTimeout(() => list.current?.scrollToEnd({ animated: true }), 50);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ padding: 12, gap: 6, borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.card }}>
        <Row>
          <Button small kind="plain" title="←" onPress={onBack} />
          <Title>{title}</Title>
        </Row>
      </View>
      {!msgs && !err ? (
        <Loading />
      ) : (
        <FlatList
          ref={list}
          data={msgs ?? []}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: 12, gap: 8 }}
          onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
          ListHeaderComponent={
            msgs && msgs.length >= 50 && hasMore ? <Button small kind="plain" title={t('earlier')} onPress={older} /> : msgs?.length === 0 ? <T muted>{t('noMessages')}</T> : null
          }
          renderItem={({ item: m }) => {
            const mine = m.sender?.id === meId;
            return (
              <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
                <Card style={{ padding: 10, backgroundColor: mine ? c.chip : c.card }}>
                  {!mine && m.sender && (
                    <T bold size={13} color={c.primary}>
                      {m.sender.firstName} {m.sender.lastName}
                    </T>
                  )}
                  {m.text ? <T>{m.text}</T> : null}
                  <FileView files={m.files} />
                  <T muted size={11} style={{ alignSelf: 'flex-end' }}>
                    {fmtDay(m.createdAt, locale)} {fmtTime(m.createdAt)}
                  </T>
                </Card>
              </View>
            );
          }}
        />
      )}
      <View style={{ padding: 8, gap: 6, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.card }}>
        {gone ? <T color={c.warn}>{t('chatGone')}</T> : <ErrorBox error={err} />}
        {!gone && attach && <Attachments files={files} onChange={setFiles} onAudio={() => {}} />}
        <Row style={{ flexWrap: 'nowrap' }}>
          <Button small kind="plain" title={attach ? '✕' : '📎'} onPress={() => setAttach(!attach)} />
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={t('message')}
            placeholderTextColor={c.muted}
            multiline
            style={{ flex: 1, maxHeight: 120, borderWidth: 1, borderColor: c.border, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8, color: c.text }}
          />
          <Button small title="➤" onPress={send} disabled={gone || busy || (!text.trim() && !files.length)} />
        </Row>
      </View>
    </KeyboardAvoidingView>
  );
}
