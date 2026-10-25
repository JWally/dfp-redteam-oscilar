#!/usr/bin/env node
/**
 * oscilar-wasm.mjs — capture the sandbox SDK's WASM module, memory, export
 * calls, and worker source. Telemetry is fulfilled locally, never sent.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

const html = readFileSync('/tmp/opencode/osc/instrument-prod.html','utf8');
const server = createServer((req,res)=>{ res.writeHead(200,{'content-type':'text/html'}); res.end(html); });
await new Promise(r=>server.listen(8799,'127.0.0.1',r));

const INIT = `(() => {
  const W = window;
  const S = W.__oscw = { wasm: [], calls: [], blobs: [], blobTexts: [], workerMsgs: [], errors: [] };
  const cap = (a,o,n=400)=>{ if(a.length<n) a.push(o); };
  const stack = () => { try { return (new Error().stack||'').split('\\n').slice(2,6).join(' | '); } catch(e){ return ''; } };
  const b64 = (u8) => { try { const CH=8192,p=[]; for(let i=0;i<u8.length;i+=CH)p.push(String.fromCharCode.apply(null,u8.subarray(i,i+CH))); return btoa(p.join('')); } catch(e){ return ''; } };

  const readStr = (inst, ptr, len, utf16) => {
    try {
      const mem = inst.exports.memory;
      const u8 = new Uint8Array(mem.buffer);
      if (!ptr || ptr < 0 || ptr >= u8.length) return '';
      const n = len && len > 0 && len < 4096 ? len : 256;
      const slice = u8.subarray(ptr, Math.min(ptr + n, u8.length));
      return new TextDecoder(utf16 ? 'utf-16le' : 'utf-8', {fatal:false}).decode(slice).replace(/[^ -~]/g,'.').slice(0,300);
    } catch(e) { return ''; }
  };

  const OB = W.Blob;
  W.Blob = function (parts, opts) {
    try {
      const rec = { type: opts && opts.type, size: 0, text: '' };
      if (parts) for (const p of parts) {
        if (typeof p === 'string') { rec.size += p.length; if (rec.text.length < 30000) rec.text += p; }
        else if (p && p.size !== undefined) rec.size += p.size;
        else if (p && p.byteLength !== undefined) rec.size += p.byteLength;
      }
      cap(S.blobs, rec, 30);
    } catch(e) {}
    return new OB(parts, opts);
  };
  const oCreate = URL.createObjectURL;
  URL.createObjectURL = function (blob) {
    const url = oCreate.call(this, blob);
    try { if (blob && blob.text) blob.text().then(t => cap(S.blobTexts, { url, len: t.length, text: t.slice(0,40000) }, 30)).catch(()=>{}); } catch(e) {}
    return url;
  };

  const after = (p, rec) => {
    const handle = (r) => {
      try {
        const inst = (r && r.instance) || r;
        if (!inst || !inst.exports) return;
        S.instance = inst;
        rec.exports = Object.keys(inst.exports);
        try { const mem = inst.exports.memory; if (mem) rec.memLen = mem.buffer.byteLength; } catch(e) {}
        // wrap exported functions
        for (const [k, v] of Object.entries(inst.exports)) {
          if (typeof v !== 'function') continue;
          inst.exports[k] = function (...args) {
            const out = v.apply(this, args);
            try {
              if (k.startsWith('__') || S.calls.length < 500) {
                const rec2 = { name: k, args: args.slice(0,8).map(a => typeof a === 'number' ? a : (typeof a === 'string' ? a.slice(0,120) : String(a))), out: typeof out === 'number' ? out : String(out).slice(0,120), stack: stack() };
                try {
                  const ptrs = args.filter(a => typeof a === 'number' && a > 0);
                  if (ptrs.length) rec2.mem = ptrs.slice(0,3).map(p => ({ p, utf8: readStr(inst,p,128,false), utf16: readStr(inst,p,128,true) }));
                } catch(e) {}
                cap(S.calls, rec2, 800);
              }
            } catch(e) {}
            return out;
          };
        }
      } catch(e) { cap(S.errors, {where:'after', err:String(e)}); }
    };
    try { if (p && p.then) p.then(handle, ()=>{}); else handle(p); } catch(e) {}
  };
  const wrapWasm = (name, cb) => {
    const orig = WebAssembly[name]; if (typeof orig !== 'function') return;
    WebAssembly[name] = function (...args) {
      const rec = { op: name, stack: stack() };
      try {
        const src = args[0];
        if (src && src.byteLength !== undefined) { rec.byteLen = src.byteLength; rec.b64 = b64(new Uint8Array(src)).slice(0, 600000); }
        else if (src && src.buffer && src.buffer.byteLength !== undefined) { rec.byteLen = src.buffer.byteLength; rec.b64 = b64(new Uint8Array(src.buffer)).slice(0, 600000); }
        if (args[1] && typeof args[1] === 'object' && !(args[1] instanceof ArrayBuffer)) rec.imports = Object.keys(args[1]);
      } catch(e) { cap(S.errors,{where:name,err:String(e)}); }
      cap(S.wasm, rec, 10);
      const p = orig.apply(this, args);
      if (cb) cb(p, rec);
      return p;
    };
  };
  ['compile','instantiate','instantiateStreaming','compileStreaming'].forEach(n => wrapWasm(n, after));

  const OW = W.Worker;
  if (OW) {
    W.Worker = function (url, opts) {
      try { cap(S.workerMsgs, { op:'new', url:String(url), stack: stack() }, 20); } catch(e) {}
      const w = new OW(url, opts);
      try { w.addEventListener('message', e => { try { cap(S.workerMsgs, { op:'message', data: typeof e.data === 'string' ? e.data.slice(0,3000) : String(e.data) }, 50); } catch(e) {} }); } catch(e) {}
      return w;
    };
  }
})();`;

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext();
await ctx.addInitScript({ content: INIT });
const page = await ctx.newPage();
const telemetry = [];
await page.route('**/telemetry', async (route) => {
  telemetry.push(route.request().postData() || '');
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ beaconIDs: [] }) });
});
page.on('pageerror', e => console.log('pageerror', String(e).slice(0,200)));
await page.goto('http://127.0.0.1:8799/', { waitUntil:'load' });
await page.mouse.move(320,320); await page.mouse.click(320,320);
await page.waitForTimeout(25000);

