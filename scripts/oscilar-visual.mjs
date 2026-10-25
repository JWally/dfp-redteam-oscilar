#!/usr/bin/env node
/**
 * oscilar-visual.mjs — HEADED (visible) Oscilar SDK demo in a browser window.
 *
 * Phase 1 (clean): loads the real sandbox loader, captures the SDK's own
 * payload object `A` at the encrypt call site (before encryption), recovers
 * the ChaCha20 key from plaintext XOR ciphertext, and renders the readable
 * payload with the bot tells highlighted. The telemetry POST is intercepted
 * locally — never sent.
 *
 * Phase 2 (tamper): same page, but the payload object `A` is mutated
 * client-side (screen 2560x1440, UA -> Win32 Chrome, webdriver=false,
 * timeString=TAMPERED-TIME) and re-shipped. Shows the diff the server would
 * see, plus the earlier real-sandbox oracle differential (clean vs tampered
 * both returned 200 / 5 beaconIDs / the SAME `d` = device identity, not a
 * risk verdict).
 *
 * Bundle: reads the instrumented public bundle from
 *   assets/osc-index-wrapped.js  (repo)   or   /tmp/opencode/osc/osc-index-wrapped.js
 * and injects the read-only capture at the encrypt call site at serve time.
 *
 * Usage:
 *   node scripts/oscilar-visual.mjs
 *   (close the browser window to exit)
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const PORT = 8895;

// ---------------------------------------------------------------------------
// Bundle: instrumented public SDK + the read-only A-capture injection
// ---------------------------------------------------------------------------
function findBase() {
  for (const p of [
    '/tmp/opencode/osc/osc-index-wrapped.js',
    join(repoRoot, 'assets', 'osc-index-wrapped.js'),
  ]) if (existsSync(p)) return readFileSync(p, 'utf8');
  return null;
}

const E_LINE = '        const E = wt(g(Q["encode"](A), B));\n        return btoa(E);';

function inject(base, tamper) {
  if (!base.includes(E_LINE)) throw new Error('anchor `const E = wt(g(Q["encode"](A), B));` not found — bundle mismatch');
  const cap = `        const __pk = Q["encode"](A);
        const __pkU8 = __pk instanceof Uint8Array ? __pk : new Uint8Array(__pk);
        const __ctU8 = g(__pkU8, B);
        const __b64x = (u8) => { const CH=8192, p=[]; for (let i=0;i<u8.length;i+=CH) p.push(String.fromCharCode.apply(null,u8.subarray(i,i+CH))); return btoa(p.join("")); };
        (window.__oscWasm = window.__oscWasm || []).push({
          A: JSON.stringify(A),
          encB64: __b64x(__pkU8),
          outB64: __b64x(new Uint8Array(__ctU8)),
          keyB64: B instanceof Uint8Array ? __b64x(B) : String(B),
          ts: Date.now()
        });
`;
  const tamperBlk = tamper ? `        try {
          if (A && A.JSScreen) { A.JSScreen.screenWidth = 2560; A.JSScreen.width = 2560; A.JSScreen.screenHeight = 1440; A.JSScreen.height = 1440; A.JSScreen.availWidth = 2560; A.JSScreen.availHeight = 1440; }
          if (A && A.JSUserAgent) { A.JSUserAgent.platform = "Win32"; A.JSUserAgent.userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"; A.JSUserAgent.webdriver = false; }
          if (A && A.JSTime) { A.JSTime.timeString = "TAMPERED-TIME"; }
        } catch (e) {}
` : '';
  const E = '        const E = wt(new Uint8Array(__ctU8));\n        return btoa(E);';
  return base.replace(E_LINE, tamperBlk + cap + E);
}

// ---------------------------------------------------------------------------
// Page: terminal-style control panel + render targets
// ---------------------------------------------------------------------------
const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Oscilar — readable payload + tamper (live)</title>
<style>
  body{background:#0d1117;color:#e6edf3;font-family:ui-monospace,Menlo,Consolas,monospace;margin:0}
  #wrap{max-width:1000px;margin:0 auto;padding:24px}
  h1{font-size:18px;color:#58a6ff;margin:0 0 4px}
  .sub{color:#8b949e;font-size:12px;margin:0 0 14px}
  #log{background:#010409;border:1px solid #30363d;border-radius:8px;padding:12px 14px;
       font-size:12px;line-height:1.5;max-height:240px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;margin-bottom:16px}
  .ok{color:#3fb950}.warn{color:#d29922}.bad{color:#f85149}.dim{color:#8b949e}.acc{color:#58a6ff}.hex{color:#d2a8ff}
  h2{font-size:13px;color:#58a6ff;margin:16px 0 4px;letter-spacing:.5px}
  table{border-collapse:collapse;width:100%;font-size:12px;margin:4px 0 12px}
  th,td{border:1px solid #30363d;padding:3px 8px;text-align:left;vertical-align:top;word-break:break-all}
  th{background:#161b22;color:#8b949e;font-weight:normal;text-transform:uppercase;font-size:10px;letter-spacing:.5px}
  tr.tell td{background:#3a1414} tr.tell td.k{color:#ff7b72;font-weight:bold}
  .k{color:#a5d6ff;white-space:nowrap}.dim{color:#8b949e}
  .big{background:#010409;border:1px solid #30363d;border-radius:8px;padding:12px 14px;font-size:12px;line-height:1.6;margin:4px 0 12px}
  .big b{color:#a5d6ff}
</style></head>
<body><div id="wrap">
  <h1>Oscilar device-intelligence SDK — readable payload + ChaCha20 key (live)</h1>
  <p class="sub">real sandbox loader (zqp-sand.oscilar.com/hwtsyp5h) · payload captured pre-encryption from the SDK's own object · telemetry POST intercepted locally, never sent</p>
  <div id="log"></div>
  <div id="out"></div>
</div>
<script async src="https://zqp-sand.oscilar.com/hwtsyp5h/loader.js"></script>
<script>
window.__log=function(cls,line){ const el=document.getElementById('log');
  const d=document.createElement('div'); d.className=cls||'';
  d.textContent='['+String(Date.now()).slice(-6)+'] '+line; el.appendChild(d); el.scrollTop=el.scrollHeight; };
window.__render=function(id, htmlStr){ const el=document.getElementById(id); const d=document.createElement('div'); d.innerHTML=htmlStr; el.appendChild(d); };
window.__esc=function(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
</script></body></html>`;

const server = createServer((req,res)=>{
  if (req.url === '/') { res.writeHead(200,{'content-type':'text/html'}); res.end(html); }
  else if (req.url === '/clean' || req.url === '/tamper') { res.writeHead(200,{'content-type':'text/html'}); res.end(html); }
  else { res.writeHead(200,{'content-type':'text/plain'}); res.end('ok'); }
});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));

const base = findBase();
if (!base) { console.error('[!] instrumented bundle not found (assets/osc-index-wrapped.js)'); process.exit(1); }
const cleanSrc = inject(base, false);
const tamperSrc = inject(base, true);

// oracle report (earlier real-sandbox differential), embedded for display
let oracle = null;
try { oracle = JSON.parse(readFileSync('/tmp/opencode/osc/osc-oracle-report.json','utf8')); } catch(e){}

const browser = await chromium.launch({ headless:false, args:['--window-size=1060,940'] });
const ctx = await browser.newContext({ viewport:{ width:1000, height:920 } });
const page = await ctx.newPage();

const L = cls => txt => page.evaluate(([c,t])=>window.__log(c,t), [cls,txt]).catch(()=>{});
const step = async (cls, txt)=>{ await L(cls)(txt); await new Promise(r=>setTimeout(r,450)); };
const sleep = ms => new Promise(r=>setTimeout(r,ms));

let clean = null, tampered = null, cleanCaps = null;
await page.route('**/index.min.js*', r=>r.fulfill({ status:200, contentType:'application/javascript', body: cleanSrc }));
await page.route('**/telemetry', async r=>{ const q=r.request(); cleanCaps = cleanCaps || { len:(q.postData()||'').length }; await r.fulfill({ status:200, contentType:'application/json', body: JSON.stringify({ beaconIDs: [] }) }); });
await page.route('**/error', r=>r.fulfill({ status:200, contentType:'application/json', body:'{}' }));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil:'load' });
await L('dim')('[.] loading real sandbox loader: zqp-sand.oscilar.com/hwtsyp5h/loader.js');

