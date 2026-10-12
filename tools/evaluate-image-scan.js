import { readFile, writeFile } from 'node:fs/promises';
import { evaluateImageScan } from '../modules/platform/src/image-scan-gate.js';

// node tools/evaluate-image-scan.js <trivy-image-report.json> [--exceptions deploy/image-scan-exceptions.json] [--summary out.json] [--max-age-hours N]
// Exit code 1 when the policy blocks. The summary (counts, blockers, accepted findings) is written whether or not it passes.
const args = process.argv.slice(2);
const reportPath = args.find(argument => !argument.startsWith('--') && !['--exceptions', '--summary', '--max-age-hours'].includes(args[args.indexOf(argument) - 1]));
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
if (!reportPath) throw new Error('Usage: node tools/evaluate-image-scan.js <trivy-image-report.json> [--exceptions file] [--summary out.json] [--max-age-hours N]');

const report = JSON.parse(await readFile(reportPath, 'utf8'));
const exceptionsPath = option('--exceptions');
const exceptions = exceptionsPath ? JSON.parse(await readFile(exceptionsPath, 'utf8')).exceptions ?? [] : [];
const maxAgeHours = option('--max-age-hours');
const result = evaluateImageScan(report, { exceptions, maxReportAgeMs: maxAgeHours ? Number(maxAgeHours) * 3_600_000 : null });
const summary = { ...result, artifact: report.ArtifactName ?? null, scannedAt: report.CreatedAt ?? null, os: report.Metadata?.OS ?? null };
const summaryPath = option('--summary');
if (summaryPath) await writeFile(summaryPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ status: summary.status, counts: summary.counts, blocking: summary.blocking, accepted: summary.accepted.length, problems: summary.problems, blockers: summary.blockers.slice(0, 20) }, null, 2));
if (result.status !== 'passed') process.exitCode = 1;
