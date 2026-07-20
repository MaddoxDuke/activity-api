'use strict';
// Verification harness: stubs the pg module, boots app.js on a real port,
// then exercises every route with fetch. No real database needed.

const path = require('node:path');

const APP_DIR = path.join(__dirname, '..');

process.env.DATABASE_URL = 'postgres://stub:stub@localhost:5432/stub';
process.env.API_KEY = 'test-key-123';
process.env.ANALYST_KEY = 'analyst-key-456';
process.env.PORT = '3199';

// In-memory fake tables
const inserted = [];
const metrics = [];
const analystNotes = [];

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
        if (sql.startsWith('INSERT INTO events')) {
          inserted.push({ ts: params[0], event: params[1], source: params[2] ?? 'unknown' });
          return { rows: [] };
        }
        if (sql.startsWith('INSERT INTO metrics')) {
          const [day, name, value, unit, source] = params;
          const row = { day, name, value, unit, source: source ?? 'unknown' };
          const i = metrics.findIndex((m) => m.day === day && m.name === name);
          if (i >= 0) metrics[i] = row; else metrics.push(row);
          return { rows: [] };
        }
        if (sql.includes('FROM metrics WHERE day = ')) {
          return { rows: metrics.filter((m) => m.day === params[0]) };
        }
        if (sql.includes('FROM metrics WHERE day >=')) {
          return { rows: metrics.filter((m) => m.day >= params[0]) };
        }
        if (sql.includes('FROM metrics ORDER BY')) {
          return { rows: [...metrics] };
        }
        if (sql.startsWith('INSERT INTO analyst_notes')) {
          const [day, briefing, observations, suggestions] = params;
          const row = { day, briefing, observations: JSON.parse(observations), suggestions: JSON.parse(suggestions), received_at: new Date().toISOString() };
          const i = analystNotes.findIndex((n) => n.day === day);
          if (i >= 0) analystNotes[i] = row; else analystNotes.push(row);
          return { rows: [] };
        }
        if (sql.includes('FROM analyst_notes WHERE day = ')) {
          return { rows: analystNotes.filter((n) => n.day === params[0]).map((n) => ({ briefing: n.briefing })) };
        }
        if (sql.includes('FROM analyst_notes ORDER BY')) {
          return { rows: [...analystNotes].sort((x, y) => (x.day < y.day ? 1 : -1)).slice(0, params[0]) };
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

  // 21. digest for yesterday: chronological 12-hour entries
  r = await fetch(BASE + `/digest?date=${yesterday}&tz=${TZ}`, { headers: KEY });
  body = await r.json();
  check('GET /digest -> 200 with day lines',
    r.status === 200 && Array.isArray(body.day) && body.date === yesterday, r.status + ' ' + JSON.stringify(body.day));
  const dayStr = (body.day || []).join(' | ');
  check('digest tells work with start and end', dayStr.includes('work — 8h00 (9:00am–5:00pm)'), dayStr);
  check('digest tells gym with start and end', dayStr.includes('gym — 1h05 (5:25pm–6:30pm)'), dayStr);
  check('digest tells the reel with start and end', dayStr.includes('editing — 1h30 (8:30pm–10:00pm)'), dayStr);
  check('digest keeps chronological order',
    dayStr.indexOf('work') < dayStr.indexOf('gym') && dayStr.indexOf('gym') < dayStr.indexOf('editing'), dayStr);
  check('digest has no aggregation counters', !dayStr.includes('×'), dayStr);
  check('digest totals line covers buckets and transit',
    typeof body.totals === 'string' && body.totals.includes('work 8h00')
      && body.totals.includes('gym 1h05') && body.totals.includes('editing 1h30')
      && body.totals.includes('transit'), body.totals);
  check('digest reports gym streak', body.streak >= 1, String(body.streak));
  check('an honest day earns no note', body.note === null, String(body.note));
  check('digest body is multi-line with title first',
    body.body.startsWith(body.title + '\n') && body.body.split('\n').length >= 4, body.body);

  // 21c. a lazy day earns the requested verdict
  const lazyDay = addDays(yesterday, -3);
  const [lz, lm, ld] = lazyDay.split('-').map(Number);
  const lazyAt = (h, mi) => new Date(zonedTimeToUtc(lz, lm, ld, h, mi, TZ)).toISOString();
  await post(lazyAt(10, 0), 'left_home');
  await post(lazyAt(10, 30), 'arrived_home');
  r = await fetch(BASE + `/digest?date=${lazyDay}&tz=${TZ}`, { headers: KEY });
  body = await r.json();
  check('a lazy day earns a verdict note',
    typeof body.note === 'string' && body.note.length > 20, String(body.note));
  // Weekly rides along exactly when the reported day is a Sunday — judge
  // the day this body actually reports (the lazy day), not yesterday.
  const lazyDayIsSunday = new Intl.DateTimeFormat('en', {
    timeZone: TZ, weekday: 'short',
  }).format(new Date(zonedTimeToUtc(lz, lm, ld, 12, 0, TZ))) === 'Sun';
  check('digest body is notification-ready text',
    typeof body.body === 'string' && body.body.length > 20 && !!body.week === lazyDayIsSunday,
    body.body);

  // 21b. no date param -> reports the completed prior day
  r = await fetch(BASE + `/digest?tz=${TZ}`, { headers: KEY });
  body = await r.json();
  check('GET /digest default date -> yesterday', body.date === yesterday,
    body.date + ' vs ' + yesterday);

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

  // ——— vitals + the analyst ————————————————————————————————————
  const ANALYST = { 'x-api-key': 'analyst-key-456' };

  // metric ingest + upsert + validation (operator key)
  r = await fetch(BASE + '/metrics', {
    method: 'POST', headers: { ...KEY, ...JSON_CT },
    body: JSON.stringify({ day: yesterday, name: 'calories', value: 2140, unit: 'kcal', source: 'health' }),
  });
  check('POST /metrics -> ok', r.status === 200, r.status);
  r = await fetch(BASE + '/metrics', {
    method: 'POST', headers: { ...KEY, ...JSON_CT },
    body: JSON.stringify({ day: yesterday, name: 'weight', value: 182.6, unit: 'lb', source: 'health' }),
  });
  check('POST /metrics second metric -> ok', r.status === 200, r.status);
  r = await fetch(BASE + '/metrics', {
    method: 'POST', headers: { ...KEY, ...JSON_CT },
    body: JSON.stringify({ day: yesterday, name: 'calories', value: 2200, unit: 'kcal' }),
  });
  check('POST /metrics same day+name upserts', r.status === 200, r.status);
  r = await fetch(BASE + `/metrics?from=${yesterday}`, { headers: KEY });
  body = await r.json();
  check('GET /metrics -> 2 rows after upsert',
    body.length === 2 && Number(body.find((m) => m.name === 'calories').value) === 2200,
    JSON.stringify(body));
  r = await fetch(BASE + '/metrics', {
    method: 'POST', headers: { ...KEY, ...JSON_CT },
    body: JSON.stringify({ name: 'Bad Name', value: 1 }),
  });
  check('POST /metrics bad name -> 400', r.status === 400, r.status);
  r = await fetch(BASE + '/metrics', {
    method: 'POST', headers: { ...KEY, ...JSON_CT },
    body: JSON.stringify({ name: 'weight', value: 'heavy' }),
  });
  check('POST /metrics non-numeric value -> 400', r.status === 400, r.status);

  // analyst key: may read the record and file notes, nothing else
  r = await fetch(BASE + '/events', { headers: ANALYST });
  check('analyst key may read /events', r.status === 200, r.status);
  r = await fetch(BASE + `/digest?date=${yesterday}&tz=${TZ}`, { headers: ANALYST });
  check('analyst key may read /digest', r.status === 200, r.status);
  r = await fetch(BASE + '/events', {
    method: 'POST', headers: { ...ANALYST, ...JSON_CT },
    body: JSON.stringify({ ts: new Date().toISOString(), event: 'forged_event' }),
  });
  check('analyst key cannot write events -> 401', r.status === 401, r.status);
  r = await fetch(BASE + '/metrics', {
    method: 'POST', headers: { ...ANALYST, ...JSON_CT },
    body: JSON.stringify({ name: 'weight', value: 1 }),
  });
  check('analyst key cannot write metrics -> 401', r.status === 401, r.status);

  r = await fetch(BASE + '/analyst', {
    method: 'POST', headers: { ...ANALYST, ...JSON_CT },
    body: JSON.stringify({
      day: yesterday,
      briefing: 'A strong editing night followed the gym; guard the pre-9pm start.',
      observations: ['gym at 17:25 for 1h05', 'editing started at 20:30 for 1h30'],
      suggestions: ['repeat the gym-then-editing pairing on Wednesday'],
    }),
  });
  body = await r.json();
  check('analyst key files a note -> ok', r.status === 200 && body.ok === true, JSON.stringify(body));
  r = await fetch(BASE + '/analyst?limit=5', { headers: ANALYST });
  body = await r.json();
  check('GET /analyst -> note with parsed arrays',
    body.length === 1 && body[0].observations.length === 2 && body[0].suggestions.length === 1,
    JSON.stringify(body));
  r = await fetch(BASE + '/analyst', {
    method: 'POST', headers: { ...ANALYST, ...JSON_CT },
    body: JSON.stringify({ day: yesterday, briefing: '', observations: [], suggestions: [] }),
  });
  check('POST /analyst empty briefing -> 400', r.status === 400, r.status);

  // digest carries vitals + the analyst's line
  r = await fetch(BASE + `/digest?date=${yesterday}&tz=${TZ}`, { headers: KEY });
  body = await r.json();
  check('digest vitals line orders weight before calories',
    body.vitals === 'vitals: weight 182.6 lb · 2,200 kcal', body.vitals);
  check('digest body carries the analyst briefing',
    body.body.includes('the analyst: A strong editing night'), body.body);

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
