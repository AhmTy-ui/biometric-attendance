import type { ZodTypeAny, z } from 'zod';
import { badRequest } from './errors.js';

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest(
      'Validation failed',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    );
  }
  return r.data;
}

export interface Page {
  limit: number;
  offset: number;
}

export function pageParams(q: any, max = 500): Page {
  const limit = Math.min(Math.max(parseInt(q?.limit ?? '50', 10) || 50, 1), max);
  const offset = Math.max(parseInt(q?.offset ?? '0', 10) || 0, 0);
  return { limit, offset };
}