// ---- phase 1: clean capture ------------------------------------------------
await step('acc','[*] loader fetched · SDK downloads index.min.js (instrumented in flight)');
await step('acc','[*] WASM engine init · collecting ~48 signal modules (screen/UA/fonts/canvas/emoji/…)');
await page.mouse.move(320,320); await page.mouse.click(320,320);
await page.waitForFunction(()=>window.__oscWasm && window.__oscWasm.some(c=>c.encB64 && c.encB64.length>100), { timeout:60000 }).catch(()=>{});
await sleep(4000);
const cap = await page.evaluate(()=>window.__oscWasm||[]).catch(()=>[]);
const good = cap.filter(c=>c.encB64 && c.encB64.length>100 && c.A && c.A.startsWith('{'));
clean = good.length ? JSON.parse(good[good.length-1].A) : null;
await L('ok')('[+] payload captured pre-encryption ('+(clean?Object.keys(clean).length:0)+' modules)');
await L('dim')('    telemetry POST intercepted locally — not forwarded');

// ChaCha20 key recovery
let keyInfo = null;
if (good.length){
  const c = good[good.length-1];
  const enc = Buffer.from(c.encB64,'base64'), out = Buffer.from(c.outB64,'base64');
  const st = Buffer.alloc(64); for (let i=0;i<64;i++) st[i] = enc[i]^out[i];
  keyInfo = {
    state0: st.subarray(0,16).toString(),
    key: st.subarray(16,48).toString('hex'),
    nonce: st.subarray(48,64).toString('hex'),
    ok: st.subarray(0,16).equals(Buffer.from('expand 32-byte k')),
    encLen: enc.length, outLen: out.length
  };
}
if (keyInfo && keyInfo.ok){
  await step('ok','[+] ChaCha20: plaintext XOR ciphertext → first-64B keystream = raw state');
  await L('hex')('    state[0:16] = "'+keyInfo.state0+'" (expand 32-byte k) ✓');
  await L('hex')('    KEY = '+keyInfo.key);
  await L('dim')('    counter/nonce = '+keyInfo.nonce);
} else { await L('bad')('[!] chacha recovery failed — bundle/cipher mismatch'); }

