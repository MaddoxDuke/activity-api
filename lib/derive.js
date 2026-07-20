'use strict';

// Server-side twin of the dashboard's derive layer (activity-dash
// src/app/lib/derive.ts). Same rules, so the phone digest and the almanac
// never disagree: a missed event degrades into a gap, never corrupt hours.

const MAX_SESSION_MS = 16 * 3600_000;
const MAX_TRANSIT_MS = 3 * 3600_000;

const PLACE_RE = /^(arrived|left)_([a-z0-9_]+)$/;
const ACTIVITY_RE = /^([a-z0-9_]+)_(start|stop)$/;

function parseEvents(rows) {
  return rows
    .map((e) => {
      const m = PLACE_RE.exec(e.event);
      const a = m ? null : ACTIVITY_RE.exec(e.event);
      return {
        tsMs: new Date(e.ts).getTime(),
        event: e.event,
        source: e.source ?? 'unknown',
        kind: m ? m[1] : null,
        place: m ? m[2] : null,
        activity: a ? a[1] : null,
        phase: a ? a[2] : null,
      };
    })
    .filter((e) => Number.isFinite(e.tsMs))
    .sort((a, b) => a.tsMs - b.tsMs);
}

/** Places: arrived_X opens, left_X closes, a new arrival closes as inferred. */
function deriveSessions(events, nowMs) {
  const sessions = [];
  let open = null;
  let orphans = 0;

  const close = (endMs, end) => {
    if (!open) return;
    const dur = endMs - open.startMs;
    sessions.push({
      place: open.place,
      startMs: open.startMs,
      endMs,
      end,
      valid: end !== 'unknown' && dur > 0 && dur <= MAX_SESSION_MS,
    });
    open = null;
  };

  for (const ev of events) {
    if (!ev.kind) continue;
    if (ev.kind === 'arrived') {
      if (open && open.place === ev.place) continue;
      close(ev.tsMs, 'inferred');
      open = { place: ev.place, startMs: ev.tsMs };
    } else if (open && open.place === ev.place) {
      close(ev.tsMs, 'explicit');
    } else {
      orphans++;
    }
  }
  if (open) {
    if (nowMs - open.startMs <= MAX_SESSION_MS) close(nowMs, 'ongoing');
    else close(open.startMs + MAX_SESSION_MS, 'unknown');
  }
  return { sessions, orphans };
}

/** Activities: per-name start/stop tracks, overlapping places freely. */
function deriveActivities(events, nowMs) {
  const activities = [];
  const open = new Map();
  let orphans = 0;

  const close = (name, endMs, end) => {
    const o = open.get(name);
    if (!o) return;
    const dur = endMs - o.startMs;
    activities.push({
      place: name,
      startMs: o.startMs,
      endMs,
      end,
      valid: end !== 'unknown' && dur > 0 && dur <= MAX_SESSION_MS,
    });
    open.delete(name);
  };

  for (const ev of events) {
    if (!ev.activity) continue;
    if (ev.phase === 'start') {
      if (open.has(ev.activity)) close(ev.activity, ev.tsMs, 'unknown');
      open.set(ev.activity, { startMs: ev.tsMs });
    } else if (open.has(ev.activity)) {
      close(ev.activity, ev.tsMs, 'explicit');
    } else {
      orphans++;
    }
  }
  for (const name of [...open.keys()]) {
    const o = open.get(name);
    if (nowMs - o.startMs <= MAX_SESSION_MS) close(name, nowMs, 'ongoing');
    else close(name, o.startMs + MAX_SESSION_MS, 'unknown');
  }
  activities.sort((a, b) => a.startMs - b.startMs);
  return { activities, orphans };
}

/** Journeys: explicit left_X then arrived_Y within the transit window. */
function deriveTransitions(events) {
  const placeEvents = events.filter((e) => e.kind !== null);
  const out = [];
  for (let i = 0; i < placeEvents.length - 1; i++) {
    const a = placeEvents[i];
    const b = placeEvents[i + 1];
    if (a.kind !== 'left' || b.kind !== 'arrived') continue;
    const gap = b.tsMs - a.tsMs;
    if (gap > 0 && gap <= MAX_TRANSIT_MS) {
      out.push({ from: a.place, to: b.place, departMs: a.tsMs, minutes: gap / 60_000 });
    }
  }
  return out;
}

/** Overlap of a session with [aMs, bMs), in hours. */
function overlapHours(s, aMs, bMs) {
  const lo = Math.max(s.startMs, aMs);
  const hi = Math.min(s.endMs, bMs);
  return hi > lo ? (hi - lo) / 3600_000 : 0;
}

// ——— timezone helpers (no deps; Node's full ICU) ———————————————

function zonedParts(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short',
  }).formatToParts(ms);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    y: +get('year'), mo: +get('month'), d: +get('day'),
    h: +get('hour') % 24, mi: +get('minute'), s: +get('second'),
    weekday: get('weekday'),
  };
}

/** UTC ms of a wall-clock time in tz (iterative, DST-safe). */
function zonedTimeToUtc(y, mo, d, h, mi, tz) {
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, tz);
    const got = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    const want = Date.UTC(y, mo - 1, d, h, mi);
    if (got === want) break;
    guess += want - got;
  }
  return guess;
}

function dayWindow(dateStr, tz) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const start = zonedTimeToUtc(y, mo, d, 0, 0, tz);
  const next = new Date(Date.UTC(y, mo - 1, d));
  next.setUTCDate(next.getUTCDate() + 1);
  const end = zonedTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, tz);
  return { start, end };
}

function dayKeyInTz(ms, tz) {
  const p = zonedParts(ms, tz);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

/** Monday 00:00 of the week containing dateStr, plus offsets in days. */
function mondayOf(dateStr, tz) {
  const { start } = dayWindow(dateStr, tz);
  const wd = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[zonedParts(start, tz).weekday];
  return addDays(dateStr, -wd);
}

function addDays(dateStr, days) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

function clockInTz(ms, tz) {
  const p = zonedParts(ms, tz);
  return `${p.h}:${String(p.mi).padStart(2, '0')}`;
}

function clock12InTz(ms, tz) {
  const p = zonedParts(ms, tz);
  const h12 = p.h % 12 || 12;
  return `${h12}:${String(p.mi).padStart(2, '0')}${p.h < 12 ? 'am' : 'pm'}`;
}

/** Consecutive-day visit streak for a place, counted back from dateStr. */
function placeStreakAsOf(sessions, place, dateStr, tz) {
  const days = new Set(
    sessions.filter((s) => s.valid && s.place === place).map((s) => dayKeyInTz(s.startMs, tz)),
  );
  let cursor = dateStr;
  if (!days.has(cursor)) cursor = addDays(cursor, -1); // the day may not be done
  let streak = 0;
  while (days.has(cursor)) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

module.exports = {
  MAX_SESSION_MS,
  MAX_TRANSIT_MS,
  parseEvents,
  deriveSessions,
  deriveActivities,
  deriveTransitions,
  overlapHours,
  zonedParts,
  zonedTimeToUtc,
  dayWindow,
  dayKeyInTz,
  mondayOf,
  addDays,
  clockInTz,
  clock12InTz,
  placeStreakAsOf,
};
