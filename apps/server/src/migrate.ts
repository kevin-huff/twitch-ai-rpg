import { createPool, migrate } from './database';
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before migrating.');
const pool = createPool(process.env.DATABASE_URL);
try { await migrate(pool); } finally { await pool.end(); }
