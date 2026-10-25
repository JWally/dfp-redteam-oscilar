# Oscilar client-side SDK — assessment & interview brief

**Date:** 2026-10-25
**Subject:** public Oscilar device-intelligence SDK (`zqp`) and its public
sandbox/prod tenants
**Method:** passive/public asset review + local browser instrumentation.
Telemetry was fulfilled locally except for a small clean-vs-tampered
differential against Oscilar's own sandbox tenant. No customer origin was
touched.

**Companion notes / artifacts**

- `OSCILAR_RECON_2026_10_25.md` — first pass, deployment map, loader config
- `OSCILAR_DEEP_2026_10_25.md` — API inventory, WASM, payload schema
- `OSCILAR_CRYPTO_DEEP_2026_10_25.md` — cipher/key findings
- This file — consolidated writeup + interview framing
- Scripts: `oscilar-probe.mjs`, `oscilar-instrument.mjs`, `oscilar-wasm.mjs`,
  `oscilar-prod-wasm.mjs`, `oscilar-strings.mjs`, `oscilar-wasm-args.mjs`,
  `oscilar-tamper.mjs`, `oscilar-oracle.mjs`, `oscilar-oracle-persistent.mjs`,
  `oscilar-lie.mjs`, `oscilar-chacha-poc.mjs`
- Captures: `/tmp/opencode/osc/` (WASM, memory dumps, telemetry JSON)

---

## 1. Executive summary

Oscilar's client SDK is a **two-stage, per-tenant loader + a large obfuscated
JS shell + a 266–325 KB AssemblyScript/WASM engine**. It collects a very broad
device/behavioral fingerprint (43 modules in sandbox, 37 in prod) and ships it
as an encrypted binary blob.

The architecture has one genuinely strong idea and several weak ones:

**Strong:** the loader is dynamic. Each page load gets fresh server-issued
`tid`/`rids` (plus a `did`) that the SDK uses for the beacon. That gives the
server a per-page-load nonce to bind/anti-replay against.

**Weak:**

1. There is **no native WebCrypto**. The crypto is hand-rolled in WASM.
2. The WASM **exports its memory**, and the plaintext payload sits in it. A
   page script that hooks `WebAssembly.instantiate` can read the full
   fingerprint before it is encrypted.
3. The cipher is a hand-rolled **ChaCha20** variant whose **first 64 bytes of
   keystream are the raw initial state**:
   `"expand 32-byte k" || key || counter || nonce`. One beacon plus the public
   payload header recovers the key.
4. The key is **identical in the prod tenant I tested (`8ec9te11`) and the
   sandbox tenant (`hwtsyp5h`)**, and looks like a fixed/global test key
   (`7f 00 00 00 … ff`). The nonce is low-entropy.
5. The client **does not check for navigator lies**. Obvious Safari-UA /
   Linux-platform / Chromium-UA-CH contradictions are recorded and shipped
   without any `lie`/`anomaly` flag.
6. The many `*Hash` fields in the payload are **plain 32-bit signal hashes**
   (plus one SHA-384-looking digest). They are not keyed MACs/signatures and
   do not stop a client that controls the data.
7. The merchant sandbox is **sales-led**; there is no public self-service
   signup/trial/docs.

For an interview, the interesting story is the contrast: good server-issued
nonce/binding design, weak client-side crypto and no client-side
consistency/lie engine. The server/dashboard is where the real verdict and
mismatch checks live.

---

## 2. Where Oscilar is deployed

| Host | Role | Hosting |
|---|---|---|
| `oscilar.com` / `www.oscilar.com` | Marketing (Framer, ~1.9 MB page) | Cloudflare + Framer |
| `app.oscilar.com` | Product dashboard (React SPA) | Vercel |
| `docs.oscilar.com` | API docs (ReadMe, **password-protected**) | Cloudflare |
| `zqp.oscilar.com/<tenant>/loader.js` | **Production** device-intel SDK | Cloudflare → AWS API Gateway (Fastify/Lambda) |
| `zqp-sand.oscilar.com/<tenant>/loader.js` | **Sandbox** SDK | same |

