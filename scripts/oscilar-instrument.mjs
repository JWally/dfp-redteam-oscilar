#!/usr/bin/env node
/**
 * oscilar-instrument.mjs — run the public sandbox loader on a local page,
 * block telemetry, and record the native APIs the SDK touches plus any
 * plaintext it builds before encrypting.
 *
 * Observation only. Telemetry POSTs are fulfilled locally, never sent.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

const html = readFileSync('/tmp/opencode/osc/instrument.html','utf8');
const server = createServer((req,res)=>{ res.writeHead(200,{'content-type':'text/html'}); res.end(html); });
await new Promise(r=>server.listen(8795,'127.0.0.1',r));

const INIT = `(() => {
  const W = window;
  const S = W.__osc = { ts: Date.now(), json: [], parse: [], enc: [], dec: [], subtle: [], wasm: [], workers: [], blobs: [], fetch: [], xhr: [], beacon: [], b64: [], storage: [], events: [], fnstr: [], canvas: [], webgl: [], errors: [] };
  const cap = (arr, obj, n = 400) => { if (arr.length < n) arr.push(obj); };
  const safe = (v, n = 2000) => { try { if (typeof v === 'string') return v.slice(0, n); const s = JSON.stringify(v); return s ? s.slice(0, n) : String(v); } catch(e) { return String(v).slice(0, n); } };
  const stack = () => { try { return (new Error().stack || '').split('\\n').slice(2, 6).join(' | '); } catch(e) { return ''; } };
  const b64 = (u8) => { try { const CH=8192, p=[]; for (let i=0;i<u8.length;i+=CH) p.push(String.fromCharCode.apply(null,u8.subarray(i,i+CH))); return btoa(p.join('')); } catch(e) { return ''; } };

  // ---- JSON.stringify / parse ----
  const oStringify = JSON.stringify, oParse = JSON.parse;
  JSON.stringify = function (v, r, s) {
    let out; try { out = oStringify.call(this, v, r, s); } catch(e) { out = oStringify.call(this, v); }
    try { if (typeof out === 'string' && out.length > 40) cap(S.json, { len: out.length, sample: out.slice(0,3000), keys: v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).slice(0,60) : null, stack: stack() }); } catch(e) { cap(S.errors, {where:'json', err:String(e)}); }
    return out;
  };
  JSON.parse = function (t, r) {
    try { if (typeof t === 'string' && t.length > 40) cap(S.parse, { len: t.length, sample: t.slice(0,2000), stack: stack() }); } catch(e) {}
    return oParse.call(this, t, r);
  };

  // ---- TextEncoder / Decoder ----
  const oEnc = TextEncoder.prototype.encode, oDec = TextDecoder.prototype.decode;
  TextEncoder.prototype.encode = function (str) {
    try { if (typeof str === 'string' && str.length > 20) cap(S.enc, { len: str.length, sample: str.slice(0,3000), stack: stack() }); } catch(e) {}
    return oEnc.call(this, str);
  };
  TextDecoder.prototype.decode = function (buf, opts) {
    const out = oDec.call(this, buf, opts);
    try { if (typeof out === 'string' && out.length > 20) cap(S.dec, { len: out.length, sample: out.slice(0,2000), stack: stack() }); } catch(e) {}
    return out;
  };

  // ---- WebCrypto ----
  const SC = W.SubtleCrypto && SubtleCrypto.prototype;
  if (SC) {
    const wrap = (name) => {
      const orig = SC[name]; if (typeof orig !== 'function') return;
      SC[name] = function (...args) {
        const rec = { op: name, algo: args[0] && (args[0].name || args[0]), args: [], stack: stack() };
        try {
          if (args[1] && args[1].algorithm) rec.key = { type: args[1].type, name: args[1].algorithm.name, extractable: args[1].extractable, usages: args[1].usages };
          if (args[2] && args[2].byteLength !== undefined) { const u8 = new Uint8Array(args[2]); rec.dataLen = u8.length; rec.dataB64 = b64(u8).slice(0,4000); try { rec.dataText = new TextDecoder().decode(u8).slice(0,3000); } catch(e) {} }
          if (args[0] && args[0].iv) rec.iv = b64(new Uint8Array(args[0].iv));
          if (args[0] && args[0].salt) rec.salt = b64(new Uint8Array(args[0].salt));
          if (args[0] && args[0].info) rec.info = b64(new Uint8Array(args[0].info));
          if (typeof args[1] === 'string') rec.keyData = args[1].slice(0,2000);
          if (name === 'importKey') rec.format = args[0];
          if (name === 'generateKey') rec.algo = args[0] && (args[0].name || args[0]);
        } catch(e) { rec.err = String(e); }
        cap(S.subtle, rec, 600);
        const p = orig.apply(this, args);
        try {
          p && p.then && p.then((res) => {
            try {
              if (res && res.type && res.algorithm) { rec.outKey = { type: res.type, name: res.algorithm.name }; try { origExport = SC.exportKey; } catch(e){} }
              else if (res instanceof ArrayBuffer) { const u8 = new Uint8Array(res); rec.outLen = u8.length; rec.outB64 = b64(u8).slice(0,4000); }
              else if (res && res.publicKey) { rec.outKeyPair = true; SC.exportKey.call(SC, 'raw', res.publicKey).then(k => { try { rec.pubB64 = b64(new Uint8Array(k)); } catch(e){} }).catch(()=>{}); }
              else if (res && res.byteLength !== undefined) { const u8 = new Uint8Array(res); rec.outLen = u8.length; rec.outB64 = b64(u8).slice(0,4000); }
            } catch(e) {}
          }, () => {});
        } catch(e) {}
        return p;
      };
    };
    ['encrypt','decrypt','digest','sign','verify','deriveBits','deriveKey','generateKey','importKey','exportKey','wrapKey','unwrapKey'].forEach(wrap);
  }

  // ---- fetch / XHR / sendBeacon ----
  const oFetch = W.fetch;
  if (oFetch) {
    W.fetch = function (input, init) {
      try {
        const u = typeof input === 'string' ? input : (input && input.url) || '';
        const rec = { url: u, method: (init && init.method) || (input && input.method) || 'GET', headers: (init && init.headers) || null, stack: stack() };
        if (init && typeof init.body === 'string') { rec.bodyLen = init.body.length; rec.body = init.body.slice(0,5000); }
        else if (init && init.body && typeof init.body.entries === 'function') { rec.form = {}; for (const [k,v] of init.body.entries()) rec.form[k] = (v && v.size !== undefined) ? ('Blob('+v.size+')') : String(v).slice(0,1000); }
        else if (init && init.body && init.body.byteLength !== undefined) { rec.bodyLen = init.body.byteLength; rec.bodyB64 = b64(new Uint8Array(init.body)).slice(0,3000); }
        else if (input && input.clone) { input.clone().text().then(t => { rec.cloneLen = t.length; rec.clone = t.slice(0,2000); }).catch(()=>{}); }
        cap(S.fetch, rec, 200);
      } catch(e) { cap(S.errors, {where:'fetch', err:String(e)}); }
      return oFetch.apply(this, arguments);
    };
  }
  const oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__osc = { method: m, url: u }; return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) { try { cap(S.xhr, { method: this.__osc && this.__osc.method, url: this.__osc && this.__osc.url, body: typeof b === 'string' ? b.slice(0,3000) : (b && b.size !== undefined ? 'Blob('+b.size+')' : null), stack: stack() }, 100); } catch(e) {} return oSend.apply(this, arguments); };
  if (navigator.sendBeacon) {
    const oBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (u, d) { try { cap(S.beacon, { url: String(u), body: typeof d === 'string' ? d.slice(0,3000) : (d && d.size !== undefined ? 'Blob('+d.size+')' : null) }, 100); } catch(e) {} return oBeacon(u, d); };
  }

  // ---- base64 ----
  const oBtoa = W.btoa, oAtob = W.atob;
  W.btoa = function (s) { const out = oBtoa.call(this, s); try { if (s && s.length > 40) cap(S.b64, { op:'btoa', inLen:s.length, outLen: out.length, sample:String(s).slice(0,1200), stack: stack() }, 300); } catch(e) {} return out; };
  W.atob = function (s) { const out = oAtob.call(this, s); try { if (s && s.length > 40) cap(S.b64, { op:'atob', inLen:s.length, outLen: out.length, sample: out.slice(0,1200), stack: stack() }, 300); } catch(e) {} return out; };

  // ---- WebAssembly ----
  if (W.WebAssembly) {
    const wrapWasm = (name, cb) => {
      const orig = WebAssembly[name]; if (typeof orig !== 'function') return;
      WebAssembly[name] = function (...args) {
        const rec = { op: name, stack: stack() };
        try {
          const src = args[0];
          if (src && src.byteLength !== undefined) rec.byteLen = src.byteLength;
          else if (src && src.buffer && src.buffer.byteLength !== undefined) rec.byteLen = src.buffer.byteLength;
          if (args[1] && typeof args[1] === 'object' && !(args[1] instanceof ArrayBuffer)) rec.imports = Object.keys(args[1]);
        } catch(e) {}
        cap(S.wasm, rec, 50);
        const p = orig.apply(this, args);
        if (cb) cb(p, rec);
        return p;
      };
    };
    const after = (p, rec) => {
      try {
        const handle = (r) => {
          const inst = (r && r.instance) || r;
          if (inst && inst.exports) {
            rec.exports = Object.keys(inst.exports);
            S.wasmInstance = inst;
            try {
              const mem = inst.exports.memory || (inst.exports.env && inst.exports.env.memory);
              if (mem && mem.buffer) rec.memLen = mem.buffer.byteLength;
            } catch(e) {}
          }
        };
        if (p && p.then) p.then(handle, () => {});
        else handle(p);
      } catch(e) {}
    };
    ['instantiate','compile','instantiateStreaming','compileStreaming'].forEach(n => wrapWasm(n, after));
    if (WebAssembly.Module) {
      const OM = WebAssembly.Module;
      WebAssembly.Module = function (...args) { try { const rec={op:'Module'}; const src=args[0]; if (src&&src.byteLength!==undefined) rec.byteLen=src.byteLength; cap(S.wasm,rec,50); } catch(e) {} return new OM(...args); };
    }
  }

  // ---- Workers ----
  const OW = W.Worker;
  if (OW) {
    W.Worker = function (url, opts) {
      try {
        const rec = { url: String(url), stack: stack() };
        if (url instanceof Blob) { rec.blobSize = url.size; url.text().then(t => { rec.textLen = t.length; rec.text = t.slice(0,6000); }).catch(()=>{}); }
        cap(S.workers, rec, 20);
      } catch(e) {}
      const w = new OW(url, opts);
      try { w.addEventListener('message', e => { try { cap(S.workers, { op:'message', data: safe(e.data, 3000) }, 50); } catch(e) {} }); } catch(e) {}
      try { const op = w.postMessage.bind(w); w.postMessage = function (m, t) { try { cap(S.workers, { op:'postMessage', data: safe(m, 3000) }, 50); } catch(e) {} return op(m, t); }; } catch(e) {}
      return w;
    };
  }

  // ---- Blob / object URL ----
  const OB = W.Blob;
  W.Blob = function (parts, opts) {
    try { const rec = { size: 0, type: opts && opts.type }; if (parts) for (const p of parts) rec.size += (p && p.size !== undefined) ? p.size : (p && p.length !== undefined ? p.length : 0); cap(S.blobs, rec, 100); } catch(e) {}
    return new OB(parts, opts);
  };

  // ---- storage ----
  const oSet = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) { try { cap(S.storage, { storage: this === localStorage ? 'local' : 'session', key: k, len: String(v).length, value: String(v).slice(0,2000) }, 100); } catch(e) {} return oSet.apply(this, arguments); };

  // ---- events ----
  const oDispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (e) { try { if (e && e.type) cap(S.events, { type: e.type, detail: e.detail ? safe(e.detail, 800) : null }, 100); } catch(e) {} return oDispatch.apply(this, arguments); };

  // ---- Function.toString (what anti-tamper checks) ----
  const oFnStr = Function.prototype.toString;
  Function.prototype.toString = function () { try { const n = this && this.name; cap(S.fnstr, { name: n, stack: stack() }, 400); } catch(e) {} return oFnStr.call(this); };

  // ---- canvas / webgl ----
  const oToData = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function () { const out = oToData.apply(this, arguments); try { cap(S.canvas, { op:'toDataURL', len: out.length, prefix: out.slice(0,120) }, 50); } catch(e) {} return out; };
  const oGetImage = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function () { try { cap(S.canvas, { op:'getImageData', w: arguments[2], h: arguments[3] }, 50); } catch(e) {} return oGetImage.apply(this, arguments); };
  const oGetParam = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (p) { const out = oGetParam.apply(this, arguments); try { cap(S.webgl, { p: p, out: typeof out === 'string' ? out.slice(0,200) : String(out) }, 200); } catch(e) {} return out; };
})();`;

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext();
await ctx.addInitScript({ content: INIT });
const page = await ctx.newPage();
// Block telemetry outbound, but log it.
const telemetry = [];
await page.route('**/telemetry', async (route) => {
  const req = route.request();
  let body = req.postData(); if (body && body.length > 6000) body = body.slice(0,6000)+'…';
  telemetry.push({ url: req.url(), method: req.method(), body });
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ beaconIDs: [] }) });
});
page.on('console', m => { if (m.type()==='error') console.log('console.error', m.text().slice(0,200)); });
page.on('pageerror', e => console.log('pageerror', String(e).slice(0,200)));
await page.goto('http://127.0.0.1:8795/', { waitUntil:'load' });
await page.mouse.move(320,320); await page.mouse.click(320,320);
await page.waitForTimeout(20000);
const cap = await page.evaluate(() => window.__osc).catch(()=>null);
mkdirSync('/home/justin/Dev/ms-argus-attack-bots/bots/results',{recursive:true});
const out = `/home/justin/Dev/ms-argus-attack-bots/bots/results/oscilar-instrument-${Date.now()}.json`;
writeFileSync(out, JSON.stringify({ telemetry, cap }, null, 2));

