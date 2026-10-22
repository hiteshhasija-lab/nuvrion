import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, tierOf, daysText, summaryOf, sparklineSvg, capacityRowsHtml, chartSvg, detailDialogHtml, formatMhz, computeRowsHtml, computeSummaryOf, computeDetailDialogHtml } from '../capacity.js';

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

// ---- hosts and clusters ------------------------------------------------------------------------------------------------------------------------------------------------
const metricView = (over = {}) => ({ capacity: 50400, used: 9800, free: 40600, usedPercent: 19.44, forecast: forecast({ summary: 'Growing by about 0.8 GHz a day: fully used in about 51 days', growthBytesPerDay: 800, daysUntilFull: 51, projectedFullAt: '2026-12-12T12:00:00.000Z' }), trend: [18, 18.5, 19, 19.4], ...over });
const insufficient = forecast({ status: 'insufficient', confidence: null, growthBytesPerDay: null, daysUntilFull: null, projectedFullAt: null, sampleCount: 2, summary: 'Not enough history yet' });
const compute = (over = {}) => ({ id: 'h1', kind: 'host', name: 'esx-1.lab', connectionId: 'c1', connectionName: 'ESXi 8', parentName: 'Prod cluster', hostCount: null, observedAt: '2026-10-22T12:00:00Z', stale: false,
  cpu: metricView(), memory: metricView({ capacity: 256 * GB, used: 96 * GB, free: 160 * GB, usedPercent: 37.5, forecast: insufficient, trend: [] }), ...over });

test('processor sizes are written in MHz and GHz', () => {
  assert.deepEqual([formatMhz(900), formatMhz(9800), formatMhz(50400), formatMhz(100800), formatMhz(250000), formatMhz(null)], ['900 MHz', '9.8 GHz', '50.4 GHz', '101 GHz', '250 GHz', '—']);
});

