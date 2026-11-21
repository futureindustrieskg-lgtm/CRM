/** Файлы в интерфейсе: просмотр (фото, аудио, документы), загрузка и запись голоса. */
import { useEffect, useRef, useState } from 'react';
import { FileRef, fileBlobUrl, uploadFile } from './api';
import { useI18n } from './i18n';
import { ErrorText } from './ui';

/** Публичные медиа теста (по ссылке) открываются напрямую, остальные — через API с авторизацией. */
function useFileUrl(f: FileRef, publicToken?: string) {
  const [url, setUrl] = useState<string | null>(publicToken ? `/api/v1/public/files/${f.id}?a=${encodeURIComponent(publicToken)}` : null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (publicToken) return;
    let revoked = false;
    let made: string | null = null;
    fileBlobUrl(f.id)
      .then((u) => {
        made = u;
        if (!revoked) setUrl(u);
      })
      .catch(setError);
    return () => {
      revoked = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [f.id, publicToken]);
  return { url, error };
}

export function FileView({ file, publicToken }: { file: FileRef; publicToken?: string }) {
  const { url, error } = useFileUrl(file, publicToken);
  if (error) return <span className="muted">⚠ {file.name}</span>;
  if (!url) return <span className="muted">… {file.name}</span>;
  if (file.mime.startsWith('image/')) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="file-thumb" title={file.name}>
        <img src={url} alt={file.name} />
      </a>
    );
  }
  if (file.mime.startsWith('audio/')) {
    return (
      <div className="file-audio">
        <audio controls preload="metadata" src={url} />
        <span className="muted">{file.name}</span>
      </div>
    );
  }
  return (
    <a className="btn small" href={url} download={file.name} target="_blank" rel="noreferrer">
      📄 {file.name}
    </a>
  );
}

export function FileList({ files, publicToken }: { files?: FileRef[]; publicToken?: string }) {
  if (!files?.length) return null;
  return (
    <div className="file-list">
      {files.map((f) => (
        <FileView key={f.id} file={f} publicToken={publicToken} />
      ))}
    </div>
  );
}

const ACCEPT = 'image/*,audio/*,application/pdf,.doc,.docx,.txt';

/** Выбор и загрузка файлов: возвращает прикреплённые (id), можно убрать до отправки. */
export function FilePicker({
  value,
  onChange,
  accept = ACCEPT,
  capture,
}: {
  value: FileRef[];
  onChange: (v: FileRef[]) => void;
  accept?: string;
  /** На телефоне открыть камеру сразу (фото тетради). */
  capture?: boolean;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const input = useRef<HTMLInputElement>(null);
  async function pick(list: FileList | null) {
    if (!list?.length) return;
    setBusy(true);
    setError(null);
    try {
      const added: FileRef[] = [];
      for (const f of Array.from(list)) added.push(await uploadFile(f, f.name));
      onChange([...value, ...added]);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }
  return (
    <div>
      <div className="row" style={{ gap: 6 }}>
        {value.map((f) => (
          <span key={f.id} className="badge">
            {f.mime.startsWith('audio/') ? '🎙' : f.mime.startsWith('image/') ? '🖼' : '📄'} {f.name}{' '}
            <button type="button" className="small" style={{ border: 0, padding: 0 }} onClick={() => onChange(value.filter((x) => x.id !== f.id))} aria-label={`✕ ${f.name}`}>
              ✕
            </button>
          </span>
        ))}
        <label className="btn small" style={{ margin: 0, color: 'var(--text)' }}>
          {busy ? '…' : `📎 ${t('attach')}`}
          <input
            ref={input}
            type="file"
            multiple
            accept={accept}
            {...(capture ? { capture: 'environment' } : {})}
            hidden
            disabled={busy}
            onChange={(e) => pick(e.target.files)}
          />
        </label>
      </div>
      <ErrorText error={error} />
    </div>
  );
}

/** Запись голоса в браузере (MediaRecorder): ответ Sprechen или голосовой комментарий; автостоп по лимиту. */
export function VoiceRecorder({ maxSeconds = 300, onRecorded }: { maxSeconds?: number; onRecorded: (f: FileRef, seconds: number) => void }) {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'rec' | 'upload'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const timer = useRef<number>();
  const started = useRef(0);

  useEffect(() => () => {
    window.clearInterval(timer.current);
    rec.current?.stream.getTracks().forEach((tr) => tr.stop());
  }, []);

  async function start() {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError(new Error(t('noMic')));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((tr) => tr.stop());
        window.clearInterval(timer.current);
        const dur = Math.round((Date.now() - started.current) / 1000);
        const type = mr.mimeType || 'audio/webm';
        setState('upload');
        try {
          const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
          const f = await uploadFile(new Blob(chunks, { type }), `${t('voice')} ${new Date().toLocaleTimeString('ru-RU')}.${ext}`);
          onRecorded(f, Math.min(dur, maxSeconds));
        } catch (e) {
          setError(e);
        } finally {
          setState('idle');
        }
      };
      rec.current = mr;
      started.current = Date.now();
      setSeconds(0);
      mr.start();
      setState('rec');
      timer.current = window.setInterval(() => {
        const s = Math.round((Date.now() - started.current) / 1000);
        setSeconds(s);
        if (s >= maxSeconds && mr.state === 'recording') mr.stop();
      }, 250);
    } catch (e) {
      setError(e);
    }
  }

  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return (
    <div className="row" style={{ gap: 8 }}>
      {state === 'rec' ? (
        <button type="button" className="danger" onClick={() => rec.current?.stop()}>
          ■ {t('stop')} {mmss(seconds)} / {mmss(maxSeconds)}
        </button>
      ) : (
        <button type="button" onClick={start} disabled={state === 'upload'}>
          🎙 {state === 'upload' ? '…' : t('recordVoice')}
        </button>
      )}
      <ErrorText error={error} />
    </div>
  );
}
