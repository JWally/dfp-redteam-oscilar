#!/usr/bin/env node
/** Load Oscilar's public loader on a local page and record what the SDK does. */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const html = readFileSync('/tmp/opencode/osc/index.html','utf8');
const server = createServer((req,res)=>{ res.writeHead(200,{'content-type':'text/html'}); res.end(html); });
await new Promise(r=>server.listen(8794,'127.0.0.1',r));
const b = await chromium.launch({ headless:true });
const ctx = await b.newContext();
const page = await ctx.newPage();
const reqs = [];
page.on('request', r => {
  const u = r.url();
  if (/oscilar|zqp/.test(u)) {
    let pd = r.postData(); if (pd && pd.length > 4000) pd = pd.slice(0,4000)+'…';
    reqs.push({ method:r.method(), url:u.slice(0,300), type:r.resourceType(), postData:pd, headers:r.headers() });
  }
});
const resps = [];
page.on('response', async r => {
  if (/oscilar|zqp/.test(r.url())) {
    let body=null; try { const t=await r.text(); body=t.slice(0,1200); } catch(e){}
    resps.push({ status:r.status(), url:r.url().slice(0,300), body });
  }
});
page.on('console', m => { if (m.type()==='error') console.log('console.error', m.text().slice(0,200)); });
page.on('pageerror', e => console.log('pageerror', String(e).slice(0,200)));
await page.goto('http://127.0.0.1:8794/', { waitUntil:'load' });
await page.mouse.move(300,300); await page.mouse.click(300,300);
await page.waitForTimeout(15000);
const state = await page.evaluate(() => ({
  cookies: document.cookie,
  ls: Object.keys(localStorage).reduce((a,k)=>(a[k]=String(localStorage.getItem(k)).slice(0,300),a),{}),
  ss: Object.keys(sessionStorage).reduce((a,k)=>(a[k]=String(sessionStorage.getItem(k)).slice(0,300),a),{}),
  osc: typeof window._oSC, oscKeys: window._oSC ? Object.keys(window._oSC) : [],
  globals: Object.keys(window).filter(k=>/osc|zqp|sc_|_oSC/i.test(k)).slice(0,30),
  webassembly: typeof WebAssembly, worker: typeof Worker,
}));
mkdirSync('/home/justin/Dev/ms-argus-attack-bots/bots/results',{recursive:true});
const out = `/home/justin/Dev/ms-argus-attack-bots/bots/results/oscilar-probe-${Date.now()}.json`;
writeFileSync(out, JSON.stringify({reqs,resps,state},null,2));
console.log('=== requests ==='); for (const r of reqs) console.log(r.method, r.type, r.url, r.postData?('BODY '+r.postData.slice(0,200)):'');
console.log('\n=== responses ==='); for (const r of resps) console.log(r.status, r.url, (r.body||'').slice(0,160).replace(/\n/g,' '));
console.log('\n=== state ==='); console.log(JSON.stringify(state,null,1).slice(0,2000));
console.log('\nwrote', out);
await b.close(); server.close();
