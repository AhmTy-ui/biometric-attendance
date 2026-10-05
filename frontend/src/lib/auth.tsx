import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { api, ApiError } from './api';

export type Role = 'administrator' | 'manager' | 'branch_supervisor';

export interface Me {
  user: {
    id: string;
    email: string;
    fullName: string;
    jobTitle: string | null;
    role: Role;
    roleLabel: string;
    mfaEnabled: boolean;
    recoveryCodesLeft: number;
    lastLoginAt: string | null;
  };
  organization: { id: string; name: string; timezone: string; setupCompleted: boolean };
  permissions: string[];
  locationScope: { id: string; name: string; code: string }[] | null;
  session: { expiresAt: string; idleTimeoutMinutes: number };
  passwordPolicy: {
    passwordMinLength: number;
    passwordRequireUpper: boolean;
    passwordRequireLower: boolean;
    passwordRequireDigit: boolean;
    passwordRequireSymbol: boolean;
  };
  recoveryCodesTotal: number;
}

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  error: ApiError | null;
  can: (perm: string) => boolean;
  refresh: () => Promise<unknown>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery<Me, ApiError>({
    queryKey: ['me'],
    queryFn: () => api.get<Me>('/api/auth/me'),
    retry: (count, err) => err.status === 0 && count < 2,
    staleTime: 60_000
  });
  const me = q.data ?? null;
  const value: AuthCtx = {
    me: q.error ? null : me,
    loading: q.isLoading,
    error: q.error ?? null,
    can: (perm) => Boolean(me?.permissions.includes(perm)),
    refresh: () => q.refetch(),
    logout: async () => {
      await api.post('/api/auth/logout').catch(() => undefined);
      qc.clear();
      window.location.assign('/login');
    }
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
