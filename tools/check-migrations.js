import { readdir, readFile } from 'node:fs/promises';
const dir=new URL('../database/migrations/',import.meta.url); const files=(await readdir(dir)).filter(x=>x.endsWith('.sql')).sort();
if(!files.length) throw new Error('No migrations found');
for(const f of files){const sql=await readFile(new URL(f,dir),'utf8'); if(!sql.includes('BEGIN;')||!sql.includes('COMMIT;')) throw new Error(`${f} is not transactional`);}
console.log(`Validated ${files.length} migration(s): ${files.join(', ')}`);