// dump memory + instance info from the page
const dump = await page.evaluate(() => {
  const S = window.__oscw;
  let memB64 = null, memLen = 0;
  try {
    const inst = S.instance; const mem = inst.exports.memory;
    const u8 = new Uint8Array(mem.buffer); memLen = u8.length;
    const CH = 8192, p = [];
    for (let i=0;i<u8.length;i+=CH) p.push(String.fromCharCode.apply(null,u8.subarray(i,i+CH)));
    memB64 = btoa(p.join(''));
  } catch(e) {}
  return { memB64, memLen, wasm: S.wasm.map(w => ({op:w.op, byteLen:w.byteLen, b64:w.b64, imports:w.imports, exports:w.exports, memLen:w.memLen})), calls: S.calls, blobs: S.blobs, blobTexts: S.blobTexts, workerMsgs: S.workerMsgs, errors: S.errors };
});
mkdirSync('/tmp/opencode/osc',{recursive:true});
const w = dump.wasm.find(x=>x.b64);
if (w) writeFileSync('/tmp/opencode/osc/osc-prod.wasm', Buffer.from(w.b64,'base64'));
if (dump.memB64) writeFileSync('/tmp/opencode/osc/osc-prod-memory.bin', Buffer.from(dump.memB64,'base64'));
for (let i=0;i<telemetry.length;i++) writeFileSync(`/tmp/opencode/osc/osc-telemetry-${i}.json`, telemetry[i]);
writeFileSync('/tmp/opencode/osc/osc-prod-wasm-dump.json', JSON.stringify({ ...dump, memB64: undefined, wasm: dump.wasm.map(w=>({...w,b64:undefined})), telemetry: telemetry.map(t=>t.slice(0,500)) }, null, 2));

console.log('wasm bytes', w?.byteLen, 'memory', dump.memLen, 'telemetry', telemetry.length);
console.log('exports', JSON.stringify(dump.wasm.find(x=>x.exports)?.exports || []).slice(0,1000));
console.log('calls', dump.calls.length);
for (const c of dump.calls.slice(0,40)) console.log(' ', c.name, JSON.stringify(c.args), '->', c.out, c.mem && c.mem[0] ? JSON.stringify(c.mem[0]).slice(0,220) : '');
console.log('blobTexts', dump.blobTexts.map(b=>b.len));
for (const b of dump.blobTexts) console.log('--- worker blob', b.len, '---\n', b.text.slice(0,2000));
console.log('workerMsgs', JSON.stringify(dump.workerMsgs).slice(0,1000));
console.log('errors', JSON.stringify(dump.errors).slice(0,500));
await b.close(); server.close();
