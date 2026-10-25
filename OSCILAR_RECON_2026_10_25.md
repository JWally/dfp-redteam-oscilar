# Oscilar — public client-side recon (interview prep)

**Date:** 2026-10-25
**Scope:** public web assets only (homepage, public loader/SDK, response headers,
public URL-scan indexes). No customer probing, no auth bypass, no exploitation.

## 1. Where it lives

| Host | What it is | Hosting |
|---|---|---|
| `oscilar.com` / `www.oscilar.com` | Marketing site (1.9 MB Framer page) | Cloudflare + Framer |
| `app.oscilar.com` | Product dashboard (React SPA, `/assets/index-*.js`) | Vercel |
| `docs.oscilar.com` | Docs (ReadMe, password-gated) | Cloudflare |
| `zqp.oscilar.com/<tenant>/loader.js` | **Production** client device-intel SDK loader | Cloudflare → AWS API Gateway (Fastify/Lambda) |
| `zqp-sand.oscilar.com/<tenant>/loader.js` | **Sandbox** loader (marketing site uses tenant `hwtsyp5h`) | same |

The loader path is per-tenant: `/<tenant>/loader.js`, `/<tenant>/index.min.js`,
`/<tenant>/telemetry`, `/<tenant>/error`.

Public examples of real deployments (from URL-scan indexes, not scanned by me):

- `app.topperpay.com` → `zqp.oscilar.com/8ec9te11/loader.js`
- `ezmanagementllc.managebuilding.com` → `zqp.oscilar.com`
- `natural.com` → `zqp.oscilar.com`
- `url6422.livelyme.com` → `zqp.oscilar.com`

So the model is: merchant page includes a per-tenant `<script src="https://zqp.oscilar.com/<tenant>/loader.js">`.
The marketing site dogfoods the sandbox tenant.

## 2. The loader (2.5 KB)

Marketing site:

```html
<script async src="https://zqp-sand.oscilar.com/hwtsyp5h/loader.js"></script>
```

It is a two-stage bootstrap, not the SDK:

1. Creates a script tag for `<tenant>/index.min.js?bid=…&c=…&k=…`.
2. Removes itself (`parentElement.removeChild`) and removes the injected SDK
   tag on load.
3. On script error, fires an image beacon to `<tenant>/error`.
4. Uses two custom events (names rotate per build) to hand a config object to
   the SDK. Example prod config:

```js
{
  c:"8ec9te11",                       // tenant
  oe:null,
  tid:"E2BfLQkJ…",                    // per-request transaction token
  rids:[ "...", "...", "...", "...", "..." ], // 5 per-request request IDs
  tel:[2143289343, 1060841599],       // bitmask/flags
  net:"./telemetry",                  // beacon path
  did:"hh0eMecIVd4…",                 // device seed/ID (stable)
  v:"8.1.3",                          // SDK version
  nr:false, dcld:4000, ld:10000, bl:false,
  gab:false, bbc:0, ggt:5000
}
```

Key observation: **the loader is dynamic** (`cache-control: no-cache, no-store,
must-revalidate`). Fetching it three times gave three different `tid`s, three
different `rids` sets, and a different `c` config hash, while `bid`/`did`/`v`
stayed constant. That is a **server-issued per-page-load nonce** design, not a
static file.

Sandbox vs prod differences:

| | prod `8ec9te11` | sandbox `hwtsyp5h` |
|---|---|---|
| SDK version | `8.1.3` (570 KB) | `8.2.2` (671 KB) |
| `gab` | false | true |
| `bbc` | 0 | 256 |
| `nr` | false | true |
| extra flags | — | `rsk:16, cte:false, lt/lrs/lvs/lu/lsa` |

So the sandbox build enables extra telemetry/feature paths.

## 3. The SDK (`index.min.js`, 570–671 KB)

Served with `cache-control: public, max-age=31536000` (immutable) and
`access-control-allow-origin: *`. One file, heavily obfuscated:

- custom base64 + hash string decoder (`_ojs`, `bc`, `qc`, big encoded string arrays)
- `_oSC` global, `Tt` app class
- build UUID comment at the top (`/* bb3672ed-… */`)
- `WebAssembly` referenced 3× and `Worker` 2× in the bundle
- no readable endpoint strings (assembled at runtime)

Observed behaviour on a local secure-context page (real Chrome, loader loaded):

```
GET  /8ec9te11/loader.js
GET  /8ec9te11/index.min.js?bid=O3UyY5qwEqmPD4j_GXsH1Q&c=…&k=_SZXIyvH
POST /8ec9te11/telemetry   {"beaconID":"d3vW1xel…","data":"vKeP+UJ9…"}
POST /8ec9te11/telemetry   {"beaconID":"d3vW1xel…","data":"vKeP+UJ9…"}
POST /8ec9te11/telemetry   {"beaconID":"d3vW1xel…","data":"vKeP+UJ9…"}
200  {"beaconIDs":["d3vW1xel…","d3vW1xel…","d3vW1xel…"]}
```

- `beaconID` has a stable 64-char prefix and a per-beacon 24-char suffix — looks
  like an encrypted device/session identifier with a per-beacon nonce/tag.
- `data` is a long opaque blob (encrypted compressed fingerprint).
- The server replies with the accepted `beaconIDs`.
- The telemetry CORS preflight is `ACAO: *`, `allow-headers: *`, `GET,POST`.

Client state after a run:

```
localStorage.__oscf__   = base64({ "8ec9te11": { t:<ts>, s:"<tid>", d:"<did>" } })
localStorage.__xr9f__   = "<did>"           (same value as loader did)
sessionStorage.__oscTID = "<tid>"           (same value as loader tid)
sessionStorage.buffer   = "<encrypted beacon buffer>"
document.cookie         = ""                (no cookies in this run)
```

So: device ID/seed persisted in `localStorage`, transaction token + telemetry
buffer in `sessionStorage`, no cookies. The `did` is stable across loader
fetches; the `tid`/`rids` rotate per fetch.

`window._oSC` is removed/undefined after init — the SDK cleans up its globals.

## 4. What the architecture implies

- **Server-issued binding.** The loader fetch is server-side observable (IP,
  headers, Referer) and returns fresh `tid`/`rids`. The SDK then submits
  encrypted beacons referencing those tokens. That is a much stronger
  anti-replay/anti-forgery design than a static client key: the server can
  reject beacons whose `tid`/`rids` were not issued to that browser fetch, or
  whose origin/IP/UA don't match the loader fetch.
- **Static engine, dynamic config.** `index.min.js` is cacheable for a year;
  the per-request decisions live in the loader. Updating a tenant's config
  doesn't require a new SDK build.
- **Obfuscation as friction, not proof.** The SDK is a single obfuscated bundle
  with a custom string decoder. Same ceiling as any client-side detector: the
  page owns the realm. Rotating `tid`/`rids` raises the cost of replay/forgery;
  it does not make the client trustworthy.
- **WASM/Worker present.** The bundle references both. Likely used for
  fingerprinting/anti-tamper or crypto. The dashboard CSP explicitly allows
  `'wasm-unsafe-eval'`, which is consistent with a WASM-using client stack.
- **Hosting.** `zqp` is Cloudflare in front of AWS API Gateway + Lambda
  (Fastify: root 404 is `{"message":"Route GET:/ not found"}`). `loader.js` is
  dynamic; `index.min.js` is an immutable static object; `telemetry` is the
  ingestion route.

## 5. Dashboard / company stack (from headers + assets)

`app.oscilar.com` is Vercel with a real CSP:

```
default-src 'self' vercel.live *.sentry-cdn.com;
script-src 'self' 'wasm-unsafe-eval' 'sha256-…' 'nonce-osc-…' …;
frame-ancestors 'none'; object-src 'none'; worker-src 'self' blob:;
connect-src 'self' *.oscilar.com … api.workos.com … api.statsig.com …;
```

Third parties visible: WorkOS (auth), Statsig (flags/experiments),
LaunchDarkly, Hotjar, Sentry, Orb (billing), Box, Appcues, Google Maps,
Localize, Cloudinary. Good hygiene on the dashboard: nonce-based scripts,
`frame-ancestors 'none'`, `object-src 'none'`.

Marketing site is Framer and does **not** carry that CSP; it loads the
sandbox tenant. `docs.oscilar.com` is ReadMe and password-gated.

## 6. Comparison to the OICU/Argus lite.js we just broke

| | Oscilar `zqp` | OICU/Argus `lite.js` |
|---|---|---|
| Loader | dynamic per-request config (`tid`/`rids`/`c` rotate) | `script-tag.js` static, `data-posturl`/`data-oak-host` |
| Server nonce | yes (`tid` + 5 `rids` issued on loader fetch) | no; static `SERVER_PUBLIC_KEY` |
| Telemetry | encrypted `beaconID` + `data`, server ack | AES-GCM ciphertext + client ECDSA signature |
| Integrity binding | server-issued tokens (likely checked server-side) | signature over ciphertext, client-owned key |
| Identity | `did` persisted in localStorage, fuzzy/device signals | `browserFingerPrint` client-asserted, server trusts it |
| Dev plaintext | none observed | `/v1/tracker` plaintext copy in `dev-jw` |
| Obfuscation | custom decoder, WASM/Worker refs | obfuscated script-tag + 200 KB lite bundle |

This is the interesting interview contrast: Oscilar's loader/telemetry design
has the **server-issued nonce** property that the OICU/Argus proxy build lacks.
Whether they actually enforce it server-side is the question to ask.

## 7. Questions worth asking in the interview

1. The loader returns fresh `tid`/`rids` per fetch. Are those single-use, and
   is the telemetry rejected if the `tid` doesn't match the loader fetch
   (origin/IP/UA/time window)?
2. Is `did` a per-tenant seed or a per-device ID? What happens when
   localStorage is cleared/copied between browsers?
3. How do you bind the encrypted `beaconID`/`data` to the server-issued config?
   Is there a server-side MAC/HMAC, or only encryption?
4. How do you treat client-reported signals (`webdriver`, `lieCount`,
   `privateBrowsing`) vs server-derived ones (TLS/JA3, H2, IP/ASN, timing)?
5. What does the WASM module do, and why WASM rather than `crypto.subtle`?
   How do you protect the WASM boundary/memory from a controlled client?
6. How does the zqp device-intel product relate to the Fingerprint
   partnership — is Fingerprint a signal provider, or is zqp the in-house
   replacement?
7. What's the failure mode if the loader is blocked (adblock/CSP/Tor)? Does the
   decision fail open or closed?

## 8. Artifacts

- `bots/oscilar-probe.mjs` — loads the public loader on a local page, captures
  requests/responses/storage. Non-destructive.
- `bots/results/oscilar-probe-1792933164496.json` — captured run.
- `/tmp/opencode/osc-*.js` — downloaded loader/SDK bundles (prod + sandbox).

Not done: full deobfuscation of `index.min.js`, decrypting `beaconID`/`data`,
or touching any customer origin. Those are the next steps if useful.
