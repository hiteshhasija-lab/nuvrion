// Capacity in the console (docs/capacity.md): the datastore table with when each will be full, a small trend beside it, and the dialog with a chart of one datastore's history and
// the line the forecast follows. Pure functions, kept apart from app.js so they can be tested in node; app.js passes in `esc`, `when` (date and time) and `day` (date). The server
// works out the forecast; nothing here decides what the numbers are.

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const TIERS = { bad: 14, warn: 30 };   // days: a datastore full within two weeks is urgent, within a month needs attention

export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—';
  const abs = Math.abs(bytes);
  if (abs >= 1024 ** 4) return `${round(bytes / 1024 ** 4, abs >= 10 * 1024 ** 4 ? 0 : 1)} TB`;
  if (abs >= 1024 ** 3) return `${round(bytes / 1024 ** 3, abs >= 100 * 1024 ** 3 ? 0 : 1)} GB`;
  return `${round(bytes / 1024 ** 2, 0)} MB`;
}

// How urgent a forecast is: bad, warn, good or neutral (nothing known).
export function tierOf(forecast) {
  if (!forecast) return 'neutral';
  if (forecast.status === 'full') return 'bad';
  if (forecast.status === 'insufficient') return 'neutral';
  if (forecast.status === 'growing' && forecast.daysUntilFull !== null) return forecast.daysUntilFull <= TIERS.bad ? 'bad' : forecast.daysUntilFull <= TIERS.warn ? 'warn' : 'good';
  return 'good';
}

export function daysText(days) {
  if (days === null || days === undefined) return '—';
  if (days < 1) return 'less than a day';
  return plural(Math.round(days), 'day');
}

// What the page says about the whole estate in one phrase.
export function summaryOf(items) {
  if (!items.length) return { tone: 'neutral', text: 'No datastores' };
  const urgent = items.filter(item => tierOf(item.forecast) === 'bad').length, soon = items.filter(item => ['bad', 'warn'].includes(tierOf(item.forecast))).length;
  if (urgent) return { tone: 'bad', text: `${urgent} full within 14 days` };
  if (soon) return { tone: 'warn', text: `${soon} full within 30 days` };
  return { tone: 'good', text: 'None full within 30 days' };
}

// ---- the small trend ----------------------------------------------------------------------------------------------------------------------------------------------------
// values: used share of the size (0 to 100) over time. Drawn between its own lowest and highest value (at least 2 points of range) so a slow rise is visible.
export function sparklineSvg(values, { width = 96, height = 28 } = {}) {
  if (!Array.isArray(values) || values.length < 2) return '<span class="capacity-nospark">—</span>';
  const low = Math.min(...values), high = Math.max(...values), range = Math.max(high - low, 2), floor = low - (range - (high - low)) / 2;
  const x = i => round(2 + (width - 4) * i / (values.length - 1), 1), y = value => round(height - 3 - (height - 6) * (value - floor) / range, 1);
  const points = values.map((value, i) => `${x(i)},${y(value)}`).join(' ');
  const label = `Used space over the last 14 days: from ${round(values[0], 1)}% to ${round(values.at(-1), 1)}%`;
  return `<svg class="capacity-spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${label}"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

// ---- the table ----------------------------------------------------------------------------------------------------------------------------------------------------------
function fullInCell(item, { esc, day }) {
  const f = item.forecast, tier = tierOf(f);
  const badge = text => `<span class="badge ${tier}">${esc(text)}</span>`;
  if (f.status === 'full') return `${badge('Full')}`;
  if (f.status === 'insufficient') return `<span class="capacity-unknown">Not enough history yet</span><small class="block">${esc(plural(f.sampleCount, 'reading'))} so far</small>`;
  if (f.status === 'stable') return `${badge('Not filling')}<small class="block">Stable</small>`;
  if (f.status === 'shrinking') return `${badge('Shrinking')}`;
  const confidence = f.confidence ? `<small class="block">${esc(f.confidence)} confidence</small>` : '';
  if (f.daysUntilFull === null) return `${badge('Not within ten years')}${confidence}`;
  return `${badge(daysText(f.daysUntilFull))}<small class="block">about ${esc(day(f.projectedFullAt))}</small>${confidence}`;
}

export function capacityRowsHtml(items, { esc, when, day }) {
  if (!items.length) return '<tr><td colspan="7"><div class="empty compact"><strong>No datastores yet</strong><p>Datastores appear here once a VMware connection has reported them. Capacity needs about a day of readings before it can say when a datastore will be full.</p></div></td></tr>';
  return items.map(item => {
    const used = item.usedPercent, bar = used === null ? '' : `<span class="capacity-bar" role="img" aria-label="${esc(round(used, 1))}% used"><span style="width:${Math.max(0, Math.min(100, used))}%" class="${used >= 90 ? 'bad' : used >= 75 ? 'warn' : 'good'}"></span></span>`;
    const growth = item.forecast.growthBytesPerDay === null ? '—' : `${item.forecast.growthBytesPerDay >= 0 ? '+' : '−'}${formatBytes(Math.abs(item.forecast.growthBytesPerDay))} a day`;
    const stale = item.stale ? `<small class="block">Last seen ${esc(when(item.observedAt))}</small>` : '';
    return `<tr data-capacity-row="${esc(item.id)}"><td><strong>${esc(item.name)}</strong><small class="block">${esc(item.connectionName ?? 'A connection that was removed')}</small></td><td>${bar}<span class="capacity-used">${used === null ? '—' : `${esc(round(used, 1))}%`}</span><small class="block">${esc(formatBytes(item.usedBytes))} of ${esc(formatBytes(item.capacityBytes))}</small>${stale}</td><td>${esc(formatBytes(item.freeBytes))}</td><td>${esc(growth)}</td><td>${fullInCell(item, { esc, day })}</td><td class="capacity-trend">${sparklineSvg(item.trend)}</td><td class="row-actions right"><button type="button" data-capacity-details="${esc(item.id)}">Details<span class="sr-only"> of datastore ${esc(item.name)}</span></button></td></tr>`;
  }).join('');
}

// ---- the chart ----------------------------------------------------------------------------------------------------------------------------------------------------------
// points: [{ at, usedBytes, capacityBytes }] ascending; forecast as the server sends it. The line is the used share of the size; the dashed line carries the forecast on to the day it
// reaches 100% (or as far as the chart goes: it never extends the time shown by more than the time shown).
export function chartSvg(points, forecast, { width = 640, height = 240 } = {}) {
  if (!points.length) return '';
  const left = 44, right = 14, top = 12, bottom = 28, plotW = width - left - right, plotH = height - top - bottom;
  const times = points.map(point => new Date(point.at).getTime()), first = times[0], last = times.at(-1), span = Math.max(last - first, 3_600_000);
  const share = point => point.usedBytes / point.capacityBytes * 100;
  const latest = points.at(-1), growth = forecast?.status === 'growing' && forecast.growthBytesPerDay > 0 ? forecast.growthBytesPerDay / latest.capacityBytes * 100 : null;   // percent of the size per day
  const toFull = growth !== null && forecast.daysUntilFull !== null ? forecast.daysUntilFull * 86_400_000 : null;
  const extension = growth !== null ? Math.min(toFull ?? span, span) : 0;
  const xEnd = last + extension;
  const x = at => round(left + plotW * (at - first) / (xEnd - first), 1), y = percent => round(top + plotH * (1 - Math.max(0, Math.min(100, percent)) / 100), 1);
  const line = points.map(point => `${x(new Date(point.at).getTime())},${y(share(point))}`).join(' ');
  let projection = '';
  if (growth !== null) {
    const endPercent = Math.min(100, share(latest) + growth * extension / 86_400_000);
    projection = `<line x1="${x(last)}" y1="${y(share(latest))}" x2="${x(last + extension)}" y2="${y(endPercent)}" stroke="currentColor" stroke-width="1.6" stroke-dasharray="5 4" class="capacity-projection"/>`;
  }
  const grid = [0, 50, 100].map(percent => `<line x1="${left}" y1="${y(percent)}" x2="${width - right}" y2="${y(percent)}" class="capacity-grid"/><text x="${left - 6}" y="${y(percent) + 4}" text-anchor="end" class="capacity-axis">${percent}%</text>`).join('');
  const ticks = [first, first + (xEnd - first) / 2, xEnd].map((at, i) => `<text x="${x(at)}" y="${height - 8}" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}" class="capacity-axis">${new Date(at).toISOString().slice(5, 10)}</text>`).join('');
  const from = round(share(points[0]), 1), to = round(share(latest), 1);
  const label = `Used space of the datastore from ${from}% to ${to}% over ${round(span / 86_400_000, 0)} days${growth !== null && forecast.daysUntilFull !== null ? `, expected to be full in about ${daysText(forecast.daysUntilFull)}` : ''}.`;
  return `<svg class="capacity-chart" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${label}"><title>${label}</title>${grid}<polyline points="${line}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" class="capacity-line"/>${projection}${ticks}</svg>`;
}

