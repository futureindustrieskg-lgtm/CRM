import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { ErrorText, Field, fmtDate, fmtPhone, Modal } from '../ui';
import { useBranches } from './Leads';

interface Role {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  _count: { users: number };
}

interface Catalog {
  modules: { code: string; name: string }[];
  actions: string[];
  special: { code: string; name: string }[];
}

const useRoles = () => useQuery({ queryKey: ['roles'], queryFn: () => api<Role[]>('/roles') });

// ───────────── Роли и права ─────────────

export function RolesPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const roles = useRoles();
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: () => api<Catalog>('/roles/catalog'), staleTime: Infinity });
  const [edit, setEdit] = useState<Role | 'new' | null>(null);

  return (
    <>
      <div className="toolbar">
        <h1 style={{ margin: 0, marginRight: 'auto' }}>{t('roles')}</h1>
        {can('roles.create') && (
          <button className="primary" onClick={() => setEdit('new')}>
            + {t('newRole')}
          </button>
        )}
      </div>
      <ErrorText error={roles.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('name')}</th>
              <th>{t('code')}</th>
              <th>{t('permissions')}</th>
              <th>{t('users')}</th>
            </tr>
          </thead>
          <tbody>
            {roles.data?.map((r) => (
              <tr key={r.id} className="click" onClick={() => setEdit(r)}>
                <td>
                  {r.name} {r.isSystem && <span className="badge">{t('systemRole')}</span>}
                </td>
                <td className="muted">{r.code}</td>
                <td>{r.permissions.includes('*') ? 'все' : r.permissions.length}</td>
                <td>{r._count.users}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && catalog.data && <RoleEditor role={edit === 'new' ? null : edit} catalog={catalog.data} onClose={() => setEdit(null)} />}
    </>
  );
}

function RoleEditor({ role, catalog, onClose }: { role: Role | null; catalog: Catalog; onClose: () => void }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [name, setName] = useState(role?.name ?? '');
  const [code, setCode] = useState(role?.code ?? '');
  const [perms, setPerms] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const isOwner = role?.code === 'owner';
  const editable = !isOwner && (role ? can('roles.update') : can('roles.create'));

  const toggle = (p: string) => {
    const n = new Set(perms);
    n.has(p) ? n.delete(p) : n.add(p);
    setPerms(n);
  };

  const save = useMutation({
    mutationFn: () =>
      role
        ? api(`/roles/${role.id}`, { method: 'PATCH', body: { name, permissions: [...perms] } })
        : api('/roles', { method: 'POST', body: { name, code, permissions: [...perms] } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['roles'] });
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/roles/${role!.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['roles'] });
      onClose();
    },
  });

  return (
    <Modal title={role ? role.name : t('newRole')} onClose={onClose} wide>
      <div className="grid2">
        <Field label={t('name')}>
          <input value={name} disabled={!editable} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('code')}>
          <input value={code} disabled={!!role} onChange={(e) => setCode(e.target.value.replace(/[^a-z0-9_]/g, ''))} placeholder="methodist" />
        </Field>
      </div>
      {isOwner ? (
        <p className="muted">Владелец имеет все права.</p>
      ) : (
        <>
          <div className="table-wrap" style={{ marginBottom: 12 }}>
            <table className="matrix">
              <thead>
                <tr>
                  <th>{t('module')}</th>
                  {catalog.actions.map((a) => (
                    <th key={a}>{t(`act.${a}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {catalog.modules.map((m) => (
                  <tr key={m.code}>
                    <td>{m.name}</td>
                    {catalog.actions.map((a) => (
                      <td key={a}>
                        <input
                          type="checkbox"
                          disabled={!editable}
                          checked={perms.has(`${m.code}.${a}`)}
                          onChange={() => toggle(`${m.code}.${a}`)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {catalog.special.map((s) => (
            <label key={s.code} style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text)', fontSize: 14 }}>
              <input type="checkbox" style={{ width: 'auto' }} disabled={!editable} checked={perms.has(s.code)} onChange={() => toggle(s.code)} />
              {s.name}
            </label>
          ))}
        </>
      )}
      <ErrorText error={save.error ?? remove.error} />
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        {role && !role.isSystem && can('roles.delete') && (
          <button className="danger" style={{ marginRight: 'auto' }} onClick={() => confirm('Удалить роль?') && remove.mutate()}>
            Удалить
          </button>
        )}
        <button onClick={onClose}>{t('close')}</button>
        {editable && (
          <button className="primary" disabled={!name || (!role && !code)} onClick={() => save.mutate()}>
            {t('save')}
          </button>
        )}
      </div>
    </Modal>
  );
}

// ───────────── Сотрудники ─────────────

interface UserRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  lastLoginAt: string | null;
  roles: { id: string; branchId: string | null; role: { id: string; code: string; name: string } }[];
}

export function UsersPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserRow[]>('/users') });
  const branches = useBranches();
  const [edit, setEdit] = useState<UserRow | 'new' | null>(null);
  const bname = (id: string | null) => (id ? branches.data?.find((b) => b.id === id)?.name ?? '…' : t('allBranches'));

  return (
    <>
      <div className="toolbar">
        <h1 style={{ margin: 0, marginRight: 'auto' }}>{t('users')}</h1>
        {can('users.create') && (
          <button className="primary" onClick={() => setEdit('new')}>
            + {t('add')}
          </button>
        )}
      </div>
      <ErrorText error={users.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('name')}</th>
              <th>{t('email')}</th>
              <th>{t('phone')}</th>
              <th>{t('roles')}</th>
              <th>{t('active')}</th>
              <th>Последний вход</th>
            </tr>
          </thead>
          <tbody>
            {users.data?.map((u) => (
              <tr key={u.id} className="click" onClick={() => can('users.update') && setEdit(u)}>
                <td>
                  {u.lastName} {u.firstName}
                </td>
                <td>{u.email ?? '—'}</td>
                <td>{fmtPhone(u.phone)}</td>
                <td style={{ whiteSpace: 'normal' }}>
                  {u.roles.map((r) => (
                    <div key={r.id}>
                      {r.role.name} <span className="muted">· {bname(r.branchId)}</span>
                    </div>
                  ))}
                </td>
                <td>{u.isActive ? t('yes') : <span className="neg">{t('no')}</span>}</td>
                <td className="muted">{fmtDate(u.lastLoginAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <UserModal user={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function UserModal({ user, onClose }: { user: UserRow | null; onClose: () => void }) {
  const { t } = useI18n();
  const { activeRole } = useAuth();
  const qc = useQueryClient();
  const roles = useRoles();
  const branches = useBranches();
  const [form, setForm] = useState({
    firstName: user?.firstName ?? '',
    lastName: user?.lastName ?? '',
    email: user?.email ?? '',
    phone: user?.phone ?? '',
    password: '',
    isActive: user?.isActive ?? true,
  });
  const [ur, setUr] = useState<{ roleId: string; branchId: string | null }[]>(
    user?.roles.map((r) => ({ roleId: r.role.id, branchId: r.branchId })) ?? [{ roleId: '', branchId: activeRole?.branchId ?? null }],
  );

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email || undefined,
        phone: form.phone || undefined,
        password: form.password || undefined,
        roles: ur.filter((r) => r.roleId),
      };
      if (user) body.isActive = form.isActive;
      return user ? api(`/users/${user.id}`, { method: 'PATCH', body }) : api('/users', { method: 'POST', body });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['staff'] });
      onClose();
    },
  });

  return (
    <Modal title={user ? `${user.lastName} ${user.firstName}` : t('users')} onClose={onClose}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid2">
          <Field label={t('firstName')}>
            <input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
          </Field>
          <Field label={t('lastName')}>
            <input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
          </Field>
          <Field label={t('email')}>
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label={t('phone')}>
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
          <Field label={user ? 'Новый пароль (не менее 8 символов)' : t('password') + ' (не менее 8 символов)'}>
            <input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
          {user && (
            <Field label={t('active')}>
              <select value={form.isActive ? '1' : ''} onChange={(e) => setForm({ ...form, isActive: !!e.target.value })}>
                <option value="1">{t('yes')}</option>
                <option value="">{t('no')}</option>
              </select>
            </Field>
          )}
        </div>
        <h3>{t('roles')}</h3>
        {ur.map((r, i) => (
          <div key={i} className="row" style={{ marginBottom: 6, flexWrap: 'nowrap' }}>
            <select value={r.roleId} onChange={(e) => setUr(ur.map((x, j) => (j === i ? { ...x, roleId: e.target.value } : x)))}>
              <option value="">—</option>
              {roles.data?.map((ro) => (
                <option key={ro.id} value={ro.id}>
                  {ro.name}
                </option>
              ))}
            </select>
            <select
              value={r.branchId ?? ''}
              disabled={!!activeRole?.branchId}
              onChange={(e) => setUr(ur.map((x, j) => (j === i ? { ...x, branchId: e.target.value || null } : x)))}
            >
              <option value="">{t('allBranches')}</option>
              {branches.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => setUr(ur.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
        <button type="button" className="small" onClick={() => setUr([...ur, { roleId: '', branchId: activeRole?.branchId ?? null }])}>
          + роль
        </button>
        <ErrorText error={save.error} />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="primary" disabled={!form.firstName || !form.lastName || !ur.some((r) => r.roleId)}>
            {t('save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ───────────── Филиалы ─────────────

interface Branch {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  isActive: boolean;
}

export function BranchesPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['branches'], queryFn: () => api<Branch[]>('/branches') });
  const [edit, setEdit] = useState<Partial<Branch> | null>(null);
  const save = useMutation({
    mutationFn: (b: Partial<Branch>) => {
      const body = { name: b.name, address: b.address || undefined, phone: b.phone || undefined };
      return b.id ? api(`/branches/${b.id}`, { method: 'PATCH', body }) : api('/branches', { method: 'POST', body });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['branches'] });
      setEdit(null);
    },
  });

  return (
    <>
      <div className="toolbar">
        <h1 style={{ margin: 0, marginRight: 'auto' }}>{t('branches')}</h1>
        {can('branches.create') && (
          <button className="primary" onClick={() => setEdit({})}>
            + {t('add')}
          </button>
        )}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('name')}</th>
              <th>{t('address')}</th>
              <th>{t('phone')}</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((b) => (
              <tr key={b.id} className="click" onClick={() => can('branches.update') && setEdit(b)}>
                <td>{b.name}</td>
                <td>{b.address ?? '—'}</td>
                <td>{b.phone ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <Modal title={edit.id ? edit.name! : t('branches')} onClose={() => setEdit(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(edit);
            }}
          >
            <Field label={t('name')}>
              <input autoFocus value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </Field>
            <Field label={t('address')}>
              <input value={edit.address ?? ''} onChange={(e) => setEdit({ ...edit, address: e.target.value })} />
            </Field>
            <Field label={t('phone')}>
              <input value={edit.phone ?? ''} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} />
            </Field>
            <ErrorText error={save.error} />
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setEdit(null)}>
                {t('cancel')}
              </button>
              <button className="primary" disabled={!edit.name}>
                {t('save')}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

// ───────────── Журнал действий ─────────────

interface AuditRow {
  id: string;
  entity: string;
  entityId: string;
  action: string;
  reason: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
  user: { firstName: string; lastName: string } | null;
}

const ENTITY_NAMES: Record<string, string> = {
  lead: 'Лид',
  student: 'Студент',
  user: 'Сотрудник',
  role: 'Роль',
  branch: 'Филиал',
  payment: 'Оплата',
  attendance: 'Посещаемость',
};

export function AuditPage() {
  const { t } = useI18n();
  const [entity, setEntity] = useState('');
  const [open, setOpen] = useState<AuditRow | null>(null);
  const q = useQuery({ queryKey: ['audit', entity], queryFn: () => api<AuditRow[]>(`/audit${qs({ entity })}`) });

  return (
    <>
      <div className="toolbar">
        <h1 style={{ margin: 0, marginRight: 'auto' }}>{t('audit')}</h1>
        <select value={entity} onChange={(e) => setEntity(e.target.value)}>
          <option value="">{t('entity')}: все</option>
          {Object.entries(ENTITY_NAMES).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <ErrorText error={q.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('when')}</th>
              <th>{t('who')}</th>
              <th>{t('entity')}</th>
              <th>{t('action')}</th>
              <th>Причина</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((a) => (
              <tr key={a.id} className="click" onClick={() => setOpen(a)}>
                <td className="muted">{fmtDate(a.createdAt)}</td>
                <td>{a.user ? `${a.user.firstName} ${a.user.lastName}` : 'система'}</td>
                <td>{ENTITY_NAMES[a.entity] ?? a.entity}</td>
                <td>{a.action}</td>
                <td>{a.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && (
        <Modal title={`${ENTITY_NAMES[open.entity] ?? open.entity} · ${open.action}`} onClose={() => setOpen(null)}>
          <div className="grid2">
            <div>
              <h3>До</h3>
              <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{JSON.stringify(open.before, null, 2)}</pre>
            </div>
            <div>
              <h3>После</h3>
              <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{JSON.stringify(open.after, null, 2)}</pre>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
