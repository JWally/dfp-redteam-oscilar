# Oscilar SDK — deep dive (public sandbox build 8.2.2)

**Date:** 2026-10-25
**Target:** `https://zqp-sand.oscilar.com/hwtsyp5h/{loader.js,index.min.js,telemetry}`
(public marketing-site tenant; telemetry blocked locally, never sent)
**Artifacts:** `bots/oscilar-instrument.mjs`, `bots/oscilar-wasm.mjs`,
`/tmp/opencode/osc/osc-sandbox.wasm`, `osc-sandbox-memory.bin`,
`osc-telemetry-{0,1,2}.json`, `osc-wasm-dump.json`.

## TL;DR

- The JS bundle is a thin obfuscated shell. The real work is a **325 KB
  AssemblyScript/WASM module** with a **3 MB exported memory**.
- **No `crypto.subtle`, no `TextEncoder`, no `TextDecoder`** calls at all.
  Encryption/compression/marshalling are **custom, inside WASM**.
- The WASM name section is **not stripped**. Readable symbols include:
  `encryptPayload`, `gcmEncrypt`, `gcmDecrypt`, `chacha20Block`,
  `poly1305Mac`, `computeHMAC`, `hashSHA1/256/512`, `hashMD5`,
  `pbkdf2Rounds`, `deriveKey`, `stretchKey`, `expandKey`, `generateNonce`,
  `lz4Compress/Decompress`, `marshalBinary/unmarshalBinary`,
  `encodeBase64/decodeBase64`.
- `JSON.stringify` / `TextEncoder` traps see **only the encrypted envelope**
  `{beaconID, data}`. The fingerprint never crosses those APIs.
- But the plaintext **is in the exported WASM memory**. A page script can hook
  `WebAssembly.instantiate` and read it — which is exactly what I did. The
  memory dump contains the full field schema and live values.
- Worker: a tiny blob worker probes **OPFS sync-access-handle flush timing**
  (`createSyncAccessHandle`, `< 0.1 ms`) for `opfsIncognitoDetected`.

## Native API inventory (sandbox run)

From the instrumented run (`oscilar-instrument-*.json`):

| API | Calls | Notes |
|---|---|---|
| `JSON.stringify` | 14 | only `{beaconID,data}` and `__oscf__` |
| `JSON.parse` | 20 | config/responses |
| `TextEncoder.encode` | **0** | not used |
| `TextDecoder.decode` | **0** | not used |
| `crypto.subtle.*` | **0** | no WebCrypto |
| `WebAssembly.compile` | 1 | 324,982 bytes |
| `WebAssembly.instantiate` | 1 | 196 exports, 3 import modules |
| `Worker` | 2 | blob workers (OPFS probe + one binary worker) |
| `canvas.toDataURL/getImageData` | 17 | canvas fingerprint |
| `btoa/atob` | 17 | base64 stages |
| `localStorage/sessionStorage.setItem` | 4 | `__oscf__`, `__xr9f__`, `__oscTID`, `buffer` |
| `fetch` | 1 (page hook) / 3 (route) | `POST /telemetry` |
| `XHR` / `sendBeacon` | 0 | fetch only |

The first Worker's source:

```js
(async()=>{try{
  const r=await navigator.storage.getDirectory(),
        f=await(await r.getFileHandle('_',{create:true})).createSyncAccessHandle(),
        b=new Uint8Array(1); let m=Infinity;
  for(let i=0;i<3;i++){f.write(b,{at:0});const s=performance.now();f.flush();
    const dt=performance.now()-s;if(dt<m)m=dt}
  f.close(); const res=m<0.1; try{await r.removeEntry('_')}catch{}
  postMessage(res)
}catch{postMessage(false)}})()
```

That's an OPFS flush-latency probe (VM/incognito/remote-FS signal), not a
fingerprint collector.

## WASM

```
bytes:   324,982
memory:  3,145,728 (exported)
exports: __new, __pin, __unpin, __collect, __rtti_base, __setArgumentsLength,
         memory, + ~190 obfuscated `_...` functions
imports: _Ze6u, _Ra7k, _tYQ2lq
```

AssemblyScript runtime markers (`__new/__pin/__collect/__rtti_base`) are
unmistakable. The name section leaks the crypto/compression pipeline:

```
generateNonce  deriveKey  stretchKey  pbkdf2Rounds  expandKey
chacha20Block  poly1305Mac  gcmEncrypt  gcmDecrypt
computeHMAC  hashSHA1  hashSHA256  hashSHA512  hashMD5
lz4Compress  lz4Decompress  compressBlock  decompressChunk
marshalBinary  unmarshalBinary  encodeBase64  decodeBase64
encryptPayload
```

