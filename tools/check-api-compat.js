import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { basename } from 'node:path';
import { compareMessageSchemas, compareOpenApi } from '../modules/platform/src/api-compat.js';

// Usage: node tools/check-api-compat.js <before> <after> [--allow-breaking]
// Two OpenAPI descriptions (.yaml) or two message schemas (.json). Exits 1 when the new one would break an existing client,
// producer or consumer, unless --allow-breaking is given (an intentional, announced change).
const [beforePath, afterPath, ...flags] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error('Usage: node tools/check-api-compat.js <before> <after> [--allow-breaking]');
const messages = afterPath.endsWith('.json');
const read = async path => messages ? JSON.parse(await readFile(path, 'utf8')) : parse(await readFile(path, 'utf8'));
const report = messages ? compareMessageSchemas(await read(beforePath), await read(afterPath), basename(afterPath)) : compareOpenApi(await read(beforePath), await read(afterPath));
const allowed = flags.includes('--allow-breaking');
const status = report.breaking.length === 0 ? 'compatible' : allowed ? 'breaking-allowed' : 'breaking';
console.log(JSON.stringify({ status, kind: messages ? 'message schema' : 'OpenAPI', breaking: report.breaking, additions: report.additions.length, notes: report.notes }, null, 2));
if (status === 'breaking') process.exitCode = 1;
