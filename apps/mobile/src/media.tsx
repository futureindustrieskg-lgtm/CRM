/**
 * Вложения ДЗ с телефона (ТЗ 3.6): фото тетради (камера / галерея), файл, голосовой ответ до 5 минут;
 * просмотр фото и прослушивание аудио из задания и ответа преподавателя.
 */
import { Audio } from 'expo-av';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useRef, useState } from 'react';
import { Image, Platform, Pressable, View } from 'react-native';
import { FileRef, fileSource, LocalFile, uploadFile } from './api';
import { useI18n } from './i18n';
import { Button, Chip, ErrorBox, Row, T, useColors } from './ui';

export const MAX_AUDIO_SECONDS = 300;
export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const extOf = (mime: string) => (mime.includes('png') ? 'png' : mime.includes('heic') ? 'heic' : mime.includes('webp') ? 'webp' : 'jpg');

/** Ответ из ImagePicker → файл для загрузки. */
function fromImage(a: ImagePicker.ImagePickerAsset): LocalFile {
  const mime = a.mimeType ?? 'image/jpeg';
  return { uri: a.uri, name: a.fileName ?? `Фото ${new Date().toLocaleTimeString('ru-RU').replace(/:/g, '-')}.${extOf(mime)}`, mime, blob: (a as { file?: Blob }).file };
}

/** Кнопки «Камера / Фото / Файл / Голос» и список уже загруженных вложений. */
export function Attachments({
  files,
  onChange,
  audioSeconds,
  onAudio,
}: {
  files: FileRef[];
  onChange: (f: FileRef[]) => void;
  audioSeconds?: number;
  onAudio: (seconds: number) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [recording, setRecording] = useState(false);

  const add = async (local: LocalFile[]) => {
    if (!local.length) return;
    setBusy(true);
    setErr(null);
    try {
      const up: FileRef[] = [];
      for (const f of local) up.push(await uploadFile(f));
      onChange([...files, ...up].slice(0, 10));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const camera = async () => {
    const p = await ImagePicker.requestCameraPermissionsAsync();
    if (!p.granted) return setErr(new Error(t('noCameraAccess')));
    const r = await ImagePicker.launchCameraAsync({ quality: 0.7, mediaTypes: ['images'] });
    if (!r.canceled) await add(r.assets.map(fromImage));
  };
  const gallery = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ quality: 0.7, mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: 5 });
    if (!r.canceled) await add(r.assets.map(fromImage));
  };
  const document = async () => {
    const r = await DocumentPicker.getDocumentAsync({ type: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'image/*', 'audio/*'], multiple: true });
    if (!r.canceled) await add(r.assets.map((a) => ({ uri: a.uri, name: a.name, mime: a.mimeType ?? 'application/octet-stream', blob: a.file })));
  };

  return (
    <View style={{ gap: 8 }}>
      <Row>
        {Platform.OS !== 'web' && <Button small kind="plain" title={`📷 ${t('camera')}`} onPress={camera} disabled={busy || recording} />}
        <Button small kind="plain" title={`🖼 ${t('photo')}`} onPress={gallery} disabled={busy || recording} />
        <Button small kind="plain" title={`📎 ${t('file')}`} onPress={document} disabled={busy || recording} />
      </Row>
      <VoiceRecorder
        disabled={busy}
        onState={setRecording}
        onDone={async (f, seconds) => {
          await add([f]);
          onAudio(seconds);
        }}
        onError={setErr}
      />
      {busy && <T muted>{t('uploading')}</T>}
      {audioSeconds ? <T muted>🎙 {mmss(audioSeconds)} / {mmss(MAX_AUDIO_SECONDS)}</T> : null}
      {files.length > 0 && (
        <Row>
          {files.map((f) => (
            <Pressable key={f.id} onPress={() => onChange(files.filter((x) => x.id !== f.id))} accessibilityLabel={`${t('remove')} ${f.name}`}>
              <Chip label={`${icon(f.mime)} ${f.name}  ✕`} />
            </Pressable>
          ))}
        </Row>
      )}
      <ErrorBox error={err} />
    </View>
  );
}

const icon = (mime: string) => (mime.startsWith('image/') ? '🖼' : mime.startsWith('audio/') ? '🎙' : '📄');

