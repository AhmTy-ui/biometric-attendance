/**
 * Copies non-TypeScript runtime assets (SQL migrations, static CSS/JS) into dist/ after `tsc`.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pairs = [
  ['src/db/migrations', 'dist/db/migrations'],
  ['src/static', 'dist/static']
];
for (const [from, to] of pairs) {
  const src = join(root, from);
  if (!existsSync(src)) throw new Error(`Missing asset directory ${from}`);
  mkdirSync(join(root, to), { recursive: true });
  cpSync(src, join(root, to), { recursive: true });
  console.log(`copied ${from} -> ${to}`);
}