So the likely pipeline is:
`fingerprint object → marshalBinary → lz4Compress → AEAD (ChaCha20-Poly1305
or AES-GCM) with a key from deriveKey/stretchKey/pbkdf2 and a generated nonce
→ base64 → {beaconID, data}`.

`beaconID` is 88 base64 chars with a stable 64-char prefix and a per-beacon
24-char suffix — consistent with an encrypted device/session token + per-beacon
nonce/tag. `data` is ~22 KB base64; first ~100 chars are stable across beacons,
the body varies.

## The plaintext schema (from WASM memory)

Top-level keys:

```
transactionID, tabID, sessionID, deviceID, version
```

43 signal modules (`JS*`):

```
JSTime, JSScreen, JSKeyboard, JSMouse, JSTouch, JSUserAgent, JSFonts,
JSCanvasHash, JSClipboard, JSSDK, JSWebGL, JSBattery, JSAdblockDetector,
JSConsole, JSIncognito, JSBrowserPlugins, JSWebRTC, JSLocation, JSRealm,
JSUserJourney, JSEmoji, JSAudio, JSHardwareConcurrency, JSSeleniumProperties,
JSCSSMediaQueries, JSPlaywright, JSFontMetrics, JSMathFingerprint,
JSSpeechVoices, JSBrowserExtensions, JSBrowserFeatures, JSDRM, JSWebGPU,
JSClientRects, JSMediaCodecs, JSExtendedFonts, JSDeviceIdPersistence,
JSRuntimeDomain, JSVideo, JSBrowserFeaturesV2, JSLoadTiming, JSRequestSample,
JSWebLocks
```

Notable per-module fields observed in memory:

- **JSUserAgent** — `userAgent`, `appCodeName`, `appName`, `appVersion`,
  `platform`, `product`, `productSub`, `vendor`, `vendorSub`, `cookieEnabled`,
  `deviceMemory`, `doNotTrack`, `hardwareConcurrency`, `language`, `languages`,
  `maxTouchPoints`, `pdfViewerEnabled`, **`webdriver`**, `uaData`, `isBrave`.
  Live values: `HeadlessChrome/148.0.7778.96`, `Linux x86_64`, `Google Inc.`.
- **JSScreen** — width/height, avail, colorDepth, pixelDepth, devicePixelRatio,
  `isExtended`, outer size, `visualViewportScale`.
- **JSCanvasHash / JSWebGL** — `contextName`, `contextNativeFns`,
  `dataURLSubstr`, `vendor`, `renderer`, `extensions`, `glVersion`,
  `shadingLanguageVersion`, all the `maxTextureSize`/`max*` limits,
  **`unmaskedRenderer`**, **`unmaskedVendor`**, `enhancedRenderHash`,
  `shaderPrecisionHash`.
- **JSAudio** — `audioContextHash`, `oscillatorHash`, `analyserHash`,
  `destinationHash`, `audioBufferHash`, `supportedCodecs` (`audio/mpeg`,
  wav/ogg/aac/webm/flac), `sampleRate`, `fftSize`, `frequencyDataHash`,
  `timeDataHash`, `compressorHash`, hashes.
- **JSFonts / JSExtendedFonts / JSFontMetrics** — huge font list (Arial,
  Helvetica, Times New Roman, Wingdings, Apple/MS/Noto families, …), plus
  `serifHash`, `sansSerifHash`, `monospaceHash`, `cursorWidthsHash`,
  `numFontsMeasured`.
- **JSMouse / JSKeyboard / JSTouch** — trust + timing + coalescing:
  `isTrusted`, `movementX/Y`, `movesSince`, `msSinceLastMove`, `pointerType`,
  `pressure`, `tiltX/Y`, `twist`, `numSimulatedMoveEvents`,
  `numUntrustedMoveEvents`, `maxCoalescedEvents`, `numFutureStampedEvents`,
  `domContentLoadedEndMs`, `reasoningDelayMs`, gesture trails.
- **JSUserJourney** — `pageVisits`, `focusEvents`, `visibilityStates`,
  `totalTimeSpent`, `lastActiveTime`, per-page `path/title/entryTime/exitTime/
  timeSpent/isHistoryChange/referrer/navigationType`.
- **JSWebRTC** — `publicIP` (saw `107.210.133.127`), `candidateType` (`srflx`).
- **JSLocation** — locationHref/string, documentURI/URL/baseURI,
  performanceURL, navigationURL, navigationEntriesURL, anchorURL.
- **JSAdblockDetector** — `domBlockers`, `networkBlockedURLs`,
  `numDOMChecked`.
- **JSIncognito** — `serviceWorker`, `webkitTemporaryStorage`, `indexedDB`,
  **`opfsIncognitoDetected`**.