/** Запись голоса: автостоп через 5 минут (ограничение сервера для ответа Sprechen). */
function VoiceRecorder({
  disabled,
  onDone,
  onError,
  onState,
}: {
  disabled: boolean;
  onDone: (f: LocalFile, seconds: number) => Promise<void>;
  onError: (e: unknown) => void;
  onState: (rec: boolean) => void;
}) {
  const { t } = useI18n();
  const c = useColors();
  const rec = useRef<Audio.Recording | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [active, setActive] = useState(false);

  useEffect(() => () => void rec.current?.stopAndUnloadAsync().catch(() => {}), []);

  const stop = async () => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    setActive(false);
    onState(false);
    try {
      const st = await r.getStatusAsync();
      await r.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      const uri = r.getURI();
      if (!uri) return;
      const secs = Math.min(MAX_AUDIO_SECONDS, Math.round((st.durationMillis ?? seconds * 1000) / 1000));
      const web = Platform.OS === 'web';
      const mime = web ? 'audio/webm' : Platform.OS === 'ios' ? 'audio/x-m4a' : 'audio/mp4';
      const ext = web ? 'webm' : 'm4a';
      await onDone({ uri, mime, name: `${t('voiceAnswer')} ${new Date().toLocaleTimeString('ru-RU').replace(/:/g, '-')}.${ext}` }, secs);
    } catch (e) {
      onError(e);
    }
  };

  const start = async () => {
    try {
      const p = await Audio.requestPermissionsAsync();
      if (!p.granted) throw new Error(t('noMicAccess'));
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY, (s) => {
        const secs = Math.floor((s.durationMillis ?? 0) / 1000);
        setSeconds(secs);
        if (secs >= MAX_AUDIO_SECONDS) stop();
      }, 500);
      rec.current = recording;
      setSeconds(0);
      setActive(true);
      onState(true);
    } catch (e) {
      onError(e);
    }
  };

  return active ? (
    <Row>
      <T bold color={c.danger}>● {mmss(seconds)} / {mmss(MAX_AUDIO_SECONDS)}</T>
      <Button small title={`■ ${t('stop')}`} onPress={stop} />
    </Row>
  ) : (
    <Button small kind="plain" title={`🎙 ${t('recordVoice')}`} onPress={start} disabled={disabled} />
  );
}

/** Защищённое фото (задание, ответ преподавателя). */
export function RemoteImage({ id }: { id: string }) {
  const [src, setSrc] = useState<{ uri: string; headers?: Record<string, string> } | null>(null);
  useEffect(() => {
    let alive = true;
    fileSource(id).then((s) => alive && setSrc(s)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [id]);
  if (!src) return null;
  return <Image source={src} style={{ width: '100%', height: 220, borderRadius: 8 }} resizeMode="contain" />;
}

/** Проигрыватель аудио: из задания (по входу) или из теста (по ссылке попытки). */
export function AudioPlayer({ id, uri, name }: { id?: string; uri?: string; name: string }) {
  const { t } = useI18n();
  const sound = useRef<Audio.Sound | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [err, setErr] = useState<unknown>(null);

  useEffect(() => () => void sound.current?.unloadAsync().catch(() => {}), []);

  const toggle = async () => {
    try {
      setErr(null);
      if (!sound.current) {
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
        const src = uri ? { uri } : await fileSource(id!);
        const { sound: s } = await Audio.Sound.createAsync(src, { shouldPlay: true }, (st) => {
          if (!st.isLoaded) return;
          setPos(Math.floor(st.positionMillis / 1000));
          setPlaying(st.isPlaying);
          if (st.didJustFinish) s.setPositionAsync(0).catch(() => {});
        });
        sound.current = s;
        return;
      }
      const st = await sound.current.getStatusAsync();
      if (st.isLoaded && st.isPlaying) await sound.current.pauseAsync();
      else await sound.current.playAsync();
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <View style={{ gap: 4 }}>
      <Row>
        <Button small kind="plain" title={playing ? `❚❚ ${t('pause')}` : `▶ ${t('play')}`} onPress={toggle} />
        <T muted size={13}>
          {name} {pos ? `· ${mmss(pos)}` : ''}
        </T>
      </Row>
      <ErrorBox error={err} />
    </View>
  );
}

/** Файлы задания или ответа преподавателя: фото — показываем, аудио — проигрываем, остальное — название. */
export function FileView({ files }: { files: FileRef[] }) {
  if (!files.length) return null;
  return (
    <View style={{ gap: 6 }}>
      {files.map((f) =>
        f.mime.startsWith('image/') ? (
          <RemoteImage key={f.id} id={f.id} />
        ) : f.mime.startsWith('audio/') ? (
          <AudioPlayer key={f.id} id={f.id} name={f.name} />
        ) : (
          <T key={f.id} muted>
            📄 {f.name}
          </T>
        ),
      )}
    </View>
  );
}
