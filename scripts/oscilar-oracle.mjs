#!/usr/bin/env node
/**
 * oscilar-oracle.mjs — clean vs tampered differential against Oscilar's
 * public sandbox tenant (zqp-sand.../hwtsyp5h). Telemetry is allowed to hit
 * the real sandbox; responses/status/timing are captured. Low volume.
 *
 *   node bots/oscilar-oracle.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

const cleanSrc = readFileSync('/tmp/opencode/osc-index.js','utf8');
const wrapped = readFileSync('/tmp/opencode/osc/osc-index-wrapped.js','utf8');
const marker = `        const Q = new Oc();
        let g = await iQ("_AEZNb");`;
const tamperInject = `        const Q = new Oc();
        try {
          if (A && A.JSScreen) { A.JSScreen.screenWidth = 2560; A.JSScreen.width = 2560; A.JSScreen.screenHeight = 1440; A.JSScreen.height = 1440; A.JSScreen.availWidth = 2560; A.JSScreen.availHeight = 1440; }
          if (A && A.JSUserAgent) { A.JSUserAgent.platform = 'Win32'; A.JSUserAgent.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'; A.JSUserAgent.webdriver = false; }
          if (A && A.JSWebRTC) { A.JSWebRTC.publicIP = '203.0.113.7'; }
          if (A && A.JSTime) { A.JSTime.timeString = 'TAMPERED-TIME'; }
        } catch (e) {}
        let g = await iQ("_AEZNb");`;
const tamperSrc = wrapped.replace(marker, tamperInject);
const html = `<!doctype html><html><body><h1>oracle</h1><script async src="https://zqp-sand.oscilar.com/hwtsyp5h/loader.js"></script></body></html>`;
const server = createServer((req,res)=>{ res.writeHead(200,{'content-type':'text/html'}); res.end(html); });
await new Promise(r=>server.listen(8801,'127.0.0.1',r));

async function run(mode, src) {
  const b = await chromium.launch({headless:true});
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  const reqs=[], resps=[];
  await page.route('**/index.min.js*', r => r.fulfill({status:200, contentType:'application/javascript', body:src}));
  page.on('request', r => { if (/\/telemetry/.test(r.url())) reqs.push({t:Date.now(), url:r.url(), bodyLen:(r.postData()||'').length}); });
  page.on('response', async r => { if (/\/telemetry/.test(r.url())) { let body=null; try { body=await r.text(); } catch(e){} resps.push({t:Date.now(), status:r.status(), body}); } });
  await page.goto('http://127.0.0.1:8801/', {waitUntil:'load'});
  await page.mouse.move(320,320); await page.mouse.click(320,320);
  await page.waitForTimeout(15000);
  const state = await page.evaluate(() => ({
    ls: Object.fromEntries(Object.keys(localStorage).map(k=>[k, String(localStorage.getItem(k)).slice(0,200)])),
    ss: Object.fromEntries(Object.keys(sessionStorage).map(k=>[k, String(sessionStorage.getItem(k)).slice(0,200)])),
    err: window.__oscTamper ? JSON.stringify(window.__oscTamper).slice(0,300) : null,
  })).catch(()=>({}));
  await b.close();
  return {mode, reqs, resps, state};
}

const clean = await run('clean', cleanSrc);
const tampered = await run('tamper', tamperSrc);
function summarize(r){
  const out = {mode:r.mode, requests:r.reqs.length, timings:[], responses:[]};
  for (const x of r.resps) {
    let j=null; try { j=JSON.parse(x.body); } catch(e){}
    out.responses.push({status:x.status, keys:j?Object.keys(j):null, beaconIDs:j?j.beaconIDs?.length:null, d:j?String(j.d||'').slice(0,24):null, body:(x.body||'').slice(0,120)});
  }
  out.reqTimes = r.reqs.map(x=>x.t);
  out.state = r.state;
  return out;
}
const report = {clean:summarize(clean), tamper:summarize(tampered)};
writeFileSync('/tmp/opencode/osc/osc-oracle-report.json', JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
server.close();
