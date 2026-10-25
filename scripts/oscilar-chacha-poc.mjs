#!/usr/bin/env node
/**
 * oscilar-chacha-poc.mjs — recover Oscilar's ChaCha20 key/nonce from one
 * captured beacon, using the public SDK's fixed plaintext header.
 *
 * Why it works: the first 64 bytes of the keystream are the raw ChaCha20
 * initial state (constant || key || counter || nonce), not the block
 * function output. So:
 *
 *     data[0..64] XOR known_header[0..64]  ==  "expand 32-byte k" || key || ctr || nonce
 *
 * The header is public: it is the first 64 bytes of the binary payload
 * built by the SDK (visible in WASM memory / the `a0` capture). The key is
 * identical across the prod tenant and the sandbox tenant in testing.
 *
 * Usage:
 *   node bots/oscilar-chacha-poc.mjs \
 *     --beacon /tmp/opencode/osc/osc-telemetry-0.json \
 *     --memory /tmp/opencode/osc/osc-prod-memory.bin
 *
 *   # or supply the known 64-byte plaintext header directly (base64/hex):
 *   node bots/oscilar-chacha-poc.mjs --beacon ... --header-hex d9dfff98...
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const get = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };

const beaconPath = get('beacon', '/tmp/opencode/osc/osc-telemetry-0.json');
const memoryPath = get('memory', '/tmp/opencode/osc/osc-prod-memory.bin');
const headerHex = get('header-hex', null);

const beacon = JSON.parse(readFileSync(beaconPath, 'utf8'));
const data = Buffer.from(beacon.data, 'base64');

let header;
if (headerHex) {
  header = Buffer.from(headerHex, 'hex');
} else {
  // Find the SDK's serialized-payload magic in the WASM memory dump.
  const mem = readFileSync(memoryPath);
  const magic = Buffer.from([0xd9, 0xdf, 0xff]);
  const at = mem.indexOf(magic);
  if (at < 0) throw new Error('payload magic d9dfff not found in ' + memoryPath);
  header = mem.subarray(at, at + 64);
  console.log(`[+] plaintext header @ ${memoryPath} + 0x${at.toString(16)}`);
}

const state = Buffer.alloc(64);
for (let i = 0; i < 64; i++) state[i] = data[i] ^ header[i];

console.log('[+] data[0..16]      ', data.subarray(0, 16).toString('hex'));
console.log('[+] header[0..16]    ', header.subarray(0, 16).toString('hex'));
console.log('[+] recovered state  ', state.subarray(0, 16).toString());
console.log('[+] key              ', state.subarray(16, 48).toString('hex'));
console.log('[+] counter/nonce    ', state.subarray(48, 64).toString('hex'));

const ok = state.subarray(0, 16).equals(Buffer.from('expand 32-byte k'));
console.log(ok
  ? '[+] CONFIRMED: first keystream block is the raw ChaCha20 state (key leak)'
  : '[!] constant mismatch — header is for a different SDK/build');

if (ok) {
  console.log('[+] one beacon is enough to recover the key; the key is reusable across beacons.');
}
