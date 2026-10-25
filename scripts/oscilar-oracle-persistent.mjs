#!/usr/bin/env node
/**
 * Persistent-context sandbox oracle: clean1, clean2, tamper in the same
 * browser context, so localStorage/IndexedDB device state persists.
 * Compares the sandbox's `d` (device id?) and `beaconIDs` ack.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const cleanSrc = readFileSync('/tmp/opencode/osc-index.js','utf8');
const wrapped = readFileSync('/tmp/opencode/osc/osc-index-wrapped.js','utf8');
const marker = `        const Q = new Oc();
        let g = await iQ("_AEZNb");`;
const tamperCode = `        const Q = new Oc();
        try {
          if (A && A.JSScreen) { A.JSScreen.screenWidth = 2560; A.JSScreen.width = 2560; A.JSScreen.screenHeight = 1440; A.JSScreen.height = 1440; A.JSScreen.availWidth = 2560; A.JSScreen.availHeight = 1440; }
          if (A && A.JSUserAgent) { A.JSUserAgent.platform = 'Win32'; A.JSUserAgent.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'; A.JSUserAgent.webdriver = false; }
          if (A && A.JSWebRTC) { A.JSWebRTC.publicIP = '203.0.113.7'; }
          if (A && A.JSTime) { A.JSTime.timeString = 'TAMPERED-TIME'; }
        } catch (e) {}
        let g = await iQ("_AEZNb");`;
const tamperSrc = wrapped.replace(marker, tamperCode);
const html = `<!doctype html><html><body><h1>persistent oracle</h1><script async src="https://zqp-sand.oscilar.com/hwtsyp5h/loader.js"></script></body></html>`;
const server = createServer((req,res)=>{ res.writeHead(200,{'content-type':'text/html'}); res.end(html); });
await new Promise(r=>server.listen(8802,'127.0.0.1',r));

const b = await chromium.launch({headless:true});
const ctx = await b.newContext();

async function run(label, src) {
  const page = await ctx.newPage();
  const resps=[];
  await page.route('**/index.min.js*', r => r.fulfill({status:200, contentType:'application/javascript', body:src}));
  page.on('response', async r => { if (/\/telemetry/.test(r.url())) { let body=null; try { body=await r.text(); } catch(e){} resps.push({status:r.status(), body}); } });
  await page.goto('http://127.0.0.1:8802/', {waitUntil:'load'});
  await page.mouse.move(320,320); await page.mouse.click(320,320);
  await page.waitForTimeout(12000);
  const st = await page.evaluate(() => ({
    did: localStorage.getItem('__xr9f__'),
    oscf: localStorage.getItem('__oscf__'),
    tid: sessionStorage.getItem('__oscTID'),
  })).catch(()=>({}));
  await page.close();
  const out = {label, resps: resps.map(x => { let j=null; try{j=JSON.parse(x.body)}catch(e){}; return {status:x.status, keys:j?Object.keys(j):null, beaconIDs:j?j.beaconIDs?.length:null, d:j?String(j.d||'').slice(0,24):null}; }), storage:{didPrefix:(st.did||'').slice(0,24), tid:(st.tid||'').slice(0,24), oscfPrefix:(st.oscf||'').slice(0,40)} };
  console.log(JSON.stringify(out,null,1));
  return out;
}

const clean1 = await run('clean1', cleanSrc);
const clean2 = await run('clean2', cleanSrc);
const tamper = await run('tamper', tamperSrc);
console.log('\nCOMPARE d:', {clean1:clean1.resps[0]?.d, clean2:clean2.resps[0]?.d, tamper:tamper.resps[0]?.d});
console.log('COMPARE beaconIDs:', {clean1:clean1.resps[0]?.beaconIDs, clean2:clean2.resps[0]?.beaconIDs, tamper:tamper.resps[0]?.beaconIDs});
console.log('COMPARE storage did:', {clean1:clean1.storage.didPrefix, clean2:clean2.storage.didPrefix, tamper:tamper.storage.didPrefix});
await b.close(); server.close();
