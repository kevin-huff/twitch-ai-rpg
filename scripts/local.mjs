import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
if (Number(process.versions.node.split('.')[0]) !== 24) {
  console.error('Use Node.js 24.22.1 for this project: nvm install && nvm use');
  process.exit(1);
}
if (!existsSync('.env')) {
  writeFileSync('.env', readFileSync('.env.example', 'utf8')
    .replace('replace-with-at-least-32-random-characters', randomBytes(36).toString('base64url'))
    .replace('replace-with-another-random-password', randomBytes(24).toString('base64url')), { mode: 0o600 });
}
process.loadEnvFile('.env');
const database = new URL(process.env.DATABASE_URL);
const require = createRequire(import.meta.url);
const { Client } = require('pg');
async function reachable() {
  const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 1500 });
  try { await client.connect(); return true; } catch { return false; } finally { await client.end().catch(() => {}); }
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', timeout: 60000, ...options });
  if (result.status !== 0) throw new Error(`${command} failed. ${result.error?.message ?? ''}`);
}
if (!(await reachable())) {
  if (!['localhost', '127.0.0.1'].includes(database.hostname) || database.port !== '55432') {
    throw new Error('Configured database is unavailable. Start it before running npm run local.');
  }
  const found = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' }).stdout?.trim();
  const pgBin = process.env.PG_BIN ?? (found && existsSync(join(found, 'pg_ctl')) ? found : '/usr/lib/postgresql/14/bin');
  if (!existsSync(join(pgBin, 'pg_ctl'))) throw new Error('PostgreSQL is unavailable. Start the database with docker compose up -d db, then retry.');
  mkdirSync('.local/pgsocket', { recursive: true });
  if (!existsSync('.local/postgres/PG_VERSION')) run(join(pgBin, 'initdb'), ['-D', resolve('.local/postgres'), '-U', database.username, '-A', 'trust', '--no-locale', '--encoding=UTF8']);
  const status = spawnSync(join(pgBin, 'pg_ctl'), ['-D', resolve('.local/postgres'), 'status'], { stdio: 'ignore' });
  if (status.status !== 0) run(join(pgBin, 'pg_ctl'), ['-D', resolve('.local/postgres'), '-l', resolve('.local/postgres.log'), '-o', `-h 127.0.0.1 -p 55432 -k ${resolve('.local/pgsocket')}`, '-w', 'start']);
  const admin = new Client({ connectionString: new URL('/postgres', database).href });
  await admin.connect();
  try {
    for (const name of [database.pathname.slice(1), 'rpg_test']) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error('Use a simple database name for local setup.');
      if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount) await admin.query(`CREATE DATABASE "${name}"`);
    }
  } finally { await admin.end(); }
}
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'apps/web/vite.config.ts']);
console.log('Starting the local rehearsal at http://localhost:3000. Your private host token is in .env.');
const child = spawn(process.execPath, ['--env-file-if-exists=.env', '--import', 'tsx', 'apps/server/src/main.ts'], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 0));