- **JSConsole** — `open`, `propsHash`, **`cdpDetected`**.
- **JSSeleniumProperties / JSPlaywright / JSBrowserExtensions** —
  `windowProps`, `documentProps`, prop counts/hashes.
- **JSHardwareConcurrency** — `estimatedConcurrency`, confidence/method/
  duration/samples, `maxWorkersAttempted`, `Worker execution timeout`.
- **JSMathFingerprint** — `mathHash`, `mathResults`, `extMathHash`,
  `extMathResults`, `nanBehavior`, `wasmMathHash`, `wasmVsJsResults`, `engine`
  (saw `acos(0.123)=1.4473588658278522`).
- **JSCSSMediaQueries** — prefers-color-scheme/contrast/reduced-motion/
  transparency, colorGamut, dynamicRange, forcedColors, monochrome,
  invertedColors, pointer/hover/any-pointer/any-hover.
- **JSBattery** — charging, chargingTime, dischargingTime, level.
- **JSEmoji** — emoji rendering set + per-emoji hashes.
- **JSClientRects / JSExtendedFonts / JSMediaCodecs / JSDRM / JSWebGPU /
  JSVideo / JSClipboard / JSRealm / JSRuntimeDomain / JSDeviceIdPersistence /
  JSBrowserFeatures(V2) / JSLoadTiming / JSRequestSample / JSWebLocks** —
  additional rendering/codec/DRM/GPU/lifecycle/persistence signals.

Live values in the memory dump: `2026-10-25T13:05:01.811Z`,
`America/Chicago`, `Mozilla/5.0 … HeadlessChrome/148 …`,
`Linux x86_64`, `Google Inc.`, WebRTC `107.210.133.127` (`srflx`),
audio codec list, font list, math result, etc.

## Why the JSON/TextEncoder traps missed it

The SDK builds the object in WASM and seals it there. `JSON.stringify` is used
only for the final `{beaconID,data}` envelope and the localStorage record. The
only way to see the plaintext is to instrument the WASM boundary/memory — which
worked because `WebAssembly.Memory` is exported and the page realm owns the
instance.

This is the important architectural point: **WASM raises the cost, but the
page is still the attacker's VM. The plaintext is in the same realm.** If the
goal is to hide the payload from a controlled client, WASM alone does not do
it; the trust has to move server-side (nonce-bound MAC, server recomputation,
hardware attestation).

## What I did not do

- Full JS string-table deobfuscation (`H`, `bc`, `qc`, `KM`, `pH` decoders).
  The WASM name section + memory gave the schema faster.
- Recover the exact KDF/key schedule and decrypt `data`. The WASM has
  `pbkdf2Rounds`/`stretchKey`/`deriveKey`/`generateNonce`; the tenant `did`
  and per-request `tid`/`rids` are likely inputs. That's the next step if you
  want to turn `data` back into JSON offline.
- Touch any customer origin or send telemetry. All POSTs were fulfilled
  locally with `{"beaconIDs":[]}`.

## Interview talking points

1. **Architecture:** dynamic per-tenant loader (fresh `tid`/`rids` per page
   load) + immutable 325 KB WASM engine + encrypted beacons + localStorage
   device seed. Stronger anti-replay design than a static client key.
2. **Crypto:** custom AssemblyScript crypto (ChaCha20-Poly1305 and AES-GCM,
   HMAC, SHA-1/256/512, MD5, PBKDF2, LZ4) rather than `crypto.subtle`. Ask
   why: WASM constant-time control? bundle size? key hiding? Note the
   trade-off: hand-rolled crypto + readable WASM name section + exported
   memory.
3. **Data:** 43 modules, heavily behavioral (mouse/keyboard/touch trust and
   timing, user journey, focus/visibility), plus the usual canvas/WebGL/audio/
   fonts/math/WebRTC/UA/screen/CSS media, plus bot signals (`webdriver`,
   `cdpDetected`, `Selenium`/`Playwright` props, `opfsIncognitoDetected`,
   adblock, console, WebLocks, hardware concurrency).
4. **Binding:** ask whether `transactionID`/`tabID`/`sessionID`/`deviceID` are
   single-use/server-issued, whether the AEAD key is derived from the
   server-issued `tid`/`rids`, and whether the server rejects a replayed
   `beaconID`/`data` from a different origin/IP/UA.
5. **WASM boundary:** the plaintext is readable from exported memory. Ask how
   they treat that in the threat model; the answer is usually "WASM is
   obfuscation, not a trust boundary."
6. **Product:** how `zqp` relates to the Fingerprint partnership — is
   Fingerprint an optional signal provider alongside the in-house 43-module
   SDK, or a fallback?