test('the table of hosts and clusters shows each one’s processor and memory use, when each will be fully used, and says where a host belongs and how many hosts a cluster counts', () => {
  const html = computeRowsHtml([compute(), compute({ id: 'cl1', kind: 'cluster', name: 'Prod cluster', parentName: null, hostCount: 2 })], ctx);
  assert.match(html, /<strong>esx-1\.lab<\/strong><small class="block">Host · ESXi 8 · in Prod cluster<\/small>/); assert.match(html, /<strong>Prod cluster<\/strong><small class="block">Cluster · ESXi 8 · 2 hosts counted<\/small>/);
  assert.match(html, /aria-label="Processor 19\.4% used"/); assert.match(html, /9\.8 GHz of 50\.4 GHz/); assert.match(html, /96 GB of 256 GB/); assert.match(html, /aria-label="Memory 37\.5% used"/);
  assert.match(html, /capacity-label">Processor<\/span> <span class="badge good">51 days<\/span> <small>about on 2026-12-12, high confidence<\/small>/); assert.match(html, /capacity-label">Memory<\/span> <span class="capacity-unknown">Not enough history yet<\/span>/);
  assert.equal((html.match(/<svg class="capacity-spark"/g) ?? []).length, 2, 'the processor of each has a trend; the memory with no history has none'); assert.match(html, /aria-label="Processor use over the last 14 days: from 18% to 19\.4%"/);
  assert.match(html, /data-capacity-compute-details="h1">Details<span class="sr-only"> of host esx-1\.lab<\/span>/); assert.match(html, /of cluster Prod cluster/);
  assert.match(computeRowsHtml([compute({ stale: true })], ctx), /Last seen at 2026-10-22T12:00:00Z/); assert.match(computeRowsHtml([compute({ connectionName: null })], ctx), /A connection that was removed/);
  assert.match(computeRowsHtml([compute({ cpu: metricView({ capacity: null, used: null, free: null, usedPercent: null, forecast: insufficient, trend: [] }) })], ctx), /<small class="block">Processor<\/small><span class="capacity-used">—<\/span>/);
  assert.match(computeRowsHtml([], ctx), /No hosts yet/);
  assert.match(computeRowsHtml([compute({ cpu: metricView({ forecast: forecast({ status: 'full', daysUntilFull: 0 }) }) })], ctx), /badge bad">Fully used/);
  assert.match(computeRowsHtml([compute({ memory: metricView({ forecast: forecast({ status: 'stable', daysUntilFull: null }) }) })], ctx), /badge good">Not filling/);
});

test('the badge for hosts and clusters counts the processors and memories that will be fully used soon', () => {
  assert.deepEqual(computeSummaryOf([]), { tone: 'neutral', text: 'No hosts' });
  assert.deepEqual(computeSummaryOf([compute({ cpu: metricView({ forecast: forecast({ daysUntilFull: 90 }) }) })]), { tone: 'good', text: 'None fully used within 30 days' });
  assert.deepEqual(computeSummaryOf([compute({ cpu: metricView({ forecast: forecast({ daysUntilFull: 25 }) }) })]), { tone: 'warn', text: '1 resource fully used within 30 days' });
  assert.deepEqual(computeSummaryOf([compute({ cpu: metricView({ forecast: forecast({ daysUntilFull: 5 }) }), memory: metricView({ forecast: forecast({ daysUntilFull: 9 }) }) })]), { tone: 'bad', text: '2 resources fully used within 14 days' });
});

test('the dialog for a host or cluster offers the processor and the memory and the ranges, draws the chart in the right words, and lists the facts in the right units', () => {
  const points = Array.from({ length: 13 }, (_, i) => ({ at: new Date(Date.parse('2026-10-09T12:00:00Z') + i * 86_400_000).toISOString(), usedBytes: 6000 + 300 * i, capacityBytes: 50400 }));
  const html = computeDetailDialogHtml({ ...compute({ kind: 'cluster', name: 'Prod cluster', hostCount: 2 }), metric: 'cpu', days: 30, points, meta: {} }, ctx);
  assert.match(html, /CLUSTER · ESXi 8/); assert.match(html, /<h2 id="capacity-title">Prod cluster<\/h2>/); assert.match(html, /role="status">Growing by about 0\.8 GHz a day: fully used in about 51 days/);
  assert.match(html, /<option value="cpu" selected>Processor<\/option>/); assert.match(html, /<option value="memory">Memory<\/option>/); assert.match(html, /<option value="30" selected>30 days<\/option>/);
  assert.match(html, /aria-label="Processor use of the cluster from 11\.9% to 19% over 12 days, expected to be fully used in about 51 days\."/);
  assert.match(html, /<dt>Capacity<\/dt><dd>50\.4 GHz<\/dd>/); assert.match(html, /<dt>Growth<\/dt><dd>\+800 MHz a day<\/dd>/); assert.match(html, /<dt>Fully used in<\/dt><dd>51 days, about on 2026-12-12<\/dd>/); assert.match(html, /<dt>Hosts counted<\/dt><dd>2<\/dd>/);
  const memory = computeDetailDialogHtml({ ...compute(), metric: 'memory', days: 7, points: [], meta: {} }, ctx);
  assert.match(memory, /<option value="memory" selected>/); assert.match(memory, /<dt>Capacity<\/dt><dd>256 GB<\/dd>/); assert.match(memory, /Not enough readings in this range/); assert.match(memory, /1 reading|2 readings so far/); assert.doesNotMatch(memory, /Hosts counted/);
});

test('nothing a server sent about a host or cluster is put in the page unescaped', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = computeRowsHtml([compute({ name: evil, connectionName: evil, parentName: evil, observedAt: evil, stale: true })], ctx) + computeDetailDialogHtml({ ...compute({ name: evil, connectionName: evil }), metric: 'cpu', days: 30, points: [], meta: {} }, ctx);
  assert.doesNotMatch(html, /<img/);
});