Per-tenant paths: `/<tenant>/loader.js`, `/<tenant>/index.min.js`,
`/<tenant>/telemetry`, `/<tenant>/error`.

Public examples of real deployments (from public URL-scan indexes, not probed):

- `app.topperpay.com` → `zqp.oscilar.com/8ec9te11/loader.js`
- `ezmanagementllc.managebuilding.com` → `zqp.oscilar.com`
- `natural.com`, `url6422.livelyme.com` → `zqp.oscilar.com`

The marketing site dogfoods the sandbox tenant `hwtsyp5h`.

### Self-service?

**No — sales-led.** Evidence:

- `oscilar.com` only links `./demo` and `./contact-us`; both are HubSpot forms.
- `/pricing` redirects to `/demo`. `/sandbox`, `/developers`, `/docs`, `/api`,
  `/plans` → 404.
- `docs.oscilar.com` is a password-gated ReadMe page.
- `app.oscilar.com` is a WorkOS-authenticated SPA (`/auth/workos/SignIn`,
  `workos-logout`); `/login`, `/signup`, `/auth/landing` all return the same
  app shell; no public signup/trial CTA.
- `zqp-sand` is their own marketing/demo tenant, not a self-service developer
  sandbox.

To get a sandbox account, docs password, or dashboard access, talk to a
client rep/sales — or ask the interviewer/recruiter for a sandbox account.

---

## 3. Loader (2.5 KB, dynamic)

Marketing site:

```html
<script async src="https://zqp-sand.oscilar.com/hwtsyp5h/loader.js"></script>
```

The loader:

1. Injects `<tenant>/index.min.js?bid=…&c=…&k=…`.
2. Removes itself and removes the injected SDK tag on load.
3. On error, fires an image beacon to `<tenant>/error`.
4. Hands a config object to the SDK via rotating custom events.

Example prod config:

```js
{
  c:"8ec9te11",                       // tenant
  oe:null,
  tid:"E2BfLQkJ…",                    // per-request transaction token
  rids:[ "...", "...", "...", "...", "..." ], // 5 per-request request IDs
  tel:[2143289343, 1060841599],       // masks/flags
  net:"./telemetry",
  did:"hh0eMecIVd4…",                 // device seed/ID
  v:"8.1.3",
  nr:false, dcld:4000, ld:10000, bl:false,
  gab:false, bbc:0, ggt:5000
}
```

Key observation: the loader is **dynamic** (`cache-control: no-cache,
no-store, must-revalidate`). Fetching it three times produced three different
`tid`s, three `rids` sets, and a different `c` config hash, while
`bid`/`did`/`v` stayed constant. That is a **server-issued per-page-load
nonce** design.

Sandbox vs prod:

| | prod `8ec9te11` | sandbox `hwtsyp5h` |
|---|---|---|
| SDK version | `8.1.3` (570 KB) | `8.2.2` (671 KB) |
| `gab` | false | true |
| `bbc` | 0 | 256 |
| `nr` | false | true |
| extra flags | — | `rsk:16, cte:false, lt/lrs/lvs/lu/lsa` |

`nr` enables the `newRealm` hidden-iframe path (section 5).

---

## 4. SDK shell — what it does

`index.min.js` is a single heavily obfuscated bundle with custom string
tables. Exposing the decoders and substituting 1,161 calls revealed the glue:

```
transports:
  network: POST ./telemetry, Content-Type: application/json
  storage: sessionStorage key "buffer", sessionStorageKey "__oscBuffer"

encoder:
  const Q = new Oc();                 // binary encoder (MessagePack-like)
  let g = await iQ("_AEZNb");         // WASM encrypt export
  return btoa(g(Q.encode(A), B));     // B = per-beacon 8-byte value

envelope: {"beaconID": B, "data": A}
```

Other glue strings:

