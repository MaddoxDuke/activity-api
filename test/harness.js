'use strict';
// Verification harness: stubs the pg module, boots app.js on a real port,
// then exercises every route with fetch. No real database needed.

const path = require('node:path');

const APP_DIR = path.join(__dirname, '..');

process.env.DATABASE_URL = 'postgres://stub:stub@localhost:5432/stub';
process.env.API_KEY = 'test-key-123';
process.env.PORT = '3199';

// In-memory fake table
const inserted = [];

const pgPath = require.resolve('pg', { paths: [APP_DIR] });
require.cache[pgPath] = {
  id: pgPath,
  filename: pgPath,
  loaded: true,
  exports: {
    Pool: class {
      async query(text, params) {
        const sql = text.trim();
        if (sql.startsWith('CREATE TABLE')) return { rows: [] };
        if (sql.startsWith('INSERT')) {
          inserted.push({ ts: params[0], event: params[1], source: params[2] ?? 'unknown' });
          return { rows: [] };
        }
        if (sql.startsWith('SELECT')) {
          let rows = inserted.slice();
          if (params && params.length) rows = rows.filter((r) => r.ts >= params[0]);
          rows.sort((a, b) => (a.ts < b.ts ? -1 : 1));
          return { rows };
        }
        throw new Error('unexpected query: ' + sql);
      }
      async end() {}
    },
  },
};

require(require.resolve('./app.js', { paths: [APP_DIR] }));

