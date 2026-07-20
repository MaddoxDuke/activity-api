'use strict';

// The evening dispatch: one day's account plus, on Sundays (or on demand),
// a week-over-week reading with a little deterministic advice. Pure
// functions over parsed events — no queries, no clock reads, no LLM.

const {
  parseEvents,
  deriveSessions,
  deriveActivities,
  deriveTransitions,
  overlapHours,
  dayWindow,
  mondayOf,
  addDays,
  clock12InTz,
  placeStreakAsOf,
  dayKeyInTz,
  zonedParts,
} = require('./derive');

/** Display order and phone-friendly names; activities render by name. */
const BUCKET_LABEL = { work: 'work', gym: 'gym', shop: 'shop', editing: 'editing', home: 'home' };
const BUCKET_ORDER = ['work', 'gym', 'shop', 'editing', 'driving', 'home'];

function fmtH(hours) {
  const m = Math.round(hours * 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

function label(name) {
  return BUCKET_LABEL[name] ?? name.replace(/_/g, ' ');
}

function orderKeys(keys) {
  return [...keys].sort((a, b) => {
    const ra = BUCKET_ORDER.indexOf(a);
    const rb = BUCKET_ORDER.indexOf(b);
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb) || a.localeCompare(b);
  });
}

/** All valid sessions (places + activities) with per-window overlap hours. */
function hoursByBucket(sessions, activities, aMs, bMs) {
  const out = {};
  for (const s of [...sessions, ...activities]) {
    if (!s.valid) continue;
    const h = overlapHours(s, aMs, bMs);
    if (h > 0) out[s.place] = (out[s.place] ?? 0) + h;
  }
  return out;
}

/** Compact one-line vitals from the day's metrics, familiar names first. */
function vitalsLine(dayMetrics) {
  if (!dayMetrics?.length) return null;
  const order = ['weight', 'calories', 'protein', 'steps'];
  const sorted = [...dayMetrics].sort((a, b) => {
    const ra = order.indexOf(a.name);
    const rb = order.indexOf(b.name);
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb) || a.name.localeCompare(b.name);
  });
  const parts = sorted.map((m) => {
    const v = Number(m.value);
    const shown = Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(1);
    if (m.name === 'calories') return `${shown} ${m.unit ?? 'kcal'}`;
    if (m.name === 'steps') return `${shown} steps`;
    return `${m.name.replace(/_/g, ' ')} ${shown}${m.unit ? ` ${m.unit}` : ''}`;
  });
  return `vitals: ${parts.join(' · ')}`;
}