```
beaconID, transactionID, sessionID, deviceID, version
tid, did, rids
writeDeviceIdToWasmBackends, wasmInit, markWasmInit, wasmInitMs
getIDsGateReleased, retryFirstBeacon, getIDsAfterFirstBeacon
beaconTimingLog, firstBeaconOk, telemetryDCLDelay, telemetryLoadDelay
initialDid, persistedDid, newRealm, realm, iframe,
sandbox: "allow-same-origin allow-scripts"
```

`newRealm` creates a hidden iframe with
`sandbox="allow-same-origin allow-scripts"` and a nested `javascript:` iframe,
then runs callbacks in that fresh realm. It is enabled by `nr` (sandbox on,
prod off). It is the SDK's pristine-realm/anti-prototype-patch mechanism.

The Worker is an OPFS probe:

```js
navigator.storage.getDirectory()
  → createSyncAccessHandle()
  → write/flush timing (<0.1 ms) → opfsIncognitoDetected
```

---

## 5. WASM engine

| | prod `8ec9te11` (v8.1.3) | sandbox `hwtsyp5h` (v8.2.2) |
|---|---|---|
| WASM | 266,886 B | 324,982 B |
| memory | 393,216 B | 3,145,728 B |
| modules | 37 | 43 |
| exports | AssemblyScript runtime + ~obfuscated `_...` | same |
| imports | `_Ze6u`, `_Ra7k`, `_tYQ2lq` | same shape |

AssemblyScript runtime markers: `__new`, `__pin`, `__unpin`, `__collect`,
`__rtti_base`, `__setArgumentsLength`, `memory`.

Readable name-section symbols (both):

```
encryptPayload, gcmEncrypt, gcmDecrypt, chacha20Block, poly1305Mac,
computeHMAC, hashSHA1/256/512, hashMD5, pbkdf2Rounds, deriveKey,
stretchKey, expandKey, generateNonce, lz4Compress/Decompress,
marshalBinary/unmarshalBinary, encodeBase64/decodeBase64, compressBlock
```

No `crypto.subtle`, no `TextEncoder/TextDecoder` calls at runtime.

Sandbox-only modules vs prod: `JSHardwareConcurrency`, `JSVideo`,
`JSBrowserFeaturesV2`, `JSLoadTiming`, `JSRequestSample`, `JSWebLocks`.
Prod is leaner but uses the same crypto path.

---

## 6. Payload schema

Top-level: `transactionID, tabID, sessionID, deviceID, version`.

Sandbox 43 modules:

```
JSTime JSScreen JSKeyboard JSMouse JSTouch JSUserAgent JSFonts JSCanvasHash
JSClipboard JSSDK JSWebGL JSBattery JSAdblockDetector JSConsole JSIncognito
JSBrowserPlugins JSWebRTC JSLocation JSRealm JSUserJourney JSEmoji JSAudio
JSHardwareConcurrency JSSeleniumProperties JSCSSMediaQueries JSPlaywright
JSFontMetrics JSMathFingerprint JSSpeechVoices JSBrowserExtensions
JSBrowserFeatures JSDRM JSWebGPU JSClientRects JSMediaCodecs JSExtendedFonts
JSDeviceIdPersistence JSRuntimeDomain JSVideo JSBrowserFeaturesV2
JSLoadTiming JSRequestSample JSWebLocks
```

Prod omits the last six (`JSHardwareConcurrency`, `JSVideo`,
`JSBrowserFeaturesV2`, `JSLoadTiming`, `JSRequestSample`, `JSWebLocks`).

Notable fields/values observed:

- **UA**: `HeadlessChrome/148`, `Linux x86_64`, `Google Inc.`;
  `webdriver`, `isBrave`, UA-CH brands.
- **Time**: ISO time, `America/Chicago`.
- **Screen**: 1280×720, avail, DPR, outer size, visualViewportScale.
- **Canvas/WebGL**: `dataURLSubstr`, `stringHash`, vendor/renderer,
  extensions, `unmaskedRenderer`/`unmaskedVendor`, `enhancedRenderHash`,
  `shaderPrecisionHash`, all `max*` limits.
- **Audio**: audioContext/oscillator/analyser/destination/audioBuffer hashes,
  codecs (`audio/mpeg,wav,ogg,aac,webm,flac`), sampleRate, fftSize,
  frequency/time data hashes, compressorHash.
