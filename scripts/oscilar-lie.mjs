#!/usr/bin/env node
/**
 * oscilar-lie.mjs — feed the sandbox SDK obvious navigator lies and inspect
 * the pre-encryption payload for explicit lie/anomaly/tamper fields.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const wrapped = readFileSync('/tmp/opencode/osc/osc-index-wrapped.js','utf8');
const marker = `        const Q = new Oc();
        let g = await iQ("_AEZNb");`;
const sniff = `        const Q = new Oc();
        try { (window.top || window).__oscPayload = A; } catch (e) { window.__oscPayload = A; }
        let g = await iQ("_AEZNb");`;
const src = wrapped.replace(marker, sniff);
const html = `<!doctype html><html><body><h1>lie</h1><script async src="https://zqp-sand.oscilar.com/hwtsyp5h/loader.js"></script></body></html>`;
const server = createServer((req,res)=>{ res.writeHead(200,{'content-type':'text/html'}); res.end(html); });
await new Promise(r=>server.listen(8803,'127.0.0.1',r));

const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const SAFARI_APP = '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const FULL_SAFARI = `(() => {
  const ua = ${JSON.stringify(SAFARI_UA)}, app = ${JSON.stringify(SAFARI_APP)};
  const def = (p, prop, get) => { try { Object.defineProperty(p, prop, { get, configurable: true }); } catch(e) {} };
  def(Navigator.prototype, 'vendor', () => 'Apple Computer, Inc.');
  def(Navigator.prototype, 'platform', () => 'MacIntel');
  def(Navigator.prototype, 'appVersion', () => app);
  def(Navigator.prototype, 'userAgent', () => ua);
  def(Navigator.prototype, 'deviceMemory', () => undefined);
  def(Navigator.prototype, 'hardwareConcurrency', () => 8);
  def(Navigator.prototype, 'maxTouchPoints', () => 0);
  def(Navigator.prototype, 'webdriver', () => false);
  try { delete Navigator.prototype.userAgentData; } catch(e) {}
  try { Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined, configurable: true }); } catch(e) {}
})();`;

const profiles = [
  { name:'clean', ua:null, init:null },
  { name:'safari-ua', ua:SAFARI_UA, init:null },
  { name:'safari-full', ua:SAFARI_UA, init:FULL_SAFARI },
  { name:'windows-ua', ua:WIN_UA, init:null },
];

const b = await chromium.launch({headless:true});
for (const p of profiles) {
  const ctx = await b.newContext(p.ua ? { userAgent:p.ua } : {});
  if (p.init) await ctx.addInitScript({ content:p.init });
  const page = await ctx.newPage();
  await page.route('**/index.min.js*', r => r.fulfill({status:200, contentType:'application/javascript', body:src}));
  await page.route('**/telemetry', r => r.fulfill({status:200, contentType:'application/json', body:'{"beaconIDs":[]}'}));
  await page.goto('http://127.0.0.1:8803/', {waitUntil:'load'});
  await page.mouse.move(320,320); await page.mouse.click(320,320);
  await page.waitForTimeout(12000);
  const out = await page.evaluate(() => {
    const A = (window.top || window).__oscPayload || window.__oscPayload;
    if (!A) return { err:'no payload' };
    const hits=[];
    const walk=(o,path='')=>{
      if (o && typeof o==='object') {
        for (const [k,v] of Object.entries(o)) {
          const kk=path?path+'.'+k:k;
          if (/lie|anomal|mismatch|tamper|spoof|fake|inconsisten|contradict|suspicious/i.test(k)) hits.push([kk, String(v).slice(0,120)]);
          if (v && typeof v==='object' && hits.length<80) walk(v,kk);
        }
      }
    };
    walk(A);
    const ua=A.JSUserAgent||{}, uad=ua.uaData||{};
    return {
      ua: { userAgent:ua.userAgent, appVersion:ua.appVersion, vendor:ua.vendor, platform:ua.platform, webdriver:ua.webdriver, isBrave:ua.isBrave, uaData: uad ? {platform:uad.platform, mobile:uad.mobile, brands:uad.brands} : null },
      sel: A.JSSeleniumProperties, pw: A.JSPlaywright, con: A.JSConsole,
      canvas: A.JSCanvasHash ? { keys:Object.keys(A.JSCanvasHash), lied:A.JSCanvasHash.lied, error:A.JSCanvasHash.error } : null,
      audio: A.JSAudio ? { keys:Object.keys(A.JSAudio), lied:A.JSAudio.lied, error:A.JSAudio.error } : null,
      fonts: A.JSFonts ? { keys:Object.keys(A.JSFonts), lied:A.JSFonts.lied, error:A.JSFonts.error } : null,
      hits,
    };
  }).catch(e=>({err:String(e)}));
  const u=out.ua||{};
  const hits=(out.hits||[]).filter(([k])=>!/ClientRects/.test(k));
  console.log(`\n### ${p.name}`);
  console.log(`  UA=${String(u.userAgent).slice(0,70)}`);
  console.log(`  vendor=${u.vendor} platform=${u.platform} appVersion=${String(u.appVersion).slice(0,55)}`);
  console.log(`  webdriver=${u.webdriver} uaData=${JSON.stringify(u.uaData)}`);
  console.log(`  sel=${out.sel?.count} playwright=${out.pw?.count} cdp=${out.con?.cdpDetected} canvasLied=${out.canvas?.lied} audioLied=${out.audio?.lied}`);
  console.log(`  explicit lie/anomaly hits=${JSON.stringify(hits)}`);
  await ctx.close();
}
await b.close(); server.close();
