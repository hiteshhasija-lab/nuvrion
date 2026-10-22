// Capacity forecasts (docs/capacity.md): how fast a datastore is filling and when it will be full. Pure functions, shared by both stores and the API so they cannot disagree.
//
// Nuvrion records the size and free space of every datastore about every half hour. A forecast is a straight line fitted (least squares) through the used space of the last 14 days. It is
// deliberately simple and says how far to trust it: a line through three days of data is a hint, a line through two weeks that hugs the points is a plan. Three things are never guessed:
// a datastore with too little history, one whose size changed inside the window (only the samples since the change are used) and one whose growth is too small to matter.

export const SAMPLE_INTERVAL_MS = 30 * 60_000;          // at most one sample per datastore per half hour
export const RETENTION_DAYS = 90;
export const WINDOW_DAYS = 14;
export const MIN_SAMPLES = 6;
export const MIN_SPAN_MS = 24 * 3_600_000;               // a forecast needs a full day of history
export const HORIZON_DAYS = 3650;                         // beyond ten years the answer is "no end in sight"
export const STABLE_SHARE = 0.01;                         // under 1% of the size gained or lost in 30 days counts as stable
export const DAY_MS = 86_400_000;

const finite = value => typeof value === 'number' && Number.isFinite(value);
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

// What may be recorded for a datastore: sizes are whole non-negative numbers of bytes, the free space cannot exceed the size, the time is a real time.
// Returns { capacityBytes, freeBytes, usedBytes, at } or null when the reading cannot be trusted.
export function sanitizeReading({ capacityBytes, freeBytes, observedAt }) {
  const at = typeof observedAt === 'number' ? observedAt : new Date(observedAt ?? '').getTime();
  if (!finite(capacityBytes) || !finite(freeBytes) || !finite(at) || capacityBytes <= 0 || freeBytes < 0 || freeBytes > capacityBytes) return null;
  return { capacityBytes: Math.round(capacityBytes), freeBytes: Math.round(freeBytes), usedBytes: Math.round(capacityBytes) - Math.round(freeBytes), at };
}

// Whether a new reading is worth keeping given the readings already kept for the same datastore (ascending by time): not when one is within the interval, unless the size changed.
export function worthKeeping(reading, kept, intervalMs = SAMPLE_INTERVAL_MS) {
  const near = kept.filter(sample => Math.abs(sample.at - reading.at) < intervalMs);
  if (!near.length) return true;
  return near.every(sample => sample.capacityBytes !== reading.capacityBytes) && !near.some(sample => sample.at === reading.at);
}