- **Fonts**: huge font list + serif/sans/mono/cursor-width/metrics hashes.
- **Behavior**: mouse/keyboard/touch trust + timing, coalesced/future-stamped
  events, moves/distance/direction changes, pointer pressure/tilt/twist,
  gestures, `reasoningDelayMs`.
- **WebRTC**: `publicIP` (`srflx`), candidate type.
- **Bot signals**: `webdriver`, `cdpDetected`, Selenium/Playwright props,
  `opfsIncognitoDetected`, adblock DOM/network probes, console open,
  `JSWebLocks`, hardware concurrency estimation, Math/WASM-vs-JS results.
- **Journey**: pageVisits/focus/visibility, per-page path/title/entry/exit/
  timeSpent/isHistoryChange/referrer/navigationType.
- **Location**: href/string, documentURI/URL/baseURI, performance/navigation/
  entries/anchor URLs.

---

## 7. Crypto: no WebCrypto, and a first-block state leak

The encoder calls a WASM export (`_AEZNb`) over the binary payload. Wrapping
that call captured `(plaintext, keyArg, ciphertext)` triples.

XORing the first 64 bytes of plaintext and ciphertext:

```
plaintext  d9 df ff 98 31 19 e0 00 98 2f 66 4a 53 54 69 6d 65 ...
ciphertext bc a7 8f f9 5f 7d c0 33 aa 02 04 33 27 31 49 06 ...
XOR        "expand 32-byte k" || key || counter || nonce
```

Recovered:

```
key     = 7f0000007f0000007f000000ff000000fe0000007f000000ff000000ff000000
counter = 0
nonce   = 00000000 7f000000 7f000000     (sandbox; prod same shape)
```

`keystream[64:128]` exactly equals `ChaCha20(key, nonce, 0)`. Offsets 128+ do
**not** match counters 0–20,000 — the implementation switches to a
non-standard schedule after the first block. The first block already leaks the
key.

### Prod == sandbox

Using the prod plaintext header from `osc-prod-memory.bin`:

```
prod data[0:16]   bc a7 8f f9 42 7d c0 33 ...
prod header[0:16] d9 df ff 98 2c 19 e0 00 ...
state[0:16]       "expand 32-byte k"
key               7f000000...ff000000     (same as sandbox)
nonce             00000000 7f000000 7f000000
```

All three prod beacons recover the same key. The nonce is low-entropy
(`0x00`/`0x7f`, one word varies). The key is not per-tenant: prod
`8ec9te11` and sandbox `hwtsyp5h` share it. It looks like a fixed/global
test key.

PoC:

```
node bots/oscilar-chacha-poc.mjs \
  --beacon /tmp/opencode/osc/osc-telemetry-0.json \
  --memory /tmp/opencode/osc/osc-prod-memory.bin
```

```
[+] recovered state   expand 32-byte k
[+] key               7f000000...ff000000
[+] counter/nonce     00000000000000007f0000007f000000
[+] CONFIRMED: first keystream block is the raw ChaCha20 state (key leak)
```

Why it matters:

- One captured beacon + the public 64-byte header (fixed per SDK build)
  recovers the key and nonce.
- The key is constant, so the leak is not limited to one session.
- The first-block state leak is not confidentiality against a client-side
  observer; the plaintext is also in exported WASM memory.
- The rest of the stream is custom, so full ciphertext-only decryption needs a
  bit more RE; the key/nonce are already out.

---

## 8. Tamper / MITM: swapping values before encryption

The pre-encryption object (`A`, 48 keys) is exposed at the encoder:

```js
const Q = new Oc();
g(Q.encode(A), B);   // A is the fingerprint object
```

I mutated `A` before `Q.encode(A)` and let the SDK encrypt/ship it:

- `JSScreen`: `1280×720` → `2560×1440` (`width/height/screenWidth/
  screenHeight/avail*`)
