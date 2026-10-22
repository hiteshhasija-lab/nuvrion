import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, tierOf, daysText, summaryOf, sparklineSvg, capacityRowsHtml, chartSvg, detailDialogHtml } from '../capacity.js';

// The capacity table, the small trend, the chart and the dialog: what each says for a datastore that is filling, steady, new, full or unreachable, that urgency is shown in words as well
// as colour, that the chart carries the forecast on to the day it reaches 100%, and that nothing a server sent is put in the page unescaped.
const esc = value => String(value ?? '—').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const when = value => `at ${value}`, day = value => `on ${String(value).slice(0, 10)}`;
const ctx = { esc, when, day };
const GB = 1024 ** 3, TB = 1024 ** 4;
const forecast = (over = {}) => ({ status: 'growing', confidence: 'high', growthBytesPerDay: 10 * GB, daysUntilFull: 38, projectedFullAt: '2026-11-28T12:00:00.000Z', sampleCount: 49, spanDays: 12, fit: 0.99, summary: 'Growing by about 10 GB a day: full in about 38 days', ...over });
const item = (over = {}) => ({ id: 'd1', name: 'datastore1', connectionId: 'c1', connectionName: 'ESXi 7', capacityBytes: 1000 * GB, freeBytes: 380 * GB, usedBytes: 620 * GB, usedPercent: 62, observedAt: '2026-10-21T12:00:00Z', stale: false, forecast: forecast(), trend: [60, 60.5, 61, 61.5, 62], ...over });

test('sizes are written the way an administrator reads them', () => {
  assert.deepEqual([formatBytes(0), formatBytes(5 * 1024 ** 2), formatBytes(1.5 * GB), formatBytes(620 * GB), formatBytes(2 * TB), formatBytes(64 * TB), formatBytes(null), formatBytes(NaN)], ['0 MB', '5 MB', '1.5 GB', '620 GB', '2 TB', '64 TB', '—', '—']);
  assert.deepEqual([daysText(null), daysText(0.4), daysText(1), daysText(37.6), daysText(2)], ['—', 'less than a day', '1 day', '38 days', '2 days']);
});

test('urgency: full within two weeks is bad, within a month needs attention, anything else is fine, and what is not known is neutral', () => {
  assert.deepEqual([tierOf(forecast({ daysUntilFull: 5 })), tierOf(forecast({ daysUntilFull: 14 })), tierOf(forecast({ daysUntilFull: 20 })), tierOf(forecast({ daysUntilFull: 30 })), tierOf(forecast({ daysUntilFull: 31 }))], ['bad', 'bad', 'warn', 'warn', 'good']);
  assert.deepEqual([tierOf(forecast({ status: 'full' })), tierOf(forecast({ status: 'stable' })), tierOf(forecast({ status: 'shrinking' })), tierOf(forecast({ status: 'insufficient' })), tierOf(null)], ['bad', 'good', 'good', 'neutral', 'neutral']);
  assert.equal(tierOf(forecast({ daysUntilFull: null })), 'good');
});

test('the badge on the page counts what needs attention', () => {
  assert.deepEqual(summaryOf([]), { tone: 'neutral', text: 'No datastores' });
  assert.deepEqual(summaryOf([item(), item({ forecast: forecast({ status: 'stable' }) })]), { tone: 'good', text: 'None full within 30 days' });
  assert.deepEqual(summaryOf([item({ forecast: forecast({ daysUntilFull: 25 }) }), item()]), { tone: 'warn', text: '1 full within 30 days' });
  assert.deepEqual(summaryOf([item({ forecast: forecast({ daysUntilFull: 5 }) }), item({ forecast: forecast({ daysUntilFull: 9 }) }), item({ forecast: forecast({ daysUntilFull: 25 }) })]), { tone: 'bad', text: '2 full within 14 days' });
});

test('a filling datastore says how many days and which day, how sure that is, how much it grows and how full it is now', () => {
  const html = capacityRowsHtml([item()], ctx);
  assert.match(html, /<strong>datastore1<\/strong><small class="block">ESXi 7<\/small>/); assert.match(html, /62%/); assert.match(html, /620 GB of 1000 GB/); assert.match(html, /380 GB/);
  assert.match(html, /\+10 GB a day/); assert.match(html, /<span class="badge good">38 days<\/span><small class="block">about on 2026-11-28<\/small><small class="block">high confidence<\/small>/);
  assert.match(html, /aria-label="62% used"/); assert.match(html, /<svg class="capacity-spark"/); assert.match(html, /data-capacity-details="d1">Details<span class="sr-only"> of datastore datastore1<\/span>/);
  assert.match(capacityRowsHtml([item({ forecast: forecast({ daysUntilFull: 6 }) })], ctx), /<span class="badge bad">6 days<\/span>/);
  assert.match(capacityRowsHtml([item({ usedPercent: 92 })], ctx), /class="bad"/); assert.match(capacityRowsHtml([item({ usedPercent: 80 })], ctx), /class="warn"/);
});

