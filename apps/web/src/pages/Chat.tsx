/** Внутренний чат (ТЗ 3.8): группы, «студент — преподаватель», «клиент — администрация»; файлы и голосовые. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, FileRef } from '../api';
import { useAuth } from '../auth';
import { FileList, FilePicker, VoiceRecorder } from '../files';
import { useI18n } from '../i18n';
import { ErrorText, fmtDate, fmtTime, Modal } from '../ui';

interface Person {
  id: string;
  firstName: string;
  lastName: string;
}
interface Conv {
  id: string;
  type: 'group' | 'direct' | 'support';
  title: string | null;
  members: number;
  unread: number;
  lastMessageAt: string;
  last: { text: string | null; createdAt: string; sender: Person; _count: { files: number } } | null;
}
interface Msg {
  id: string;
  text: string | null;
  createdAt: string;
  sender: Person;
  files: FileRef[];
}

export function useChatUnread(enabled: boolean) {
  return useQuery({ queryKey: ['chatUnread'], queryFn: () => api<{ unread: number }>('/chat/unread'), enabled, refetchInterval: 15_000 });
}

function convTitle(c: Conv, t: (k: string) => string) {
  if (c.type === 'support' && !c.title) return t('supportChat');
  return c.title ?? '—';
}

export function ChatPage() {
  const { t } = useI18n();
  const { id } = useParams();
  const nav = useNavigate();
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ['convs'], queryFn: () => api<Conv[]>('/chat/conversations'), refetchInterval: 10_000 });
  const current = list.data?.find((c) => c.id === id);
  return (
    <div className={`chat ${id ? 'has-open' : ''}`}>
      <aside className="chat-list">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <h1 style={{ margin: 0 }}>{t('chat')}</h1>
          <button className="small primary" onClick={() => setCreating(true)}>
            + {t('newChat')}
          </button>
        </div>
        <ErrorText error={list.error} />
        {list.data?.map((c) => (
          <button key={c.id} className={`chat-item ${c.id === id ? 'on' : ''}`} onClick={() => nav(`/chat/${c.id}`)}>
            <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
              <b className="ellipsis">
                {c.type === 'group' ? '👥 ' : c.type === 'support' ? '🏢 ' : '👤 '}
                {convTitle(c, t)}
              </b>
              {c.unread > 0 && <span className="count-badge static">{c.unread}</span>}
            </div>
            <div className="muted ellipsis" style={{ fontSize: 12 }}>
              {c.last ? `${c.last.sender.firstName}: ${c.last.text ?? (c.last._count.files ? '📎' : '')}` : t('noMessages')}
            </div>
          </button>
        ))}
        {list.data?.length === 0 && <div className="muted">{t('noChats')}</div>}
      </aside>
      <section className="chat-view">
        {id ? (
          <Conversation id={id} title={current ? convTitle(current, t) : '…'} onBack={() => nav('/chat')} />
        ) : (
          <div className="muted" style={{ padding: 24 }}>
            {t('chooseChat')}
          </div>
        )}
      </section>
      {creating && <NewChatModal onClose={() => setCreating(false)} onOpen={(cid) => nav(`/chat/${cid}`)} />}
    </div>
  );
}

function Conversation({ id, title, onBack }: { id: string; title: string; onBack: () => void }) {
  const { t } = useI18n();
  const { me } = useAuth();
  const qc = useQueryClient();
  const msgs = useQuery({ queryKey: ['msgs', id], queryFn: () => api<Msg[]>(`/chat/conversations/${id}/messages`), refetchInterval: 5_000 });
  const [text, setText] = useState('');
  const [files, setFiles] = useState<FileRef[]>([]);
  const bottom = useRef<HTMLDivElement>(null);
  const read = useMutation({
    mutationFn: () => api(`/chat/conversations/${id}/read`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['convs'] });
      qc.invalidateQueries({ queryKey: ['chatUnread'] });
    },
  });
  const count = msgs.data?.length ?? 0;
  const lastId = msgs.data?.[count - 1]?.id;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
    if (lastId) read.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, lastId]);
  const send = useMutation({
    mutationFn: (fileIds?: string[]) => api<Msg>(`/chat/conversations/${id}/messages`, { method: 'POST', body: { text: text || undefined, fileIds: fileIds ?? files.map((f) => f.id) } }),
    onSuccess: () => {
      setText('');
      setFiles([]);
      qc.invalidateQueries({ queryKey: ['msgs', id] });
      qc.invalidateQueries({ queryKey: ['convs'] });
    },
  });
  let lastDay = '';
  return (
    <>
      <div className="chat-head">
        <button className="small chat-back" onClick={onBack} aria-label={t('back')}>
          ←
        </button>
        <b>{title}</b>
      </div>
      <div className="chat-msgs">
        <ErrorText error={msgs.error} />
        {msgs.data?.map((m) => {
          const day = fmtDate(m.createdAt, false);
          const sep = day !== lastDay;
          lastDay = day;
          const mine = m.sender.id === me?.id;
          return (
            <div key={m.id}>
              {sep && <div className="chat-day">{day}</div>}
              <div className={`msg ${mine ? 'mine' : ''}`}>
                {!mine && <div className="who">{m.sender.firstName} {m.sender.lastName}</div>}
                {m.text && <div className="txt">{m.text}</div>}
                <FileList files={m.files} />
                <div className="time">{fmtTime(m.createdAt)}</div>
              </div>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>
      <form
        className="chat-compose"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() || files.length) send.mutate(undefined);
        }}
      >
        <ErrorText error={send.error} />
        {files.length > 0 && <FilePicker value={files} onChange={setFiles} />}
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <textarea
            rows={1}
            placeholder={t('writeMessage')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (text.trim() || files.length) send.mutate(undefined);
              }
            }}
          />
          <button className="primary" disabled={send.isPending || (!text.trim() && !files.length)} aria-label={t('send')}>
            ➤
          </button>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {files.length === 0 && <FilePicker value={files} onChange={setFiles} />}
          {/* Голосовое отправляется сразу после записи. */}
          <VoiceRecorder maxSeconds={300} onRecorded={(f) => send.mutate([f.id])} />
        </div>
      </form>
    </>
  );
}

function NewChatModal({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const contacts = useQuery({ queryKey: ['chatContacts'], queryFn: () => api<{ users: (Person & { hint: string })[]; support: boolean }>('/chat/contacts') });
  const open = useMutation({
    mutationFn: (userId?: string) =>
      userId ? api<{ id: string }>('/chat/direct', { method: 'POST', body: { userId } }) : api<{ id: string }>('/chat/support', { method: 'POST' }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['convs'] });
      onClose();
      onOpen(c.id);
    },
  });
  const uniq = [...new Map((contacts.data?.users ?? []).map((u) => [u.id, u])).values()];
  return (
    <Modal title={t('newChat')} onClose={onClose}>
      <ErrorText error={contacts.error ?? open.error} />
      {contacts.data?.support && (
        <button className="chat-item" onClick={() => open.mutate(undefined)}>
          🏢 <b>{t('supportChat')}</b>
          <div className="muted" style={{ fontSize: 12 }}>
            {t('supportHint')}
          </div>
        </button>
      )}
      {uniq.map((u) => (
        <button key={u.id} className="chat-item" onClick={() => open.mutate(u.id)}>
          👤 <b>
            {u.firstName} {u.lastName}
          </b>
          <div className="muted" style={{ fontSize: 12 }}>
            {u.hint}
          </div>
        </button>
      ))}
      {contacts.data && !uniq.length && !contacts.data.support && <div className="muted">{t('noContacts')}</div>}
    </Modal>
  );
}