- `JSUserAgent`: `HeadlessChrome/148` → Windows Chrome, `platform:
  Linux x86_64 → Win32`, `webdriver: true → false`
- `JSWebRTC.publicIP`: `107.210.133.127` → `203.0.113.7`
- `JSTime.timeString`: → `TAMPERED-TIME`

The captured pre-encryption `a0` contains `TAMPERED-TIME`, `Win32`,
`203.0.113.7`, and the Windows UA. The SDK then encrypted and POSTed 3
beacons (sandbox 200). The modified object is what the server receives.

Limits:

- The server’s verdict is not visible client-side; the ack is only
  `{beaconIDs, d}`.
- Transport still tells the truth: HTTP UA, TLS/JA3/JA4, IP/ASN, and the
  actual WebRTC/network path are unchanged. Payload spoofing is half the job;
  matching the transport is the other half.

---

## 9. Sandbox oracle: what you can and can’t tune

I ran clean, clean again, and tampered in one persistent browser context
against `zqp-sand.oscilar.com/hwtsyp5h`.

| run | telemetry | status | `beaconIDs` | `d` |
|---|---|---|---|---|
| clean1 | 3× | 200 | 5 | `3/acCaiueQRHr8SGE1qA6Eq6` |
| clean2 | 3× | 200 | 5 | `3/acCaiueQRHr8SGE1qA6Eq6` |
| tamper | 3× | 200 | 5 | `3/acCaiueQRHr8SGE1qA6Eq6` |

Conclusions:

- **Not a risk oracle.** Clean and tampered are identical: 200, 5
  `beaconIDs`, same `d`, same storage keys. No client-visible verdict.
- **`d` is a device-identity oracle.** It is stable across clean runs and
  unchanged by the tamper in the same context. The server still sees the same
  device. To mint a new identity, clear `__xr9f__`/IndexedDB or rotate the
  crypto key. Fresh contexts get a different `d` (`mlgCZLZl…` earlier,
  `3/ac…` now), so it is per-context/server-issued.
- **`beaconIDs`/status only confirm ingestion/decryption**, not risk.

To get the real verdict you need a merchant sandbox account/dashboard
(`app.oscilar.com`) or a decision-log API. The public sandbox tenant can test
ingestion, identity persistence, and anti-replay behavior, but not the risk
score.

---

## 10. Does the client catch navigator lies? No.

Four profiles, same sandbox SDK, pre-encryption payload inspected:

| profile | recorded `navigator` values | client flags |
|---|---|---|
| clean | Chromium / `Linux x86_64` / `Google Inc.` / UA-CH Chromium+HeadlessChrome | `webdriver:true`, sel 0, playwright 0, cdp false |
| Safari UA only | Safari UA, **`vendor:"Google Inc."`**, **`platform:"Linux x86_64"`**, UA-CH `platform:"macOS"` with **Chromium/HeadlessChrome brands** | `webdriver:true`, **no complaint** |
| Safari full | Safari UA, `vendor:"Apple Computer, Inc."`, `platform:"MacIntel"`, UA-CH empty, `webdriver:false` | **no complaint** |
| Windows UA only | Windows UA, **`vendor:"Google Inc."`**, **`platform:"Linux x86_64"`**, UA-CH `platform:"Windows"` + Chromium/Headless brands | `webdriver:true`, **no complaint** |

No `lie`/`anomaly`/`mismatch`/`tamper` field exists in the payload. The only
client-side tell is `webdriver:true` (and that is true in the clean Playwright
run too). `JSSeleniumProperties`/`JSPlaywright` are 0 and `cdpDetected` is
false even under Playwright. `JSCanvasHash`/`JSAudio`/`JSFonts` have `error`
fields but no `lied` flags (unlike Signifyd’s `lite.js`).

So the client is a **collector**, not a consistency engine. The server/dashboard
has to notice Safari UA + Chromium UA-CH brands + Linux platform + `sec-ch-ua:
HeadlessChrome`, or compare the payload to TLS/JA3/JA4, HTTP headers, IP/ASN,
and worker signals.

PoC: `node bots/oscilar-lie.mjs`.

---

