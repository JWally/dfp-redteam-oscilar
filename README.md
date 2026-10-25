# Oscilar (zqp) Device-Intelligence SDK — Client-Side Red Team

**Executive write-up · 2026-10-25 · authorized, own-stack only · no customer /
prod traffic touched**

> **One line:** Oscilar's client SDK ships a very broad device fingerprint
> encrypted with a **hand-rolled ChaCha20** whose key is **recoverable from a
> single beacon** (the first 64 keystream bytes are the raw state) and is
> **shared across prod and sandbox**. The plaintext payload is fully readable
> in WASM memory before encryption, there is **no client-side lie/anomaly
> detection**, and a clean-vs-tampered sandbox differential returned the same
> device id — the real verdict logic lives server-side.

---

## What we accomplished

1. **Mapped the deployment.** Two-stage per-tenant loader (`zqp.oscilar.com`
   prod / `zqp-sand.oscilar.com` sandbox) with dynamic, server-issued
   `tid`/`rids` per page load; tenant paths `8ec9te11` (prod) and `hwtsyp5h`
   (sandbox).
2. **Read the plaintext payload.** The 266–325 KB AssemblyScript/WASM engine
   **exports its memory**, and the SDK builds the full fingerprint as a plain
   object `A` before encrypting it. Hooking the encrypt boundary yields the
   readable payload — **43–48 modules**: `JSTime`, `JSScreen`, `JSUserAgent`,
   `JSFonts`, `JSCanvasHash`, `JSEmoji`, `JSMathFingerprint`, `JSWebGL`,
   `JSBattery`, `JSIncognito`, `JSPlaywright`, `JSSeleniumProperties`,
   `JSLoadTiming`, `JSWebRTC`, `JSDeviceIdPersistence`, … (see the visual
   demo / `oscilar-visual.mjs`).
3. **Recovered the crypto key from one beacon.** The cipher is hand-rolled
   ChaCha20; the first 64 bytes of keystream are the **raw initial state**
   (`"expand 32-byte k" ‖ key ‖ counter ‖ nonce`). XOR the first 64 bytes of a
   captured ciphertext with the (public, in-memory) plaintext header → key.
   ```
   KEY = 7f000000 7f000000 7f000000 ff000000 fe000000 7f000000 ff000000 ff000000
   ```
   **Identical in the prod and sandbox tenants** — looks like a fixed/global
   (test) key. Nonce is low-entropy.
4. **Proved the payload is spoofable with no client-side tell.** No lie/anomaly
   flag is emitted for obvious contradictions (Safari UA on Linux, etc.), and a
   clean-vs-tampered differential against the sandbox (screen 2560×1440,
   UA→Win32 Chrome, `webdriver→false`) returned **200 / 5 beaconIDs / the same
   `d`** — `d` is a device-identity signal, **not a risk verdict**.

## How we did it (methodology)

- **Runtime instrumentation (Playwright):** hooked `fetch`/`XHR`/`sendBeacon`,
  `WebAssembly.instantiate`, `SubtleCrypto`, `JSON`, `btoa/atob`, canvas/WebGL,
  workers, storage, events — capturing the SDK's full native surface.
- **In-flight bundle patching:** at the encrypt call site
  (`Q["encode"](A)` → `g(bytes, key)`), injected a read-only capture of the SDK's
  own payload object `A` (JSON), the encoded bytes, and the ciphertext.
- **WASM memory dumps:** located the serialized payload (magic `d9dfff`,
  msgpackr packed-structures) and used the plaintext header for the key
  recovery (`oscilar-chacha-poc.mjs`).
- **Differential (clean vs tamper):** mutated `A.JSScreen`/`A.JSUserAgent`/
  `A.JSTime` client-side, shipped both, compared sandbox responses
  (`oscilar-oracle.mjs`, `oscilar-tamper.mjs`).

## What it proves

- The client SDK gives a determined actor **everything needed to read and
  rewrite its own telemetry**: plaintext readable in WASM memory, a recoverable
  (and shared) key, and no client-side lie detection.
