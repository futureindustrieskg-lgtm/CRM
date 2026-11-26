/** Вход, уведомления (колокольчик), профиль: роль, язык, push, выход. */
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';
import { api, Profile, Role } from '../api';
import { fmtDay, fmtTime, Locale, LOCALES, useI18n } from '../i18n';
import { Button, Card, ErrorBox, Loading, Row, Screen, T, Title, useColors } from '../ui';
import { useLoad } from '../useLoad';

export function LoginScreen({ onLogin }: { onLogin: (login: string, password: string) => Promise<void> }) {
  const { t, locale, setLocale } = useI18n();
  const c = useColors();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const input = { borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 12, color: c.text, backgroundColor: c.card, fontSize: 16 } as const;
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onLogin(login.trim(), password);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: c.bg, justifyContent: 'center', padding: 24 }}>
      <View style={{ gap: 12, maxWidth: 420, width: '100%', alignSelf: 'center' }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <T bold size={24}>
            {t('appName')}
          </T>
          <Row>
            {(Object.keys(LOCALES) as Locale[]).map((l) => (
              <Button key={l} small kind={l === locale ? 'primary' : 'plain'} title={LOCALES[l]} onPress={() => setLocale(l)} />
            ))}
          </Row>
        </Row>
        <TextInput
          style={input}
          value={login}
          onChangeText={setLogin}
          placeholder={t('loginHint')}
          placeholderTextColor={c.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="username"
          accessibilityLabel={t('login')}
        />
        <TextInput
          style={input}
          value={password}
          onChangeText={setPassword}
          placeholder={t('password')}
          placeholderTextColor={c.muted}
          secureTextEntry
          textContentType="password"
          onSubmitEditing={submit}
          accessibilityLabel={t('password')}
        />
        <ErrorBox error={err} />
        <Button title={t('signIn')} onPress={submit} disabled={busy || !login.trim() || !password} />
      </View>
    </KeyboardAvoidingView>
  );
}

interface Inbox {
  items: { id: string; title: string; body: string; createdAt: string; readAt: string | null }[];
  unread: number;
}

export function InboxScreen({ onRead }: { onRead?: () => void }) {
  const { t, locale } = useI18n();
  const c = useColors();
  const q = useLoad<Inbox>('inbox', () => api<Inbox>('/notifications/inbox'));
  if (q.loading && !q.data) return <Loading />;
  const readAll = async () => {
    await api('/notifications/inbox/read', { method: 'POST', body: {} }).catch(() => {});
    await q.reload();
    onRead?.();
  };
  return (
    <Screen refreshing={q.loading} onRefresh={q.reload}>
      <ErrorBox error={q.error} onRetry={q.reload} />
      {!!q.data?.unread && <Button small kind="plain" title={t('markRead')} onPress={readAll} />}
      {q.data?.items.length === 0 && <T muted>{t('noData')}</T>}
      {q.data?.items.map((n) => (
        <Card key={n.id} style={n.readAt ? undefined : { borderColor: c.primary }}>
          <T bold>{n.title}</T>
          <T>{n.body}</T>
          <T muted size={12}>
            {fmtDay(n.createdAt, locale)} {fmtTime(n.createdAt)}
          </T>
        </Card>
      ))}
    </Screen>
  );
}

export function ProfileScreen({
  profile,
  role,
  pushState,
  onRole,
  onLogout,
}: {
  profile: Profile;
  role: Role;
  pushState: string | null | undefined;
  onRole: (r: Role) => void;
  onLogout: () => void;
}) {
  const { t, locale, setLocale } = useI18n();
  const c = useColors();
  return (
    <Screen>
      <Card>
        <Title>
          {profile.firstName} {profile.lastName}
        </Title>
        <T muted>
          {role.name}
          {role.branchName ? ` · ${role.branchName}` : ''}
        </T>
      </Card>
      {profile.roles.length > 1 && (
        <Card>
          <T bold>{t('role')}</T>
          {profile.roles.map((r) => (
            <Button key={r.id} small kind={r.id === role.id ? 'primary' : 'plain'} title={`${r.name}${r.branchName ? ` · ${r.branchName}` : ''}`} onPress={() => onRole(r)} />
          ))}
        </Card>
      )}
      <Card>
        <T bold>{t('language')}</T>
        <Row>
          {(Object.keys(LOCALES) as Locale[]).map((l) => (
            <Button key={l} small kind={l === locale ? 'primary' : 'plain'} title={LOCALES[l]} onPress={() => setLocale(l)} />
          ))}
        </Row>
      </Card>
      <Card>
        <T bold>{t('push')}</T>
        <T color={pushState === null ? c.ok : c.muted}>{pushState === undefined ? '…' : pushState === null ? t('pushOn') : t(`push.${pushState}`)}</T>
      </Card>
      <Button kind="danger" title={t('logout')} onPress={onLogout} />
    </Screen>
  );
}
