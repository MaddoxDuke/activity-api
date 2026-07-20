'use strict';

require('dotenv').config();

const Fastify = require('fastify');
const { Pool } = require('pg');
const { buildDigest } = require('./lib/digest');
const { dayKeyInTz, mondayOf, addDays, dayWindow } = require('./lib/derive');

const { DATABASE_URL, API_KEY, PORT = 3000, DIGEST_TZ = 'America/Chicago' } = process.env;

if (!DATABASE_URL) {
  console.error('Missing required env var DATABASE_URL');
  process.exit(1);
}
if (!API_KEY) {
  console.error('Missing required env var API_KEY');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

const fastify = Fastify({ logger: true });

fastify.register(require('@fastify/cors'), {
  origin: [
    'https://dash.maddox-duke.com',
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['content-type', 'x-api-key'],
});

fastify.addHook('onRequest', async (req, reply) => {
  // OPTIONS must reach @fastify/cors so browser preflights succeed;
  // preflights carry no credentials and touch no data.
  if (req.method === 'OPTIONS') return;
  if (req.routeOptions.url === '/health') return;
  if (req.headers['x-api-key'] !== API_KEY) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
});

fastify.get('/health', async () => ({ ok: true }));

const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

fastify.post('/events', async (req, reply) => {
  const { ts, event, source } = req.body ?? {};

  const parsedTs = new Date(ts);
  if (typeof ts !== 'string' || Number.isNaN(parsedTs.getTime())) {
    return reply.code(400).send({ error: 'ts must be a valid date' });
  }
  if (typeof event !== 'string' || !SNAKE_CASE.test(event)) {
    return reply.code(400).send({ error: 'event must be snake_case text' });
  }
  if (source !== undefined && typeof source !== 'string') {
    return reply.code(400).send({ error: 'source must be a string' });
  }

  await pool.query(
    `INSERT INTO events (ts, event, source) VALUES ($1, $2, COALESCE($3, 'unknown'))`,
    [parsedTs.toISOString(), event, source ?? null]
  );
  return { ok: true };
});

fastify.get('/events', async (req, reply) => {
  const { from } = req.query;

  if (from !== undefined) {
    const parsedFrom = new Date(from);
    if (Number.isNaN(parsedFrom.getTime())) {
      return reply.code(400).send({ error: 'from must be a valid date' });
    }
    const { rows } = await pool.query(
      'SELECT * FROM events WHERE ts >= $1 ORDER BY ts',
      [parsedFrom.toISOString()]
    );
    return rows;
  }

  const { rows } = await pool.query('SELECT * FROM events ORDER BY ts');
  return rows;
});

// The evening dispatch: today's account, with a week-over-week reading and
// advice on Sundays (or ?week=1). Interpretation stays read-side — the
// ingest path remains generic.
fastify.get('/digest', async (req, reply) => {
  const tz = req.query.tz ?? DIGEST_TZ;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    return reply.code(400).send({ error: 'unknown tz' });
  }

  const nowMs = Date.now();
  const date = req.query.date ?? dayKeyInTz(nowMs, tz);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(dayWindow(date, tz).start)) {
    return reply.code(400).send({ error: 'date must be YYYY-MM-DD' });
  }

  // Five weeks of history feeds the week-over-week and advice medians.
  const cutoff = dayWindow(addDays(mondayOf(date, tz), -28), tz).start;
  const { rows } = await pool.query('SELECT ts, event, source FROM events WHERE ts >= $1 ORDER BY ts', [
    new Date(cutoff).toISOString(),
  ]);

  return buildDigest(rows, { date, tz, nowMs, forceWeekly: req.query.week === '1' });
});

fastify.addHook('onClose', async () => {
  await pool.end();
});

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id serial PRIMARY KEY,
      ts timestamptz NOT NULL,
      event text NOT NULL,
      source text DEFAULT 'unknown',
      received_at timestamptz DEFAULT now()
    )
  `);
  await fastify.listen({ port: Number(PORT), host: '127.0.0.1' });
}

start().catch((err) => {
  fastify.log.error(err);
  process.exit(1);
});
