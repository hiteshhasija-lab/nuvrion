import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { compareOpenApi } from '../modules/platform/src/api-compat.js';

// Usage: node tools/check-api-compat.js <before.yaml> <after.yaml> [--allow-breaking]
// Exits 1 when the new description would break an existing client, unless --allow-breaking is given (an intentional, announced change).
const [beforePath, afterPath, ...flags] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error('Usage: node tools/check-api-compat.js <before.yaml> <after.yaml> [--allow-breaking]');
const report = compareOpenApi(parse(await readFile(beforePath, 'utf8')), parse(await readFile(afterPath, 'utf8')));
const allowed = flags.includes('--allow-breaking');
const status = report.breaking.length === 0 ? 'compatible' : allowed ? 'breaking-allowed' : 'breaking';
console.log(JSON.stringify({ status, breaking: report.breaking, additions: report.additions.length, notes: report.notes }, null, 2));
if (status === 'breaking') process.exitCode = 1;
