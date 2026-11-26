import { FormEvent, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { LOCALES, Locale, useI18n } from './i18n';
import { AuditPage, BranchesPage, RolesPage, UsersPage } from './pages/Admin';
import { CoursesPage, RoomsPage } from './pages/Courses';
import { DashboardPage } from './pages/Dashboard';
import { FinancePage } from './pages/Finance';
import { ChatPage, useChatUnread } from './pages/Chat';
import { CompanyPage, DocumentsPage } from './pages/Documents';
import { ReportsPage } from './pages/Reports';
import { GroupsPage } from './pages/Groups';
import { NotificationBell, NotificationsPage } from './pages/Notifications';
import { HomeworkPage } from './pages/Homework';
import { MyHomeworkPage } from './pages/MyHomework';
import { PublicAttemptPage, PublicTestPage } from './pages/TestRun';
import { TestsPage } from './pages/Tests';
import { PayrollPage } from './pages/Payroll';
import { LearningSettingsPage, TodayPage } from './pages/Journal';
import { LeadsPage, useBranches } from './pages/Leads';
import { setTimezone } from './tz';
import { SchedulePage } from './pages/Schedule';
import { StudentsPage } from './pages/Students';
import { TasksPage } from './pages/Tasks';
import { ErrorText } from './ui';

export function App() {
  const { me, loading } = useAuth();
  const loc = useLocation();
  // Тест по ссылке проходят без входа (лиды, гости).
  if (loc.pathname.startsWith('/test/a/')) return <Routes><Route path="/test/a/:token" element={<PublicAttemptPage />} /></Routes>;
  if (loc.pathname.startsWith('/test/')) return <Routes><Route path="/test/:token" element={<PublicTestPage />} /></Routes>;
  if (loading) return <div className="login-page muted">…</div>;
  if (!me) return <LoginPage />;
  return <Layout />;
}

function LoginPage() {
  const { login } = useAuth();
  const { t } = useI18n();
  const [form, setForm] = useState({ login: '', password: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(form.login, form.password);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="card" onSubmit={submit}>
        <div className="row" style={{ marginBottom: 20 }}>
          <h1 style={{ margin: 0, flex: 1 }}>{t('appName')}</h1>
          <LocaleSwitch />
        </div>
        <div className="field">
          <label>{t('loginField')}</label>
          <input autoFocus value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} />
        </div>
        <div className="field">
          <label>{t('password')}</label>
          <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </div>
        <ErrorText error={error} />
        <button className="primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
          {t('signIn')}
        </button>
      </form>
    </div>
  );
}

function LocaleSwitch() {
  const { locale, setLocale } = useI18n();
  return (
    <select style={{ width: 'auto' }} value={locale} onChange={(e) => setLocale(e.target.value as Locale)} aria-label="Language">
      {Object.entries(LOCALES).map(([k, v]) => (
        <option key={k} value={k}>
          {v}
        </option>
      ))}
    </select>
  );
}

function Layout() {
  const { me, activeRole, can, logout, switchRole } = useAuth();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // Время в интерфейсе — по часовому поясу филиала активной роли.
  const branches = useBranches();
  setTimezone((branches.data?.find((b) => b.id === activeRole?.branchId) ?? branches.data?.[0])?.timezone);

  const chatUnread = useChatUnread(can('messages.read'));
  const nav: { to: string; label: string; show: boolean; badge?: number }[] = [
    { to: '/', label: t('dashboard'), show: activeRole?.code !== 'student' },
    { to: '/leads', label: t('leads'), show: can('leads.read') },
    { to: '/tasks', label: t('tasks'), show: can('leads.read') },
    { to: '/students', label: t('students'), show: can('students.read') },
    { to: '/today', label: t('myLessons'), show: can('attendance.create') },
    { to: '/my/homework', label: t('myHomework'), show: activeRole?.code === 'student' },
    { to: '/schedule', label: t('schedule'), show: can('schedule.read') },
    { to: '/homework', label: t('homework'), show: can('homework.create') },
    { to: '/tests', label: t('testsTitle'), show: can('homework.create') },
    { to: '/chat', label: t('chat'), show: can('messages.read'), badge: chatUnread.data?.unread },
    { to: '/groups', label: t('groups'), show: can('groups.read') },
    { to: '/courses', label: t('courses'), show: can('groups.read') },
    { to: '/finance', label: t('finance'), show: can('finance.read') },
    { to: '/reports', label: t('reports'), show: can('reports.read') },
    { to: '/documents', label: t('documentsTitle'), show: can('documents.read') },
    { to: '/payroll', label: can('finance.salaries') ? t('payroll') : t('myPayroll'), show: can('finance.salaries') || can('attendance.create') },
  ];
  const admin = [
    { to: '/users', label: t('users'), show: can('users.read') },
    { to: '/roles', label: t('roles'), show: can('roles.read') },
    { to: '/branches', label: t('branches'), show: can('branches.read') || can('branches.update') },
    { to: '/rooms', label: t('rooms'), show: can('schedule.update') },
    { to: '/learning-rules', label: t('learningRules'), show: can('branches.update') },
    { to: '/notifications', label: t('notifications'), show: can('messages.update') },
    { to: '/company', label: t('companyTitle'), show: can('branches.update') },
    { to: '/audit', label: t('audit'), show: can('audit.read') },
  ].filter((n) => n.show);

  return (
    <div className="layout">
      <aside className={`sidebar ${open ? 'open' : ''}`} onClick={() => setOpen(false)}>
        <div className="brand">
          <span className="logo">DE</span> {t('appName')}
        </div>
        {nav.filter((n) => n.show).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'}>
            {n.label}
            {!!n.badge && <span className="count-badge">{n.badge}</span>}
          </NavLink>
        ))}
        {admin.length > 0 && <div className="section">{t('settings')}</div>}
        {admin.map((n) => (
          <NavLink key={n.to} to={n.to}>
            {n.label}
          </NavLink>
        ))}
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="menu-btn" onClick={() => setOpen(!open)} aria-label="Menu">
            ☰
          </button>
          <div className="spacer" />
          {me!.roles.length > 1 ? (
            <select
              style={{ width: 'auto', maxWidth: 280 }}
              value={activeRole?.id}
              onChange={(e) => switchRole(e.target.value)}
              title={t('role')}
            >
              {me!.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {r.branchName ?? t('allBranches')}
                </option>
              ))}
            </select>
          ) : (
            <span className="muted hide-mobile">
              {activeRole?.name} · {activeRole?.branchName ?? t('allBranches')}
            </span>
          )}
          <NotificationBell />
          <LocaleSwitch />
          <span className="hide-mobile">
            {me!.firstName} {me!.lastName}
          </span>
          <button onClick={logout}>{t('logout')}</button>
        </header>
        <main className="content">
          <Routes>
            <Route path="/" element={activeRole?.code === 'student' ? <Navigate to="/my/homework" /> : <DashboardPage />} />
            <Route path="/my/homework" element={<MyHomeworkPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/documents" element={<DocumentsPage />} />
            <Route path="/company" element={<CompanyPage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/chat/:id" element={<ChatPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/homework" element={<HomeworkPage />} />
            <Route path="/homework/:id" element={<HomeworkPage />} />
            <Route path="/tests" element={<TestsPage />} />
            <Route path="/tests/:id" element={<TestsPage />} />
            <Route path="/leads" element={<LeadsPage />} />
            <Route path="/leads/:id" element={<LeadsPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/students" element={<StudentsPage />} />
            <Route path="/students/:id" element={<StudentsPage />} />
            <Route path="/today" element={<TodayPage />} />
            <Route path="/finance" element={<FinancePage />} />
            <Route path="/payroll" element={<PayrollPage />} />
            <Route path="/learning-rules" element={<LearningSettingsPage />} />
            <Route path="/schedule" element={<SchedulePage />} />
            <Route path="/groups" element={<GroupsPage />} />
            <Route path="/groups/:id" element={<GroupsPage />} />
            <Route path="/courses" element={<CoursesPage />} />
            <Route path="/rooms" element={<RoomsPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/roles" element={<RolesPage />} />
            <Route path="/branches" element={<BranchesPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