function buildDigest(
  rows,
  { date, tz, nowMs, forceWeekly = false, dayMetrics = [], analystBriefing = null },
) {
  const events = parseEvents(rows);
  const { sessions, orphans } = deriveSessions(events, nowMs);
  const { activities, orphans: activityOrphans } = deriveActivities(events, nowMs);
  const transitions = deriveTransitions(events);

  const { start: dayStart, end: dayEnd } = dayWindow(date, tz);

  // ——— the day, told in order ————————————————————————————
  const pool = [...sessions, ...activities].sort((a, b) => a.startMs - b.startMs);
  const dayLines = [];
  for (const s of pool) {
    if (!s.valid && s.end !== 'unknown') continue;
    const h = overlapHours(s, dayStart, dayEnd);
    if (h <= 0) continue;
    const from = clock12InTz(Math.max(s.startMs, dayStart), tz);
    const to = clock12InTz(Math.min(s.endMs, dayEnd), tz);
    if (s.end === 'unknown') {
      dayLines.push(`${label(s.place)} — end unrecorded (started ${from})`);
    } else if (s.end === 'ongoing') {
      dayLines.push(`${label(s.place)} — ${fmtH(h)} so far (${from}–now)`);
    } else {
      dayLines.push(`${label(s.place)} — ${fmtH(h)} (${from}–${to})`);
    }
  }

  const transitMin = transitions
    .filter((t) => t.departMs >= dayStart && t.departMs < dayEnd)
    .reduce((m, t) => m + t.minutes, 0);

  const dayEventCount = events.filter((e) => e.tsMs >= dayStart && e.tsMs < dayEnd).length;
  if (dayLines.length === 0) {
    dayLines.push(dayEventCount === 0 ? 'a quiet ledger — no events recorded' : 'events recorded, but nothing paired into time yet');
  }

  // ——— footer: totals, streak, and the note you asked for ————
  const totalsBy = hoursByBucket(sessions, activities, dayStart, dayEnd);
  const totalParts = orderKeys(Object.keys(totalsBy))
    .filter((n) => n !== 'home')
    .map((n) => `${label(n)} ${fmtH(totalsBy[n])}`);
  if (transitMin >= 10) totalParts.push(`transit ${fmtH(transitMin / 60)}`);
  const totals = totalParts.length ? `totals: ${totalParts.join(' · ')}` : null;

  const gymStreak = placeStreakAsOf(sessions, 'gym', date, tz);
  const streakLine = gymStreak >= 1 ? `gym streak: ${gymStreak} day${gymStreak === 1 ? '' : 's'}` : null;

  const note = buildNote({ totalsBy, dayEventCount, date, tz, sessions });

  // ——— the weekly reading (Sundays, or forced) ——————————————
  const isSunday = zonedParts(dayStart, tz).weekday === 'Sun';
  let week = null;
  if (isSunday || forceWeekly) {
    week = buildWeekly({ events, sessions, activities, orphans, activityOrphans, date, tz, nowMs });
  }

  const p = zonedParts(dayStart, tz);
  const title = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'long', day: 'numeric', month: 'long',
  }).format(dayStart);

  const bodyParts = [title, ...dayLines];
  const vitals = vitalsLine(dayMetrics);
  const analyst = analystBriefing ? `the analyst: ${analystBriefing}` : null;
  const footer = [totals, vitals, streakLine, note, analyst].filter(Boolean);
  if (footer.length) bodyParts.push('—', ...footer);
  if (week) {
    bodyParts.push('—', `This week: ${week.lines.join(' · ')}`);
    for (const a of week.advice) bodyParts.push(a);
  }

  return {
    date,
    tz,
    title,
    day: dayLines,
    totals,
    vitals,
    analyst: analystBriefing,
    streak: gymStreak,
    note,
    week,
    body: bodyParts.join('\n'),
    generatedAt: new Date(nowMs).toISOString(),
    meta: { events: dayEventCount, y: p.y },
  };
}

/**
 * The note you asked for: the ledger speaks only when the day convicts you.
 * Deterministic — same date, same verdict — and silent on honest days.
 */
function buildNote({ totalsBy, dayEventCount, date, tz, sessions }) {
  if (dayEventCount === 0) return null; // no data is a tracking gap, not sloth

  const productive =
    (totalsBy.work ?? 0) + (totalsBy.gym ?? 0) + (totalsBy.shop ?? 0) + (totalsBy.editing ?? 0);
  const pick = (arr) => arr[[...date].reduce((h, c) => h + c.charCodeAt(0), 0) % arr.length];

  let line = null;
  if (productive < 0.5) {
    line = pick([
      'Verdict: zero productive hours. The ledger records; the shame is entirely yours, chud.',
      'A blank page — not the good kind. The bar, the editing desk and the shop all report you missing.',
      'A full day at home and nothing paired against it. Future-you will read this page. He is not impressed.',
    ]);
  } else if (productive < 2) {
    line = pick([
      `Verdict: ${fmtH(productive)} of productive time. The ledger calls that a rounding error, not a day.`,
      `${fmtH(productive)} on the books all day. The couch logged more hours than you did.`,
    ]);
  }

  // A gym drought earns its own jab, appended or standing alone. Only
  // visits before the reported day's end count — the report can't be
  // absolved by a workout that happened after it.
  const lastGym = sessions
    .filter((s) => s.valid && s.place === 'gym' && s.startMs < dayWindow(date, tz).end)
    .at(-1);
  if (lastGym) {
    const daysSince = Math.max(
      0,
      Math.round((dayWindow(date, tz).start - dayWindow(dayKeyInTz(lastGym.startMs, tz), tz).start) / 86_400_000),
    );
    if (daysSince >= 3) {
      const jab = `${daysSince} days since the gym last saw you. The streak folio is a graveyard.`;
      line = line ? `${line} ${jab}` : `Verdict: ${jab}`;
    }
  }

  return line;
}

