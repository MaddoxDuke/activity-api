'use strict';

require('dotenv').config();

const Fastify = require('fastify');
const { Pool } = require('pg');
const { buildDigest } = require('./lib/digest');
const { dayKeyInTz, mondayOf, addDays, dayWindow } = require('./lib/derive');

const {
  DATABASE_URL,
  API_KEY,
  ANALYST_KEY,
  PORT = 3000,
  DIGEST_TZ = 'America/Chicago',
} = process.env;

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

// The analyst key belongs to the nightly scheduled routine: it may read
// the record and file its notes, nothing more. If it ever leaks, nobody
// can write events, wipe data, or read anything the routine couldn't.
const ANALYST_ALLOWED = new Set([
  'GET /events',
  'GET /digest',
  'GET /metrics',
  'GET /analyst',
  'POST /analyst',
]);

fastify.addHook('onRequest', async (req, reply) => {
  // OPTIONS must reach @fastify/cors so browser preflights succeed;
  // preflights carry no credentials and touch no data.
  if (req.method === 'OPTIONS') return;
  if (req.routeOptions.url === '/health') return;
  const key = req.headers['x-api-key'];
  if (key === API_KEY) return;
  if (
    ANALYST_KEY &&
    key === ANALYST_KEY &&
    ANALYST_ALLOWED.has(`${req.method} ${req.routeOptions.url ?? ''}`)
  ) {
    return;
  }
  return reply.code(401).send({ error: 'unauthorized' });
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

// ——— vitals: daily-grain personal metrics —————————————————————
// MyFitnessPal's API is partner-only, but MFP syncs to Apple Health and an
// iOS Shortcut reads Health samples and posts them here. Generic like the
// event log: any {name, value} pair per day, no schema opinions.

const METRIC_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

fastify.post('/metrics', async (req, reply) => {
  const { day, name, value, unit, source } = req.body ?? {};
  const metricDay = day ?? dayKeyInTz(Date.now(), DIGEST_TZ);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(metricDay)) {
    return reply.code(400).send({ error: 'day must be YYYY-MM-DD' });
  }
  if (typeof name !== 'string' || !METRIC_NAME.test(name)) {
    return reply.code(400).send({ error: 'name must be snake_case text' });
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return reply.code(400).send({ error: 'value must be a finite number' });
  }
  if (unit !== undefined && typeof unit !== 'string') {
    return reply.code(400).send({ error: 'unit must be a string' });
  }
  await pool.query(
    `INSERT INTO metrics (day, name, value, unit, source)
     VALUES ($1, $2, $3, $4, COALESCE($5, 'unknown'))
     ON CONFLICT (day, name)
     DO UPDATE SET value = EXCLUDED.value, unit = EXCLUDED.unit,
                   source = EXCLUDED.source, received_at = now()`,
    [metricDay, name, num, unit ?? null, source ?? null],
  );
  return { ok: true, day: metricDay, name };
});

fastify.get('/metrics', async (req, reply) => {
  const { from } = req.query;
  if (from !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    return reply.code(400).send({ error: 'from must be YYYY-MM-DD' });
  }
  const { rows } = from
    ? await pool.query(
        'SELECT day, name, value, unit, source FROM metrics WHERE day >= $1 ORDER BY day, name',
        [from],
      )
    : await pool.query('SELECT day, name, value, unit, source FROM metrics ORDER BY day, name');
  return rows;
});

// ——— the analyst's notes ——————————————————————————————————————
// Filed nightly by a scheduled Claude routine running on the operator's
// subscription. Stored and served here; this service never calls any LLM.

fastify.post('/analyst', async (req, reply) => {
  const { day, briefing, observations, suggestions } = req.body ?? {};
  const noteDay = day ?? dayKeyInTz(Date.now(), DIGEST_TZ);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(noteDay)) {
    return reply.code(400).send({ error: 'day must be YYYY-MM-DD' });
  }
  if (typeof briefing !== 'string' || !briefing.trim()) {
    return reply.code(400).send({ error: 'briefing must be non-empty text' });
  }
  if (!Array.isArray(observations) || !Array.isArray(suggestions)) {
    return reply.code(400).send({ error: 'observations and suggestions must be arrays' });
  }
  await pool.query(
    `INSERT INTO analyst_notes (day, briefing, observations, suggestions)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (day)
     DO UPDATE SET briefing = EXCLUDED.briefing, observations = EXCLUDED.observations,
                   suggestions = EXCLUDED.suggestions, received_at = now()`,
    [noteDay, briefing.trim(), JSON.stringify(observations), JSON.stringify(suggestions)],
  );
  return { ok: true, day: noteDay };
});

fastify.get('/analyst', async (req) => {
  const limit = Math.min(Number(req.query.limit) || 14, 60);
  const { rows } = await pool.query(
    'SELECT day, briefing, observations, suggestions, received_at FROM analyst_notes ORDER BY day DESC LIMIT $1',
    [limit],
  );
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
  // Default to the completed prior day: an evening report on "today" would
  // always miss the late hours. Calendar arithmetic, so DST can't skip a day.
  const date = req.query.date ?? addDays(dayKeyInTz(nowMs, tz), -1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(dayWindow(date, tz).start)) {
    return reply.code(400).send({ error: 'date must be YYYY-MM-DD' });
  }

  // Five weeks of history feeds the week-over-week and advice medians.
  const cutoff = dayWindow(addDays(mondayOf(date, tz), -28), tz).start;
  const { rows } = await pool.query('SELECT ts, event, source FROM events WHERE ts >= $1 ORDER BY ts', [
    new Date(cutoff).toISOString(),
  ]);
  const { rows: dayMetrics } = await pool.query(
    'SELECT name, value, unit FROM metrics WHERE day = $1 ORDER BY name',
    [date],
  );
  const { rows: notes } = await pool.query(
    'SELECT briefing FROM analyst_notes WHERE day = $1',
    [date],
  );

  return buildDigest(rows, {
    date,
    tz,
    nowMs,
    forceWeekly: req.query.week === '1',
    dayMetrics,
    analystBriefing: notes[0]?.briefing ?? null,
  });
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS metrics (
      id serial PRIMARY KEY,
      day date NOT NULL,
      name text NOT NULL,
      value numeric NOT NULL,
      unit text,
      source text DEFAULT 'unknown',
      received_at timestamptz DEFAULT now(),
      UNIQUE (day, name)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analyst_notes (
      id serial PRIMARY KEY,
      day date NOT NULL UNIQUE,
      briefing text NOT NULL,
      observations jsonb NOT NULL,
      suggestions jsonb NOT NULL,
      received_at timestamptz DEFAULT now()
    )
  `);
  await fastify.listen({ port: Number(PORT), host: '127.0.0.1' });
}

start().catch((err) => {
  fastify.log.error(err);
  process.exit(1);
});
