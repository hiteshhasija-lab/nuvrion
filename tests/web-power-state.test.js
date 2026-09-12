import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('VM inventory uses accessible green and red power indicators',async()=>{const app=await readFile(new URL('../apps/web/app.js',import.meta.url),'utf8'),css=await readFile(new URL('../apps/web/styles.css',import.meta.url),'utf8');assert.match(app,/function powerIndicator\(v\)/);assert.match(app,/power-indicator \$\{v\}/);assert.match(app,/aria-label="Power state: \$\{label\}"/);assert.match(app,/\$\{powerIndicator\(displayPower\)\}/);assert.match(css,/\.power-indicator\.running\{color:#1f9d5a/);assert.match(css,/\.power-indicator\.stopped\{color:#d23f3a/);assert.match(css,/\.sr-only\{/);});
