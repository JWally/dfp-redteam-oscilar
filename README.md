# Oscilar (zqp) device fingerprinting — client-side drill-down

Authorized red-team on the **user's own stack** (`ms-argus-*` repos). Public
SDK bundle + sandbox only; telemetry POSTs to Oscilar were fulfilled locally
(plus a small clean-vs-tamper sandbox differential). **No prod traffic touched.**

## What we recovered

- **Deployment map:** production (`zqp`) and sandbox (`zqp-sand`) tenants, with
  per-tenant request paths (`8ec9te11` / `hwtsyp5h`).
- **Dynamic loader:** `tid`/`rids` rotate per fetch.
- **Payload schema:** 43 `JS*` modules in the 325KB AssemblyScript WASM.
- **ChaCha20 crypto:** the first 64 bytes of keystream equal the raw state
  (`expand 32-byte k` ‖ key ‖ counter ‖ nonce). PoC `oscilar-chacha-poc.mjs`.
- **Shared key:** `7f000000…` is used by **both prod and sandbox** bundles.
- **Sandbox oracle:** the response `d` is a device-identity signal, not a risk
  verdict — clean and tampered runs both returned 200 / 5 beaconIDs / same `d`.

## Scripts (`scripts/`)
- `oscilar-probe.mjs` — load + call the SDK against local endpoints
- `oscilar-wasm.mjs` / `oscilar-prod-wasm.mjs` / `oscilar-wasm-args.mjs` — WASM
  fetch, arg capture, tenant paths
- `oscilar-instrument.mjs` — in-flight bundle string-decoder patching
- `oscilar-chacha-poc.mjs` — first-block keystream == raw ChaCha20 state
- `oscilar-lie.mjs` / `oscilar-oracle.mjs` / `oscilar-oracle-persistent.mjs` —
  lie-detector + sandbox oracle differentials
- `oscilar-tamper.mjs` — client payload tamper against sandbox
- `oscilar-strings.mjs` — decoded string/segment extraction

## Reports
- `OSCILAR_WRITEUP_2026_10_25.md` — consolidated findings + interview questions
- `OSCILAR_RECON_2026_10_25.md` — deployment + loader + payload recon
- `OSCILAR_DEEP_2026_10_25.md` — deep dive (WASM, schema, key)
- `OSCILAR_CRYPTO_DEEP_2026_10_25.md` — ChaCha20 analysis + key extraction

## Honest boundary
The recovered key is the public bundle's shared key, and `d` is an identity
signal — this shows the client crypto is readable/replayable, **not** that a
fraud verdict can be forged. Durable defense is server-side binding
(server-issued state, TLS/network consistency).

Requires `node` + `playwright` (+ chromium) and `pycryptodome`/`Crypto` for the
ChaCha PoC.
