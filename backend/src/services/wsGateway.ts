import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Principal } from '../auth/rbac.js';
import { can } from '../auth/rbac.js';
import { authenticateRequest } from '../auth/session.js';
import { logger } from '../lib/logger.js';
import { onDashboardMessage } from './mqtt.js';

/**
 * WebSocket gateway bridged from the MQTT broker (Technology stack: "Live updates").
 * Every message published on bamp/{org}/dashboard/# is forwarded to connected dashboard sessions of
 * that organisation, filtered by the viewer's role and location scope (FR-5.3).
 */
interface Conn {
  socket: WebSocket;
  principal: Principal;
}

const conns = new Set<Conn>();

const KIND_PERMISSION: Record<string, Parameters<typeof can>[1]> = {
  attendance: 'attendance.view',
  delivery: 'attendance.view',
  device: 'devices.view',
  alert: 'alerts.view',
  sync: 'integration.view',
  firmware: 'firmware.view',
  enrolment: 'enrolment.view',
  command: 'devices.view',
  employee: 'employees.view'
};

export function wsClientCount() {
  return conns.size;
}

export function registerWsGateway(app: FastifyInstance) {
  onDashboardMessage((orgId, kind, message) => {
    const root = kind.split('/')[0];
    const perm = KIND_PERMISSION[root];
    const locationId: string | undefined = message?.data?.locationId ?? undefined;
    const frame = JSON.stringify({ kind, at: message?.at, data: message?.data });
    for (const c of conns) {
      if (c.principal.organizationId !== orgId) continue;
      if (perm && !can(c.principal, perm)) continue;
      if (c.principal.locationIds !== null && locationId && !c.principal.locationIds.includes(locationId)) continue;
      if (c.principal.locationIds !== null && !locationId && root !== 'sync') continue;
      if (c.socket.readyState === c.socket.OPEN) c.socket.send(frame);
    }
  });

  app.get('/ws', { websocket: true }, async (socket, req) => {
    let principal: Principal | null = null;
    try {
      principal = await authenticateRequest(req);
    } catch {
      principal = null;
    }
    if (!principal) {
      socket.send(JSON.stringify({ kind: 'error', data: { code: 'unauthorized' } }));
      socket.close(4401, 'unauthorized');
      return;
    }
    const conn: Conn = { socket, principal };
    conns.add(conn);
    socket.send(JSON.stringify({ kind: 'hello', data: { userId: principal.userId } }));
    const ping = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, 25000);
    socket.on('close', () => {
      clearInterval(ping);
      conns.delete(conn);
    });
    socket.on('error', (err) => logger.debug({ err: err.message }, 'ws error'));
  });
}
