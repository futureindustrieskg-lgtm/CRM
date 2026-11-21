import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, ReactNode, useContext, useEffect } from 'react';
import { api, getSession, setSession } from './api';

export interface UserRole {
  id: string;
  code: string;
  name: string;
  permissions: string[];
  branchId: string | null;
  branchName: string | null;
}

export interface Me {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  locale: string;
  roles: UserRole[];
  activeRoleId: string;
}

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  activeRole: UserRole | null;
  can: (perm: string) => boolean;
  login: (login: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  switchRole: (roleId: string) => void;
}

const Ctx = createContext<AuthCtx>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => api<Me>('/auth/me'),
    enabled: !!getSession(),
    retry: false,
  });

  useEffect(() => {
    const onLogout = () => qc.clear();
    window.addEventListener('crm:logout', onLogout);
    return () => window.removeEventListener('crm:logout', onLogout);
  }, [qc]);

  const me = getSession() ? meQuery.data ?? null : null;
  const activeRole = me?.roles.find((r) => r.id === me.activeRoleId) ?? null;

  const value: AuthCtx = {
    me,
    loading: !!getSession() && meQuery.isLoading,
    activeRole,
    can: (perm) => !!activeRole && (activeRole.permissions.includes('*') || activeRole.permissions.includes(perm)),
    async login(login, password) {
      const res = await api<{ accessToken: string; refreshToken: string }>('/auth/login', {
        method: 'POST',
        body: { login, password },
      });
      setSession({ accessToken: res.accessToken, refreshToken: res.refreshToken });
      await qc.fetchQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me') });
    },
    async logout() {
      const s = getSession();
      if (s) await api('/auth/logout', { method: 'POST', body: { refreshToken: s.refreshToken } }).catch(() => {});
      setSession(null);
      qc.clear();
      window.location.href = '/';
    },
    /** Переключение роли без повторного входа (ТЗ 2). */
    switchRole(roleId) {
      const s = getSession();
      if (!s) return;
      setSession({ ...s, activeRoleId: roleId });
      window.location.href = '/';
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
