# Oscilar SDK — crypto deep dive (prod + sandbox)

**Date:** 2026-10-25
**Scope:** public client assets only. Telemetry POSTs were fulfilled locally,
never sent. No customer origin touched.
**Artifacts:** `bots/oscilar-instrument.mjs`, `oscilar-wasm.mjs`,
`oscilar-prod-wasm.mjs`, `oscilar-strings.mjs`, `oscilar-wasm-args.mjs`,
`oscilar-chacha-poc.mjs`; binaries/memory under `/tmp/opencode/osc/`.

## TL;DR

1. **No native WebCrypto.** The SDK uses a 266–325 KB **AssemblyScript/WASM**
   module for collection, marshalling, compression, and encryption. Zero
   `crypto.subtle`, zero `TextEncoder/TextDecoder` calls.
2. The fingerprint payload is **binary (MessagePack-like `Oc` format)**, not
   JSON. `JSON.stringify` only sees the final `{beaconID, data}` envelope.
3. The WASM **exports its memory**, and the plaintext payload is in it. A page
   script can hook `WebAssembly.instantiate` and read the full schema/values.
4. The cipher is a hand-rolled **ChaCha20** variant. The first 64 bytes of the
   keystream are the **raw ChaCha20 initial state**:
   `"expand 32-byte k" || key || counter || nonce`.
   `plaintext[0..64] XOR ciphertext[0..64]` reveals the key and nonce.
5. The key is **identical in prod and sandbox**:
   `7f000000 7f000000 7f000000 ff000000 fe000000 7f000000 ff000000 ff000000`
   (counter 0; nonce `00000000 7f000000 7f000000`, low entropy and mostly
   reused). It looks like a fixed/global test key, not a per-tenant key.
6. The rest of the keystream is not a standard counter schedule: block 0 at
   offset 64 matches `ChaCha20(key, nonce, 0)`, but offsets 128+ do **not**
   match counters 0–20,000. The implementation is custom/buggy beyond the
   first block; the state leak is the critical part.
7. PoC: `node bots/oscilar-chacha-poc.mjs --beacon <telemetry.json> --memory <prod-memory.bin>`
   recovers the key from one beacon using the public 64-byte header.

## 1. JS glue (deobfuscated)

Exposing the SDK's string decoders and substituting 1,161 calls revealed the
transport/glue:

```
transports:
  network: POST ./telemetry, Content-Type: application/json
  storage: sessionStorage key "buffer", sessionStorageKey "__oscBuffer"
encoder:
  const Q = new Oc();                    // binary encoder (MessagePack-like)
  let g = await iQ("_AEZNb");            // WASM encrypt export
  return btoa(g(Q.encode(A), B));        // B = per-beacon 8-byte value
payload: JSON.stringify({ beaconID: B, data: A })
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
`sandbox="allow-same-origin allow-scripts"` and a nested `javascript:`
iframe, then runs callbacks in that fresh realm. It is enabled by `nr`:
sandbox `nr:true`, prod `nr:false`. This is the SDK's pristine-realm/anti-tamper
mechanism (same family as Argus's pristine iframe).

The worker is an OPFS probe:

```js
navigator.storage.getDirectory()
  → createSyncAccessHandle()
  → write/flush timing (<0.1ms) → opfsIncognitoDetected
```

## 2. WASM surface

| | prod `8ec9te11` (v8.1.3) | sandbox `hwtsyp5h` (v8.2.2) |
|---|---|---|
| bundle | 570 KB | 671 KB |
| WASM | 266,886 B | 324,982 B |
| memory | 393,216 B | 3,145,728 B |
| modules | 37 | 43 |
| exports | AssemblyScript runtime + ~obfuscated `_...` | same |
| imports | `_Ze6u`, `_Ra7k`, `_tYQ2lq` | same shape |

Readable name-section symbols (both):

```
encryptPayload, gcmEncrypt, gcmDecrypt, chacha20Block, poly1305Mac,
computeHMAC, hashSHA1/256/512, hashMD5, pbkdf2Rounds, deriveKey,
stretchKey, expandKey, generateNonce, lz4Compress/Decompress,
marshalBinary/unmarshalBinary, encodeBase64/decodeBase64, compressBlock
```

Sandbox-only modules (vs prod): `JSHardwareConcurrency`, `JSVideo`,
`JSBrowserFeaturesV2`, `JSLoadTiming`, `JSRequestSample`, `JSWebLocks`.
Prod is leaner but uses the same crypto path.

## 3. The cipher leak

I wrapped the WASM encrypt export call in the deobfuscated source and captured
three `(plaintext, keyArg, ciphertext)` triples. For capture 0:

```
plaintext[0:64] = d9 df ff 98 31 19 e0 00 98 2f 66 4a 53 54 69 6d 65 ...
ciphertext[0:64] = bc a7 8f f9 5f 7d c0 33 aa 02 04 33 27 31 49 06 ...
XOR              = "expand 32-byte k" || key || counter || nonce
```

Recovered:

```
key     = 7f0000007f0000007f000000ff000000fe0000007f000000ff000000ff000000
counter = 0
nonce   = 00000000 7f000000 7f000000     (sandbox; prod is the same shape)
```

Verification: `keystream[64:128]` equals
`ChaCha20(key, nonce, counter=0)` exactly. Offsets 128+ do **not** match
counters 0..20,000 — the implementation switches to a non-standard schedule
after the first block. But the first block already leaks the key.

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
(`0x00`/`0x7f`, one word varies). The key is not per-tenant: the prod tenant
`8ec9te11` and the sandbox tenant `hwtsyp5h` share it. That strongly suggests a
**fixed/global key** (or a key derived from a global constant), not a
server-issued per-tenant secret.

### Why this matters

- One captured beacon + the public 64-byte header (visible in the SDK/WASM
  memory) recovers the key and nonce. The header is fixed per SDK build and
  ships to every visitor.
- The key is constant, so the leak is not limited to one session.
- The first-block state leak means the cipher is not providing confidentiality
  against a client-side observer (and any passive observer who knows the
  header).
- The rest of the stream is a custom schedule, so full plaintext recovery from
  ciphertext alone needs a bit more RE; but the key/nonce are already out, and
  the plaintext is also in the exported WASM memory.

PoC:

```
node bots/oscilar-chacha-poc.mjs \
  --beacon /tmp/opencode/osc/osc-telemetry-0.json \
  --memory /tmp/opencode/osc/osc-prod-memory.bin
