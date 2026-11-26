/**
 * Мобильное приложение CRM (ТЗ 4): студент, родитель, преподаватель.
 * Набор вкладок зависит от активной роли; сотрудники офиса работают в веб-версии.
 */
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { api, currentSession, loadSession, login, logout, pickRole, Profile, Role, setActiveRole, setLogoutHandler } from './api';
import { I18nCtx, Locale, LOCALES, translate } from './i18n';
import { startAutoSync } from './offline';
import { registerForPush, unregisterPush } from './push';
import { HomeScreen, HomeworkScreen, ProgressScreen, ScheduleScreen } from './screens/Client';
import { InboxScreen, LoginScreen, ProfileScreen } from './screens/Common';
import { JournalScreen, TeacherLessonsScreen } from './screens/Teacher';
import { getJson, setJson } from './storage';
import { Card, Loading, Screen, T, useColors } from './ui';

type Tab = 'home' | 'schedule' | 'progress' | 'homework' | 'lessons' | 'inbox' | 'profile';

const TABS: Record<string, Tab[]> = {
  student: ['home', 'schedule', 'progress', 'homework', 'inbox', 'profile'],
  parent: ['home', 'schedule', 'progress', 'inbox', 'profile'],
  teacher: ['lessons', 'inbox', 'profile'],
};
const ICONS: Record<Tab, string> = { home: '🏠', schedule: '📅', progress: '📈', homework: '📝', lessons: '✅', inbox: '🔔', profile: '👤' };
const TAB_LABEL: Record<Tab, string> = { home: 'home', schedule: 'schedule', progress: 'progress', homework: 'homework', lessons: 'lessons', inbox: 'inbox', profile: 'profile' };