// render payload — FULLY expanded (every module, field, nested value, list item)
if (clean){
  await step('acc','[*] rendering FULL readable payload (all modules + all values) …');
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const TELLS = ['webdriver','isBrave','playwright','selenium','incognito','debuggerActive','cdpDetected','error','lie'];
  const rows = [];
  const push = (path, type, val, tell) => rows.push(`<tr${tell?' class="tell"':''}><td class="k">${esc(path)}</td><td class="dim">${esc(type)}</td><td>${val}</td></tr>`);
  const isObj = v => v !== null && typeof v === 'object';
  const prim = v => !isObj(v);
  function flatten(path, v) {
    const tell = TELLS.some(t => path.toLowerCase().includes(t));
    if (prim(v)) {
      let disp, title = '';
      if (typeof v === 'string') { disp = esc(v.slice(0,300)) + (v.length>300?'…':''); title = v; }
      else disp = esc(String(v));
      push(path, typeof v, title ? `<span title="${esc(title)}">${disp}</span>` : disp, tell);
      return;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) { push(path, 'list[0]', '<span class="dim">(empty)</span>', tell); return; }
      if (v.every(isObj)) {
        push(path, `list[${v.length}]`, `<span class="dim">${v.length} object(s)</span>`, tell);
        v.forEach((item, i) => flatten(`${path}[${i}]`, item));
      } else {
        const all = v.map(x => typeof x === 'string' ? `"${x}"` : String(x)).join(', ');
        const disp = all.length > 600 ? all.slice(0,600) + '…' : all;
        push(path, `list[${v.length}]`, `<span title="${esc(all)}">${esc(disp)}</span>`, tell);
      }
      return;
    }
    // object
    for (const [k, sub] of Object.entries(v)) flatten(`${path}.${k}`, sub);
  }
  for (const [mod, body] of Object.entries(clean)) flatten(mod, body);
  const table = '<table><tr><th>path</th><th>type</th><th>value</th></tr>' + rows.join('') + '</table>';
  await page.evaluate(([t,k])=>window.__render('out',
    '<h2>FULL READABLE PAYLOAD — '+k.modules+' modules · '+k.rows+' rows (captured pre-encryption from the SDK\'s own object)</h2>'+
    '<div style="max-height:62vh;overflow:auto;border:1px solid #30363d;border-radius:8px">'+t+'</div>'+
    '<div class="big"><b>ChaCha20 key:</b> '+k.key+'</div>'), [table, {modules:Object.keys(clean).length, rows: rows.length, key: keyInfo?keyInfo.key:'n/a'}]);
  mkdirSync('/tmp/opencode/osc',{recursive:true});
  writeFileSync('/tmp/opencode/osc/visual-A-clean.json', JSON.stringify(clean,null,2));
}