const counts = {};
for (const k of Object.keys(cap||{})) if (Array.isArray(cap[k])) counts[k] = cap[k].length;
console.log('counts', JSON.stringify(counts));
console.log('\nsubtle ops:');
for (const s of (cap?.subtle||[])) console.log(' ', s.op, s.algo, s.key ? JSON.stringify(s.key) : '', s.dataLen ? 'dataLen='+s.dataLen : '', s.dataText ? 'TEXT='+s.dataText.slice(0,200) : '', s.outLen ? 'outLen='+s.outLen : '');
console.log('\njson captures (top 8 by len):');
for (const j of (cap?.json||[]).sort((a,b)=>b.len-a.len).slice(0,8)) console.log(' ', j.len, j.keys ? JSON.stringify(j.keys).slice(0,200) : '', '\n   ', (j.sample||'').slice(0,500));
console.log('\nenc captures (top 5):');
for (const e of (cap?.enc||[]).sort((a,b)=>b.len-a.len).slice(0,5)) console.log(' ', e.len, (e.sample||'').slice(0,400));
console.log('\nwasm:'); console.log(JSON.stringify(cap?.wasm, null, 1).slice(0,1500));
console.log('\nworkers:'); console.log(JSON.stringify(cap?.workers, null, 1).slice(0,1500));
console.log('\nfetch:'); for (const f of (cap?.fetch||[])) console.log(' ', f.method, f.url, f.bodyLen||f.form?JSON.stringify(f.form||f.body).slice(0,400):'');
console.log('\ntelemetry:'); for (const t of telemetry) console.log(' ', t.method, t.url, (t.body||'').slice(0,200));
console.log('\nwrote', out);
await b.close(); server.close();
