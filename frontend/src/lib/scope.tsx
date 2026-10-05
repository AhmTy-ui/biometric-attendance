import { createContext, useContext, useState, type ReactNode } from 'react';

/**
 * Global location scope chosen in the top bar. Pages use it as the default location filter
 * (server-side authorisation still applies — this only narrows what the user asked to see).
 */
const Ctx = createContext<[string | null, (v: string | null) => void]>([null, () => undefined]);
const KEY = 'bamp.scope.location';

export function ScopeProvider({ children }: { children: ReactNode }) {
  const [v, setV] = useState<string | null>(() => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  });
  const set = (x: string | null) => {
    setV(x);
    try {
      if (x) localStorage.setItem(KEY, x);
      else localStorage.removeItem(KEY);
    } catch {
      /* storage unavailable */
    }
  };
  return <Ctx.Provider value={[v, set]}>{children}</Ctx.Provider>;
}

export const useGlobalLocation = () => useContext(Ctx);