## 11. Hashes/integrity: 38 fields, but no keyed MAC

The payload contains 38 hash/checksum/signature-like fields:

- **32-bit signal hashes**: `JSCanvasHash.stringHash`,
  `JSFontMetrics.{metrics,serif,sansSerif,monospace,cursorWidths}Hash`,
  `JSMathFingerprint.{math,extMath,wasmMath}Hash`, `JSClientRects.*Hash`,
  `JSMediaCodecs.codecHash`, `JSBrowserFeatures.featureHash`,
  `JSDRM.keySystemConfigHash`, `JSWebGL.{string,enhancedRender,
  shaderPrecision}Hash`, `JSAudio.*Hash`, `JSSpeechVoices.voicesHash`,
  `JSBrowserExtensions.extensionHash`, `JSWebGPU.*Hash`,
  `JSConsole.propsHash`, etc.
- **One cryptographic-looking digest**: `JSBrowserFeaturesV2.digest`
  — 96 hex chars (SHA-384-sized), client-computed.
- **One signature field**: `JSDeviceIdPersistence.signature` — empty in my
  runs.

The WASM has `verifySignature`, `computeHMAC`, `poly1305Mac`,
`checksumCRC32`/`checksumAdler`, and digest primitives, but they are used for
the transport/encryption and server-issued tokens (`tid`/`rids`/`did`/
`beaconID`), not a server-keyed MAC over the fingerprint calculations.

The 32-bit hashes are non-cryptographic signal hashes, computed client-side.
An attacker can update both the value and its hash. The fields I tampered
(`JSScreen`, `JSUserAgent`, `JSWebRTC`, `JSTime`) are not covered by those
hashes at all. If you tamper a hashed module (canvas/fonts/audio/math/WebGL),
a server that recomputes might notice a stale hash — but the client can
recompute it, and there is no secret involved.

**Bottom line:** hashes yes; a tamper-proof check against a controlled client
no. The only real binding is the server-issued `tid`/`rids`/`did` + encryption/
beaconID, and the key for that is client-controlled/leaked.

---

## 12. What this means for the product

- **WASM is obscurity, not a boundary.** The page owns the instance and the
  exported memory; plaintext is readable. `JSON.stringify`/`TextEncoder` traps
  miss it, but memory hooks don’t.
- **The client-side cipher is broken as a confidentiality mechanism.** Fixed
  key, leaked in block 0, shared prod/sandbox, low-entropy nonce.
- **The schema is rich and behavioral.** 43 modules sandbox / 37 prod,
  including strong bot signals (`cdpDetected`, `webdriver`, Selenium/
  Playwright, OPFS incognito, WebLocks, trusted-event timing) and heavy
  rendering/audio/font/math/WebRTC entropy.
- **The realm isolation is real but bypassable with CDP/init-script.** It
  raises cost; it does not change the trust model.
- **The loader/nonce design is the strongest part.** Fresh `tid`/`rids` per
  page load is exactly the sort of server-issued binding that client-side
  crypto lacks.

---

## 13. Interview talking points

1. **Architecture:** dynamic per-tenant loader (fresh `tid`/`rids` per page
   load) + immutable WASM engine + encrypted beacons + localStorage device
   seed. Stronger anti-replay design than a static client key.
2. **Crypto:** custom AssemblyScript crypto (ChaCha20-Poly1305 and AES-GCM,
   HMAC, SHA-1/256/512, MD5, PBKDF2, LZ4) rather than `crypto.subtle`. Ask
   why: WASM constant-time control? bundle size? key hiding? Note the
   trade-off: hand-rolled crypto + readable WASM name section + exported
   memory + first-block state leak.
3. **Data:** 43 modules, heavily behavioral (mouse/keyboard/touch trust and
   timing, user journey, focus/visibility), plus canvas/WebGL/audio/fonts/
   math/WebRTC/UA/screen/CSS media, plus bot signals (`webdriver`,
   `cdpDetected`, Selenium/Playwright, `opfsIncognitoDetected`, adblock,
   console, WebLocks, hardware concurrency).
