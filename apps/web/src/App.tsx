import { FormEvent, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { LOCALES, Locale, useI18n } from './i18n';
import { AuditPage, BranchesPage, RolesPage, UsersPage } from './pages/Admin';
import { DashboardPage } from './pages/Dashboard';
import { LeadsPage } from './pages/Leads';
import { StudentsPage } from './pages/Students';
import { TasksPage } from './pages/Tasks';
import { ErrorText } from './ui';

export function App() {
  const { me, loading } = useAuth();
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

  const nav = [
    { to: '/', label: t('dashboard'), show: true },
    { to: '/leads', label: t('leads'), show: can('leads.read') },
    { to: '/tasks', label: t('tasks'), show: can('leads.read') },
    { to: '/students', label: t('students'), show: can('students.read') },
  ];
  const admin = [
    { to: '/users', label: t('users'), show: can('users.read') },
    { to: '/roles', label: t('roles'), show: can('roles.read') },
    { to: '/branches', label: t('branches'), show: can('branches.read') || can('branches.update') },
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
          <LocaleSwitch />
          <span className="hide-mobile">
            {me!.firstName} {me!.lastName}
          </span>
          <button onClick={logout}>{t('logout')}</button>
        </header>
        <main className="content">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/leads" element={<LeadsPage />} />
            <Route path="/leads/:id" element={<LeadsPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/students" element={<StudentsPage />} />
            <Route path="/students/:id" element={<StudentsPage />} />
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