test('a datastore that is not filling, is new, is full or cannot be reached is described plainly', () => {
  assert.match(capacityRowsHtml([item({ forecast: forecast({ status: 'stable', daysUntilFull: null, projectedFullAt: null, growthBytesPerDay: 1000 }) })], ctx), /<span class="badge good">Not filling<\/span><small class="block">Stable<\/small>/);
  assert.match(capacityRowsHtml([item({ forecast: forecast({ status: 'shrinking', growthBytesPerDay: -5 * GB, daysUntilFull: null }) })], ctx), /−5 GB a day[\s\S]*Shrinking/);
  assert.match(capacityRowsHtml([item({ forecast: forecast({ status: 'insufficient', growthBytesPerDay: null, daysUntilFull: null, sampleCount: 1, confidence: null }), trend: [90] })], ctx), /Not enough history yet<\/span><small class="block">1 reading so far<\/small>[\s\S]*capacity-nospark/);
  assert.match(capacityRowsHtml([item({ forecast: forecast({ status: 'full', daysUntilFull: 0 }) })], ctx), /<span class="badge bad">Full<\/span>/);
  assert.match(capacityRowsHtml([item({ stale: true })], ctx), /Last seen at 2026-10-21T12:00:00Z/);
  assert.match(capacityRowsHtml([item({ capacityBytes: null, freeBytes: null, usedBytes: null, usedPercent: null })], ctx), /<span class="capacity-used">—<\/span>/);
  assert.match(capacityRowsHtml([item({ connectionName: null })], ctx), /A connection that was removed/);
  assert.match(capacityRowsHtml([], ctx), /No datastores yet/);
});

test('the trend is a small picture with a text alternative, drawn between its own lowest and highest value', () => {
  const svg = sparklineSvg([40, 40.5, 41]);
  assert.match(svg, /role="img" aria-label="Used space over the last 14 days: from 40% to 41%"/); assert.match(svg, /<polyline points="/);
  assert.equal(sparklineSvg([50, 50, 50]).includes('NaN'), false, 'a flat line is not a divide by zero');
  assert.match(sparklineSvg([50]), /capacity-nospark/); assert.match(sparklineSvg(undefined), /capacity-nospark/);
});

const points = Array.from({ length: 13 }, (_, i) => ({ at: new Date(Date.parse('2026-10-09T12:00:00Z') + i * 86_400_000).toISOString(), usedBytes: (500 + 10 * i) * GB, capacityBytes: 1000 * GB }));

const nearlyFull = points.map((point, i) => ({ ...point, usedBytes: (780 + 10 * i) * GB }));   // 78% to 90% in 12 days: 1% a day, ten days to go

test('the chart draws the readings, the 0, 50 and 100% lines, dates, and a dashed forecast on to the day it is full', () => {
  const svg = chartSvg(nearlyFull, forecast({ daysUntilFull: 10, growthBytesPerDay: 10 * GB }));
  assert.match(svg, /role="img" aria-label="Used space of the datastore from 78% to 90% over 12 days, expected to be full in about 10 days\."/);
  assert.match(svg, />0%</); assert.match(svg, />50%</); assert.match(svg, />100%</);
  assert.match(svg, /<polyline /); assert.match(svg, /stroke-dasharray/);
  const projection = /<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"[^>]*capacity-projection/.exec(svg);
  assert.ok(projection && Number(projection[3]) > Number(projection[1]), 'the forecast runs to the right of the last reading');
  assert.equal(Number(projection[4]), 12, 'and reaches the 100% line (the top of the plot) on the day the datastore is full');
  assert.equal(svg.includes('NaN'), false);
});

test('a forecast further away than the chart is long is cut off short of 100%, and a datastore that is not filling has no dashed line', () => {
  const far = chartSvg(points, forecast({ daysUntilFull: 300, growthBytesPerDay: 1.7 * GB }));
  const line = /<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"[^>]*capacity-projection/.exec(far);
  assert.ok(Number(line[4]) > 12, 'it stops below the top of the plot');
  assert.doesNotMatch(chartSvg(points, forecast({ status: 'stable', daysUntilFull: null })), /capacity-projection/);
  assert.doesNotMatch(chartSvg(points, null), /capacity-projection/);
  assert.equal(chartSvg([], forecast()), '');
});

test('the dialog names the datastore, says the forecast in a sentence, offers the ranges, draws the chart and lists the facts', () => {
  const html = detailDialogHtml({ ...item(), days: 30, points, meta: {} }, ctx);
  assert.match(html, /<h2 id="capacity-title">datastore1<\/h2>/); assert.match(html, /DATASTORE · ESXi 7/); assert.match(html, /role="status">Growing by about 10 GB a day: full in about 38 days/);
  assert.match(html, /<option value="30" selected>30 days<\/option>/); assert.match(html, /<option value="7">7 days/); assert.match(html, /<option value="90">90 days/);
  assert.match(html, /<svg class="capacity-chart"/); assert.match(html, /<dt>Full in<\/dt><dd>38 days, about on 2026-11-28<\/dd>/); assert.match(html, /<dt>Based on<\/dt><dd>49 readings over 12 days, high confidence<\/dd>/);
  assert.match(html, /<dt>Growth<\/dt><dd>\+10 GB a day<\/dd>/); assert.match(html, /id="capacity-close"/);
  const thin = detailDialogHtml({ ...item({ forecast: forecast({ status: 'insufficient', growthBytesPerDay: null, daysUntilFull: null, projectedFullAt: null, sampleCount: 1, confidence: null }) }), days: 7, points: points.slice(0, 1), meta: {} }, ctx);
  assert.match(thin, /Not enough readings in this range to draw a chart yet/); assert.doesNotMatch(thin, /<svg class="capacity-chart"/); assert.match(thin, /1 reading so far/);
});

test('nothing a server sent is put in the page unescaped', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = capacityRowsHtml([item({ name: evil, connectionName: evil, observedAt: evil, stale: true, forecast: forecast({ projectedFullAt: evil, confidence: evil }) })], ctx)
    + detailDialogHtml({ ...item({ name: evil, connectionName: evil, forecast: forecast({ summary: evil, projectedFullAt: evil }) }), days: 30, points, meta: {} }, ctx);
  assert.doesNotMatch(html, /<img/);
});
