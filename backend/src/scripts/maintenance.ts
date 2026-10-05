/** Toggle dashboard maintenance mode:  npm run maintenance -- on "Upgrading to v1.1, back at 02:00 UTC"  |  npm run maintenance -- off */
import { redis } from '../lib/redis.js';

const [mode, ...msg] = process.argv.slice(2);
if (mode === 'on') {
  await redis.set('bamp:maintenance', JSON.stringify({ message: msg.join(' ') || 'Scheduled maintenance in progress.', since: new Date().toISOString() }));
  console.log('Maintenance mode ON');
} else if (mode === 'off') {
  await redis.del('bamp:maintenance');
  console.log('Maintenance mode OFF');
} else {
  console.log('Usage: npm run maintenance -- on "<message>" | off');
}
await redis.quit();
