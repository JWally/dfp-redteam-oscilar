#!/usr/bin/env node
/** Wrap iQ("_AEZNb") (WASM encrypt) and capture MessagePack plaintext + key. */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
const src = readFileSync('/tmp/opencode/osc/osc-index-wrapped.js','utf8');
const html = `<!doctype html><html><body><h1>args</h1><script async src="https://zqp-sand.oscilar.com/hwtsyp5h/loader.js"></script></body></html>`;
const server = createServer((req,res)=>{ res.writeHead(200,{'content-type':'text/html'}); res.end(html); });
await new Promise(r=>server.listen(8798,'127.0.0.1',r));
const b = await chromium.launch({headless:true});
const ctx = await b.newContext();
const page = await ctx.newPage();
await page.route('**/index.min.js*', r => r.fulfill({status:200, contentType:'application/javascript', body:src}));
await page.route('**/telemetry', r => r.fulfill({status:200, contentType:'application/json', body:'{"beaconIDs":[]}'}));
page.on('pageerror', e => console.log('pageerror', String(e).slice(0,300)));
await page.goto('http://127.0.0.1:8798/', {waitUntil:'load'});
await page.waitForTimeout(12000);
const out = await page.evaluate(() => window.__oscWasm || []);
writeFileSync('/tmp/opencode/osc/osc-wasm-args.json', JSON.stringify(out,null,2));
console.log('captures', out.length);
for (const c of out.slice(0,5)) {
  console.log('a0 len', c.a0 && c.a0.length, 'a1', JSON.stringify(c.a1).slice(0,160), 'out len', c.out && c.out.length);
  console.log('a0 prefix', String(c.a0).slice(0,120));
}
await b.close(); server.close();