// ---- phase 2: tamper (in a SECOND tab so the full payload stays on page) ----
await step('bad','[*] PHASE 2: opening a second tab with the client-side payload tamper (screen 2560x1440, UA→Win32 Chrome, webdriver→false)');
const page2 = await ctx.newPage();
await page2.route('**/index.min.js*', r=>r.fulfill({ status:200, contentType:'application/javascript', body: tamperSrc }));
await page2.route('**/telemetry', r=>r.fulfill({ status:200, contentType:'application/json', body:JSON.stringify({ beaconIDs: [] }) }));
await page2.route('**/error', r=>r.fulfill({ status:200, contentType:'application/json', body:'{}' }));
await page2.goto(`http://127.0.0.1:${PORT}/`, { waitUntil:'load' });
await page2.mouse.move(320,320); await page2.mouse.click(320,320);
await page2.waitForFunction(()=>window.__oscWasm && window.__oscWasm.some(c=>c.encB64 && c.encB64.length>100), { timeout:60000 }).catch(()=>{});
await sleep(4000);
const cap2 = await page2.evaluate(()=>window.__oscWasm||[]).catch(()=>[]);
const good2 = cap2.filter(c=>c.encB64 && c.encB64.length>100 && c.A && c.A.startsWith('{'));
tampered = good2.length ? JSON.parse(good2[good2.length-1].A) : null;
await page2.close();
await L('ok')('[+] tampered payload captured in 2nd tab ('+(tampered?Object.keys(tampered).length:0)+' modules), re-encrypted, POST intercepted');

// render tamper diff (appended BELOW the full payload, which is still on page)
if (clean && tampered){
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const fields = [['JSScreen','width'],['JSScreen','height'],['JSScreen','screenWidth'],['JSScreen','screenHeight'],
    ['JSScreen','availWidth'],['JSScreen','availHeight'],['JSUserAgent','userAgent'],['JSUserAgent','platform'],
    ['JSUserAgent','webdriver'],['JSTime','timeString']];
  let rows='';
  for (const [m,f] of fields){
    const a = clean[m]&&clean[m][f], b = tampered[m]&&tampered[m][f];
    if (a===undefined && b===undefined) continue;
    rows += `<tr><td class="k">${esc(m)}.${esc(f)}</td><td>${esc(String(a).slice(0,70))}</td><td class="bad">${esc(String(b).slice(0,70))}</td></tr>`;
  }
  let oracleRows = '';
  if (oracle) {
    const mk = (m)=> oracle[m].responses.map(r=>`${r.status}/${r.beaconIDs||'?'}`).join(', ');
    oracleRows = '<tr><th>run</th><th>HTTP</th><th>beacons</th><th>d (device id)</th></tr>'+
      '<tr><td class="k">clean</td><td>'+mk('clean')+'</td><td>5</td><td>'+esc(String(oracle.clean.responses[0].d))+'…</td></tr>'+
      '<tr><td class="k">tampered</td><td>'+mk('tamper')+'</td><td>5</td><td>'+esc(String(oracle.tamper.responses[0].d))+'…</td></tr>';
  } else oracleRows = '<tr><td class="dim">oracle report not found — see scripts/oscilar-oracle.mjs</td></tr>';
  await page.evaluate(([r,o])=>window.__render('out',
    '<h2>TAMPER DIFF — what the server would see after client-side modification</h2>'+
    '<table><tr><th>field</th><th>clean</th><th>tampered</th></tr>'+r+'</table>'+
    '<h2>SANDBOX ORACLE — clean vs tampered (earlier real-sandbox differential)</h2>'+
    '<table>'+o+'</table>'+
    '<div class="big"><b>Takeaway:</b> the payload carries no client-side lie/anomaly flag, and the sandbox '
    +'returned the <b>same device id `d`</b> for clean and tampered runs — `d` is a device-identity signal, '
    +'<b>not a risk verdict</b>. Verdict/mismatch logic lives server-side.</div>'), [rows, oracleRows]);
  writeFileSync('/tmp/opencode/osc/visual-A-tampered.json', JSON.stringify(tampered,null,2));
}

await step('dim','———— done · close the window to exit —————');
mkdirSync(join(repoRoot,'screenshots'),{recursive:true});
// expand the inner scroll pane so fullPage captures EVERY row of the payload
await page.evaluate(()=>{ const el=document.querySelector('#out div[style*="max-height"]'); if (el) el.style.maxHeight='none'; });
await sleep(800);
await page.screenshot({ path: join(repoRoot,'screenshots','oscillar-full-payload.png'), fullPage:true });
await page.screenshot({ path: join(repoRoot,'screenshots','oscillar-view.png') });
console.log('[+] screenshots saved: screenshots/oscillar-full-payload.png, oscillar-view.png');
browser.on('disconnected', ()=> process.exit(0));
await new Promise(()=>{});
