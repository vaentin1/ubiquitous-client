/** LZMA (LZMA1) decoding, written from the published LZMA specification,
 * for ZIP members stored with compression method 14. */

export class LzmaError extends Error {}

const PROB_INIT = 1024;
const NUM_STATES = 12;
const POS_STATES_MAX = 1 << 4;
const LEN_TO_POS_STATES = 4;
const END_POS_MODEL_INDEX = 14;
const NUM_FULL_DISTANCES = 1 << (END_POS_MODEL_INDEX >>> 1);
const ALIGN_BITS = 4;
const MATCH_MIN_LEN = 2;

export interface LzmaProps {
  lc: number;
  lp: number;
  pb: number;
  dictSize: number;
}

/** The five-byte properties block: the lc/lp/pb byte, then the dictionary size. */
export function parseProps(bytes: Uint8Array, at = 0): LzmaProps {
  if (bytes.length < at + 5) throw new LzmaError('truncated LZMA properties');
  let d = bytes[at];
  if (d >= 9 * 5 * 5) throw new LzmaError(`bad LZMA properties byte ${d}`);
  const lc = d % 9;
  d = (d / 9) | 0;
  const lp = d % 5;
  const pb = (d / 5) | 0;
  const dictSize =
    (bytes[at + 1] | (bytes[at + 2] << 8) | (bytes[at + 3] << 16) | (bytes[at + 4] << 24)) >>> 0;
  return { lc, lp, pb, dictSize };
}

class RangeDecoder {
  private range = 0xffffffff;
  private code = 0;
  pos: number;

  constructor(
    private readonly buf: Uint8Array,
    start: number,
  ) {
    if (buf.length < start + 5) throw new LzmaError('truncated LZMA stream');
    if (buf[start] !== 0) throw new LzmaError('LZMA stream does not start with a zero byte');
    this.pos = start + 1;
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.next()) >>> 0;
    if (this.code === this.range) throw new LzmaError('corrupt LZMA stream');
  }

  // Reading past the end yields zeros so a stream whose last bits sit in the
  // final byte still decodes; a corrupt stream is caught by the size checks.
  private next(): number {
    return this.pos < this.buf.length ? this.buf[this.pos++] : (this.pos++, 0);
  }

  get finishedOk(): boolean {
    return this.code === 0;
  }

  bit(probs: Uint16Array, i: number): number {
    const p = probs[i];
    const bound = (this.range >>> 11) * p;
    let bit: number;
    if (this.code < bound) {
      this.range = bound;
      probs[i] = p + ((2048 - p) >>> 5);
      bit = 0;
    } else {
      this.range = (this.range - bound) >>> 0;
      this.code = (this.code - bound) >>> 0;
      probs[i] = p - (p >>> 5);
      bit = 1;
    }
    if (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.next()) >>> 0;
    }
    return bit;
  }

  direct(numBits: number): number {
    let res = 0;
    for (; numBits > 0; numBits--) {
      this.range >>>= 1;
      let code = (this.code - this.range) >>> 0;
      const t = code >>> 31 ? 0xffffffff : 0;
      code = (code + (this.range & t)) >>> 0;
      this.code = code;
      res = ((res << 1) + (t ? 0 : 1)) >>> 0;
      if (this.range < 0x1000000) {
        this.range = (this.range << 8) >>> 0;
        this.code = ((this.code << 8) | this.next()) >>> 0;
      }
    }
    return res;
  }

  tree(probs: Uint16Array, base: number, numBits: number): number {
    let m = 1;
    for (let i = 0; i < numBits; i++) m = (m << 1) | this.bit(probs, base + m);
    return m - (1 << numBits);
  }

  reverseTree(probs: Uint16Array, base: number, numBits: number): number {
    let m = 1;
    let sym = 0;
    for (let i = 0; i < numBits; i++) {
      const b = this.bit(probs, base + m);
      m = (m << 1) | b;
      sym |= b << i;
    }
    return sym;
  }
}

class LenDecoder {
  private readonly choice = new Uint16Array(2).fill(PROB_INIT);
  private readonly low = new Uint16Array(POS_STATES_MAX << 3).fill(PROB_INIT);
  private readonly mid = new Uint16Array(POS_STATES_MAX << 3).fill(PROB_INIT);
  private readonly high = new Uint16Array(256).fill(PROB_INIT);

  decode(rc: RangeDecoder, posState: number): number {
    if (rc.bit(this.choice, 0) === 0) return rc.tree(this.low, posState << 3, 3);
    if (rc.bit(this.choice, 1) === 0) return 8 + rc.tree(this.mid, posState << 3, 3);
    return 16 + rc.tree(this.high, 0, 8);
  }
}

/**
 * Decode a raw LZMA stream that starts at `at` in `input`.
 *
 * `size` is the uncompressed size. When `endMarker` is false the stream
 * stops at `size`; when true it may also end on the end-of-stream marker.
 */
