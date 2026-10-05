import pino from 'pino';
import { config } from '../config.js';

// Structured JSON logging (Observability). Pretty-print only in development.
export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'bamp-backend' },
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', '*.password', '*.secret', '*.token', '*.template'],
    censor: '[redacted]'
  },
  transport:
    config.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,service' } }
      : undefined
});