const BASE = 'http://127.0.0.1:3199';
const KEY = { 'x-api-key': 'test-key-123' };
const JSON_CT = { 'content-type': 'application/json' };

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('PASS  ' + name);
  else { failures++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

async function main() {
  // wait for server to come up
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/health'); break; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  let r, body;

  // 1. /health needs no auth
  r = await fetch(BASE + '/health');
  body = await r.json();
  check('GET /health no auth -> 200 {ok:true}', r.status === 200 && body.ok === true, r.status);

  // 2. GET /events without key -> 401
  r = await fetch(BASE + '/events');
  check('GET /events no key -> 401', r.status === 401, r.status);

  // 3. POST /events without key -> 401
  r = await fetch(BASE + '/events', { method: 'POST', headers: JSON_CT, body: '{}' });
  check('POST /events no key -> 401', r.status === 401, r.status);

  // 4. wrong key -> 401
  r = await fetch(BASE + '/events', { headers: { 'x-api-key': 'wrong' } });
  check('GET /events wrong key -> 401', r.status === 401, r.status);

  // 5. unknown route without key -> still rejected
  r = await fetch(BASE + '/nope');
  check('GET /nope no key -> 401', r.status === 401, r.status);

  // 6. valid POST
  r = await fetch(BASE + '/events', {
    method: 'POST', headers: { ...KEY, ...JSON_CT },
    body: JSON.stringify({ ts: '2026-07-14T10:00:00Z', event: 'workout_done', source: 'phone' }),
  });
  body = await r.json();
  check('POST valid -> 200 {ok:true}', r.status === 200 && body.ok === true, r.status + ' ' + JSON.stringify(body));

  // 7. valid POST without source (defaults)
  r = await fetch(BASE + '/events', {
    method: 'POST', headers: { ...KEY, ...JSON_CT },
    body: JSON.stringify({ ts: '2026-07-13T08:00:00Z', event: 'woke_up' }),
  });
  check('POST valid no source -> 200', r.status === 200, r.status);

  // 8. invalid ts -> 400
  r = await fetch(BASE + '/events', {
    method: 'POST', headers: { ...KEY, ...JSON_CT },
    body: JSON.stringify({ ts: 'banana', event: 'workout_done' }),
  });
  check('POST invalid ts -> 400', r.status === 400, r.status);

  // 9. missing ts -> 400
  r = await fetch(BASE + '/events', {
    method: 'POST', headers: { ...KEY, ...JSON_CT },
    body: JSON.stringify({ event: 'workout_done' }),
  });
  check('POST missing ts -> 400', r.status === 400, r.status);

  // 10. non-snake_case event -> 400
  for (const bad of ['Workout Done', 'workoutDone', '_leading', 'trailing_', 'double__under', '']) {
    r = await fetch(BASE + '/events', {
      method: 'POST', headers: { ...KEY, ...JSON_CT },
      body: JSON.stringify({ ts: '2026-07-14T10:00:00Z', event: bad }),
    });
    check(`POST event=${JSON.stringify(bad)} -> 400`, r.status === 400, r.status);
  }

  // 11. numeric ts -> 400 (must be a string date)
  r = await fetch(BASE + '/events', {
    method: 'POST', headers: { ...KEY, ...JSON_CT },
    body: JSON.stringify({ ts: 1720000000, event: 'workout_done' }),
  });
  check('POST numeric ts -> 400', r.status === 400, r.status);

  // 12. GET /events returns rows ordered by ts
  r = await fetch(BASE + '/events', { headers: KEY });
  body = await r.json();
  check('GET /events -> 200, 2 rows, ordered by ts',
    r.status === 200 && body.length === 2 && body[0].event === 'woke_up' && body[1].event === 'workout_done',
    JSON.stringify(body));

  // 13. GET /events?from filters
  r = await fetch(BASE + '/events?from=2026-07-14', { headers: KEY });
  body = await r.json();
  check('GET /events?from=2026-07-14 -> 1 row', r.status === 200 && body.length === 1 && body[0].event === 'workout_done',
    JSON.stringify(body));

  // 14. GET /events?from=garbage -> 400
  r = await fetch(BASE + '/events?from=garbage', { headers: KEY });
  check('GET /events?from=garbage -> 400', r.status === 400, r.status);

  // 15. default source recorded as 'unknown' in insert params path
  check("insert without source stored as 'unknown' (via COALESCE param)", inserted.some((i) => i.event === 'woke_up' && i.source === 'unknown'), JSON.stringify(inserted));

  // 16. CORS preflight from dash origin -> 204 with allow headers, no auth needed
  r = await fetch(BASE + '/events', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://dash.maddox-duke.com',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-api-key',
    },
  });
  check('OPTIONS preflight dash origin -> 204 + ACAO',
    r.status === 204
      && r.headers.get('access-control-allow-origin') === 'https://dash.maddox-duke.com'
      && (r.headers.get('access-control-allow-headers') || '').includes('x-api-key'),
    r.status + ' ' + JSON.stringify([...r.headers]));

  // 17. preflight from localhost dev origin allowed
  r = await fetch(BASE + '/events', {
    method: 'OPTIONS',
    headers: {
      origin: 'http://localhost:4200',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-api-key',
    },
  });
  check('OPTIONS preflight localhost:4200 -> 204 + ACAO',
    r.status === 204 && r.headers.get('access-control-allow-origin') === 'http://localhost:4200', r.status);

  // 18. preflight from unknown origin -> no ACAO header
  r = await fetch(BASE + '/events', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://evil.example.com',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-api-key',
    },
  });
  check('OPTIONS preflight foreign origin -> no ACAO',
    !r.headers.get('access-control-allow-origin'), r.headers.get('access-control-allow-origin'));

  // 19. actual GET with Origin carries ACAO, still requires key
  r = await fetch(BASE + '/events', { headers: { origin: 'https://dash.maddox-duke.com' } });
  check('GET with dash origin but no key -> still 401', r.status === 401, r.status);
  r = await fetch(BASE + '/events', { headers: { ...KEY, origin: 'https://dash.maddox-duke.com' } });
  check('GET with dash origin + key -> 200 + ACAO',
    r.status === 200 && r.headers.get('access-control-allow-origin') === 'https://dash.maddox-duke.com', r.status);

  // ——— /digest ————————————————————————————————————————————————
  const { zonedTimeToUtc, dayKeyInTz, mondayOf, addDays } = require(
    require.resolve('./lib/derive.js', { paths: [APP_DIR] }),
  );
  const TZ = 'America/Chicago';
  const yesterday = dayKeyInTz(Date.now() - 24 * 3600_000, TZ);
  const [yy, ym, yd] = yesterday.split('-').map(Number);
  const atLocal = (h, mi) => new Date(zonedTimeToUtc(yy, ym, yd, h, mi, TZ)).toISOString();
  const post = (ts, event, source = 'harness') =>
    fetch(BASE + '/events', {
      method: 'POST', headers: { ...KEY, ...JSON_CT },
      body: JSON.stringify({ ts, event, source }),
    });

  // A full specimen day (yesterday, local tz): work, gym, an evening reel.
  await post(atLocal(9, 0), 'arrived_work');
  await post(atLocal(17, 0), 'left_work');
  await post(atLocal(17, 25), 'arrived_gym');
  await post(atLocal(18, 30), 'left_gym');
  await post(atLocal(18, 45), 'arrived_home');
  await post(atLocal(20, 30), 'editing_start', 'roughcut');
  await post(atLocal(22, 0), 'editing_stop', 'roughcut');
  // Prior week: a shop block, so the weekly delta has something to say.
  const prevMonday = addDays(mondayOf(yesterday, TZ), -7);
  const [py, pm, pd] = prevMonday.split('-').map(Number);
  await post(new Date(zonedTimeToUtc(py, pm, pd, 10, 0, TZ)).toISOString(), 'arrived_shop');
  await post(new Date(zonedTimeToUtc(py, pm, pd, 12, 0, TZ)).toISOString(), 'left_shop');

  // 20. digest requires the key
  r = await fetch(BASE + `/digest?date=${yesterday}`);
  check('GET /digest no key -> 401', r.status === 401, r.status);

  // 21. digest for yesterday: paired buckets with spans
  r = await fetch(BASE + `/digest?date=${yesterday}&tz=${TZ}`, { headers: KEY });
  body = await r.json();
  check('GET /digest -> 200 with day lines',
    r.status === 200 && Array.isArray(body.day) && body.date === yesterday, r.status + ' ' + JSON.stringify(body.day));
  const dayStr = (body.day || []).join(' | ');
  check('digest pairs work 8h00 (9:00–17:00)', dayStr.includes('work 8h00 (9:00–17:00)'), dayStr);
  check('digest pairs gym 1h05', dayStr.includes('gym 1h05'), dayStr);
  check('digest pairs bench 1h30 (20:30–22:00)', dayStr.includes('bench 1h30 (20:30–22:00)'), dayStr);
  check('digest counts transit', dayStr.includes('in transit'), dayStr);
  check('digest body is notification-ready text',
    typeof body.body === 'string' && body.body.length > 20 && !body.week, body.body);

  // 22. weekly reading on demand
  r = await fetch(BASE + `/digest?date=${yesterday}&tz=${TZ}&week=1`, { headers: KEY });
  body = await r.json();
  const weekStr = body.week ? body.week.lines.join(' | ') : '(none)';
  check('digest?week=1 -> week lines with work delta',
    !!body.week && weekStr.includes('work 8h00'), weekStr);
  check('digest week advice is a bounded list',
    Array.isArray(body.week?.advice) && body.week.advice.length <= 2, JSON.stringify(body.week?.advice));

  // 23. validation
  r = await fetch(BASE + '/digest?tz=Not/AZone', { headers: KEY });
  check('digest bad tz -> 400', r.status === 400, r.status);
  r = await fetch(BASE + '/digest?date=16-07-2026', { headers: KEY });
  check('digest bad date -> 400', r.status === 400, r.status);

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
