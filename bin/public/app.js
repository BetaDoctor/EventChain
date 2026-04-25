    // ── Wallet (inline, browser-compatible JS) ─────────────────────────────────
    // ⚠ REPLACE with your token's policy id + asset name (hex).
    // Must match bin/contracts/validators/event_chain.ak.
    const ECT_POLICY_ID  = "00000000000000000000000000000000000000000000000000000000";
    const ECT_ASSET_NAME = "";
    const ECT_DECIMALS   = 6;

    function hexToBytes(hex) {
      const b = new Uint8Array(hex.length / 2);
      for (let i = 0; i < hex.length; i += 2) b[i / 2] = parseInt(hex.slice(i, i + 2), 16);
      return b;
    }
    function bytesToHex(bytes) {
      return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
    }

    let walletApi = null;
    let connectedWalletName = null;

    function getAvailableWallets() {
      if (!window.cardano) return [];
      return Object.keys(window.cardano);
    }

    async function connectWallet(walletName) {
      if (!window.cardano?.[walletName]) throw new Error(`Wallet "${walletName}" not found.`);
      walletApi = await window.cardano[walletName].enable();
      connectedWalletName = walletName;
      const used = await walletApi.getUsedAddresses();
      const unused = await walletApi.getUnusedAddresses();
      const rawAddress = used[0] ?? unused[0];
      if (!rawAddress) throw new Error("No address found.");
      // Normalise to bech32 — Eternl returns raw 114-char hex, not bech32
      const address = await normaliseToBech32(rawAddress) ?? rawAddress;
      return address;
    }

    async function getECTBalance() {
      if (!walletApi) return 0;
      try {
        const { decode } = await import("/vendor/cborg.js");
        const balanceHex = await walletApi.getBalance();
        const value = decode(hexToBytes(balanceHex), { useMaps: true });

        // Value is either a plain integer (lovelace only) or [lovelace, multiasset]
        if (!Array.isArray(value) || value.length < 2) return 0;

        const multiasset = value[1];
        for (const [policyBytes, assets] of multiasset) {
          if (bytesToHex(policyBytes) === ECT_POLICY_ID) {
            for (const [nameBytes, amount] of assets) {
              if (bytesToHex(nameBytes) === ECT_ASSET_NAME) {
                const raw = typeof amount === "bigint" ? Number(amount) : amount;
                return ECT_DECIMALS > 0 ? raw / Math.pow(10, ECT_DECIMALS) : raw;
              }
            }
          }
        }
        return 0;
      } catch (e) {
        console.error("Balance parse error:", e);
        return 0;
      }
    }

    // ── VKH extraction from CIP-30 address ────────────────────────────────────
    // CIP-30 returns addresses as CBOR hex OR bech32 depending on the wallet.
    // We need the payment key hash (28 bytes starting at offset 1 in address bytes).

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
      const data = str.slice(sep + 1, -6); // strip HRP and 6-char checksum
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

    // Encode raw bytes to bech32 string (standard, not bech32m)
    function bytesToBech32(hrp, bytes) {
      // Convert bytes → 5-bit words
      const words = [];
      let bits = 0, value = 0;
      for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) { bits -= 5; words.push((value >> bits) & 31); }
      }
      if (bits > 0) words.push((value << (5 - bits)) & 31);
      // Compute checksum
      const checksumInput = [...bech32HrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0];
      const checksum = bech32Polymod(checksumInput) ^ 1;
      const csWords = [];
      for (let i = 5; i >= 0; i--) csWords.push((checksum >> (5 * i)) & 31);
      return hrp + '1' + [...words, ...csWords].map(w => BECH32_CHARSET[w]).join('');
    }

    // Convert a raw-hex Cardano address (from Eternl CIP-30) to bech32.
    // The header byte's LSB encodes the network: 1 = mainnet, 0 = testnet.
    function addressHexToBech32(hexAddr) {
      if (!hexAddr) return null;
      if (hexAddr.toLowerCase().startsWith('addr')) return hexAddr; // already bech32
      const bytes = hexToBytes(hexAddr);
      if (!bytes || bytes.length < 2) return null;
      const isMainnet = (bytes[0] & 0x01) === 1;
      return bytesToBech32(isMainnet ? 'addr' : 'addr_test', bytes);
    }

    // Normalise any CIP-30 address to bech32 (handles bech32, raw hex, CBOR hex)
    async function normaliseToBech32(addr) {
      if (!addr) return null;
      if (addr.toLowerCase().startsWith('addr')) return addr; // already bech32
      if (addr.length === 114 || addr.length === 58) {
        // Raw address bytes as hex (Eternl returns 57-byte base address = 114 hex chars)
        return addressHexToBech32(addr);
      }
      // Try CBOR-wrapped address
      try {
        const { decode } = await import("/vendor/cborg.js");
        const bytes = decode(hexToBytes(addr));
        return addressHexToBech32(bytesToHex(bytes));
      } catch { return null; }
    }

    async function getPaymentKeyHash(addr) {
      if (!addr) return null;
      // Normalise to bech32 first, then decode to raw bytes
      const bech32 = await normaliseToBech32(addr);
      if (!bech32) return null;
      const addrBytes = bech32ToBytes(bech32);
      if (!addrBytes || addrBytes.length < 29) return null;
      return bytesToHex(addrBytes.slice(1, 29)); // skip header byte, take 28-byte PKH
    }

    // ── Market (inline, browser-compatible JS) ─────────────────────────────────
    async function loadMarkets() {
      const res = await fetch("/api/markets");
      if (!res.ok) throw new Error("Failed to load markets");
      return res.json();
    }

    // ── Decode all wallet UTxOs directly from CIP-30 getUtxos() ─────────────────
    // This is more reliable than querying Koios per-address, because HD wallets
    // spread funds across many addresses that getUsedAddresses() may not list.
    async function decodeWalletUtxos() {
      if (!walletApi) return [];
      let rawList;
      try { rawList = await walletApi.getUtxos(); } catch { return []; }
      if (!rawList?.length) return [];
      const { decode } = await import("/vendor/cborg.js");
      const result = [];
      for (const cborHex of rawList) {
        try {
          let decoded = decode(hexToBytes(cborHex), { useMaps: true });
          // Some wallets wrap in a CBOR tag object — unwrap
          if (decoded && !Array.isArray(decoded) && typeof decoded === 'object' && 'value' in decoded) {
            decoded = decoded.value;
          }
          const [txIn, txOut] = decoded;
          const [txHashBytes, txIdx] = txIn;
          const txHash = bytesToHex(new Uint8Array(txHashBytes));

          // txOut can be:
          //   array format (pre-Babbage): [address_bytes, value, ...]
          //   map format (Babbage/Conway): Map { 0 => address_bytes, 1 => value, ... }
          let addrBytes, value;
          if (txOut instanceof Map) {
            addrBytes = txOut.get(0);
            value     = txOut.get(1);
          } else {
            addrBytes = txOut[0];
            value     = txOut[1];
          }

          const assets = {};
          if (typeof value === 'bigint' || typeof value === 'number') {
            assets['lovelace'] = value.toString();
          } else if (Array.isArray(value)) {
            const [lovelace, multiasset] = value;
            assets['lovelace'] = lovelace.toString();
            if (multiasset instanceof Map) {
              for (const [polBytes, assetMap] of multiasset) {
                const policyId = bytesToHex(new Uint8Array(polBytes));
                for (const [nameBytes, qty] of assetMap) {
                  assets[policyId + bytesToHex(new Uint8Array(nameBytes))] = qty.toString();
                }
              }
            }
          } else if (value instanceof Map) {
            // Conway value map: { 0 => lovelace, 1 => multiasset }
            const lovelace = value.get(0);
            if (lovelace !== undefined) assets['lovelace'] = lovelace.toString();
            const multiasset = value.get(1);
            if (multiasset instanceof Map) {
              for (const [polBytes, assetMap] of multiasset) {
                const policyId = bytesToHex(new Uint8Array(polBytes));
                for (const [nameBytes, qty] of assetMap) {
                  assets[policyId + bytesToHex(new Uint8Array(nameBytes))] = qty.toString();
                }
              }
            }
          }
          const address = addressHexToBech32(bytesToHex(new Uint8Array(addrBytes))) ?? bytesToHex(new Uint8Array(addrBytes));
          result.push({ txHash, outputIndex: Number(txIdx), assets, address, datum: null, datumHash: null });
        } catch (e) {
          console.warn('UTxO decode failed, skipping:', cborHex.slice(0,20), e.message);
        }
      }
      const ectUnit = ECT_POLICY_ID + ECT_ASSET_NAME;
      const totalEct = result.reduce((s, u) => s + BigInt(u.assets[ectUnit] ?? 0), 0n);
      const totalAda = result.reduce((s, u) => s + BigInt(u.assets.lovelace ?? 0), 0n);
      console.log(`decodeWalletUtxos: ${result.length} UTxOs decoded — ${Number(totalAda)/1e6} ADA, ${Number(totalEct)/1e6} ECT`);
      return result;
    }

    // price is an integer percentage (e.g. 72 = 72%). Cost = price/100 ECT per share.
    function calculateCost(price, shares) {
      return parseFloat(((price / 100) * shares).toFixed(4));
    }

    // Pari-mutuel "balanced pool" scenario: if losers' pool == winners' pool,
    // each winner roughly doubles their stake (minus 3% house fee on the loser pool).
    // ret ≈ stake + stake × 0.97 = stake × 1.97
    function calculatePotentialReturn(cost) { return cost * 1.97; }

    function calculateImpliedProbability(price) { return price; } // already a percentage

    // ── CBOR byte-length scanner ──────────────────────────────────────────────
    // Measures the byte length of a CBOR item at `offset` without fully decoding.
    // Handles all major types including tag 24 (CBOR embedded data) used by Cardano.
    function cborItemLen(b, o) {
      const ib = b[o], mt = ib >> 5, ai = ib & 0x1f;
      let hLen = 1, count = ai;
      if      (ai === 24) { hLen = 2; count = b[o+1]; }
      else if (ai === 25) { hLen = 3; count = (b[o+1] << 8) | b[o+2]; }
      else if (ai === 26) { hLen = 5; count = (b[o+1] << 24) | (b[o+2] << 16) | (b[o+3] << 8) | b[o+4]; }
      else if (ai === 27) { hLen = 9; count = 0; } // 64-bit (rare; treat count=0)
      // Indefinite length (ai === 31) for mt 2,3,4,5: walk children until break (0xff)
      if (ai === 31 && (mt === 2 || mt === 3 || mt === 4 || mt === 5)) {
        let len = 1; // initial byte
        while (b[o + len] !== 0xff) len += cborItemLen(b, o + len);
        return len + 1; // include break
      }
      if (mt === 0 || mt === 1) return hLen;
      if (mt === 2 || mt === 3) return hLen + count;
      if (mt === 6) return hLen + cborItemLen(b, o + hLen);  // tag (incl. tag 24)
      if (mt === 7) { // simple/float/break
        if (ai <= 23) return 1; if (ai === 24) return 2;
        if (ai === 25) return 3; if (ai === 26) return 5; if (ai === 27) return 9;
        return 1;
      }
      // mt 4 (array) or 5 (map): recurse over children
      const children = mt === 4 ? count : count * 2;
      let len = hLen;
      for (let i = 0; i < children; i++) len += cborItemLen(b, o + len);
      return len;
    }

    // Cardano CIP-30: signTx returns either:
    //   (a) a full signed tx CBOR — major type 4 (array) — submit as-is
    //   (b) just a witness set — major type 5 (map) — must splice into the tx
    // We work entirely at the byte level so CBOR tag 24 never needs decoding.
    // Parse a CBOR map at offset; returns { entries:[[keyBytes,valBytes],...], end }
    function parseCborMap(b, o) {
      const ib = b[o], mt = ib >> 5, ai = ib & 0x1f;
      if (mt !== 5) throw new Error('not a map at offset ' + o);
      let hLen, count;
      if (ai < 24)         { hLen = 1; count = ai; }
      else if (ai === 24)  { hLen = 2; count = b[o+1]; }
      else if (ai === 25)  { hLen = 3; count = (b[o+1]<<8)|b[o+2]; }
      else if (ai === 26)  { hLen = 5; count = (b[o+1]<<24)|(b[o+2]<<16)|(b[o+3]<<8)|b[o+4]; }
      else if (ai === 31)  { hLen = 1; count = -1; }
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

    // Parse a CBOR array; returns { itemsRaw:[Uint8Array,...], end }
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

    // Emit a definite-length CBOR header (major type `mt`, count `n`)
    function cborHeader(mt, n) {
      if (n < 24)          return new Uint8Array([(mt << 5) | n]);
      if (n < 0x100)       return new Uint8Array([(mt << 5) | 24, n]);
      if (n < 0x10000)     return new Uint8Array([(mt << 5) | 25, (n>>8)&0xff, n&0xff]);
      return new Uint8Array([(mt << 5) | 26, (n>>>24)&0xff, (n>>16)&0xff, (n>>8)&0xff, n&0xff]);
    }

    function concatBytes(...arrs) {
      let total = 0; for (const a of arrs) total += a.length;
      const out = new Uint8Array(total); let p = 0;
      for (const a of arrs) { out.set(a, p); p += a.length; }
      return out;
    }

    // Merge two witness-set CBOR maps. For overlapping integer keys whose values are arrays,
    // concatenate the arrays. Otherwise the signed-side value wins.
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
          // Both present — if both values are arrays, concatenate
          try {
            const a1 = parseCborArray(existing.v, 0);
            const a2 = parseCborArray(v, 0);
            const items = [...a1.itemsRaw, ...a2.itemsRaw];
            const merged = concatBytes(cborHeader(4, items.length), ...items);
            keyToVal.set(h, { k, v: merged });
          } catch {
            keyToVal.set(h, { k, v }); // fallback: signed wins
          }
        } else {
          keyToVal.set(h, { k, v });
        }
      }
      const entries = [...keyToVal.values()];
      // Sort by key bytes (canonical CBOR); keys are short ints so lexicographic works
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
        // Full tx starts with 0x84 (array of 4); witness set starts with 0xa? (map)
        if ((wBytes[0] >> 5) === 4) return signedOrWitnessHex; // already a full tx

        const txBytes = hexToBytes(unsignedTxHex);
        const outerHeader = txBytes[0];          // 0x84 (definite) or 0x9f (indefinite)
        const bodyStart = 1;
        const bodyLen = cborItemLen(txBytes, bodyStart);
        const witnessStart = bodyStart + bodyLen;
        const witnessLen = cborItemLen(txBytes, witnessStart);
        const afterWitness = witnessStart + witnessLen;
        const tail = txBytes.slice(afterWitness);

        // MERGE the wallet's witness set with the original one (preserves redeemers + scripts)
        const origWitnessBytes = txBytes.slice(witnessStart, afterWitness);
        const mergedWitness = mergeWitnessSets(origWitnessBytes, wBytes);
        console.log('Merged witness set, byte length:', mergedWitness.length, '(orig:', witnessLen, ', signed:', wBytes.length, ')');

        const out = new Uint8Array(1 + bodyLen + mergedWitness.length + tail.length);
        out[0] = outerHeader;
        out.set(txBytes.slice(bodyStart, witnessStart), 1);
        out.set(mergedWitness, 1 + bodyLen);
        out.set(tail, 1 + bodyLen + mergedWitness.length);
        console.log('Assembled signed tx, byte length:', out.length);
        return bytesToHex(out);
      } catch (e) {
        console.warn('assembleSignedTx failed:', e.message);
        return signedOrWitnessHex;
      }
    }

    // ── Pre-sign tx verification (audit P0-1) ────────────────────────────────
    // Decode the unsigned tx CBOR and confirm at least one output pays the
    // expected address at least the expected ECT base units. Defends against
    // a compromised server serving a tx that silently redirects funds.
    // Returns true if verification passes; throws with a user-visible message
    // on mismatch so callers can abort before signTx.
    let _cachedContractAddr = null;
    async function getContractAddress() {
      if (_cachedContractAddr) return _cachedContractAddr;
      const r = await fetch('/api/contract-address');
      if (!r.ok) throw new Error('Could not fetch contract address for tx verify');
      const j = await r.json();
      if (!j.contractAddress) throw new Error('Server missing contractAddress');
      _cachedContractAddr = j.contractAddress;
      return _cachedContractAddr;
    }

    // ── Byte-level CBOR helpers for tx verify ───────────────────────────────
    // We can't use cborg.js here because Cardano tx outputs carry CBOR tag 24
    // (inline datums) that cborg.js refuses to decode by default. The
    // byte-level parsers below navigate the tx structure without interpreting
    // tagged payloads.
    function cborReadUint(b, o) {
      const ib = b[o], mt = ib >> 5, ai = ib & 0x1f;
      if (mt !== 0 && mt !== 1) throw new Error('not int at ' + o);
      let val, len;
      if (ai < 24)        { val = ai; len = 1; }
      else if (ai === 24) { val = b[o+1]; len = 2; }
      else if (ai === 25) { val = (b[o+1]<<8)|b[o+2]; len = 3; }
      else if (ai === 26) { val = (b[o+1]*0x1000000) + (b[o+2]<<16) + (b[o+3]<<8) + b[o+4]; len = 5; }
      else if (ai === 27) {
        const hi = b[o+1]*0x1000000 + (b[o+2]<<16) + (b[o+3]<<8) + b[o+4];
        const lo = b[o+5]*0x1000000 + (b[o+6]<<16) + (b[o+7]<<8) + b[o+8];
        val = BigInt(hi) * 0x100000000n + BigInt(lo);
        len = 9;
      } else throw new Error('bad int ai ' + ai);
      if (mt === 1) val = (typeof val === 'bigint') ? (-1n - val) : (-1 - val);
      return { value: val, len };
    }

    function cborReadBytes(b, o) {
      const ib = b[o], mt = ib >> 5, ai = ib & 0x1f;
      if (mt !== 2) throw new Error('not bytes at ' + o);
      let hLen, count;
      if (ai < 24)        { hLen = 1; count = ai; }
      else if (ai === 24) { hLen = 2; count = b[o+1]; }
      else if (ai === 25) { hLen = 3; count = (b[o+1]<<8)|b[o+2]; }
      else if (ai === 26) { hLen = 5; count = (b[o+1]*0x1000000) + (b[o+2]<<16) + (b[o+3]<<8) + b[o+4]; }
      else throw new Error('bad bytes ai ' + ai);
      return b.slice(o + hLen, o + hLen + count);
    }

    // Skip any CBOR tags (major type 6), returning new offset pointing at
    // the tag's inner item. Cardano sometimes wraps sets in tag 258.
    function skipTags(b, o) {
      while ((b[o] >> 5) === 6) {
        // cborReadUint works for the tag number (same header encoding)
        o += cborReadUint(b, o).len;
      }
      return o;
    }

    // Walk outputs of an unsigned tx. Throws if no output pays expectedBech32
    // at least minEct ECT base units. Audit P0-1.
    async function verifyTxOutput(unsignedTxHex, expectedBech32, minEct) {
      const b = hexToBytes(unsignedTxHex);
      // Outer: array of 4 — [body, witness_set, is_valid, aux_data]
      if ((b[0] >> 5) !== 4) throw new Error('Tx verify: outer not an array');
      const bodyStart = 1; // definite-length small array: 1-byte header
      const body = parseCborMap(b, bodyStart);
      // Find key 1 = outputs
      let outputsBytes = null;
      for (const [k, v] of body.entries) {
        if (cborReadUint(k, 0).value === 1) { outputsBytes = v; break; }
      }
      if (!outputsBytes) throw new Error('Tx verify: no outputs in body');
      // Outputs can be tag-wrapped (tag 258 set-like) in some encodings
      let outOff = skipTags(outputsBytes, 0);
      const outputs = parseCborArray(outputsBytes.slice(outOff), 0);
      const minBig = BigInt(Math.trunc(minEct));
      for (const outBytes of outputs.itemsRaw) {
        const off = skipTags(outBytes, 0);
        const mt = outBytes[off] >> 5;
        let addrBytes = null, valueBytes = null;
        if (mt === 5) {
          const m = parseCborMap(outBytes.slice(off), 0);
          for (const [k, v] of m.entries) {
            const ki = cborReadUint(k, 0).value;
            if (ki === 0) addrBytes = cborReadBytes(v, skipTags(v, 0));
            else if (ki === 1) valueBytes = v;
          }
        } else if (mt === 4) {
          const a = parseCborArray(outBytes.slice(off), 0);
          if (a.itemsRaw.length >= 2) {
            addrBytes = cborReadBytes(a.itemsRaw[0], skipTags(a.itemsRaw[0], 0));
            valueBytes = a.itemsRaw[1];
          }
        } else continue;
        if (!addrBytes || !valueBytes) continue;
        const bech = addressHexToBech32(bytesToHex(addrBytes));
        if (bech !== expectedBech32) continue;
        // Value: int (ADA only, no ECT) or [lovelace, multiasset]
        const vOff = skipTags(valueBytes, 0);
        const vmt = valueBytes[vOff] >> 5;
        if (vmt !== 4) continue; // no multiasset
        const vArr = parseCborArray(valueBytes.slice(vOff), 0);
        if (vArr.itemsRaw.length < 2) continue;
        const maBytes = vArr.itemsRaw[1];
        const maOff = skipTags(maBytes, 0);
        if ((maBytes[maOff] >> 5) !== 5) continue;
        const ma = parseCborMap(maBytes.slice(maOff), 0);
        let ectQty = 0n;
        for (const [polKey, assetsVal] of ma.entries) {
          const polBytes = cborReadBytes(polKey, skipTags(polKey, 0));
          if (bytesToHex(polBytes) !== ECT_POLICY_ID) continue;
          const assetsOff = skipTags(assetsVal, 0);
          const am = parseCborMap(assetsVal.slice(assetsOff), 0);
          for (const [nameKey, qtyVal] of am.entries) {
            const nameBytes = cborReadBytes(nameKey, skipTags(nameKey, 0));
            if (bytesToHex(nameBytes) !== ECT_ASSET_NAME) continue;
            const qi = cborReadUint(qtyVal, skipTags(qtyVal, 0)).value;
            ectQty += (typeof qi === 'bigint') ? qi : BigInt(qi);
          }
        }
        if (ectQty >= minBig) return;
      }
      throw new Error(
        `Tx verify failed: no output pays ${minEct} ECT base units to ${expectedBech32.slice(0, 20)}…. ` +
        `Refusing to sign — server may be compromised.`,
      );
    }

    async function buyShares(market, side, shares) {
      if (!walletApi) { showToast('Wallet required', 'Connect your wallet first.', 'error'); return; }
      const submitBtn = document.getElementById('trade-submit-btn');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Building transaction…';
      try {
        const used = await walletApi.getUsedAddresses();
        const unused = await walletApi.getUnusedAddresses();
        const rawAddr = used[0] ?? unused[0];
        if (!rawAddr) throw new Error('No address found in wallet.');
        const bettorAddress = await normaliseToBech32(rawAddr) ?? rawAddr;
        const bettorVkh = await getPaymentKeyHash(bettorAddress);
        if (!bettorVkh) throw new Error('Could not extract payment key hash. Try reconnecting your wallet.');

        // Decode ALL wallet UTxOs directly from the wallet API (avoids multi-address Koios issues)
        const walletUtxos = await decodeWalletUtxos();

        const price = tradingSide === 'YES' ? tradingMarket.yesPrice : tradingMarket.noPrice;
        const costEct = calculateCost(price, shares); // display ECT
        const ectAmount = Math.round(costEct * 1_000_000); // base units (6 decimals)
        const resp = await fetch('/api/tx/place-bet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ marketId: market.id, side: side === 'YES' ? 'Yes' : 'No', ectAmount, bettorAddress, bettorVkh, walletUtxos }),
        });
        if (!resp.ok) {
          const err = await resp.json();
          throw new Error(err.error ?? 'Server error building tx');
        }
        const { unsignedTx } = await resp.json();

        // Audit P0-1: verify the server-built tx actually locks the bettor's
        // ECT at the contract address before we ask the wallet to sign.
        submitBtn.textContent = 'Verifying tx…';
        const contractAddr = await getContractAddress();
        await verifyTxOutput(unsignedTx, contractAddr, ectAmount);

        submitBtn.textContent = 'Sign in wallet…';
        const signedOrWitness = await walletApi.signTx(unsignedTx, true);

        // CIP-30 says signTx returns a witness set (CBOR map).
        // Some wallets (Eternl) return the full tx instead.
        // Detect which we got and assemble the full tx if needed.
        const finalTx = await assembleSignedTx(unsignedTx, signedOrWitness);

        submitBtn.textContent = 'Submitting…';
        const txHash = await walletApi.submitTx(finalTx);
        showToast('Bet placed', `Your ${side} bet on "${market.title}" is on-chain.`, 'success', { txHash });
        tradeModal.classList.add('hidden');
      } catch (err) {
        console.error('Bet TX error:', err);
        showToast('Transaction failed', err.message ?? JSON.stringify(err), 'error');
      } finally {
        submitBtn.disabled = false;
        updateTradeSide(tradingSide);
      }
    }

    // ── Toast modal (replaces native alert) ────────────────────────────────────
    // variant: 'info' | 'success' | 'error'
    // opts:    { txHash?: string, linkLabel?: string }
    function showToast(title, message, variant = 'info', opts = {}) {
      const modal = document.getElementById('toast-modal');
      const icon  = document.getElementById('toast-icon');
      const t     = document.getElementById('toast-title');
      const msg   = document.getElementById('toast-message');
      const card  = document.getElementById('toast-card');
      const okBtn = document.getElementById('toast-ok');
      const styles = {
        info:    { ring: 'border-blue-800',  iconBg: 'bg-blue-900/40  text-blue-300',  sym: 'ℹ',  btn: 'bg-blue-600 hover:bg-blue-500' },
        success: { ring: 'border-green-800', iconBg: 'bg-green-900/40 text-green-300', sym: '✓',  btn: 'bg-green-600 hover:bg-green-500' },
        error:   { ring: 'border-red-900',   iconBg: 'bg-red-900/40   text-red-300',   sym: '!',  btn: 'bg-red-600 hover:bg-red-500' },
      };
      const s = styles[variant] ?? styles.info;
      card.className = card.className.replace(/border-(blue|green|red)-[0-9]+/g, '').trim();
      card.classList.add(s.ring);
      icon.className = `flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-lg font-bold ${s.iconBg}`;
      icon.textContent = s.sym;
      t.textContent = title;
      msg.textContent = message;
      okBtn.className = `w-full py-2.5 rounded-lg text-sm font-semibold transition-colors text-white ${s.btn}`;
      // Optional TX link
      const link = document.getElementById('toast-link');
      if (opts.txHash && /^[0-9a-f]{64}$/i.test(opts.txHash)) {
        link.href = `https://cexplorer.io/tx/${opts.txHash}`;
        link.textContent = (opts.linkLabel ?? 'View transaction on cexplorer') + ' ↗';
        link.classList.remove('hidden');
      } else {
        link.classList.add('hidden');
      }
      modal.classList.remove('hidden');
    }
    function hideToast() { document.getElementById('toast-modal').classList.add('hidden'); }
    document.getElementById('toast-close').addEventListener('click', hideToast);
    document.getElementById('toast-ok').addEventListener('click', hideToast);
    document.getElementById('toast-modal').addEventListener('click', (e) => {
      if (e.target.id === 'toast-modal') hideToast();
    });

    // ── State ──────────────────────────────────────────────────────────────────
    let markets = [];
    let resolvedMarkets = [];      // lazy-loaded when user clicks "Resolved"
    let resolvedLoaded = false;
    let activeCategory = 'All';
    let tradingMarket = null;
    let tradingSide = 'YES';
    let connectedAddress = null;

    // ── Market rendering ───────────────────────────────────────────────────────
    function categoryColor(cat) {
      const map = { Crypto: 'text-blue-400 bg-blue-900/30', Politics: 'text-purple-400 bg-purple-900/30',
        Sports: 'text-orange-400 bg-orange-900/30', Science: 'text-teal-400 bg-teal-900/30',
        Economics: 'text-yellow-400 bg-yellow-900/30', DeFi: 'text-pink-400 bg-pink-900/30' };
      return map[cat] ?? 'text-gray-400 bg-gray-800/30';
    }

    function formatVolume(v) {
      if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
      return v.toString();
    }

    function renderMarkets() {
      const grid = document.getElementById('market-grid');
      const isResolvedView = activeCategory === '__resolved__';
      const source = isResolvedView ? resolvedMarkets : markets;
      const filtered = isResolvedView || activeCategory === 'All'
        ? source
        : source.filter(m => m.category === activeCategory);
      document.getElementById('market-count').textContent = `${filtered.length} markets`;

      if (!filtered.length) {
        const msg = isResolvedView ? 'No resolved markets yet.' : 'No markets in this category.';
        grid.innerHTML = `<div class="col-span-full text-center py-16 text-gray-600">${msg}</div>`;
        return;
      }

      grid.innerHTML = filtered.map(m => {
        // Coerce numerics — server response is untyped over the wire; if any of
        // these land as a string the `style="width: X%"` or innerHTML usage
        // below becomes an injection vector.
        const yesPrice = Math.max(0, Math.min(100, Number(m.yesPrice) || 0));
        const noPrice  = Math.max(0, Math.min(100, Number(m.noPrice)  || 0));
        const volume   = Number(m.volume) || 0;
        const deadline = Number(m.deadline) || 0;
        const endsDate = new Date(deadline).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
        const resolved = m.status === 'resolved';
        const resolveBtn = '';
        // Market id is server-validated to [a-z0-9-]+ but escape anyway.
        const safeId = escapeHtml(m.id);
        // Resolved markets get a cexplorer TX link instead of YES/NO buttons.
        const resolutionTxHash = resolved && typeof m.resolutionUtxoRef === 'string'
          ? m.resolutionUtxoRef.split('#')[0]
          : null;
        const txLink = resolutionTxHash && /^[0-9a-f]{64}$/i.test(resolutionTxHash)
          ? `<a href="https://cexplorer.io/tx/${resolutionTxHash}" target="_blank" rel="noopener"
                class="flex-1 text-center text-xs px-3 py-2 rounded-lg border border-[#1e2d45] text-gray-300 hover:text-white hover:border-blue-700 transition-colors font-mono">
               View Tx ↗
             </a>`
          : `<span class="flex-1 text-center text-xs text-gray-500 italic py-2">Resolved</span>`;
        const tradeBtns = resolved
          ? txLink
          : `<button class="trade-btn yes-btn flex-1 text-base px-6 py-3 rounded-lg font-semibold transition-colors" data-id="${safeId}" data-side="YES">YES</button>
             <button class="trade-btn no-btn flex-1 text-base px-6 py-3 rounded-lg font-semibold transition-colors" data-id="${safeId}" data-side="NO">NO</button>`;
        return `
        <div class="market-card bg-[#0f1623] border ${resolved ? 'border-gray-700 opacity-75' : 'border-[#1e2d45] hover:border-blue-800'} rounded-xl p-5 transition-colors">
          <div class="flex items-start justify-between gap-2 mb-3">
            <h3 class="text-sm font-semibold leading-snug text-gray-100">${escapeHtml(m.title)}</h3>
            <span class="text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${categoryColor(m.category)}">${escapeHtml(m.category)}</span>
          </div>
          <div class="mb-3">
            <div class="flex justify-between text-xs text-gray-500 mb-1.5">
              <span class="text-green-400 font-semibold">YES ${yesPrice}%</span>
              <span class="text-red-400 font-semibold">NO ${noPrice}%</span>
            </div>
            <div class="h-2 rounded-full bg-red-700 overflow-hidden">
              <div class="h-full bg-green-600" style="width: ${yesPrice}%"></div>
            </div>
          </div>
          <div class="flex gap-3 mb-3">${resolveBtn}${tradeBtns}</div>
          <div class="text-xs text-gray-500 text-center">
            <span class="text-gray-400">Vol:</span> ${formatVolume(volume)} ECT &nbsp;·&nbsp;
            <span class="text-gray-400">Ends:</span> ${escapeHtml(endsDate)}
          </div>
        </div>`;
      }).join('');

      // Bind trade buttons
      grid.querySelectorAll('.trade-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const id = e.currentTarget.dataset.id;
          const side = e.currentTarget.dataset.side;
          openTradeModal(markets.find(m => m.id === id), side);
        });
      });

    }

    // ── Category filter ────────────────────────────────────────────────────────
    async function loadResolvedMarkets() {
      try {
        const r = await fetch('/api/markets/resolved');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        resolvedMarkets = await r.json();
        resolvedLoaded = true;
      } catch (err) {
        console.warn('Failed to load resolved markets:', err);
        resolvedMarkets = [];
      }
    }

    document.querySelectorAll('.category-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        document.querySelectorAll('.category-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeCategory = btn.dataset.cat;
        if (activeCategory === '__resolved__' && !resolvedLoaded) {
          document.getElementById('market-grid').innerHTML =
            `<div class="col-span-full text-center py-16 text-gray-500">Loading resolved markets…</div>`;
          await loadResolvedMarkets();
        }
        renderMarkets();
      });
    });

    // ── Wallet connection ──────────────────────────────────────────────────────
    const walletModal = document.getElementById('wallet-modal');
    const connectBtn = document.getElementById('connect-btn');

    connectBtn.addEventListener('click', () => {
      const wallets = getAvailableWallets();
      const list = document.getElementById('wallet-list');

      if (!wallets.length) {
        list.innerHTML = `<p class="text-sm text-gray-500 text-center py-4">No Cardano wallets detected.<br/>Install Eternl or Nami.</p>`;
      } else {
        // Wallet IDs come from window.cardano[key] — an extension could
        // choose any key string. Escape to prevent HTML injection.
        list.innerHTML = wallets.map(w => {
          const sw = escapeHtml(w);
          const init = escapeHtml(w.slice(0, 2));
          return `
          <button class="wallet-option w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-[#1e2d45]
            hover:border-blue-600 hover:bg-blue-900/10 transition-colors text-sm font-medium"
            data-wallet="${sw}">
            <div class="w-8 h-8 rounded-md bg-[#1e2d45] flex items-center justify-center text-xs font-bold uppercase">${init}</div>
            <span class="capitalize">${sw}</span>
          </button>`;
        }).join('');

        list.querySelectorAll('.wallet-option').forEach(btn => {
          btn.addEventListener('click', async () => {
            const walletName = btn.dataset.wallet;
            try {
              await applyWalletConnection(walletName);
              walletModal.classList.add('hidden');
            } catch (err) {
              showToast('Connection failed', err.message, 'error');
            }
          });
        });
      }
      walletModal.classList.remove('hidden');
    });

    document.getElementById('wallet-modal-close').addEventListener('click', () => walletModal.classList.add('hidden'));
    walletModal.addEventListener('click', e => { if (e.target === walletModal) walletModal.classList.add('hidden'); });

    // ── Trade modal ────────────────────────────────────────────────────────────
    const tradeModal = document.getElementById('trade-modal');
    const sharesInput = document.getElementById('trade-shares');

    function openTradeModal(market, side) {
      tradingMarket = market;
      tradingSide = side;

      document.getElementById('trade-market-title').textContent = market.title;
      updateTradeSide(side);
      tradeModal.classList.remove('hidden');
    }

    function updateTradeSide(side) {
      tradingSide = side;
      const price = side === 'YES' ? tradingMarket.yesPrice : tradingMarket.noPrice;

      document.getElementById('trade-price').textContent = `${(price / 100).toFixed(4)} ECT`;
      document.getElementById('trade-prob').textContent = `${calculateImpliedProbability(price)}%`;

      const yesBtn = document.getElementById('trade-yes-btn');
      const noBtn = document.getElementById('trade-no-btn');
      const submitBtn = document.getElementById('trade-submit-btn');

      if (side === 'YES') {
        yesBtn.className = 'flex-1 py-2.5 text-sm font-semibold transition-colors trade-side-btn bg-green-700 text-white';
        noBtn.className = 'flex-1 py-2.5 text-sm font-semibold transition-colors trade-side-btn bg-transparent text-gray-400 hover:text-gray-200';
        submitBtn.className = 'w-full py-3 rounded-lg text-sm font-bold transition-colors bg-green-600 hover:bg-green-500 text-white';
        submitBtn.textContent = 'Buy YES Shares';
      } else {
        noBtn.className = 'flex-1 py-2.5 text-sm font-semibold transition-colors trade-side-btn bg-red-700 text-white';
        yesBtn.className = 'flex-1 py-2.5 text-sm font-semibold transition-colors trade-side-btn bg-transparent text-gray-400 hover:text-gray-200';
        submitBtn.className = 'w-full py-3 rounded-lg text-sm font-bold transition-colors bg-red-600 hover:bg-red-500 text-white';
        submitBtn.textContent = 'Buy NO Shares';
      }

      updateCostDisplay();
    }

    function updateCostDisplay() {
      const shares = parseFloat(sharesInput.value) || 0;
      const price = tradingSide === 'YES' ? tradingMarket.yesPrice : tradingMarket.noPrice;
      const cost = calculateCost(price, shares);
      const ret = calculatePotentialReturn(cost);
      document.getElementById('trade-cost').textContent = `${cost.toFixed(4)} ECT`;
      document.getElementById('trade-return').textContent = `≈ ${ret.toFixed(4)} ECT`;
    }

    document.getElementById('trade-yes-btn').addEventListener('click', () => updateTradeSide('YES'));
    document.getElementById('trade-no-btn').addEventListener('click', () => updateTradeSide('NO'));
    sharesInput.addEventListener('input', updateCostDisplay);

    document.getElementById('trade-submit-btn').addEventListener('click', async () => {
      if (!tradingMarket) return;
      const shares = parseFloat(sharesInput.value) || 0;
      if (shares <= 0) { showToast('Invalid input', 'Enter a valid number of shares.', 'error'); return; }
      await buyShares(tradingMarket, tradingSide, shares);
    });

    document.getElementById('trade-modal-close').addEventListener('click', () => tradeModal.classList.add('hidden'));
    tradeModal.addEventListener('click', e => { if (e.target === tradeModal) tradeModal.classList.add('hidden'); });

    // ── Whitepaper modal ──────────────────────────────────────────────────────
    const whitepaperModal = document.getElementById('whitepaper-modal');
    const whitepaperBody = document.getElementById('whitepaper-body');
    let whitepaperLoaded = false;

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // Allow only safe URL schemes in markdown / user-rendered HTML.
    // Blocks javascript:, data:, vbscript:, file: etc. — any of which can
    // become clickable XSS payloads when rendered inside innerHTML.
    function safeUrl(u) {
      const s = String(u).trim();
      // Reject protocol-relative URLs like //evil.com by requiring the path
      // to start with exactly one slash not followed by another.
      if (/^(https?:|mailto:|#)/i.test(s)) return s;
      if (/^\/(?!\/)/.test(s)) return s;
      return '#';
    }

    // Small markdown renderer — handles headings, bold, italic, code, links,
    // lists, tables, hr, blockquote. Scoped to what our whitepaper uses.
    function renderMarkdown(md) {
      const lines = md.replace(/\r\n/g, '\n').split('\n');
      const out = [];
      let i = 0;

      const inline = (s) => {
        // Escape first, then re-inject allowed inline markup.
        s = escapeHtml(s);
        // Code spans
        s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
        // Bold
        s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        // Italic (single *) — avoid already-bolded text
        s = s.replace(/(^|[^*])\*([^*\n]+)\*([^*]|$)/g, '$1<em>$2</em>$3');
        // Links [text](url) — filter URL scheme to stop javascript: XSS.
        s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) =>
          `<a href="${escapeHtml(safeUrl(u))}" target="_blank" rel="noopener">${t}</a>`);
        return s;
      };

      while (i < lines.length) {
        const line = lines[i];

        // Horizontal rule
        if (/^---+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

        // Headings
        const h = line.match(/^(#{1,3})\s+(.*)$/);
        if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }

        // Blockquote
        if (line.startsWith('> ')) {
          const buf = [];
          while (i < lines.length && lines[i].startsWith('> ')) {
            buf.push(lines[i].slice(2));
            i++;
          }
          out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
          continue;
        }

        // Table (header row + separator row + body rows)
        if (line.startsWith('|') && i + 1 < lines.length && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
          const splitRow = (r) => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
          const header = splitRow(line);
          i += 2; // skip header + separator
          const rows = [];
          while (i < lines.length && lines[i].startsWith('|')) { rows.push(splitRow(lines[i])); i++; }
          let html = '<table><thead><tr>';
          for (const h of header) html += `<th>${inline(h)}</th>`;
          html += '</tr></thead><tbody>';
          for (const r of rows) {
            html += '<tr>';
            for (const c of r) html += `<td>${inline(c)}</td>`;
            html += '</tr>';
          }
          out.push(html + '</tbody></table>');
          continue;
        }

        // Bullet list
        if (/^[-*]\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^[-*]\s+/, ''));
            i++;
          }
          out.push('<ul>' + items.map(x => `<li>${inline(x)}</li>`).join('') + '</ul>');
          continue;
        }

        // Blank line
        if (line.trim() === '') { i++; continue; }

        // Paragraph — gather consecutive non-empty non-structural lines
        const para = [];
        while (i < lines.length && lines[i].trim() !== '' &&
               !/^#{1,3}\s/.test(lines[i]) && !/^---+\s*$/.test(lines[i]) &&
               !lines[i].startsWith('|') && !lines[i].startsWith('> ') &&
               !/^[-*]\s+/.test(lines[i])) {
          para.push(lines[i]);
          i++;
        }
        if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
      }
      return out.join('\n');
    }

    async function openWhitepaper() {
      whitepaperModal.classList.remove('hidden');
      // Populate the contract link (once) from the debug endpoint.
      const contractLink = document.getElementById('whitepaper-contract-link');
      if (contractLink && contractLink.getAttribute('href') === '#') {
        fetch('/api/contract-address')
          .then(r => r.json())
          .then(d => { if (d.contractAddress) contractLink.href = `https://cexplorer.io/address/${d.contractAddress}`; })
          .catch(() => {});
      }
      if (whitepaperLoaded) return;
      try {
        const resp = await fetch('/docs/WHITEPAPER.md', { cache: 'no-cache' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const md = await resp.text();
        whitepaperBody.innerHTML = renderMarkdown(md);
        whitepaperLoaded = true;
      } catch (err) {
        whitepaperBody.innerHTML = `<p class="text-red-400">Failed to load whitepaper: ${escapeHtml(String(err.message || err))}</p>`;
      }
    }

    document.getElementById('whitepaper-btn').addEventListener('click', openWhitepaper);
    document.getElementById('whitepaper-modal-close').addEventListener('click', () => whitepaperModal.classList.add('hidden'));
    whitepaperModal.addEventListener('click', e => { if (e.target === whitepaperModal) whitepaperModal.classList.add('hidden'); });

    // ── My Bets ────────────────────────────────────────────────────────────────
    async function loadMyBets() {
      if (!connectedAddress) return;
      const panel = document.getElementById('my-bets-panel');
      const empty = document.getElementById('my-bets-empty');
      const list = document.getElementById('my-bets-list');
      panel.classList.remove('hidden');
      if (empty) empty.classList.add('hidden');
      list.innerHTML = '<p class="text-xs text-gray-600">Loading…</p>';
      try {
        const resp = await fetch(`/api/bets/${connectedAddress}`);
        const data = await resp.json();
        const openBets = data.openBets ?? [];
        const payouts = data.payouts ?? [];

        if (!openBets.length && !payouts.length) {
          list.innerHTML = '<p class="text-xs text-gray-600">No open bets or payouts found.</p>';
          return;
        }

        const payoutHtml = payouts.map(p => `
          <div class="bg-green-950/40 border border-green-800/60 rounded-lg p-2 text-xs space-y-1">
            <div class="font-semibold text-green-300 truncate">${escapeHtml(p.marketId)}</div>
            <div class="flex justify-between">
              <span class="text-green-400 font-semibold">WINNER</span>
              <span class="text-gray-300">${(p.payoutAmount / 1_000_000).toLocaleString()} ECT</span>
            </div>
            <button class="claim-btn w-full py-1 mt-1 rounded bg-green-700 hover:bg-green-600 text-white font-semibold" data-ref="${escapeHtml(p.ref)}" data-amount="${Number(p.payoutAmount) || 0}">Claim</button>
          </div>
        `).join('');

        // Claim-all button shown only when 2+ payouts — saves fees + clicks.
        // Sum is computed client-side from the same data the individual Claim
        // buttons use, so users don't need to trust the server on the total.
        let claimAllHtml = '';
        if (payouts.length >= 2) {
          const totalEct = payouts.reduce((s, p) => s + (Number(p.payoutAmount) || 0), 0);
          claimAllHtml = `
            <button class="claim-all-btn w-full py-2 mb-2 rounded bg-green-600 hover:bg-green-500 text-white font-bold text-xs" data-total="${totalEct}">
              Claim all ${payouts.length} · ${(totalEct / 1_000_000).toLocaleString()} ECT
            </button>
          `;
        }

        const betHtml = openBets.map(b => `
          <div class="bg-[#0a0f1c] rounded-lg p-2 text-xs space-y-1">
            <div class="font-semibold text-gray-300 truncate">${escapeHtml(b.marketId)}</div>
            <div class="flex justify-between">
              <span class="${b.side === 'Yes' ? 'text-green-400' : 'text-red-400'}">${b.side === 'Yes' ? 'YES' : 'NO'}</span>
              <span class="text-gray-400">${(b.ectAmount / 1_000_000).toLocaleString()} ECT</span>
            </div>
            <button class="refund-btn w-full py-1 mt-1 rounded bg-gray-700 hover:bg-gray-600 text-white font-semibold" data-ref="${escapeHtml(b.ref)}" data-amount="${Number(b.ectAmount) || 0}" title="Available 7 days after the market deadline if the oracle never resolves. (Admin can force-refund sooner if a market is cancelled.)">Refund</button>
          </div>
        `).join('');

        list.innerHTML = claimAllHtml + payoutHtml + betHtml;
        list.querySelectorAll('.claim-btn').forEach(btn => btn.addEventListener('click', () => claimPayout(btn.dataset.ref, Number(btn.dataset.amount) || 0, btn)));
        list.querySelectorAll('.claim-all-btn').forEach(btn => btn.addEventListener('click', () => claimAllPayouts(Number(btn.dataset.total) || 0, btn)));
        list.querySelectorAll('.refund-btn').forEach(btn => btn.addEventListener('click', () => refundBet(btn.dataset.ref, Number(btn.dataset.amount) || 0, btn)));
      } catch (e) {
        console.error('loadMyBets failed:', e);
        list.innerHTML = '<p class="text-xs text-red-500">Failed to load bets.</p>';
      }
    }

    // Disable the originating button (and its siblings in the same bet row)
    // during an in-flight tx. Without this, a double-click kicks off two
    // concurrent signTx/submitTx pairs against the same UTxO — the second
    // will fail on-chain but the UX (two wallet prompts, two alerts) is bad.
    function lockBetRow(btn) {
      if (!btn) return () => {};
      const row = btn.closest('[data-bet-row]') ?? btn.parentElement;
      const btns = row ? row.querySelectorAll('button') : [btn];
      const prev = [];
      btns.forEach(b => { prev.push([b, b.disabled]); b.disabled = true; });
      const origText = btn.textContent;
      btn.textContent = '…';
      return () => {
        prev.forEach(([b, d]) => { b.disabled = d; });
        btn.textContent = origText;
      };
    }

    async function claimPayout(payoutUtxoRef, expectedPayoutBaseUnits, btn) {
      const unlock = lockBetRow(btn);
      try {
        const bettorVkh = await getPaymentKeyHash(connectedAddress);
        const walletUtxos = await decodeWalletUtxos();
        const resp = await fetch('/api/tx/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payoutUtxoRef, bettorAddress: connectedAddress, bettorVkh, walletUtxos }),
        });
        if (!resp.ok) { const e = await resp.json(); throw new Error(e.error); }
        const { unsignedTx } = await resp.json();
        // Audit P0-1: confirm the built tx actually pays me at least what I
        // expect before the wallet is asked to sign.
        if (expectedPayoutBaseUnits > 0) {
          await verifyTxOutput(unsignedTx, connectedAddress, expectedPayoutBaseUnits);
        }
        const finalTx = await assembleSignedTx(unsignedTx, await walletApi.signTx(unsignedTx, true));
        const txHash = await walletApi.submitTx(finalTx);
        showToast('Claimed', 'Your payout has been sent to your wallet.', 'success', { txHash });
        loadMyBets();
      } catch (err) {
        console.error('Claim error:', err);
        const msg = String(err?.message ?? err).split('\n')[0].slice(0, 200);
        showToast('Claim failed', msg, 'error');
      } finally {
        unlock();
      }
    }

    async function claimAllPayouts(expectedTotalBaseUnits, btn) {
      const unlock = lockBetRow(btn);
      try {
        const walletUtxos = await decodeWalletUtxos();
        const resp = await fetch('/api/tx/claim-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bettorAddress: connectedAddress, walletUtxos }),
        });
        if (!resp.ok) { const e = await resp.json(); throw new Error(e.error); }
        const { unsignedTx, count, totalEct, remaining } = await resp.json();
        // Same safety check as single-claim: verify the built tx actually
        // pays us at least what the server claimed, BEFORE signing. We pass
        // the CLIENT-summed expectation (not the server's `totalEct`) so a
        // malicious server can't trick us into signing a smaller-than-earned
        // payout. If the server limited the slice (remaining > 0), the tx
        // will pay at least server-sliceEct; client min-bound might be
        // larger than what's in this tx, so only verify when remaining===0.
        const serverEct = BigInt(totalEct);
        const clientExpected = BigInt(Math.trunc(expectedTotalBaseUnits));
        if (remaining === 0 && serverEct < clientExpected) {
          throw new Error(`Server built a tx for ${serverEct} ECT but we expected ${clientExpected} — aborting.`);
        }
        await verifyTxOutput(unsignedTx, connectedAddress, Number(serverEct));
        const finalTx = await assembleSignedTx(unsignedTx, await walletApi.signTx(unsignedTx, true));
        const txHash = await walletApi.submitTx(finalTx);
        const suffix = remaining > 0 ? ` (${remaining} more to claim — click again after this confirms)` : '';
        showToast('Claimed', `${count} payouts · ${(Number(serverEct) / 1_000_000).toLocaleString()} ECT sent to your wallet.${suffix}`, 'success', { txHash });
        loadMyBets();
      } catch (err) {
        console.error('Claim-all error:', err);
        const msg = String(err?.message ?? err).split('\n')[0].slice(0, 200);
        showToast('Claim all failed', msg, 'error');
      } finally {
        unlock();
      }
    }

    async function refundBet(betUtxoRef, expectedEctBaseUnits, btn) {
      const unlock = lockBetRow(btn);
      try {
        const bettorVkh = await getPaymentKeyHash(connectedAddress);
        const walletUtxos = await decodeWalletUtxos();
        const resp = await fetch('/api/tx/refund', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ betUtxoRef, bettorAddress: connectedAddress, bettorVkh, walletUtxos }),
        });
        if (!resp.ok) { const e = await resp.json(); throw new Error(e.error); }
        const { unsignedTx } = await resp.json();
        // Audit P0-1: refund must return the staked ECT to the bettor.
        if (expectedEctBaseUnits > 0) {
          await verifyTxOutput(unsignedTx, connectedAddress, expectedEctBaseUnits);
        }
        const finalTx = await assembleSignedTx(unsignedTx, await walletApi.signTx(unsignedTx, true));
        const txHash = await walletApi.submitTx(finalTx);
        showToast('Refunded', 'Your stake has been returned.', 'success', { txHash });
        loadMyBets();
      } catch (err) {
        console.error('Refund error:', err);
        const msg = String(err?.message ?? err).split('\n')[0].slice(0, 200);
        showToast('Refund failed', msg, 'error');
      } finally {
        unlock();
      }
    }

    // Sidebar refresh button → loadMyBets. Bound via listener instead of
    // inline onclick so CSP can drop 'unsafe-inline' from script-src.
    document.getElementById('refresh-my-bets-btn')?.addEventListener('click', () => loadMyBets());

    // ── Shared wallet connection logic (connect + update UI) ──────────────────
    async function applyWalletConnection(walletName) {
      const address = await connectWallet(walletName);
      const balance = await getECTBalance();
      connectedAddress = address;
      localStorage.setItem('connectedWallet', walletName);
      document.getElementById('wallet-address').textContent =
        address.slice(0, 12) + '…' + address.slice(-6);
      document.getElementById('balance-value').textContent = `${balance.toLocaleString()} ECT`;
      document.getElementById('ect-balance').classList.remove('hidden');
      document.getElementById('ect-balance').classList.add('flex');
      document.getElementById('wallet-info').classList.remove('hidden');
      document.getElementById('wallet-info').classList.add('flex');
      const connectBtn = document.getElementById('connect-btn');
      connectBtn.textContent = 'Connected';
      connectBtn.classList.replace('bg-blue-600', 'bg-green-700');
      connectBtn.classList.replace('hover:bg-blue-500', 'hover:bg-green-600');
      loadMyBets();
    }

    // ── Init ───────────────────────────────────────────────────────────────────
    (async () => {
      try {
        markets = await loadMarkets();
        renderMarkets();
      } catch (err) {
        document.getElementById('market-grid').innerHTML =
          `<div class="col-span-full text-center py-16 text-red-400">Failed to load markets: ${escapeHtml(err && err.message ? err.message : String(err))}</div>`;
      }

      // Auto-reconnect previously connected wallet
      const saved = localStorage.getItem('connectedWallet');
      // Allowlist: only accept wallet names we actually support. Prevents an
      // XSS/localStorage tamper from pointing us at an attacker-shaped object.
      const WALLET_ALLOWLIST = ['lace','nami','eternl','flint','typhon','gerowallet','nufi','yoroi','vespr','begin'];
      if (saved && WALLET_ALLOWLIST.includes(saved) && window.cardano?.[saved]) {
        try {
          await applyWalletConnection(saved);
        } catch {
          localStorage.removeItem('connectedWallet'); // stale — clear it
        }
      }
    })();
