// Shared wallet / CBOR / tx-assembly helpers.
// Exposes a global `WALLET` object used by admin.html (and potentially index.html later).

(function (global) {
  // ⚠ REPLACE with your token's policy id + asset name (hex).
  // Must match bin/contracts/validators/event_chain.ak.
  const ECT_POLICY_ID  = "00000000000000000000000000000000000000000000000000000000";
  const ECT_ASSET_NAME = "";
  const ECT_DECIMALS   = 6;
  const ECT_UNIT = ECT_POLICY_ID + ECT_ASSET_NAME;

  // ── Hex / bytes ────────────────────────────────────────────────────────────
  function hexToBytes(hex) {
    const b = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) b[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    return b;
  }
  function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  function utf8ToHex(str) {
    return bytesToHex(new TextEncoder().encode(str));
  }

  // ── Bech32 ─────────────────────────────────────────────────────────────────
  const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const BECH32_GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  function bech32Polymod(values) {
    let chk = 1;
    for (const v of values) {
      const top = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= BECH32_GEN[i];
    }
    return chk;
  }
  function bech32HrpExpand(hrp) {
    const ret = [];
    for (const c of hrp) ret.push(c.charCodeAt(0) >> 5);
    ret.push(0);
    for (const c of hrp) ret.push(c.charCodeAt(0) & 31);
    return ret;
  }
  function bech32ToBytes(str) {
    const sep = str.lastIndexOf('1');
    const data = str.slice(sep + 1, -6);
    let bits = 0, value = 0;
    const bytes = [];
    for (const ch of data) {
      const d = BECH32_CHARSET.indexOf(ch.toLowerCase());
      if (d < 0) return null;
      value = (value << 5) | d;
      bits += 5;
      if (bits >= 8) { bits -= 8; bytes.push((value >> bits) & 0xff); }
    }
    return new Uint8Array(bytes);
  }
  function bytesToBech32(hrp, bytes) {
    const words = [];
    let bits = 0, value = 0;
    for (const byte of bytes) {
      value = (value << 8) | byte; bits += 8;
      while (bits >= 5) { bits -= 5; words.push((value >> bits) & 31); }
    }
    if (bits > 0) words.push((value << (5 - bits)) & 31);
    const checksumInput = [...bech32HrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0];
    const checksum = bech32Polymod(checksumInput) ^ 1;
    const csWords = [];
    for (let i = 5; i >= 0; i--) csWords.push((checksum >> (5 * i)) & 31);
    return hrp + '1' + [...words, ...csWords].map(w => BECH32_CHARSET[w]).join('');
  }

  function addressHexToBech32(hexAddr) {
    if (!hexAddr) return null;
    if (hexAddr.toLowerCase().startsWith('addr')) return hexAddr;
    const bytes = hexToBytes(hexAddr);
    if (!bytes || bytes.length < 2) return null;
    const isMainnet = (bytes[0] & 0x01) === 1;
    return bytesToBech32(isMainnet ? 'addr' : 'addr_test', bytes);
  }

  async function normaliseToBech32(addr) {
    if (!addr) return null;
    if (addr.toLowerCase().startsWith('addr')) return addr;
    if (addr.length === 114 || addr.length === 58) return addressHexToBech32(addr);
    try {
      const { decode } = await import("/vendor/cborg.js");
      const bytes = decode(hexToBytes(addr));
      return addressHexToBech32(bytesToHex(bytes));
    } catch { return null; }
  }

  async function getPaymentKeyHash(addr) {
    if (!addr) return null;
    const bech32 = await normaliseToBech32(addr);
    if (!bech32) return null;
    const addrBytes = bech32ToBytes(bech32);
    if (!addrBytes || addrBytes.length < 29) return null;
    return bytesToHex(addrBytes.slice(1, 29));
  }

  // ── Wallet connect ─────────────────────────────────────────────────────────
  const state = { walletApi: null, walletName: null, address: null };

  function getAvailableWallets() {
    if (!window.cardano) return [];
    return Object.keys(window.cardano).filter(k => typeof window.cardano[k]?.enable === "function");
  }

  async function connectWallet(walletName) {
    if (!window.cardano?.[walletName]) throw new Error(`Wallet "${walletName}" not found.`);
    const api = await window.cardano[walletName].enable();
    const used = await api.getUsedAddresses();
    const unused = await api.getUnusedAddresses();
    const rawAddress = used[0] ?? unused[0];
    if (!rawAddress) throw new Error("No address found in wallet.");
    const address = await normaliseToBech32(rawAddress) ?? rawAddress;
    state.walletApi = api;
    state.walletName = walletName;
    state.address = address;
    return { api, address };
  }

  // ── Wallet UTxO decoding ───────────────────────────────────────────────────
  async function decodeWalletUtxos() {
    if (!state.walletApi) throw new Error("Not connected");
    const hexList = await state.walletApi.getUtxos();
    if (!hexList) return [];
    const { decode } = await import("/vendor/cborg.js");
    const result = [];
    for (const hex of hexList) {
      const parsed = decode(hexToBytes(hex), { useMaps: true });
      const [input, txOut] = parsed;
      const [txHash, outputIndex] = input;
      let addrBytes, value;
      if (txOut instanceof Map) { addrBytes = txOut.get(0); value = txOut.get(1); }
      else { addrBytes = txOut[0]; value = txOut[1]; }
      const addr = addressHexToBech32(bytesToHex(addrBytes));
      const assets = {};
      if (typeof value === "bigint" || typeof value === "number") {
        assets.lovelace = value.toString();
      } else if (value instanceof Map) {
        const lovelace = value.get(0);
        if (lovelace !== undefined) assets.lovelace = lovelace.toString();
        const multiasset = value.get(1);
        if (multiasset) {
          for (const [policyBytes, assetMap] of multiasset) {
            const policy = bytesToHex(policyBytes);
            for (const [nameBytes, amount] of assetMap) {
              assets[policy + bytesToHex(nameBytes)] = amount.toString();
            }
          }
        }
      } else if (Array.isArray(value)) {
        assets.lovelace = value[0].toString();
        if (value[1]) {
          for (const [policyBytes, assetMap] of value[1]) {
            const policy = bytesToHex(policyBytes);
            for (const [nameBytes, amount] of assetMap) {
              assets[policy + bytesToHex(nameBytes)] = amount.toString();
            }
          }
        }
      }
      result.push({
        txHash: bytesToHex(txHash),
        outputIndex: Number(outputIndex),
        address: addr,
        assets,
        datumHash: null,
        datum: null,
        scriptRef: null,
      });
    }
    return result;
  }

  // ── CBOR item-length scanner (walks indefinite + definite) ─────────────────
  function cborItemLen(b, o) {
    const ib = b[o], mt = ib >> 5, ai = ib & 0x1f;
    let hLen = 1, count = ai;
    if      (ai === 24) { hLen = 2; count = b[o+1]; }
    else if (ai === 25) { hLen = 3; count = (b[o+1] << 8) | b[o+2]; }
    else if (ai === 26) { hLen = 5; count = (b[o+1] << 24) | (b[o+2] << 16) | (b[o+3] << 8) | b[o+4]; }
    else if (ai === 27) { hLen = 9; count = 0; }
    if (ai === 31 && (mt === 2 || mt === 3 || mt === 4 || mt === 5)) {
      let len = 1;
      while (b[o + len] !== 0xff) len += cborItemLen(b, o + len);
      return len + 1;
    }
    if (mt === 0 || mt === 1) return hLen;
    if (mt === 2 || mt === 3) return hLen + count;
    if (mt === 6) return hLen + cborItemLen(b, o + hLen);
    if (mt === 7) {
      if (ai <= 23) return 1; if (ai === 24) return 2;
      if (ai === 25) return 3; if (ai === 26) return 5; if (ai === 27) return 9;
      return 1;
    }
    const children = mt === 4 ? count : count * 2;
    let len = hLen;
    for (let i = 0; i < children; i++) len += cborItemLen(b, o + len);
    return len;
  }

  function parseCborMap(b, o) {
    const ib = b[o], mt = ib >> 5, ai = ib & 0x1f;
    if (mt !== 5) throw new Error('not a map at offset ' + o);
    let hLen, count;
    if (ai < 24)        { hLen = 1; count = ai; }
    else if (ai === 24) { hLen = 2; count = b[o+1]; }
    else if (ai === 25) { hLen = 3; count = (b[o+1]<<8)|b[o+2]; }
    else if (ai === 26) { hLen = 5; count = (b[o+1]<<24)|(b[o+2]<<16)|(b[o+3]<<8)|b[o+4]; }
    else if (ai === 31) { hLen = 1; count = -1; }
    else throw new Error('unsupported map header');
    const entries = [];
    let p = o + hLen;
    const readOne = () => {
      const kLen = cborItemLen(b, p); const k = b.slice(p, p + kLen); p += kLen;
      const vLen = cborItemLen(b, p); const v = b.slice(p, p + vLen); p += vLen;
      entries.push([k, v]);
    };
    if (count === -1) { while (b[p] !== 0xff) readOne(); p += 1; }
    else for (let i = 0; i < count; i++) readOne();
    return { entries, end: p };
  }

  function parseCborArray(b, o) {
    const ib = b[o], mt = ib >> 5, ai = ib & 0x1f;
    if (mt !== 4) throw new Error('not an array at offset ' + o);
    let hLen, count;
    if (ai < 24)        { hLen = 1; count = ai; }
    else if (ai === 24) { hLen = 2; count = b[o+1]; }
    else if (ai === 25) { hLen = 3; count = (b[o+1]<<8)|b[o+2]; }
    else if (ai === 26) { hLen = 5; count = (b[o+1]<<24)|(b[o+2]<<16)|(b[o+3]<<8)|b[o+4]; }
    else if (ai === 31) { hLen = 1; count = -1; }
    else throw new Error('unsupported array header');
    const items = [];
    let p = o + hLen;
    if (count === -1) { while (b[p] !== 0xff) { const l = cborItemLen(b, p); items.push(b.slice(p, p+l)); p += l; } p += 1; }
    else for (let i = 0; i < count; i++) { const l = cborItemLen(b, p); items.push(b.slice(p, p+l)); p += l; }
    return { itemsRaw: items, end: p };
  }

  function cborHeader(mt, n) {
    if (n < 24)      return new Uint8Array([(mt << 5) | n]);
    if (n < 0x100)   return new Uint8Array([(mt << 5) | 24, n]);
    if (n < 0x10000) return new Uint8Array([(mt << 5) | 25, (n>>8)&0xff, n&0xff]);
    return new Uint8Array([(mt << 5) | 26, (n>>>24)&0xff, (n>>16)&0xff, (n>>8)&0xff, n&0xff]);
  }
  function concatBytes(...arrs) {
    let total = 0; for (const a of arrs) total += a.length;
    const out = new Uint8Array(total); let p = 0;
    for (const a of arrs) { out.set(a, p); p += a.length; }
    return out;
  }

  function mergeWitnessSets(origBytes, signedBytes) {
    const orig = parseCborMap(origBytes, 0);
    const signed = parseCborMap(signedBytes, 0);
    const keyToVal = new Map();
    const keyHex = (k) => Array.from(k).map(x => x.toString(16).padStart(2,'0')).join('');
    for (const [k, v] of orig.entries)   keyToVal.set(keyHex(k), { k, v });
    for (const [k, v] of signed.entries) {
      const h = keyHex(k);
      const existing = keyToVal.get(h);
      if (existing) {
        try {
          const a1 = parseCborArray(existing.v, 0);
          const a2 = parseCborArray(v, 0);
          const items = [...a1.itemsRaw, ...a2.itemsRaw];
          keyToVal.set(h, { k, v: concatBytes(cborHeader(4, items.length), ...items) });
        } catch { keyToVal.set(h, { k, v }); }
      } else keyToVal.set(h, { k, v });
    }
    const entries = [...keyToVal.values()];
    entries.sort((a, b) => {
      for (let i = 0; i < Math.min(a.k.length, b.k.length); i++) {
        if (a.k[i] !== b.k[i]) return a.k[i] - b.k[i];
      }
      return a.k.length - b.k.length;
    });
    const parts = [cborHeader(5, entries.length)];
    for (const { k, v } of entries) { parts.push(k); parts.push(v); }
    return concatBytes(...parts);
  }

  async function assembleSignedTx(unsignedTxHex, signedOrWitnessHex) {
    try {
      const wBytes = hexToBytes(signedOrWitnessHex);
      if ((wBytes[0] >> 5) === 4) return signedOrWitnessHex;
      const txBytes = hexToBytes(unsignedTxHex);
      const outerHeader = txBytes[0];
      const bodyStart = 1;
      const bodyLen = cborItemLen(txBytes, bodyStart);
      const witnessStart = bodyStart + bodyLen;
      const witnessLen = cborItemLen(txBytes, witnessStart);
      const afterWitness = witnessStart + witnessLen;
      const tail = txBytes.slice(afterWitness);
      const origWitnessBytes = txBytes.slice(witnessStart, afterWitness);
      const mergedWitness = mergeWitnessSets(origWitnessBytes, wBytes);
      const out = new Uint8Array(1 + bodyLen + mergedWitness.length + tail.length);
      out[0] = outerHeader;
      out.set(txBytes.slice(bodyStart, witnessStart), 1);
      out.set(mergedWitness, 1 + bodyLen);
      out.set(tail, 1 + bodyLen + mergedWitness.length);
      return bytesToHex(out);
    } catch (e) {
      console.warn('assembleSignedTx failed:', e.message);
      return signedOrWitnessHex;
    }
  }

  global.WALLET = {
    ECT_POLICY_ID, ECT_ASSET_NAME, ECT_DECIMALS, ECT_UNIT,
    hexToBytes, bytesToHex, utf8ToHex,
    bech32ToBytes, addressHexToBech32, normaliseToBech32, getPaymentKeyHash,
    getAvailableWallets, connectWallet, state,
    decodeWalletUtxos,
    assembleSignedTx,
  };
})(window);