4. **Binding:** ask whether `transactionID`/`tabID`/`sessionID`/`deviceID` are
   single-use/server-issued, whether the AEAD key is derived from the
   server-issued `tid`/`rids`, and whether the server rejects a replayed
   `beaconID`/`data` from a different origin/IP/UA.
5. **WASM boundary:** plaintext is readable from exported memory. Ask how they
   treat that in the threat model; the answer is usually “WASM is obfuscation,
   not a trust boundary.”
6. **Consistency:** the client does not flag Safari-UA/Linux-platform/
   Chromium-UA-CH contradictions. Where does the server catch that? Which
   headers/TLS/worker signals does it compare?
7. **Integrity:** the payload’s hashes are client-computed signal hashes, not
   MACs. Does the server recompute them? Is there a server-keyed MAC/signature
   over the calculations?
8. **Product:** how `zqp` relates to the Fingerprint partnership — is
   Fingerprint an optional signal provider alongside the in-house 43-module
   SDK, or a fallback?

Questions I’d actually ask in the room:

- “Why is the ChaCha20 key a fixed `0x7f/0xff/0xfe` pattern shared by prod and
  sandbox? Is it a test key that shipped, or is `deriveKey`/`stretchKey`
  supposed to produce a per-tenant key?”
- “Why is the first keystream block the raw state instead of the block
  function output?”
- “Why does the nonce look like `00000000 7f000000 7f000000` rather than a
  CSPRNG value?”
- “Is the AEAD tag (`poly1305Mac`) verified server-side, or is the payload
  just stream-encrypted?”
- “What stops a page-level `WebAssembly.instantiate` hook from reading
  `memory`?”
- “Are `tid`/`rids` single-use and origin/IP/UA-bound?”

---

## 14. Limitations / next steps

- Public assets only; no customer origin was touched. Telemetry was fulfilled
  locally except for a small clean-vs-tampered sandbox differential.
- Not fully reversed: post-block-0 keystream schedule, exact KDF/key schedule,
  `KM`/`pH` JS string tables, WASM disassembly of `encryptPayload`/
  `chacha20Block`.
- The key/nonce could be sandbox/test-specific; the prod tenant I tested
  (`8ec9te11`) shared the key, but do not assume all tenants.
- `data` was not decrypted from ciphertext alone; the plaintext was captured
  at the pre-encryption boundary and from WASM memory.
- To test server-side verdicts/tamper detection, use a merchant sandbox
  account/dashboard (sales-gated) and the decision logs. The public
  `beaconIDs`/`d` ack is not a risk oracle.

---

## 15. Artifact index

| File | Purpose |
|---|---|
| `bots/oscilar-probe.mjs` | Loads the public loader, records network/storage |
| `bots/oscilar-instrument.mjs` | Native API inventory + JSON/TextEncoder/fetch traps |
| `bots/oscilar-wasm.mjs` | Sandbox WASM bytes, memory, worker blobs |
| `bots/oscilar-prod-wasm.mjs` | Same for prod tenant `8ec9te11` |
| `bots/oscilar-strings.mjs` | Exposes + dumps JS string tables |
| `bots/oscilar-wasm-args.mjs` | Wraps the `_AEZNb` encrypt export, captures plaintext/key |
| `bots/oscilar-tamper.mjs` | Pre-encryption payload tamper; `--sniff`, `--tamper`, `--live` |
| `bots/oscilar-oracle.mjs` | Clean vs tampered sandbox differential |
| `bots/oscilar-oracle-persistent.mjs` | Same-context clean/clean/tamper `d` stability test |
| `bots/oscilar-lie.mjs` | Safari/Windows UA lie profiles; payload lie-field check |
| `bots/oscilar-chacha-poc.mjs` | Recovers key/nonce from one beacon |
| `/tmp/opencode/osc/` | WASM, memory dumps, telemetry JSON, string/args dumps |

---

*Prepared for interview preparation and defensive discussion. The sandbox
tenant is Oscilar’s public marketing/demo environment; customer tenants were
not probed or used as an oracle.*
