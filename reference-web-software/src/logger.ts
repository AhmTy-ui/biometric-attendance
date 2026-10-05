import { pino } from 'pino';
import { config } from './config.js';

export const loggerOptions = {
  level: config.LOG_LEVEL,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    censor: '[redacted]'
  }
};

/** Logger for code running outside a request (startup, migrations, housekeeping). */
export const logger = pino(loggerOptions);