```

Output:

```
[+] recovered state   expand 32-byte k
[+] key               7f0000007f0000007f000000ff000000fe0000007f000000ff000000ff000000
[+] counter/nonce     00000000000000007f0000007f000000
[+] CONFIRMED: first keystream block is the raw ChaCha20 state (key leak)
```

## 4. The plaintext schema

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

Notable fields/values seen in memory:

- UA: `Mozilla/5.0 … HeadlessChrome/148.0.7778.96 …`; platform
  `Linux x86_64`; vendor `Google Inc.`; `webdriver`; `isBrave`; UA-CH brands.
- Time: `2026-10-25T…Z`, `America/Chicago`.
- Screen: 1280×720, avail, DPR, outer size, visualViewportScale.
- Canvas/WebGL: `dataURLSubstr`, stringHash, vendor/renderer, extensions,
  `unmaskedRenderer`/`unmaskedVendor`, `enhancedRenderHash`,
  `shaderPrecisionHash`, all `max*` limits.
- Audio: audioContext/oscillator/analyser/destination/audioBuffer hashes,
  codecs (`audio/mpeg,wav,ogg,aac,webm,flac`), sampleRate, fftSize,
  frequency/time data hashes, compressorHash.
- Fonts: huge font list + serif/sans/mono/cursor-width/metrics hashes.
- Behavior: mouse/keyboard/touch trust + timing, coalesced/future-stamped
  events, moves/distance/direction changes, pointer pressure/tilt/twist,
  gestures, `reasoningDelayMs`.
- WebRTC: `publicIP` (`srflx`), candidate type.
- Bot signals: `webdriver`, `cdpDetected`, Selenium/Playwright props,
  `opfsIncognitoDetected`, adblock DOM/network probes, console open,
  `JSWebLocks`, hardware concurrency estimation, Math/WASM-vs-JS results.
- Journey: pageVisits/focus/visibility, per-page path/title/entry/exit/
  timeSpent/isHistoryChange/referrer/navigationType.
- Location: href/string, documentURI/URL/baseURI, performance/navigation/
  entries/anchor URLs.

## 5. What this means for the product

- **WASM is obscurity, not a boundary.** The page owns the instance and the
  exported memory; the plaintext is readable. `JSON.stringify`/`TextEncoder`
  traps miss it, but memory hooks don't.
- **The client-side cipher is broken as a confidentiality mechanism.** Fixed
  key, leaked in block 0, same across prod/sandbox, low-entropy nonce. The
  server-side `tid`/`rids` binding is the real anti-replay control; the crypto
  is not.
- **The schema is rich and behavioral.** 43 modules in sandbox / 37 in prod,
  including strong bot signals (`cdpDetected`, `webdriver`, Selenium/
  Playwright, OPFS incognito, WebLocks, trusted-event timing) and heavy
  rendering/audio/font/math/WebRTC entropy.
- **The realm isolation is real but bypassable with CDP/init-script**, same
  class as the Argus pristine iframe. It raises cost; it does not change the
  trust model.

## 6. Interview questions this enables

1. Why is the ChaCha20 key a fixed `0x7f/0xff/0xfe` pattern shared by prod and
   sandbox? Is it a test key that shipped, or is `deriveKey`/`stretchKey`
   supposed to produce a per-tenant key?
2. Why is the first keystream block the raw state instead of the block
   function output? (Off-by-one in `encryptPayload`/`chacha20Block`?)
3. Why does the nonce look like `00000000 7f000000 7f000000` rather than a
   CSPRNG value? Is it derived from `tid`/`did`/`rids` or a counter?
4. Is the AEAD tag (`poly1305Mac`) actually verified server-side, or is the
   payload just stream-encrypted?
5. What stops a page-level `WebAssembly.instantiate` hook from reading
   `memory` and extracting the plaintext? Is that considered in the threat
   model?
6. How are `transactionID`/`tabID`/`sessionID`/`deviceID` bound server-side,
   and are `tid`/`rids` single-use and origin/IP/UA-bound?

## 7. Next steps

- Reverse the post-block-0 keystream schedule (custom ChaCha variant) and
  decrypt `data` end-to-end from ciphertext alone.
- Expose `KM`/`pH` decoders (the remaining JS string tables) and finish the
  JS deobfuscation.
- Statically disassemble `encryptPayload`/`chacha20Block` in the WASM
  (wabt/wasm-tools) to confirm the off-by-one and key schedule.
- Test whether the same fixed key is used by other public tenants (only
  public assets; no customer probing).