// detail: the answer of the detail call.
export function detailDialogHtml(detail, { esc, when, day }) {
  const f = detail.forecast, ranges = [7, 30, 90];
  const rows = [
    ['Size', formatBytes(detail.capacityBytes)], ['Used', `${formatBytes(detail.usedBytes)}${detail.usedPercent === null ? '' : ` (${round(detail.usedPercent, 1)}%)`}`], ['Free', formatBytes(detail.freeBytes)],
    ['Growth', f.growthBytesPerDay === null ? '—' : `${f.growthBytesPerDay >= 0 ? '+' : '−'}${formatBytes(Math.abs(f.growthBytesPerDay))} a day`],
    ['Full in', f.status === 'growing' && f.daysUntilFull !== null ? `${daysText(f.daysUntilFull)}, about ${day(f.projectedFullAt)}` : f.status === 'full' ? 'Full now' : '—'],
    ['Based on', f.status === 'insufficient' ? `${plural(f.sampleCount, 'reading')} so far` : `${plural(f.sampleCount, 'reading')} over ${f.spanDays} days${f.confidence ? `, ${f.confidence} confidence` : ''}`],
    ['Last seen', detail.observedAt ? when(detail.observedAt) : '—']
  ];
  return `<header><div><p class="eyebrow">DATASTORE · ${esc(detail.connectionName ?? 'A connection that was removed')}</p><h2 id="capacity-title">${esc(detail.name)}</h2></div><button id="capacity-close" type="button">Close</button></header>
<p class="capacity-summary" role="status">${esc(f.summary)}</p>
<label class="capacity-range">Show the last<select id="capacity-range" name="days">${ranges.map(days => `<option value="${days}"${days === detail.days ? ' selected' : ''}>${days} days</option>`).join('')}</select></label>
<figure class="capacity-figure">${detail.points.length >= 2 ? chartSvg(detail.points, f) : '<p class="empty-note">Not enough readings in this range to draw a chart yet.</p>'}<figcaption>Solid: used share of the size. Dashed: the forecast, if the datastore keeps filling at the same rate.</figcaption></figure>
<dl class="capacity-facts">${rows.map(([name, value]) => `<div><dt>${esc(name)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>
<p class="tag-help">The forecast is a straight line through the readings of the last 14 days, one about every half hour. It is a guide, not a promise: a clean-up, a new virtual machine or a snapshot changes it.</p>`;
}