- **One beacon = one key recovery**, and the key is reusable across beacons and
  shared between prod and sandbox — so cross-session/tenant traffic can be
  decrypted with the recovered key.
- The server-issued per-page `tid`/`rids` is a genuinely good **anti-replay /
  binding** design — but it does not stop a client that simply lies about `A`.

## How this could be (ab)used

Defensive framing:

1. **Fingerprint rewriting** — forge screen/UA/webdriver/font/canvas hashes so
   the device reputation no longer matches.
2. **Device-identity minting** — forge `deviceID`/session to fragment
   device-history correlation (the sandbox `d` stayed identical only because we
   didn't touch it — an attacker would).
3. **Telemetry decryption** — with the recovered shared key, decrypt captured
   beacons (prod or sandbox) to build a ground-truth model of what signals map
   to what verdicts.
4. **Lie amplification** — because there's no client-side consistency engine,
   ship self-contradictory signals (Safari UA + Linux platform) without a flag,
   polluting the server's learning signal.

### The durable boundary

- **Server-side is where the real logic lives** — verdict/mismatch checks,
  device-history correlation, velocity, and TLS/JA3/IP/header consistency
  against the claimed payload.
- Bind each beacon to **server-issued state** (`tid`/`rids` — already present,
  good), and **never trust the client's `A`** as ground truth.
- A shared, fixed key is a real weakness; per-session server-negotiated keys
  would raise the cost.

## Honesty / scope notes

- Authorized, own-stack only. Telemetry to Oscilar was **fulfilled locally**
  except the small clean-vs-tamper sandbox differential; no customer/prod
  traffic touched.
- The recovered key is the **public bundle's key** — it's real, but it's the
  vendor's shipped key, not a compromise of a server. We did **not** obtain or
  forge a risk verdict; `d` is a device identity signal.
- `docs.oscilar.com` is password-protected and there's no self-service signup —
  this was all from the public SDK + public URL-scan indexes.

## See it live — screenshot of the full payload

![Oscilar — readable pre-encryption payload + ChaCha20 key + tamper diff (full page)](screenshots/oscillar-full-payload.png)

*Full-page capture of `scripts/oscilar-visual.mjs` (visible-browser demo): the complete readable payload (48 modules, every field and list item) captured pre-encryption from the SDK's own object, with the ChaCha20 key panel, client-side tamper diff, and sandbox-oracle section below. Full page is ~23,000px tall (includes the 419-item font list).*

## What each module means

| Module | Collects |
|---|---|
| **Envelope** | |
| `transactionID` / `tabID` / `sessionID` / `deviceID` / `version` | Per-session IDs + SDK version (`8.2.2`) |
| **Identity & time** | |
| `JSTime` | timezone (offset+string), `ts`, `timeString`, `computedTime`, `timeOnPage`, `timeSincePageLoad`, `timeOrigin` |
| `JSLocation` | href/string, documentURI/URL/baseURI, performance/navigation/entries/anchor URLs |
| `JSUserJourney` | pageVisits / focusEvents / visibilityStates with per-page path, title, entry/exit, timeSpent |
| `JSRealm`, `JSRuntimeDomain` | realm detection; devtools preview-getter + `debuggerActive` (debugger attach probe) |
| **Device surface** | |
| `JSScreen` | width/height, screen/avail, colorDepth, DPR, outerWidth/Height, `visualViewportScale`, isExtended |
| `JSUserAgent` | full UA + `app*`/`platform`/`vendor` flags + `uaData` (brands, platform, bitness, wow64, fullVersionList) + `webdriver` ⚠️ + `isBrave` |
| `JSFonts` / `JSExtendedFonts` | 419 + 111 font-availability checks |
| `JSFontMetrics` | serif/sans/mono/cursor-width metrics hashes |
| `JSCanvasHash` | canvas `stringHash` + `dataURLSubstr` |
| `JSWebGL` | vendor/renderer, extensions, all `max*` limits, `unmaskedRenderer/Vendor`, `enhancedRenderHash`, `shaderPrecisionHash` |
| `JSWebGPU` | adapter info (headless: `error=no_adapter`) |
| `JSAudio` | AudioContext/oscillator/analyser/buffer hashes + supported codecs |
| `JSEmoji` | 15 emoji-rendering hashes (OS icon-set fingerprint: melting face, fox, family, flags…) |
| `JSMathFingerprint` | math hash + 12/28 result strings + nanBehavior + **wasm-vs-JS** engine check |
| `JSClientRects` | rect/text/emoji/svg/multi-line hashes |
| `JSMediaCodecs` | video/audio codec support hashes |
| `JSDRM` | Widevine/clearkey support, robustness, hardware-secure flag |
| `JSBrowserPlugins` | plugins count + names + mimeTypes |
| `JSBattery` | charging state, level |
| **Behavioral** | |
| `JSKeyboard` / `JSMouse` / `JSTouch` | event streams: trust, timing, coalesced/future-stamped events, moves/distance/direction, pointer pressure/tilt/twist |
| `JSClipboard` | clipboard-event logs |
| `JSHardwareConcurrency` | worker-timing CPU-core estimation |
| **Bot / tamper detection** | |
| `JSPlaywright` / `JSSeleniumProperties` | playwright / selenium global+document property probes ⚠️ |
| `JSIncognito` | serviceWorker, webkitTemporaryStorage, indexedDB, **opfs incognito detection** |
| `JSConsole` | devtools console open/props hash/`cdpDetected` |
| `JSAdblockDetector` | ad-block DOM blockers + network-blocked URL probes |
| `JSBrowserExtensions` | extension detection: global vars, DOM artifacts, CSS injections, overlay flags |
| `JSWebLocks` | Web Locks API probe (automation correlation) |
| `JSWebRTC` | **`publicIP`** + candidateType (`srflx`) via STUN |
| **Environment / misc** | |
| `JSCSSMediaQueries` | prefers-* / color-gamut / pointer / hover / contrast |
| `JSSpeechVoices` | speech-synthesis voice count + hashes |
| `JSBrowserFeatures` / `JSBrowserFeaturesV2` | feature presence lists + digest (`esv/k/r/total/digest` — SHA-384-ish) |
| `JSRequestSample` / `JSLoadTiming` | resource/navigation API samples; full SDK load-timing waterfall (`beaconStatus: 200`) |
| `JSDeviceIdPersistence` | localStorage/indexedDB/cache/opfs/webSQL persistence signature + `signature`/`firstSeen` |
| `JSVideo` | autoplay policy, decode results, `rvfc` support |
| `JSSDK` | `cUserID` / `cSessionID` |

⚠️ = bot/automation tells (`webdriver`, Playwright/Selenium probes, debugger attach, CDP detection) — exactly what a client-side actor can rewrite before encryption, since there is no client-side lie/anomaly flag.

## Repo layout & quick run

```
OSCILAR_WRITEUP_2026_10_25.md     consolidated writeup + interview framing
OSCILAR_RECON/ DEEP/ CRYPTO_DEEP_2026_10_25.md   deeper passes
assets/osc-index-wrapped.js       instrumented public SDK bundle (capture hooks)
scripts/oscilar-visual.mjs        HEADED demo: readable payload + ChaCha key + tamper
scripts/oscilar-chacha-poc.mjs    offline key recovery from a captured beacon
scripts/oscilar-oracle.mjs        clean vs tampered sandbox differential
scripts/oscilar-*.mjs             probe / instrument / wasm / strings / lie / tamper
```

```bash
npm install                        # playwright + msgpackr
node scripts/oscilar-visual.mjs    # visible-browser demo (close window to exit)
node scripts/oscilar-chacha-poc.mjs --beacon /tmp/opencode/osc/osc-telemetry-0.json \
     --memory /tmp/opencode/osc/osc-prod-memory.bin
```