export function decodeLzma(
  input: Uint8Array,
  at: number,
  props: LzmaProps,
  size: number,
  endMarker: boolean,
): Uint8Array {
  const { lc, lp, pb } = props;
  const out = new Uint8Array(size);
  const rc = new RangeDecoder(input, at);

  const literal = new Uint16Array(0x300 << (lc + lp)).fill(PROB_INIT);
  const posSlot = new Uint16Array(LEN_TO_POS_STATES << 6).fill(PROB_INIT);
  const posSpecial = new Uint16Array(1 + NUM_FULL_DISTANCES - END_POS_MODEL_INDEX).fill(PROB_INIT);
  const align = new Uint16Array(1 << ALIGN_BITS).fill(PROB_INIT);
  const isMatch = new Uint16Array(NUM_STATES << 4).fill(PROB_INIT);
  const isRep = new Uint16Array(NUM_STATES).fill(PROB_INIT);
  const isRepG0 = new Uint16Array(NUM_STATES).fill(PROB_INIT);
  const isRepG1 = new Uint16Array(NUM_STATES).fill(PROB_INIT);
  const isRepG2 = new Uint16Array(NUM_STATES).fill(PROB_INIT);
  const isRep0Long = new Uint16Array(NUM_STATES << 4).fill(PROB_INIT);
  const lenDecoder = new LenDecoder();
  const repLenDecoder = new LenDecoder();

  const pbMask = (1 << pb) - 1;
  const lpMask = (1 << lp) - 1;
  let state = 0;
  let rep0 = 0;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;
  let pos = 0;

  for (;;) {
    if (pos === size && !endMarker) break;
    const posState = pos & pbMask;

    if (rc.bit(isMatch, (state << 4) + posState) === 0) {
      if (pos === size) throw new LzmaError('LZMA data runs past its size');
      const prev = pos > 0 ? out[pos - 1] : 0;
      const base = 0x300 * (((pos & lpMask) << lc) + (prev >>> (8 - lc)));
      let symbol = 1;
      if (state >= 7) {
        let matchByte = out[pos - rep0 - 1];
        while (symbol < 0x100) {
          const matchBit = (matchByte >>> 7) & 1;
          matchByte <<= 1;
          const bit = rc.bit(literal, base + ((1 + matchBit) << 8) + symbol);
          symbol = (symbol << 1) | bit;
          if (matchBit !== bit) break;
        }
      }
      while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(literal, base + symbol);
      out[pos++] = symbol & 0xff;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }

    let len: number;
    if (rc.bit(isRep, state) !== 0) {
      if (pos === 0) throw new LzmaError('LZMA repeat before any data');
      if (pos === size) throw new LzmaError('LZMA data runs past its size');
      if (rc.bit(isRepG0, state) === 0) {
        if (rc.bit(isRep0Long, (state << 4) + posState) === 0) {
          state = state < 7 ? 9 : 11;
          out[pos] = out[pos - rep0 - 1];
          pos++;
          continue;
        }
      } else {
        let dist: number;
        if (rc.bit(isRepG1, state) === 0) {
          dist = rep1;
        } else {
          if (rc.bit(isRepG2, state) === 0) {
            dist = rep2;
          } else {
            dist = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = dist;
      }
      len = repLenDecoder.decode(rc, posState);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      len = lenDecoder.decode(rc, posState);
      state = state < 7 ? 7 : 10;

      const lenState = len < LEN_TO_POS_STATES - 1 ? len : LEN_TO_POS_STATES - 1;
      const slot = rc.tree(posSlot, lenState << 6, 6);
      if (slot < 4) {
        rep0 = slot;
      } else {
        const directBits = (slot >>> 1) - 1;
        let dist = ((2 | (slot & 1)) << directBits) >>> 0;
        if (slot < END_POS_MODEL_INDEX) {
          dist += rc.reverseTree(posSpecial, dist - slot, directBits);
        } else {
          dist += rc.direct(directBits - ALIGN_BITS) << ALIGN_BITS;
          dist += rc.reverseTree(align, 0, ALIGN_BITS);
        }
        rep0 = dist >>> 0;
      }
      if (rep0 === 0xffffffff) {
        if (!endMarker) throw new LzmaError('unexpected LZMA end marker');
        if (pos !== size) throw new LzmaError('LZMA end marker before the stated size');
        break;
      }
      if (pos === size) throw new LzmaError('LZMA data runs past its size');
      if (rep0 >= pos) throw new LzmaError('LZMA distance reaches before the start');
    }

    len += MATCH_MIN_LEN;
    if (len > size - pos) throw new LzmaError('LZMA match runs past its size');
    // Byte by byte: a match may overlap the bytes it is producing.
    let from = pos - rep0 - 1;
    const end = pos + len;
    while (pos < end) out[pos++] = out[from++];
  }

  return out;
}

/** ZIP method 14 framing: version (2 bytes), properties size (2), properties, stream. */
export function decodeZipLzma(data: Uint8Array, size: number, endMarker: boolean): Uint8Array {
  if (data.length < 4) throw new LzmaError('truncated LZMA header');
  const propsSize = data[2] | (data[3] << 8);
  if (propsSize !== 5) throw new LzmaError(`unexpected LZMA properties size ${propsSize}`);
  const props = parseProps(data, 4);
  return decodeLzma(data, 9, props, size, endMarker);
}
