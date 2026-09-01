import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('VM inventory uses icon lifecycle controls without a Performance button',async()=>{const app=await readFile(new URL('../apps/web/app.js',import.meta.url),'utf8'),css=await readFile(new URL('../apps/web/styles.css',import.meta.url),'utf8');assert.match(app,/function operationButton/);assert.match(app,/start:\{symbol:'▶'/);assert.match(app,/stop:\{symbol:'■'/);assert.match(app,/restart:\{symbol:'↻'/);assert.match(app,/pause:\{symbol:'Ⅱ'/);assert.doesNotMatch(app,/render\(\).*renderPerformanceActions/);assert.match(css,/#view-inventory thead th\{position:sticky/);assert.match(css,/#view-inventory \.table-wrap\{max-height:/);});