function buildWeekly({ sessions, activities, orphans, activityOrphans, date, tz, nowMs }) {
  const monday = mondayOf(date, tz);
  const weekA = dayWindow(monday, tz).start;
  const weekB = dayWindow(addDays(monday, 7), tz).start;
  const prevA = dayWindow(addDays(monday, -7), tz).start;

  const cur = hoursByBucket(sessions, activities, weekA, Math.min(weekB, nowMs));
  const prev = hoursByBucket(sessions, activities, prevA, weekA);

  const lines = [];
  for (const name of orderKeys(new Set([...Object.keys(cur), ...Object.keys(prev)]))) {
    if (name === 'home') continue; // home hours dominate and say little
    const c = cur[name] ?? 0;
    const p = prev[name] ?? 0;
    if (c < 0.05 && p < 0.05) continue;
    const deltaM = Math.round((c - p) * 60);
    const arrow = Math.abs(deltaM) < 15 ? '—' : deltaM > 0 ? `▲${fmtH(Math.abs(deltaM) / 60)}` : `▼${fmtH(Math.abs(deltaM) / 60)}`;
    lines.push(`${label(name)} ${fmtH(c)} (${arrow})`);
  }
  if (lines.length === 0) lines.push('not enough on the books yet');

  const gymVisits = sessions.filter(
    (s) => s.valid && s.place === 'gym' && s.startMs >= weekA && s.startMs < weekB,
  ).length;
  if (gymVisits > 0) lines.push(`gym ${gymVisits} visit${gymVisits === 1 ? '' : 's'}`);

  return { monday, lines, advice: buildAdvice({ sessions, activities, orphans, activityOrphans, weekA, weekB, prevA, tz }) };
}

/**
 * Deterministic counsel, at most two lines, only where the data earns it.
 * Tone: the almanac observing, not a coach shouting.
 */
function buildAdvice({ sessions, activities, orphans, activityOrphans, weekA, weekB, prevA, tz }) {
  const advice = [];

  const bench = activities.filter((a) => a.valid && a.place === 'editing');
  const shopH = sessions.filter((s) => s.valid && s.place === 'shop')
    .reduce((h, s) => h + overlapHours(s, weekA, weekB), 0);
  const benchH = bench.reduce((h, s) => h + overlapHours(s, weekA, weekB), 0);

  // 1. The trade, when it tilts hard and both benches are in play.
  if (shopH >= 1 && benchH >= 0 && shopH > 2 * Math.max(benchH, 0.5)) {
    advice.push(
      `the shop took ${fmtH(shopH)} to editing's ${fmtH(benchH)} this week — one traded evening is roughly one rough cut reviewed.`,
    );
  }

  // 2. Late starts at the bench, when history says earlier runs longer.
  const recent = bench.slice(-21);
  if (recent.length >= 6) {
    const startHour = (s) => {
      const p = zonedParts(s.startMs, tz);
      return p.h + p.mi / 60;
    };
    const weekBench = recent.filter((s) => s.startMs >= weekA && s.startMs < weekB);
    const top3 = [...recent].sort((a, b) => (b.endMs - b.startMs) - (a.endMs - a.startMs)).slice(0, 3);
    const medWeekStart = median(weekBench.map(startHour));
    if (weekBench.length >= 2 && medWeekStart !== null && medWeekStart >= 21.5 && top3.every((s) => startHour(s) < 21)) {
      advice.push('your longest editing sessions started before 21:00; this week the first session began at ' +
        `${Math.floor(medWeekStart)}:${String(Math.round((medWeekStart % 1) * 60)).padStart(2, '0')} — protect one earlier evening.`);
    }
    // 3. Fragmentation, only without a late-start note (one theme at a time).
    const medLen = median(weekBench.map((s) => (s.endMs - s.startMs) / 60_000));
    if (advice.length < 2 && weekBench.length >= 4 && medLen !== null && medLen < 60) {
      advice.push(`${weekBench.length} editing sittings with a median of ${Math.round(medLen)}m — fewer, longer sessions tend to survive to export.`);
    }
  }

  // 4. Gym cadence against last week's own rhythm.
  const visitsIn = (a, b) =>
    sessions.filter((s) => s.valid && s.place === 'gym' && s.startMs >= a && s.startMs < b).length;
  const curVisits = visitsIn(weekA, weekB);
  const prevVisits = visitsIn(prevA, weekA);
  if (advice.length < 2 && prevVisits >= 2 && curVisits < prevVisits) {
    advice.push(`gym ×${curVisits} against ×${prevVisits} last week — the streak folio remembers.`);
  }

  // 5. Instrumentation health beats optimisation advice when the record leaks.
  const holes = orphans + activityOrphans;
  if (advice.length < 2 && holes >= 3) {
    advice.push(`${holes} unpaired events on the books — a leaky record undercounts everything; worth checking the shortcuts.`);
  }

  return advice.slice(0, 2);
}

function median(nums) {
  const xs = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

module.exports = { buildDigest, fmtH };
