// CIP-30 signData verification (COSE_Sign1 over Ed25519).
//
// Lace/Eternl/etc. return from `walletApi.signData(addressHex, payloadHex)`:
//   { signature: <COSE_Sign1 CBOR hex>, key: <COSE_Key CBOR hex> }
//
// We verify:
//   1. Ed25519 signature valid over the COSE Sig_structure
//   2. public key (from COSE_Key) hashes (blake2b-224) to the expected VKH
//   3. payload inside COSE_Sign1 matches the challenge we issued
//
// No external COSE library — hand-rolled minimal CBOR decoder/encoder.

import * as ed from "@noble/ed25519";
import { blake2b } from "@noble/hashes/blake2b";

// ── Minimal CBOR decoder ─────────────────────────────────────────────────────

type CborValue =
  | number
  | bigint
  | Uint8Array
  | string
  | CborValue[]
  | Map<CborValue, CborValue>
  | null;

function decodeCbor(bytes: Uint8Array): { value: CborValue; next: number } {
  return decodeAt(bytes, 0);
}

function decodeAt(b: Uint8Array, o: number): { value: CborValue; next: number } {
  const ib = b[o];
  const mt = ib >> 5;
  const ai = ib & 0x1f;
  let hLen = 1;
  let n = 0n;
  if (ai < 24) n = BigInt(ai);
  else if (ai === 24) { hLen = 2; n = BigInt(b[o + 1]); }
  else if (ai === 25) { hLen = 3; n = BigInt((b[o + 1] << 8) | b[o + 2]); }
  else if (ai === 26) {
    hLen = 5;
    n = BigInt(b[o + 1]) << 24n | BigInt(b[o + 2]) << 16n |
        BigInt(b[o + 3]) << 8n | BigInt(b[o + 4]);
  } else if (ai === 27) {
    hLen = 9;
    n = 0n;
    for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(b[o + 1 + i]);
  } else throw new Error("unsupported CBOR ai: " + ai);

  const num = Number(n);
  let p = o + hLen;
  switch (mt) {
    case 0: return { value: n <= 9007199254740991n ? num : n, next: p };
    case 1: {
      const v = -1n - n;
      return { value: v >= -9007199254740991n ? Number(v) : v, next: p };
    }
    case 2: return { value: b.slice(p, p + num), next: p + num };
    case 3: {
      const txt = new TextDecoder().decode(b.slice(p, p + num));
      return { value: txt, next: p + num };
    }
    case 4: {
      const arr: CborValue[] = [];
      for (let i = 0; i < num; i++) {
        const r = decodeAt(b, p);
        arr.push(r.value);
        p = r.next;
      }
      return { value: arr, next: p };
    }
    case 5: {
      const map = new Map<CborValue, CborValue>();
      for (let i = 0; i < num; i++) {
        const k = decodeAt(b, p); p = k.next;
        const v = decodeAt(b, p); p = v.next;
        map.set(k.value, v.value);
      }
      return { value: map, next: p };
    }
    case 6: return decodeAt(b, p); // tag — skip
    case 7: {
      if (ai === 22) return { value: null, next: p };
      return { value: null, next: p };
    }
    default: throw new Error("unhandled mt " + mt);
  }
}

// ── Minimal CBOR encoder (just what we need for Sig_structure) ───────────────

function cborHeader(mt: number, n: number): Uint8Array {
  if (n < 24) return new Uint8Array([(mt << 5) | n]);
  if (n < 0x100) return new Uint8Array([(mt << 5) | 24, n]);
  if (n < 0x10000) return new Uint8Array([(mt << 5) | 25, (n >> 8) & 0xff, n & 0xff]);
  return new Uint8Array([
    (mt << 5) | 26,
    (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff,
  ]);
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const a of arrs) { out.set(a, p); p += a.length; }
  return out;
}

function encBytes(b: Uint8Array): Uint8Array {
  return concat(cborHeader(2, b.length), b);
}
function encText(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  return concat(cborHeader(3, bytes.length), bytes);
}
function encArray(...items: Uint8Array[]): Uint8Array {
  return concat(cborHeader(4, items.length), ...items);
}

// ── Verifier ─────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Verify that `signatureHex` (COSE_Sign1) + `keyHex` (COSE_Key) prove
 * the holder of wallet key-hash `expectedVkh` signed exactly `expectedPayload`.
 * Throws on any failure.
 */
export async function verifyCip30Signature(
  signatureHex: string,
  keyHex: string,
  expectedPayload: string,
  expectedVkh: string,
): Promise<void> {
  // ── 1. Parse COSE_Sign1 = [protected, unprotected, payload, signature]
  const sign1 = decodeCbor(hexToBytes(signatureHex)).value;
  if (!Array.isArray(sign1) || sign1.length !== 4) {
    throw new Error("COSE_Sign1 malformed");
  }
  const protectedBstr = sign1[0] as Uint8Array;  // bstr of serialized map
  const payload = sign1[2] as Uint8Array;
  const signature = sign1[3] as Uint8Array;
  if (!(protectedBstr instanceof Uint8Array) ||
      !(payload instanceof Uint8Array) ||
      !(signature instanceof Uint8Array)) {
    throw new Error("COSE_Sign1 field types wrong");
  }

  // ── 2. Payload must match what we asked the wallet to sign
  const payloadText = new TextDecoder().decode(payload);
  if (payloadText !== expectedPayload) {
    throw new Error(
      `Signed payload mismatch. expected="${expectedPayload}" got="${payloadText}"`,
    );
  }

  // ── 3. Parse COSE_Key, extract Ed25519 public key bytes
  //    COSE_Key = map { 1: kty, 3: alg, -1: crv, -2: x (pubkey), ... }
  const coseKey = decodeCbor(hexToBytes(keyHex)).value;
  if (!(coseKey instanceof Map)) throw new Error("COSE_Key not a map");
  const pubKey = coseKey.get(-2);
  if (!(pubKey instanceof Uint8Array) || pubKey.length !== 32) {
    throw new Error("COSE_Key missing Ed25519 public key");
  }

  // ── 4. Pub key must hash (blake2b-224) to the expected VKH
  const vkh = bytesToHex(blake2b(pubKey, { dkLen: 28 }));
  if (vkh !== expectedVkh.toLowerCase()) {
    throw new Error(
      `Wrong signer. expected VKH ${expectedVkh} got ${vkh}`,
    );
  }

  // ── 5. Rebuild COSE Sig_structure and verify Ed25519 signature
  //    Sig_structure = ["Signature1", protected, external_aad (empty bstr), payload]
  const sigStructure = encArray(
    encText("Signature1"),
    encBytes(protectedBstr),
    encBytes(new Uint8Array(0)),
    encBytes(payload),
  );

  const ok = await ed.verifyAsync(signature, sigStructure, pubKey);
  if (!ok) throw new Error("Ed25519 signature invalid");
}