export default function App() {
  const [locale, setLocaleState] = useState<Locale>('ru');
  const [ready, setReady] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [roleId, setRoleId] = useState<string | undefined>();
  const [tab, setTab] = useState<Tab>('home');
  const [journal, setJournal] = useState<string | null>(null);
  const [pushState, setPushState] = useState<string | null | undefined>(undefined);
  const [unread, setUnread] = useState(0);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    setJson('crm.locale', l);
    if (currentSession()) api('/auth/locale', { method: 'POST', body: { locale: l } }).catch(() => {});
  }, []);
  const i18n = useMemo(() => ({ locale, setLocale, t: (k: string) => translate(locale, k) }), [locale, setLocale]);

  const reset = useCallback(() => {
    setProfile(null);
    setRoleId(undefined);
    setJournal(null);
  }, []);

  // Запуск: язык, сохранённая сессия, офлайн-очередь.
  useEffect(() => {
    setLogoutHandler(reset);
    const stop = startAutoSync();
    (async () => {
      const l = await getJson<Locale | null>('crm.locale', null);
      if (l && l in LOCALES) setLocaleState(l);
      const s = await loadSession();
      if (s) {
        try {
          const me = await api<Profile & { activeRoleId?: string }>('/auth/me');
          setProfile(me);
          setRoleId(s.activeRoleId ?? pickRole(me.roles)?.id);
        } catch {
          // Нет связи при запуске: остаёмся в сессии, профиль — из кэша.
          const cached = await getJson<Profile | null>('cache:profile', null);
          if (cached && currentSession()) {
            setProfile(cached);
            setRoleId(s.activeRoleId ?? pickRole(cached.roles)?.id);
          }
        }
      }
      setReady(true);
    })();
    return stop;
  }, [reset]);

  const role = profile?.roles.find((r) => r.id === roleId) ?? (profile ? pickRole(profile.roles) : undefined);
  const tabs = role ? TABS[role.code] ?? ['inbox', 'profile'] : [];
  // Вкладка, недоступная активной роли, не отрисовывается даже на мгновение (лишние запросы).
  const current: Tab = tabs.includes(tab) ? tab : tabs[0] ?? 'profile';

  useEffect(() => {
    if (!profile) return;
    setJson('cache:profile', profile);
    registerForPush().then(setPushState).catch(() => setPushState('no-project'));
  }, [profile]);

  useEffect(() => {
    if (tabs.length && !tabs.includes(tab)) setTab(tabs[0]);
  }, [role?.code]); // eslint-disable-line react-hooks/exhaustive-deps

  // Счётчик непрочитанных на вкладке «Сообщения».
  useEffect(() => {
    if (!profile) return;
    const load = () => api<{ unread: number }>('/notifications/inbox').then((r) => setUnread(r.unread)).catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [profile, roleId]);

  const doLogin = async (l: string, p: string) => {
    const me = await login(l, p);
    setProfile(me);
    setRoleId(currentSession()?.activeRoleId);
    setTab(TABS[pickRole(me.roles)?.code ?? '']?.[0] ?? 'inbox');
  };
  const doLogout = async () => {
    await unregisterPush();
    await logout();
    reset();
  };
  const changeRole = async (r: Role) => {
    await setActiveRole(r.id);
    setRoleId(r.id);
    setJournal(null);
    setTab((TABS[r.code] ?? ['inbox'])[0]);
  };

  return (
    <I18nCtx.Provider value={i18n}>
      <SafeAreaProvider>
        <Shell>
          {!ready ? (
            <Loading />
          ) : !profile || !role ? (
            <LoginScreen onLogin={doLogin} />
          ) : (
            <>
              <View style={{ flex: 1 }}>
                {journal ? (
                  <JournalScreen lessonId={journal} onBack={() => setJournal(null)} />
                ) : current === 'home' ? (
                  <HomeScreen key={role.id} />
                ) : current === 'schedule' ? (
                  <ScheduleScreen key={role.id} />
                ) : current === 'progress' ? (
                  <ProgressScreen key={role.id} />
                ) : current === 'homework' ? (
                  <HomeworkScreen />
                ) : current === 'lessons' ? (
                  <TeacherLessonsScreen onOpen={setJournal} />
                ) : current === 'inbox' ? (
                  <>
                    {!TABS[role.code] && <StaffNote />}
                    <InboxScreen onRead={() => setUnread(0)} />
                  </>
                ) : (
                  <ProfileScreen profile={profile} role={role} pushState={pushState} onRole={changeRole} onLogout={doLogout} />
                )}
              </View>
              <TabBar tabs={tabs} tab={journal ? 'lessons' : current} unread={unread} onChange={(x) => { setJournal(null); setTab(x); }} t={i18n.t} />
            </>
          )}
        </Shell>
      </SafeAreaProvider>
    </I18nCtx.Provider>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const c = useColors();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
      <StatusBar style="auto" />
      {children}
    </SafeAreaView>
  );
}

function StaffNote() {
  return (
    <Screen>
      <Card>
        <I18nCtx.Consumer>{({ t }) => <T>{t('staffUseWeb')}</T>}</I18nCtx.Consumer>
      </Card>
    </Screen>
  );
}

function TabBar({ tabs, tab, unread, onChange, t }: { tabs: Tab[]; tab: Tab; unread: number; onChange: (t: Tab) => void; t: (k: string) => string }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.card }}>
      {tabs.map((x) => (
        <Pressable key={x} onPress={() => onChange(x)} accessibilityRole="tab" accessibilityState={{ selected: x === tab }} style={{ flex: 1, alignItems: 'center', paddingVertical: 8 }}>
          <View>
            <Text style={{ fontSize: 20 }}>{ICONS[x]}</Text>
            {x === 'inbox' && unread > 0 && (
              <View style={{ position: 'absolute', top: -4, right: -12, backgroundColor: c.danger, borderRadius: 999, minWidth: 18, paddingHorizontal: 4, alignItems: 'center' }}>
                <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>{unread > 99 ? '99+' : unread}</Text>
              </View>
            )}
          </View>
          <Text numberOfLines={1} style={{ fontSize: 11, color: x === tab ? c.primary : c.muted, fontWeight: x === tab ? '700' : '400' }}>
            {t(TAB_LABEL[x])}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
