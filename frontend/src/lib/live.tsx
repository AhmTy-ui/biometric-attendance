import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Live updates: a single WebSocket to /ws (the gateway bridged from the MQTT broker).
 * Frames: { kind: 'attendance/event' | 'device/status' | 'alert/raised' | ..., at, data }.
 */
export interface LiveFrame {
  kind: string;
  at: string;
  data: any;
}
type Handler = (f: LiveFrame) => void;

interface LiveCtx {
  status: 'connecting' | 'open' | 'closed';
  subscribe: (prefix: string, h: Handler) => () => void;
  lastFrameAt: number | null;
}

const Ctx = createContext<LiveCtx>({ status: 'closed', subscribe: () => () => undefined, lastFrameAt: null });

// Which cached queries go stale when a given kind of frame arrives.
const INVALIDATE: Record<string, string[][]> = {
  'attendance/event': [['dashboard'], ['attendance-today']],
  'delivery/updated': [['delivery-summary']],
  'device/status': [['dashboard'], ['devices'], ['device']],
  'device/reconcile': [['devices'], ['device']],
  'alert/raised': [['dashboard'], ['alerts'], ['notifications']],
  'alert/updated': [['dashboard'], ['alerts'], ['alert']],
  'sync/finished': [['integration-status'], ['sync-runs'], ['dashboard'], ['employees'], ['location-mappings'], ['integration-exports']],
  'sync/started': [['integration-status'], ['sync-runs']],
  'firmware/target': [['firmware-deployment'], ['firmware-deployments']],
  'firmware/deployment': [['firmware-deployment'], ['firmware-deployments'], ['firmware-versions']],
  'enrolment/session': [['enrolment-sessions']],
  'employee/biometric': [['employee'], ['employees']],
  'command/updated': [['device']]
};

export function LiveProvider({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<LiveCtx['status']>('closed');
  const [lastFrameAt, setLast] = useState<number | null>(null);
  const handlers = useRef(new Map<string, Set<Handler>>());
  const throttle = useRef(new Map<string, number>());

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer: number | undefined;
    let closed = false;
    const connect = () => {
      setStatus('connecting');
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onopen = () => {
        retry = 0;
        setStatus('open');
      };
      ws.onmessage = (ev) => {
        let f: LiveFrame;
        try {
          f = JSON.parse(ev.data);
        } catch {
          return;
        }
        setLast(Date.now());
        for (const [prefix, set] of handlers.current) if (f.kind.startsWith(prefix)) set.forEach((h) => h(f));
        for (const key of INVALIDATE[f.kind] ?? []) {
          const k = key.join('/');
          const lastT = throttle.current.get(k) ?? 0;
          if (Date.now() - lastT > 1500) {
            throttle.current.set(k, Date.now());
            void qc.invalidateQueries({ queryKey: key });
          }
        }
      };
      ws.onclose = (ev) => {
        setStatus('closed');
        if (closed || ev.code === 4401) return;
        retry = Math.min(retry + 1, 6);
        timer = window.setTimeout(connect, 1000 * 2 ** retry);
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      ws?.close();
    };
  }, [enabled, qc]);

  const subscribe = useCallback((prefix: string, h: Handler) => {
    if (!handlers.current.has(prefix)) handlers.current.set(prefix, new Set());
    handlers.current.get(prefix)!.add(h);
    return () => {
      handlers.current.get(prefix)?.delete(h);
    };
  }, []);

  return <Ctx.Provider value={{ status, subscribe, lastFrameAt }}>{children}</Ctx.Provider>;
}

export const useLive = () => useContext(Ctx);

/** Subscribe to live frames whose kind starts with `prefix`. */
export function useLiveEvents(prefix: string, handler: Handler) {
  const { subscribe } = useLive();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe(prefix, (f) => ref.current(f)), [prefix, subscribe]);
}
