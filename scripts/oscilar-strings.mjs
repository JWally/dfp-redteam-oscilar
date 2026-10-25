#!/usr/bin/env node
/** Expose + dump the sandbox SDK's string decoders by patching the bundle in flight. */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
const patched = readFileSync('/tmp/opencode/osc-index-patched.js','utf8');
const html = `<!doctype html><html><body><h1>strings</h1><script async src="https://zqp-sand.oscilar.com/hwtsyp5h/loader.js"></script></body></html>`;
const server = createServer((req,res)=>{ res.writeHead(200,{'content-type':'text/html'}); res.end(html); });
await new Promise(r=>server.listen(8797,'127.0.0.1',r));
const b = await chromium.launch({headless:true});
const ctx = await b.newContext();
const page = await ctx.newPage();
await page.route('**/index.min.js*', route => route.fulfill({ status:200, contentType:'application/javascript', body: patched }));
await page.route('**/telemetry', route => route.fulfill({ status:200, contentType:'application/json', body:'{"beaconIDs":[]}' }));
page.on('pageerror', e => console.log('pageerror', String(e).slice(0,200)));
await page.goto('http://127.0.0.1:8797/', {waitUntil:'load'});
await page.waitForTimeout(5000);
const out = await page.evaluate(() => {
  const d = window.__oscDec;
  if (!d) return {err:'no decoder'};
  const dec = (fn, max) => {
    const a=[]; let empty=0;
    for (let i=0;i<max;i++){
      try { const v=fn(i); if (v===undefined||v===null||v===''){empty++; if(empty>30)break; continue;} empty=0; a.push([i,String(v)]); }
      catch(e){ empty++; if(empty>30)break; }
    }
    return a;
  };
  return { H: dec(d.H, 20000), bc: dec(d.bc, 300), qc: dec(d.qc, 40) };
});
writeFileSync('/tmp/opencode/osc/osc-strings.json', JSON.stringify(out,null,2));
console.log('H',out.H?.length,'bc',out.bc?.length,'qc',out.qc?.length, out.err||'');
const all=[...(out.H||[]),...(out.bc||[]),...(out.qc||[])];
const uniq=[...new Set(all.map(x=>x[1]))];
console.log('unique strings', uniq.length);
for (const s of uniq.slice(0,120)) console.log(JSON.stringify(s).slice(0,240));
await b.close(); server.close();