// samples: [{ at (ms), capacityBytes, usedBytes }] ascending. Returns the forecast:
//   status      insufficient | full | stable | growing | shrinking
//   confidence  low | medium | high (from how long the history is and how closely the points follow the line); null when insufficient
//   growthBytesPerDay, daysUntilFull (growing only; 0 when full), projectedFullAt (ISO, growing and within ten years), and what the forecast rests on.
export function forecast(samples, { now = Date.now(), windowDays = WINDOW_DAYS } = {}) {
  const inWindow = samples.filter(sample => sample.at <= now && sample.at >= now - windowDays * DAY_MS);
  const latest = inWindow.at(-1) ?? samples.filter(sample => sample.at <= now).at(-1) ?? null;
  const base = { status: 'insufficient', confidence: null, growthBytesPerDay: null, daysUntilFull: null, projectedFullAt: null, sampleCount: 0, spanDays: 0, usedBytes: latest?.usedBytes ?? null, capacityBytes: latest?.capacityBytes ?? null, freeBytes: latest ? latest.capacityBytes - latest.usedBytes : null };
  if (!latest) return base;
  // only the samples since the datastore last changed size
  let start = inWindow.length;
  while (start > 0 && inWindow[start - 1].capacityBytes === latest.capacityBytes) start--;
  const used = inWindow.slice(start);
  const span = used.length ? used.at(-1).at - used[0].at : 0;
  const described = { ...base, sampleCount: used.length, spanDays: round(span / DAY_MS) };
  if (latest.usedBytes >= latest.capacityBytes) return { ...described, status: 'full', daysUntilFull: 0, projectedFullAt: new Date(latest.at).toISOString(), confidence: 'high' };
  if (used.length < MIN_SAMPLES || span < MIN_SPAN_MS) return described;
  // least squares on (time since the first sample, used bytes)
  const t0 = used[0].at, n = used.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (const sample of used) { const x = (sample.at - t0) / DAY_MS, y = sample.usedBytes; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y; }
  const denominator = n * sxx - sx * sx;
  if (denominator <= 0) return described;
  const slope = (n * sxy - sx * sy) / denominator;                                 // bytes per day
  const varianceY = n * syy - sy * sy;
  const r2 = varianceY <= 0 ? 1 : Math.min(1, Math.max(0, (n * sxy - sx * sy) ** 2 / (denominator * varianceY)));
  const spanDays = span / DAY_MS;
  const confidence = spanDays >= 7 && r2 >= 0.9 ? 'high' : spanDays >= 3 && r2 >= 0.7 ? 'medium' : 'low';
  const result = { ...described, confidence, growthBytesPerDay: Math.round(slope), fit: round(r2, 2) };
  if (Math.abs(slope) * 30 < STABLE_SHARE * latest.capacityBytes) return { ...result, status: 'stable' };
  if (slope < 0) return { ...result, status: 'shrinking' };
  const days = (latest.capacityBytes - latest.usedBytes) / slope;
  if (days > HORIZON_DAYS) return { ...result, status: 'growing', daysUntilFull: null };
  return { ...result, status: 'growing', daysUntilFull: round(days), projectedFullAt: new Date(latest.at + days * DAY_MS).toISOString() };
}

// The measurement an alert rule can watch, in days: a datastore that will be full in so many days. Only a forecast we trust is reported; "not reported" is not zero.
//   full -> 0; growing with a date -> the days; stable, shrinking or too slow to matter -> the horizon (so an alert clears); anything uncertain -> null.
export function daysUntilFullForAlert(f) {
  if (!f) return null;
  if (f.status === 'full') return 0;
  if (f.confidence === null || f.confidence === 'low') return null;
  if (f.status === 'growing') return f.daysUntilFull === null ? HORIZON_DAYS : Math.min(HORIZON_DAYS, f.daysUntilFull);
  if (f.status === 'stable' || f.status === 'shrinking') return HORIZON_DAYS;
  return null;
}

// A series for a small chart: at most `points` values (used share of the size, 0 to 100), taken evenly across the samples.
export function trend(samples, points = 28) {
  if (!samples.length) return [];
  const share = sample => round(sample.usedBytes / sample.capacityBytes * 100, 2);
  if (samples.length <= points) return samples.map(share);
  const out = [];
  for (let i = 0; i < points; i++) out.push(share(samples[Math.round(i * (samples.length - 1) / (points - 1))]));
  return out;
}

// The same thinning for the detail chart, keeping the first and last samples: [{ at: ISO, usedBytes, capacityBytes }].
export function chartPoints(samples, max = 240) {
  const pick = samples.length <= max ? samples : Array.from({ length: max }, (_, i) => samples[Math.round(i * (samples.length - 1) / (max - 1))]);
  return pick.map(sample => ({ at: new Date(sample.at).toISOString(), usedBytes: sample.usedBytes, capacityBytes: sample.capacityBytes }));
}

// One sentence for a forecast, shared by the console and the documents.
export function describeForecast(f) {
  if (!f) return 'No forecast';
  const gb = bytes => `${round(Math.abs(bytes) / 1024 ** 3, 1)} GB`;
  if (f.status === 'full') return 'Full';
  if (f.status === 'insufficient') return 'Not enough history yet (needs a day of readings)';
  if (f.status === 'stable') return 'Stable: no meaningful growth';
  if (f.status === 'shrinking') return `Shrinking by about ${gb(f.growthBytesPerDay)} a day`;
  if (f.daysUntilFull === null) return `Growing by about ${gb(f.growthBytesPerDay)} a day, not full within ten years`;
  return `Growing by about ${gb(f.growthBytesPerDay)} a day: full in about ${f.daysUntilFull} day${f.daysUntilFull === 1 ? '' : 's'}`;
}
