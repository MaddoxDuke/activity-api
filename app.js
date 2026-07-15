'use strict';

require('dotenv').config();

const Fastify = require('fastify');
const { Pool } = require('pg');

const { DATABASE_URL, API_KEY, PORT = 3000 } = process.env;

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

fastify.addHook('onRequest', async (req, reply) => {
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
