#!/usr/bin/env node
/**
 * oscilar-tamper.mjs — modify the pre-encryption payload object, let the SDK
 * encrypt and ship it, and verify the modified values are in the ciphertext.
 *
 *   node bots/oscilar-tamper.mjs --sniff    # dump payload shape only
 *   node bots/oscilar-tamper.mjs --tamper   # swap UA/screen/WebRTC before encrypt
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

const MODE = process.argv.includes('--tamper') ? 'tamper' : 'sniff';
const LIVE = process.argv.includes('--live');
const base = readFileSync('/tmp/opencode/osc/osc-index-wrapped.js','utf8');
const marker = `        const Q = new Oc();
        let g = await iQ("_AEZNb");`;
const inject = MODE === 'sniff'
  ? `        const Q = new Oc();
        try { window.__oscPayload = A; } catch (e) {}
        let g = await iQ("_AEZNb");`
  : `        const Q = new Oc();
        try {
          window.__oscTamper = { seen: Date.now(), before: {} };
          const log = (k, v) => { try { window.__oscTamper.before[k] = JSON.stringify(v); } catch (e) {} };
          if (A && A.JSScreen) { log('JSScreen', A.JSScreen); A.JSScreen.screenWidth = 2560; A.JSScreen.width = 2560; A.JSScreen.screenHeight = 1440; A.JSScreen.height = 1440; A.JSScreen.availWidth = 2560; A.JSScreen.availHeight = 1440; }
          if (A && A.JSUserAgent) { log('JSUserAgent', A.JSUserAgent); A.JSUserAgent.platform = 'Win32'; A.JSUserAgent.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'; A.JSUserAgent.webdriver = false; }
          if (A && A.JSWebRTC) { log('JSWebRTC', A.JSWebRTC); A.JSWebRTC.publicIP = '203.0.113.7'; }
          if (A && A.JSTime) { log('JSTime', A.JSTime); A.JSTime.timeString = 'TAMPERED-TIME'; }
          window.__oscTamper.after = { JSScreen: A.JSScreen, JSUserAgent: A.JSUserAgent, JSWebRTC: A.JSWebRTC, JSTime: A.JSTime };
        } catch (e) { window.__oscTamper = { err: String(e) }; }
        let g = await iQ("_AEZNb");`;
if (!base.includes(marker)) { console.error('marker not found'); process.exit(1); }
const src = base.replace(marker, inject);
const html = `<!doctype html><html><body><h1>tamper</h1><script async src="https://zqp-sand.oscilar.com/hwtsyp5h/loader.js"></script></body></html>`;
const server = createServer((req,res)=>{ res.writeHead(200,{'content-type':'text/html'}); res.end(html); });
await new Promise(r=>server.listen(8800,'127.0.0.1',r));
const b = await chromium.launch({headless:true});
const ctx = await b.newContext();
const page = await ctx.newPage();
await page.route('**/index.min.js*', r => r.fulfill({status:200, contentType:'application/javascript', body:src}));
const telemetry=[];
const liveResps=[];
if (!LIVE) {
  await page.route('**/telemetry', async r => { telemetry.push(r.request().postData()||''); await r.fulfill({status:200, contentType:'application/json', body:'{"beaconIDs":[]}'}); });
} else {
  page.on('request', r => { if (/\/telemetry/.test(r.url())) telemetry.push((r.postData()||'').length); });
  page.on('response', async r => { if (/\/telemetry/.test(r.url())) { let b=null; try { b=await r.text(); } catch(e){} liveResps.push({status:r.status(), body:b}); } });
}
page.on('pageerror', e => console.log('pageerror', String(e).slice(0,200)));
await page.goto('http://127.0.0.1:8800/', {waitUntil:'load'});
await page.waitForTimeout(12000);
const out = await page.evaluate(() => ({ payload: window.__oscPayload, tamper: window.__oscTamper, wasm: window.__oscWasm }));
writeFileSync(`/tmp/opencode/osc/osc-${MODE}-dump.json`, JSON.stringify(out,null,2));
console.log('MODE',MODE,'LIVE',LIVE,'telemetry',telemetry.length,'wasm captures',(out.wasm||[]).length);
for (const r of liveResps) { let j=null; try{j=JSON.parse(r.body)}catch(e){}; console.log(' LIVE resp',r.status,'keys',j?Object.keys(j):null,'beaconIDs',j?j.beaconIDs?.length:null,'d',j?String(j.d||'').slice(0,20):null,'bodyLen',(r.body||'').length); }
if (MODE==='sniff' && out.payload) {
  const keys=Object.keys(out.payload);
  console.log('payload keys', keys.length, keys.slice(0,60));
  for (const k of ['JSScreen','JSUserAgent','JSWebRTC','JSTime','JSFonts','JSMathFingerprint']) {
    const v=out.payload[k];
    console.log(k, v ? JSON.stringify(v).slice(0,500) : 'MISSING');
  }
} else {
  console.log('tamper', JSON.stringify(out.tamper,null,1).slice(0,1200));
}
// search captured plaintext for the tamper markers
for (const c of (out.wasm||[])) {
  const a0=Buffer.from(c.a0||'','base64');
  const hits=['TAMPERED-TIME','Win32','203.0.113.7','Mozilla/5.0 (Windows'].filter(s=>a0.includes(Buffer.from(s)));
  console.log('a0 len',a0.length,'marker hits',hits.join(', ')||'none');
}
await b.close(); server.close();
