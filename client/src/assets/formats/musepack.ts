/*! @license
  The frame decoder below (bit reading, Huffman tables, requantisation and
  synthesis) is a TypeScript port of libmpcdec r475:

  Copyright (c) 2005-2009, The Musepack Development Team
  All rights reserved.

  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions are
  met:

  * Redistributions of source code must retain the above copyright
  notice, this list of conditions and the following disclaimer.

  * Redistributions in binary form must reproduce the above
  copyright notice, this list of conditions and the following
  disclaimer in the documentation and/or other materials provided
  with the distribution.

  * Neither the name of the The Musepack Development Team nor the
  names of its contributors may be used to endorse or promote
  products derived from this software without specific prior
  written permission.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
  "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
  LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
  A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
  OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
  SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
  LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
  DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
  THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
  OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

/**
 * Musepack SV8 (`MPCK`) to one Float32Array per channel; browsers do not
 * decode Musepack. The packet container follows the public SV8
 * specification; the audio frames inside `AP` packets are specified only by
 * the reference decoder, so that part is a port of libmpcdec (BSD-3-Clause,
 * notice above), in its floating-point build.
 */

import type { PcmData } from './wav';

export class MpcError extends Error {}

/** What the stream header (`SH`) says. */
export interface MpcHeader {
  sampleRate: number;
  channels: number;
  /** Samples per channel in the stream, before the leading silence is dropped. */
  samples: number;
  /** Samples at the start the encoder added and a player drops. */
  beginSilence: number;
  /** How many of the 32 sub-bands the stream may use. */
  bands: number;
  midSide: boolean;
  /** Frames in each audio packet. */
  framesPerPacket: number;
}

/** Samples per channel in one frame: 36 per sub-band, 32 sub-bands. */
const FRAME = 1152;
/** How many samples the synthesis filter bank lags its input. */
const SYNTH_DELAY = 481;
const RATES = [44100, 48000, 37800, 32000];

interface Packet {
  key: string;
  /** The payload, after key and size. */
  start: number;
  end: number;
}

/** Whether `bytes` opens with the SV8 magic. */
export function isMusepack(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x4d &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x43 &&
    bytes[3] === 0x4b
  );
}

/** Every packet up to and including `SE`; what follows it is tags, not stream. */
function packets(bytes: Uint8Array): Packet[] {
  if (!isMusepack(bytes)) {
    throw new MpcError('not a Musepack SV8 stream');
  }
  const out: Packet[] = [];
  for (let at = 4; ; ) {
    if (at + 3 > bytes.length) throw new MpcError('stream ends before its SE packet');
    const k0 = bytes[at];
    const k1 = bytes[at + 1];
    if (k0 < 65 || k0 > 90 || k1 < 65 || k1 > 90) throw new MpcError(`bad packet key at ${at}`);
    let p = at + 2;
    let size = 0;
    let byte: number;
    do {
      if (p >= bytes.length) throw new MpcError(`packet size runs off the end at ${at}`);
      byte = bytes[p++];
      size = size * 128 + (byte & 0x7f);
    } while (byte & 0x80);
    // The size counts the key and itself.
    if (size < p - at || at + size > bytes.length) {
      throw new MpcError(`packet at ${at} claims ${size} bytes`);
    }
    const key = String.fromCharCode(k0, k1);
    out.push({ key, start: p, end: at + size });
    if (key === 'SE') return out;
    at += size;
  }
}

/** Unsigned base-128 number, high group first, continuation in the top bit. */
function readVarint(bytes: Uint8Array, at: number, end: number): [number, number] {
  let value = 0;
  let byte: number;
  do {
    if (at >= end) throw new MpcError('header field runs off its packet');
    byte = bytes[at++];
    value = value * 128 + (byte & 0x7f);
  } while (byte & 0x80);
  return [value, at];
}

let crcTable: Uint32Array | null = null;

/** CRC-32 as PNG defines it, which the SV8 specification names for `SH`. */
function crc32(bytes: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function parseHeader(bytes: Uint8Array, sh: Packet): MpcHeader {
  if (sh.end - sh.start < 8) throw new MpcError('SH packet too short');
  const stored =
    ((bytes[sh.start] << 24) |
      (bytes[sh.start + 1] << 16) |
      (bytes[sh.start + 2] << 8) |
      bytes[sh.start + 3]) >>>
    0;
  if (stored !== crc32(bytes, sh.start + 4, sh.end)) throw new MpcError('SH checksum mismatch');
  let at = sh.start + 4;
  const version = bytes[at++];
  if (version !== 8) throw new MpcError(`stream version ${version}`);
  let samples: number;
  let beginSilence: number;
  [samples, at] = readVarint(bytes, at, sh.end);
  [beginSilence, at] = readVarint(bytes, at, sh.end);
  if (at + 2 > sh.end) throw new MpcError('SH packet too short');
  const bits = (bytes[at] << 8) | bytes[at + 1];
  const header: MpcHeader = {
    sampleRate: RATES[bits >> 13] ?? 0,
    bands: ((bits >> 8) & 31) + 1,
    channels: ((bits >> 4) & 15) + 1,
    midSide: ((bits >> 3) & 1) === 1,
    framesPerPacket: 1 << ((bits & 7) * 2),
    samples,
    beginSilence,
  };
  // The limits the reference decoder holds a stream to.
  if (!header.sampleRate) throw new MpcError(`sample rate code ${bits >> 13}`);
  if (header.bands >= 32) throw new MpcError(`${header.bands} bands`);
  if (header.channels > 2) throw new MpcError(`${header.channels} channels`);
  if (!samples) throw new MpcError('stream of unknown length');
  if (beginSilence > samples) throw new MpcError('more leading silence than samples');
  return header;
}

/** Read the stream header alone. Throws `MpcError` on anything it cannot read. */
export function readMpcHeader(bytes: Uint8Array): MpcHeader {
  const sh = packets(bytes).find(p => p.key === 'SH');
  if (!sh) throw new MpcError('no SH packet');
  return parseHeader(bytes, sh);
}

/** Decode a whole SV8 stream. Throws `MpcError` on anything it cannot read. */
export function decodeMpc(bytes: Uint8Array): PcmData {
  const list = packets(bytes);
  const shIndex = list.findIndex(p => p.key === 'SH');
  if (shIndex < 0) throw new MpcError('no SH packet');
  const header = parseHeader(bytes, list[shIndex]);
  const audio = list.slice(shIndex + 1).filter(p => p.key === 'AP');

  const length = header.samples - header.beginSilence;
  const channels = Array.from({ length: header.channels }, () => new Float32Array(length));
  const decoder = new FrameDecoder(header);
  // Output lags the stream by the filter bank's delay; the delayed start and
  // the encoder's own leading silence are both dropped.
  let skip = SYNTH_DELAY + header.beginSilence;
  const wanted = header.samples + SYNTH_DELAY;
  let decoded = 0;
  let written = 0;

  for (const packet of audio) {
    if (decoded >= wanted) break;
    // The huffman readers look 16 bits ahead of what they take, and the last
    // frame may end in the packet's final byte.
    const payload = new Uint8Array(packet.end - packet.start + 4);
    payload.set(bytes.subarray(packet.start, packet.end));
    const reader = new BitReader(payload);
    const limit = (packet.end - packet.start) * 8;
    let frames = 0;
    for (; frames < header.framesPerPacket && decoded < wanted; frames++) {
      decoder.frame(reader, frames === 0);
      if (reader.pos > limit) throw new MpcError('frame reads past its packet');
      decoded += FRAME;
      let take = Math.min(FRAME, wanted - (decoded - FRAME));
      let from = 0;
      if (skip) {
        const dropped = Math.min(skip, take);
        skip -= dropped;
        from = dropped;
        take -= dropped;
      }
      take = Math.min(take, length - written);
      for (let c = 0; c < header.channels; c++) {
        const src = decoder.out[c];
        const dst = channels[c];
        for (let i = 0; i < take; i++) {
          const v = src[from + i];
          dst[written + i] = v > 1 ? 1 : v < -1 ? -1 : v;
        }
      }
      written += take;
    }
    // A full packet is a whole number of bytes: anything more than padding
    // left over means the frames were misread.
    if (frames === header.framesPerPacket && limit - reader.pos > 7) {
      throw new MpcError('frames end short of their packet');
    }
  }
  if (written < length) throw new MpcError(`stream holds ${written} of ${length} samples`);
  return { sampleRate: header.sampleRate, channels };
}

// — bit reading ---------------------------------------------------------------

/** Most significant bit first, as libmpcdec reads. */
class BitReader {
  pos = 0;

  constructor(private readonly data: Uint8Array) {}

  /** Up to 24 bits. */
  read(n: number): number {
    if (n === 0) return 0;
    const d = this.data;
    const at = this.pos >> 3;
    const word = ((d[at] << 24) | (d[at + 1] << 16) | (d[at + 2] << 8) | d[at + 3]) >>> 0;
    const value = ((word << (this.pos & 7)) >>> 0) >>> (32 - n);
    this.pos += n;
    return value;
  }

  /** Up to 32 bits. */
  readLong(n: number): number {
    return n > 24 ? this.read(n - 16) * 65536 + this.read(16) : this.read(n);
  }

  /** The next 16 bits, left in place. */
  peek16(): number {
    const d = this.data;
    const at = this.pos >> 3;
    return (((d[at] << 16) | (d[at + 1] << 8) | d[at + 2]) >>> (8 - (this.pos & 7))) & 0xffff;
  }

  /** A canonical Huffman code, as `mpc_bits_can_dec`. */
  canonical(t: Canonical): number {
    const code = this.peek16();
    let i = 0;
    while (code < t.codes[i]) i++;
    const len = t.lengths[i];
    this.pos += len;
    return t.symbols[(t.offsets[i] - (code >> (16 - len))) & 0xff];
  }

  /** A number in 0..max, as `mpc_bits_log_dec`. */
  bounded(max: number): number {
    if (max === 0) return 0;
    const bits = LOG2[max - 1];
    let value = bits > 1 ? this.read(bits - 1) : 0;
    if (value >= LOG2_LOST[max - 1]) value = ((value << 1) | this.read(1)) - LOG2_LOST[max - 1];
    return value;
  }

  /** Which `k` of `n` positions are set, as `mpc_bits_enum_dec`; bit i is position i. */
  combination(k: number, n: number): number {
    let row = k - 1;
    let code = this.readLong(CNK_LEN[row][n - 1] - 1);
    const lost = CNK_LOST[row][n - 1];
    if (code >= lost) code = code * 2 + this.read(1) - lost;
    let bits = 0;
    do {
      n--;
      if (code >= CNK[row][n]) {
        bits |= 1 << n;
        code -= CNK[row][n];
        row--;
        k--;
      }
    } while (k > 0);
    return bits;
  }
}

// — tables, from libmpcdec ------------------------------------------------------

/**
 * A canonical Huffman table: each entry's 16-bit left-aligned first code,
 * longest codes last, with its length and the offset that turns a code into
 * an index into `symbols`.
 */
interface Canonical {
  codes: Uint16Array;
  lengths: Uint8Array;
  offsets: Int16Array;
  symbols: Int8Array;
}

function table(entries: number[], symbols: number[]): Canonical {
  const n = entries.length / 3;
  const t: Canonical = {
    codes: new Uint16Array(n),
    lengths: new Uint8Array(n),
    offsets: new Int16Array(n),
    symbols: Int8Array.from(symbols),
  };
  for (let i = 0; i < n; i++) {
    t.codes[i] = entries[i * 3];
    t.lengths[i] = entries[i * 3 + 1];
    t.offsets[i] = entries[i * 3 + 2];
  }
  return t;
}

const SCFI_1 = table([0x8000, 1, 1, 0x4000, 2, 2, 0x0, 3, 3], [2, 3, 1, 0]);
const SCFI_2 = table(
  [0x8000, 2, 3, 0x4000, 3, 5, 0x1800, 5, 11, 0x400, 6, 14, 0x0, 7, 15],
  [15, 10, 14, 11, 13, 9, 7, 6, 5, 12, 8, 3, 2, 0, 4, 1],
);
const DSCF_1 = table(
  [
    0xa000, 3, 7, 0x4000, 4, 12, 0x2800, 5, 16, 0x1800, 6, 21, 0xe00, 7, 27, 0x700, 8, 34, 0x380, 9,
    41, 0x140, 10, 48, 0x80, 11, 53, 0x30, 12, 57, 0x18, 13, 60, 0x0, 14, 63,
  ],
  [
    35, 34, 33, 36, 32, 30, 29, 27, 26, 37, 28, 25, 39, 38, 24, 23, 40, 22, 21, 20, 19, 43, 42, 41,
    18, 17, 16, 15, 46, 45, 44, 14, 13, 12, 11, 49, 48, 47, 31, 10, 9, 8, 7, 6, 52, 51, 50, 5, 4, 3,
    54, 53, 2, 1, 0, 57, 56, 55, 63, 62, 61, 60, 59, 58,
  ],
);
const DSCF_2 = table(
  [
    0x6000, 3, 7, 0x3000, 4, 10, 0x1800, 5, 13, 0x1000, 6, 16, 0xa00, 7, 20, 0x600, 8, 25, 0x380, 9,
    31, 0x1c0, 10, 38, 0xe0, 11, 45, 0x50, 12, 52, 0x20, 13, 57, 0xc, 14, 61, 0x0, 15, 64,
  ],
  [
    33, 32, 31, 30, 29, 34, 28, 27, 36, 35, 26, 37, 25, 38, 24, 23, 40, 39, 22, 21, 42, 41, 20, 19,
    18, 45, 44, 43, 17, 16, 15, 14, 48, 47, 46, 13, 12, 11, 10, 64, 52, 51, 50, 49, 9, 8, 7, 6, 55,
    54, 53, 5, 4, 3, 58, 57, 56, 2, 1, 63, 62, 61, 60, 59, 0,
  ],
);
const BANDS = table(
  [
    0x8000, 1, 1, 0x4000, 2, 2, 0x2000, 3, 3, 0x1000, 5, 6, 0x800, 6, 8, 0x600, 7, 10, 0x300, 8, 13,
    0x200, 9, 16, 0x140, 10, 20, 0xc0, 11, 25, 0x10, 12, 31, 0x0, 13, 32,
  ],
  [
    0, 32, 1, 31, 2, 30, 3, 4, 29, 6, 5, 28, 7, 27, 26, 8, 25, 24, 23, 9, 22, 21, 20, 18, 17, 16,
    15, 14, 12, 11, 10, 19, 13,
  ],
);
const RES_1 = table(
  [
    0x8000, 1, 1, 0x4000, 2, 2, 0x2000, 3, 3, 0x1000, 4, 4, 0x800, 5, 5, 0x400, 6, 6, 0x200, 7, 7,
    0x100, 8, 8, 0x80, 9, 9, 0x40, 10, 10, 0x20, 11, 11, 0x10, 12, 12, 0x8, 13, 13, 0x4, 14, 14,
    0x2, 15, 15, 0x0, 16, 16,
  ],
  [0, 1, 16, 2, 3, 4, 5, 15, 6, 7, 8, 9, 10, 11, 12, 14, 13],
);
const RES_2 = table(
  [
    0x4000, 2, 3, 0x2000, 3, 4, 0x1000, 4, 5, 0x800, 5, 6, 0x400, 6, 7, 0x200, 7, 8, 0x100, 8, 9,
    0x80, 9, 10, 0x40, 10, 11, 0x20, 11, 12, 0x10, 12, 13, 0x0, 14, 16,
  ],
  [16, 1, 0, 2, 15, 3, 14, 4, 5, 13, 6, 12, 7, 11, 10, 9, 8],
);
const Q1 = table(
  [
    0x6000, 3, 7, 0x1000, 4, 10, 0x800, 5, 11, 0x400, 6, 12, 0x200, 7, 13, 0x100, 8, 14, 0x80, 9,
    15, 0x40, 10, 16, 0x20, 11, 17, 0x0, 12, 18,
  ],
  [7, 6, 5, 4, 3, 10, 9, 8, 2, 1, 11, 0, 12, 13, 14, 15, 16, 18, 17],
);
const Q2_1 = table(
  [
    0xe000, 3, 7, 0x8000, 4, 14, 0x3c00, 6, 38, 0x2a00, 7, 53, 0x1200, 8, 74, 0x600, 9, 92, 0x3c0,
    10, 104, 0x60, 11, 119, 0x20, 12, 122, 0x0, 13, 124,
  ],
  [
    62, 87, 67, 63, 61, 57, 37, 93, 92, 88, 86, 83, 82, 81, 68, 66, 58, 56, 42, 41, 38, 36, 32, 31,
    112, 91, 72, 64, 60, 52, 43, 33, 12, 117, 113, 111, 107, 97, 89, 85, 77, 73, 71, 69, 65, 59, 55,
    53, 51, 47, 39, 35, 27, 17, 13, 11, 7, 118, 116, 108, 106, 98, 96, 94, 90, 84, 80, 78, 76, 48,
    46, 44, 40, 34, 30, 28, 26, 18, 16, 8, 6, 122, 110, 102, 74, 70, 54, 50, 22, 2, 123, 121, 119,
    115, 114, 109, 105, 103, 101, 99, 95, 79, 75, 49, 45, 29, 25, 23, 21, 19, 15, 14, 10, 9, 5, 3,
    1, 124, 104, 20, 0, 120, 100, 24, 4,
  ],
);
const Q2_2 = table(
  [
    0xf000, 4, 15, 0x7000, 5, 30, 0x4800, 6, 44, 0x3c00, 7, 62, 0xc00, 8, 92, 0x780, 9, 104, 0xc0,
    10, 119, 0x40, 11, 122, 0x0, 12, 124,
  ],
  [
    62, 92, 87, 86, 82, 68, 67, 66, 63, 61, 58, 57, 56, 42, 38, 37, 32, 93, 91, 88, 83, 81, 43, 41,
    36, 33, 31, 112, 72, 64, 60, 52, 12, 118, 117, 116, 113, 111, 108, 107, 106, 98, 97, 96, 94, 90,
    89, 85, 84, 80, 78, 77, 76, 73, 71, 69, 65, 59, 55, 53, 51, 48, 47, 46, 44, 40, 39, 35, 34, 30,
    28, 27, 26, 18, 17, 16, 13, 11, 8, 7, 6, 122, 110, 74, 70, 54, 50, 22, 14, 2, 123, 121, 119,
    115, 114, 109, 105, 103, 102, 101, 99, 95, 79, 75, 49, 45, 29, 25, 23, 21, 19, 15, 10, 9, 5, 3,
    1, 124, 104, 20, 0, 120, 100, 24, 4,
  ],
);
const Q3 = table(
  [
    0xe000, 3, 7, 0x8000, 4, 14, 0x5000, 5, 22, 0x2400, 6, 32, 0xa00, 7, 41, 0x200, 8, 46, 0x0, 9,
    48,
  ],
  [
    0, 17, 16, 1, 15, -16, -1, 32, 31, 2, 14, -15, -32, 34, 33, 47, 46, 18, 30, -14, -2, -31, -17,
    -18, 49, 48, 63, 19, 29, 3, 13, -13, -3, -30, -47, -48, -33, 50, 62, 35, 45, -29, -19, -46, -34,
    51, 61, -45, -35,
  ],
);
const Q4 = table(
  [
    0xf000, 4, 15, 0x9000, 5, 30, 0x3400, 6, 48, 0x1800, 7, 61, 0x500, 8, 73, 0x100, 9, 78, 0x0, 10,
    80, 0x0, 0, 90,
  ],
  [
    0, 32, 17, 16, 31, 2, 1, 15, 14, -15, -16, -1, -32, 49, 48, 34, 33, 47, 46, 19, 18, 30, 29, 3,
    13, -13, -14, -2, -3, -30, -31, -17, -18, -47, -48, -33, 64, 50, 63, 62, 35, 45, 4, 12, -29,
    -19, -46, -34, -64, -49, 66, 65, 79, 78, 51, 61, 36, 44, 20, 28, -12, -4, -28, -20, -45, -35,
    -62, -63, -50, 67, 77, 52, 60, -44, -36, -61, -51, 68, 76, -60, -52, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0,
  ],
);
const Q5_1 = table(
  [0xc000, 2, 3, 0x4000, 3, 6, 0x2000, 4, 8, 0x1000, 5, 10, 0x800, 6, 12, 0x0, 7, 14],
  [0, 2, 1, -1, -2, 3, -3, 4, -4, 5, -5, 7, 6, -6, -7],
);
const Q5_2 = table(
  [0x6000, 3, 7, 0x2000, 4, 10, 0x1000, 5, 12, 0x0, 6, 14],
  [2, 1, 0, -1, -2, 4, 3, -3, -4, 5, -5, 7, 6, -6, -7],
);
const Q6_1 = table(
  [
    0xc000, 2, 3, 0x8000, 3, 6, 0x4000, 4, 10, 0x2800, 5, 14, 0xc00, 6, 19, 0x800, 7, 22, 0x400, 8,
    26, 0x0, 9, 30,
  ],
  [
    0, 1, -1, 3, 2, -2, -3, 4, -4, -5, 8, 7, 6, 5, -6, -7, -8, 9, -9, 11, 10, -10, -11, 15, 14, 13,
    12, -12, -13, -14, -15,
  ],
);
const Q6_2 = table(
  [0x5000, 4, 15, 0x2000, 5, 20, 0x1000, 6, 24, 0x400, 7, 28, 0x0, 8, 30],
  [
    5, 4, 3, 2, 1, 0, -1, -2, -3, -4, -5, 8, 7, 6, -6, -7, -8, 10, 9, -9, -10, 13, 12, 11, -11, -12,
    -13, 15, 14, -14, -15,
  ],
);
const Q7_1 = table(
  [
    0xc000, 2, 3, 0x8000, 3, 6, 0x6000, 4, 10, 0x4000, 5, 16, 0x2800, 6, 24, 0x1400, 7, 34, 0xa00,
    8, 44, 0x400, 9, 54, 0x0, 10, 62,
  ],
  [
    0, 1, -1, 2, -2, 4, 3, -3, -4, 7, 6, 5, -5, -6, -7, 13, 11, 10, 9, 8, -8, -9, -10, -11, -12, 17,
    16, 15, 14, 12, -13, -14, -15, -16, -17, 28, 27, 21, 20, 19, 18, -18, -19, -20, -21, -27, -28,
    31, 30, 29, 26, 25, 24, 23, 22, -22, -23, -24, -25, -26, -29, -30, -31,
  ],
);
const Q7_2 = table(
  [0x6000, 5, 31, 0x2400, 6, 43, 0x1000, 7, 52, 0x200, 8, 60, 0x0, 9, 62],
  [
    10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, -1, -2, -3, -4, -5, -6, -7, -8, -9, 17, 16, 15, 14, 13, 12,
    11, -10, -11, -12, -13, -14, -15, -16, -17, 22, 21, 20, 19, 18, -18, -19, -20, -21, -22, 29, 28,
    27, 26, 25, 24, 23, -23, -24, -25, -26, -27, -28, -29, 31, 30, -30, -31,
  ],
);
const Q8_1 = table(
  [
    0xc000, 2, 3, 0x8000, 3, 6, 0x7000, 4, 10, 0x5800, 5, 17, 0x3800, 6, 28, 0x2800, 7, 42, 0x1900,
    8, 62, 0xd00, 9, 87, 0x280, 10, 113, 0x60, 11, 123, 0x0, 12, 126,
  ],
  [
    0, 1, -1, -2, 3, 2, -3, 7, 6, 5, 4, -4, -5, -6, -7, 11, 10, 9, 8, -8, -9, -10, -11, 19, 18, 17,
    16, 15, 14, 13, 12, -12, -13, -14, -15, -16, -17, -19, 56, 55, 31, 28, 27, 26, 25, 24, 23, 22,
    21, 20, -18, -20, -21, -22, -23, -24, -25, -26, -27, -33, -54, -56, 63, 62, 61, 60, 59, 58, 57,
    54, 53, 43, 40, 39, 38, 37, 36, 35, 34, 33, 32, 30, 29, -28, -29, -30, -31, -32, -34, -35, -36,
    -37, -38, -39, -40, -41, -43, -53, -55, -57, -58, -59, -60, -61, 49, 47, 46, 45, 44, 42, 41,
    -42, -44, -45, -46, -47, -48, -49, -50, -62, -63, 52, 51, 50, 48, -51, -52,
  ],
);
const Q8_2 = table(
  [0x9800, 6, 63, 0x2a00, 7, 101, 0x400, 8, 122, 0x0, 9, 126],
  [
    13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, -1, -2, -3, -4, -5, -6, -7, -8, -9, -10, -11, -12,
    -13, 39, 38, 37, 36, 35, 34, 33, 32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17,
    16, 15, 14, 12, -14, -15, -16, -17, -18, -19, -20, -21, -22, -23, -24, -25, -26, -27, -28, -29,
    -30, -31, -32, -33, -34, -35, -36, -37, -38, -39, -40, -41, 59, 58, 57, 56, 55, 54, 53, 52, 51,
    50, 49, 48, 47, 46, 45, 44, 43, 42, 41, 40, -42, -43, -44, -45, -46, -47, -48, -49, -50, -51,
    -52, -53, -54, -55, -56, -57, -58, -59, 63, 62, 61, 60, -60, -61, -62, -63,
  ],
);
const Q9_UP = table(
  [0xf800, 6, 63, 0xac00, 7, 125, 0x2600, 8, -45, 0x280, 9, -7, 0x40, 10, -2, 0x0, 11, -1],
  [
    -128, 127, -108, -110, -111, -112, -113, -114, -115, -116, -117, -118, -119, -120, -121, -122,
    -123, -124, -125, -126, -127, 126, 125, 124, 123, 122, 121, 120, 119, 118, 117, 116, 115, 114,
    113, 112, 111, 110, 109, 108, -44, -45, -46, -47, -48, -49, -50, -51, -52, -53, -54, -55, -56,
    -57, -58, -59, -60, -61, -62, -63, -64, -65, -66, -67, -68, -69, -70, -71, -72, -73, -74, -75,
    -76, -77, -78, -79, -80, -81, -82, -83, -84, -85, -86, -87, -88, -89, -90, -91, -92, -93, -94,
    -95, -96, -97, -98, -99, -100, -101, -102, -103, -104, -105, -106, -107, -109, 107, 106, 105,
    104, 103, 102, 101, 100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86, 85, 84, 83, 82,
    81, 80, 79, 78, 77, 76, 75, 74, 73, 72, 71, 70, 69, 68, 67, 66, 65, 64, 63, 62, 61, 60, 59, 58,
    57, 56, 55, 54, 53, 52, 51, 50, 49, 48, 47, 46, 45, 44, 43, 42, 40, 20, 19, -7, -8, -9, -10,
    -11, -12, -13, -14, -15, -16, -17, -18, -19, -20, -21, -22, -23, -24, -25, -26, -27, -28, -29,
    -30, -31, -32, -33, -34, -35, -36, -37, -38, -39, -40, -41, -42, -43, 41, 39, 38, 37, 36, 35,
    34, 33, 32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9,
    8, 7, 6, 5, -3, -4, -5, -6, 4, 3, 2, 1, 0, -1, -2,
  ],
);

const Q5_TO_8: [Canonical, Canonical][] = [
  [Q5_1, Q5_2],
  [Q6_1, Q6_2],
  [Q7_1, Q7_2],
  [Q8_1, Q8_2],
];

/**
 * `Cnk`: row k-1, column n is the number of ways to choose k of n. With
 * `CNK_LEN` (bits in a code) and `CNK_LOST` (codes left unused), as the
 * reference holds them. The reference's last `CNK_LOST` row is one entry
 * short and so ends in 0; it is kept that way, since the encoder's tables
 * decide what a stream means.
 */
const CNK = [
  [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
    26, 27, 28, 29, 30, 31,
  ],
  [
    0, 0, 1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 66, 78, 91, 105, 120, 136, 153, 171, 190, 210, 231,
    253, 276, 300, 325, 351, 378, 406, 435, 465,
  ],
  [
    0, 0, 0, 1, 4, 10, 20, 35, 56, 84, 120, 165, 220, 286, 364, 455, 560, 680, 816, 969, 1140, 1330,
    1540, 1771, 2024, 2300, 2600, 2925, 3276, 3654, 4060, 4495,
  ],
  [
    0, 0, 0, 0, 1, 5, 15, 35, 70, 126, 210, 330, 495, 715, 1001, 1365, 1820, 2380, 3060, 3876, 4845,
    5985, 7315, 8855, 10626, 12650, 14950, 17550, 20475, 23751, 27405, 31465,
  ],
  [
    0, 0, 0, 0, 0, 1, 6, 21, 56, 126, 252, 462, 792, 1287, 2002, 3003, 4368, 6188, 8568, 11628,
    15504, 20349, 26334, 33649, 42504, 53130, 65780, 80730, 98280, 118755, 142506, 169911,
  ],
  [
    0, 0, 0, 0, 0, 0, 1, 7, 28, 84, 210, 462, 924, 1716, 3003, 5005, 8008, 12376, 18564, 27132,
    38760, 54264, 74613, 100947, 134596, 177100, 230230, 296010, 376740, 475020, 593775, 736281,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 1, 8, 36, 120, 330, 792, 1716, 3432, 6435, 11440, 19448, 31824, 50388,
    77520, 116280, 170544, 245157, 346104, 480700, 657800, 888030, 1184040, 1560780, 2035800,
    2629575,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 9, 45, 165, 495, 1287, 3003, 6435, 12870, 24310, 43758, 75582,
    125970, 203490, 319770, 490314, 735471, 1081575, 1562275, 2220075, 3108105, 4292145, 5852925,
    7888725,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 10, 55, 220, 715, 2002, 5005, 11440, 24310, 48620, 92378, 167960,
    293930, 497420, 817190, 1307504, 2042975, 3124550, 4686825, 6906900, 10015005, 14307150,
    20160075,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 11, 66, 286, 1001, 3003, 8008, 19448, 43758, 92378, 184756,
    352716, 646646, 1144066, 1961256, 3268760, 5311735, 8436285, 13123110, 20030010, 30045015,
    44352165,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 12, 78, 364, 1365, 4368, 12376, 31824, 75582, 167960,
    352716, 705432, 1352078, 2496144, 4457400, 7726160, 13037895, 21474180, 34597290, 54627300,
    84672315,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 13, 91, 455, 1820, 6188, 18564, 50388, 125970, 293930,
    646646, 1352078, 2704156, 5200300, 9657700, 17383860, 30421755, 51895935, 86493225, 141120525,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 14, 105, 560, 2380, 8568, 27132, 77520, 203490,
    497420, 1144066, 2496144, 5200300, 10400600, 20058300, 37442160, 67863915, 119759850, 206253075,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 15, 120, 680, 3060, 11628, 38760, 116280, 319770,
    817190, 1961256, 4457400, 9657700, 20058300, 40116600, 77558760, 145422675, 265182525,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 16, 136, 816, 3876, 15504, 54264, 170544,
    490314, 1307504, 3268760, 7726160, 17383860, 37442160, 77558760, 155117520, 300540195,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 17, 153, 969, 4845, 20349, 74613, 245157,
    735471, 2042975, 5311735, 13037895, 30421755, 67863915, 145422675, 300540195,
  ],
];
const CNK_LEN = [
  [0, 1, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
  [0, 0, 2, 3, 4, 4, 5, 5, 6, 6, 6, 7, 7, 7, 7, 7, 8, 8, 8, 8, 8, 8, 8, 9, 9, 9, 9, 9, 9, 9, 9, 9],
  [
    0, 0, 0, 2, 4, 5, 6, 6, 7, 7, 8, 8, 9, 9, 9, 10, 10, 10, 10, 11, 11, 11, 11, 11, 12, 12, 12, 12,
    12, 12, 13, 13,
  ],
  [
    0, 0, 0, 0, 3, 4, 6, 7, 7, 8, 9, 9, 10, 10, 11, 11, 12, 12, 12, 13, 13, 13, 14, 14, 14, 14, 15,
    15, 15, 15, 15, 16,
  ],
  [
    0, 0, 0, 0, 0, 3, 5, 6, 7, 8, 9, 10, 11, 11, 12, 13, 13, 14, 14, 14, 15, 15, 16, 16, 16, 17, 17,
    17, 17, 18, 18, 18,
  ],
  [
    0, 0, 0, 0, 0, 0, 3, 5, 7, 8, 9, 10, 11, 12, 13, 13, 14, 15, 15, 16, 16, 17, 17, 18, 18, 18, 19,
    19, 19, 20, 20, 20,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 3, 6, 7, 9, 10, 11, 12, 13, 14, 15, 15, 16, 17, 17, 18, 18, 19, 19, 20, 20,
    21, 21, 21, 22, 22,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 4, 6, 8, 9, 11, 12, 13, 14, 15, 16, 17, 17, 18, 19, 19, 20, 21, 21, 22,
    22, 23, 23, 23, 24,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 6, 8, 10, 11, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 21, 22, 23,
    23, 24, 24, 25, 25,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 7, 9, 10, 12, 13, 15, 16, 17, 18, 19, 20, 21, 21, 22, 23, 24,
    24, 25, 25, 26, 26,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 7, 9, 11, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 23, 24,
    25, 26, 26, 27, 27,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 7, 9, 11, 13, 15, 16, 17, 19, 20, 21, 22, 23, 24, 25, 25,
    26, 27, 28, 28,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 7, 10, 12, 14, 15, 17, 18, 19, 21, 22, 23, 24, 25, 26,
    27, 27, 28, 29,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 7, 10, 12, 14, 16, 17, 19, 20, 21, 23, 24, 25, 26,
    27, 28, 28, 29,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 8, 10, 12, 14, 16, 18, 19, 21, 22, 23, 25, 26,
    27, 28, 29, 30,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 8, 10, 13, 15, 17, 18, 20, 21, 23, 24, 25,
    27, 28, 29, 30,
  ],
];
const CNK_LOST = [
  [
    0, 0, 1, 0, 3, 2, 1, 0, 7, 6, 5, 4, 3, 2, 1, 0, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2,
    1, 0,
  ],
  [
    0, 0, 1, 2, 6, 1, 11, 4, 28, 19, 9, 62, 50, 37, 23, 8, 120, 103, 85, 66, 46, 25, 3, 236, 212,
    187, 161, 134, 106, 77, 47, 16,
  ],
  [
    0, 0, 0, 0, 6, 12, 29, 8, 44, 8, 91, 36, 226, 148, 57, 464, 344, 208, 55, 908, 718, 508, 277,
    24, 1796, 1496, 1171, 820, 442, 36, 3697, 3232,
  ],
  [
    0, 0, 0, 0, 3, 1, 29, 58, 2, 46, 182, 17, 309, 23, 683, 228, 1716, 1036, 220, 3347, 2207, 877,
    7529, 5758, 3734, 1434, 15218, 12293, 9017, 5363, 1303, 29576,
  ],
  [
    0, 0, 0, 0, 0, 2, 11, 8, 2, 4, 50, 232, 761, 46, 1093, 3824, 2004, 7816, 4756, 880, 12419, 6434,
    31887, 23032, 12406, 65292, 50342, 32792, 12317, 119638, 92233, 60768,
  ],
  [
    0, 0, 0, 0, 0, 0, 1, 4, 44, 46, 50, 100, 332, 1093, 3187, 184, 4008, 14204, 5636, 26776, 11272,
    56459, 30125, 127548, 85044, 31914, 228278, 147548, 49268, 454801, 312295, 142384,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 28, 8, 182, 232, 332, 664, 1757, 4944, 13320, 944, 15148, 53552, 14792,
    91600, 16987, 178184, 43588, 390776, 160546, 913112, 536372, 61352, 1564729, 828448,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 7, 19, 91, 17, 761, 1093, 1757, 3514, 8458, 21778, 55490, 5102, 58654,
    204518, 33974, 313105, 1015577, 534877, 1974229, 1086199, 4096463, 2535683, 499883, 6258916,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 9, 36, 309, 46, 3187, 4944, 8458, 16916, 38694, 94184, 230358,
    26868, 231386, 789648, 54177, 1069754, 3701783, 1481708, 6762211, 2470066, 13394357, 5505632,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 62, 226, 23, 1093, 184, 13320, 21778, 38694, 77388, 171572,
    401930, 953086, 135896, 925544, 3076873, 8340931, 3654106, 13524422, 3509417, 22756699, 2596624,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 50, 148, 683, 3824, 4008, 944, 55490, 94184, 171572, 343144,
    745074, 1698160, 3931208, 662448, 3739321, 12080252, 32511574, 12481564, 49545413, 5193248,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 37, 57, 228, 2004, 14204, 15148, 5102, 230358, 401930,
    745074, 1490148, 3188308, 7119516, 16170572, 3132677, 15212929, 47724503, 127314931, 42642616,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 23, 464, 1716, 7816, 5636, 53552, 58654, 26868,
    953086, 1698160, 3188308, 6376616, 13496132, 29666704, 66353813, 14457878, 62182381, 189497312,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 8, 344, 1036, 4756, 26776, 14792, 204518, 231386,
    135896, 3931208, 7119516, 13496132, 26992264, 56658968, 123012781, 3252931, 65435312,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 120, 208, 220, 880, 11272, 91600, 33974, 789648,
    925544, 662448, 16170572, 29666704, 56658968, 113317936, 236330717, 508019104,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 15, 103, 55, 3347, 12419, 56459, 16987, 313105,
    54177, 3076873, 3739321, 3132677, 66353813, 123012781, 236330717, 0,
  ],
];
const LOG2 = [
  1, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 6,
];
const LOG2_LOST = [
  0, 1, 0, 3, 2, 1, 0, 7, 6, 5, 4, 3, 2, 1, 0, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
  31,
];

// — the frame decoder -----------------------------------------------------------

/** Room for a band index one past the 32 the filter bank has, which a frame can name. */
const BAND_SLOTS = 33;

/** `Cc`, offset by one: requantisation factor per resolution, -1 (noise) to 15. */
const CC = [
  111.285962475327, 65536.0, 21845.333333333332, 13107.200000000001, 9362.285714285713,
  7281.777777777777, 4369.066666666666, 2114.064516129032, 1040.253968253968, 516.031496062992,
  257.003921568627, 128.25048923679, 64.062561094819, 32.015632633121, 16.003907203907,
  8.000976681723, 4.000244155527, 2.000061037018, 1.000015259021,
];

/** `Dc`, offset by one: the centre of each resolution's quantiser. */
const DC = [2, 0, 1, 2, 3, 4, 7, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383, 32767];

/** `thres`: when the adaptive tables of resolutions 2 and 5-8 switch to their second table. */
const THRESHOLD = [0, 0, 3, 0, 0, 1, 3, 4, 8];

/** Scale factor per index (taken `& 0xff`), filled in libmpcdec's order. */
const SCF = (() => {
  const scf = new Float32Array(256);
  const step = 0.83298066476582673961;
  let up = 1 / (1 << 15);
  let down = up;
  scf[1] = up;
  up *= step;
  down /= step;
  for (let n = 1; n <= 128; n++) {
    // n = 128 lands both on index 129; the second write is the one kept.
    scf[(1 + n) & 0xff] = up;
    scf[(1 - n) & 0xff] = down;
    up *= step;
    down /= step;
  }
  return scf;
})();

const PARITY = (() => {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i;
    let bit = 0;
    while (v) {
      bit ^= v & 1;
      v >>= 1;
    }
    p[i] = bit;
  }
  return p;
})();

/** One channel's coded state, carried from frame to frame. */
class Channel {
  readonly res = new Int32Array(BAND_SLOTS);
  /** Three scale factor indices per band, one per third of the frame. */
  readonly scf = new Int32Array(BAND_SLOTS * 3);
  readonly scfi = new Int32Array(BAND_SLOTS);
  /** Whether the band's next first scale factor is sent whole rather than as a difference. */
  readonly absolute = new Uint8Array(BAND_SLOTS);
  readonly q = new Int16Array(BAND_SLOTS * 36);
  /** Sub-band samples, 36 rows of 32 bands. */
  readonly y = new Float32Array(36 * 32);
  readonly v = new Float32Array(2304 + 960);
}

class FrameDecoder {
  readonly out: Float32Array[];
  private readonly ch: Channel[] = [new Channel(), new Channel()];
  private readonly ms = new Uint8Array(BAND_SLOTS);
  private lastBands = 0;
  private r1 = 1;
  private r2 = 1;

  constructor(private readonly header: MpcHeader) {
    this.out = Array.from({ length: header.channels }, () => new Float32Array(FRAME));
  }

  frame(r: BitReader, key: boolean): void {
    this.readFrame(r, key);
    this.requantise();
    for (let c = 0; c < this.header.channels; c++) synthesise(this.ch[c], this.out[c]);
  }

  private random(): number {
    const t1 = PARITY[this.r1 & 0xf5] << 31;
    const t2 = PARITY[(this.r2 >>> 25) & 0x63];
    this.r1 = ((this.r1 >>> 1) | t1) >>> 0;
    this.r2 = ((this.r2 << 1) | t2) >>> 0;
    return (this.r1 ^ this.r2) >>> 0;
  }

  /** `mpc_decoder_read_bitstream_sv8`. */
  private readFrame(r: BitReader, key: boolean): void {
    const [L, R] = this.ch;
    const maxBand = this.header.bands;

    let bands: number;
    if (key) {
      bands = r.bounded(maxBand + 1);
    } else {
      bands = this.lastBands + r.canonical(BANDS);
      if (bands > 32) bands -= 33;
    }
    this.lastBands = bands;

    if (bands) {
      const top = bands - 1;
      L.res[top] = r.canonical(RES_1);
      R.res[top] = r.canonical(RES_1);
      if (L.res[top] > 15) L.res[top] -= 17;
      if (R.res[top] > 15) R.res[top] -= 17;
      for (let n = bands - 2; n >= 0; n--) {
        L.res[n] = r.canonical(L.res[n + 1] > 2 ? RES_2 : RES_1) + L.res[n + 1];
        if (L.res[n] > 15) L.res[n] -= 17;
        R.res[n] = r.canonical(R.res[n + 1] > 2 ? RES_2 : RES_1) + R.res[n + 1];
        if (R.res[n] > 15) R.res[n] -= 17;
      }

      if (this.header.midSide) {
        let total = 0;
        for (let n = 0; n < bands; n++) if (L.res[n] || R.res[n]) total++;
        const count = r.bounded(total);
        let flags = 0;
        if (count !== 0 && count !== total)
          flags = r.combination(Math.min(count, total - count), total);
        if (count * 2 > total) flags = ~flags;
        for (let n = bands - 1; n >= 0; n--) {
          if (L.res[n] || R.res[n]) {
            this.ms[n] = flags & 1;
            flags >>>= 1;
          }
        }
      }
    }
    for (let n = bands; n <= maxBand; n++) L.res[n] = R.res[n] = 0;

    // A packet's first frame can be decoded on its own, so nothing it codes
    // as a difference may lean on the frame before.
    if (key) {
      L.absolute.fill(1);
      R.absolute.fill(1);
    }

    for (let n = 0; n < bands; n++) {
      const cnt = (L.res[n] ? 1 : 0) + (R.res[n] ? 1 : 0) - 1;
      if (cnt >= 0) {
        const v = r.canonical(cnt ? SCFI_2 : SCFI_1);
        if (L.res[n]) L.scfi[n] = v >> (2 * cnt);
        if (R.res[n]) R.scfi[n] = v & 3;
      }
    }

    for (let n = 0; n < bands; n++) {
      for (const c of this.ch) {
        if (!c.res[n]) continue;
        const s = n * 3;
        if (c.absolute[n]) {
          c.scf[s] = r.read(7) - 6;
          c.absolute[n] = 0;
        } else {
          let d = r.canonical(DSCF_2);
          if (d === 64) d += r.read(6);
          c.scf[s] = ((c.scf[s + 2] - 25 + d) & 127) - 6;
        }
        for (let m = 0; m < 2; m++) {
          if (((c.scfi[n] << m) & 2) === 0) {
            let d = r.canonical(DSCF_1);
            if (d === 31) d = 64 + r.read(6);
            c.scf[s + m + 1] = ((c.scf[s + m] - 25 + d) & 127) - 6;
          } else {
            c.scf[s + m + 1] = c.scf[s + m];
          }
        }
      }
    }

    for (let n = 0; n < bands; n++) {
      for (const c of this.ch) this.readSamples(r, c.res[n], c.q, n * 36);
    }
  }

  private readSamples(r: BitReader, res: number, q: Int16Array, at: number): void {
    if (res === 0) return;
    if (res === 2) {
      // Three samples of -2..2 per code, as the code's base-5 digits.
      let idx = 2 * THRESHOLD[2];
      for (let k = 0; k < 36; k += 3) {
        const v = r.canonical(idx > THRESHOLD[2] ? Q2_2 : Q2_1);
        const a = (v % 5) - 2;
        const b = (((v / 5) | 0) % 5) - 2;
        const c = ((v / 25) | 0) - 2;
        q[at + k] = a;
        q[at + k + 1] = b;
        q[at + k + 2] = c;
        idx = (idx >> 1) + Math.abs(a) + Math.abs(b) + Math.abs(c);
      }
    } else if (res === 1) {
      // Each half of the frame: how many samples are ±1, which ones, then their signs.
      for (let k = 0; k < 36; ) {
        const end = k + 18;
        const cnt = r.canonical(Q1);
        let idx = 0;
        if (cnt > 0 && cnt < 18) idx = r.combination(cnt <= 9 ? cnt : 18 - cnt, 18);
        if (cnt > 9) idx = ~idx;
        for (; k < end; k++) {
          q[at + k] = idx & (1 << 17) ? (r.read(1) << 1) - 1 : 0;
          idx <<= 1;
        }
      }
    } else if (res === -1) {
      // Noise in place of a band the encoder judged noise-like.
      for (let k = 0; k < 36; k++) {
        const t = this.random();
        q[at + k] =
          ((t >>> 24) & 0xff) + ((t >>> 16) & 0xff) + ((t >>> 8) & 0xff) + (t & 0xff) - 510;
      }
    } else if (res <= 4) {
      // Two signed nibbles per code, the low one first.
      const table = res === 3 ? Q3 : Q4;
      for (let k = 0; k < 36; k += 2) {
        const v = r.canonical(table);
        q[at + k] = (v << 28) >> 28;
        q[at + k + 1] = (v << 24) >> 28;
      }
    } else if (res <= 8) {
      const [first, second] = Q5_TO_8[res - 5];
      const threshold = THRESHOLD[res];
      let idx = 2 * threshold;
      for (let k = 0; k < 36; k++) {
        const v = r.canonical(idx > threshold ? second : first);
        q[at + k] = v;
        idx = (idx >> 1) + Math.abs(v);
      }
    } else {
      const extra = res - 9;
      for (let k = 0; k < 36; k++) {
        let v = r.canonical(Q9_UP) & 0xff;
        if (extra) v = (v << extra) | r.read(extra);
        q[at + k] = v - DC[res + 1];
      }
    }
  }

  /** `mpc_decoder_requantisierung`: quantised values to sub-band samples. */
  private requantise(): void {
    const [L, R] = this.ch;
    const last = Math.min(this.header.bands, 31);
    for (let band = 0; band <= last; band++) {
      const rl = L.res[band];
      const rr = R.res[band];
      const ms = this.ms[band] === 1;
      for (let part = 0; part < 3; part++) {
        const fl = rl ? CC[rl + 1] * SCF[L.scf[band * 3 + part] & 0xff] : 0;
        const fr = rr ? CC[rr + 1] * SCF[R.scf[band * 3 + part] & 0xff] : 0;
        for (let n = part * 12; n < part * 12 + 12; n++) {
          const l = rl ? fl * L.q[band * 36 + n] : 0;
          const r = rr ? fr * R.q[band * 36 + n] : 0;
          const at = n * 32 + band;
          if (ms) {
            L.y[at] = l + r;
            R.y[at] = l - r;
          } else {
            L.y[at] = l;
            R.y[at] = r;
          }
        }
      }
    }
  }
}

/** Where in the V buffer each of a sample's 16 window taps reads. */
const TAPS = [0, 96, 128, 224, 256, 352, 384, 480, 512, 608, 640, 736, 768, 864, 896, 992];

/** `mpc_decoder_synthese_filter_float`: 36 rows of 32 sub-band samples to 1152 samples. */
function synthesise(c: Channel, out: Float32Array): void {
  const v = c.v;
  v.copyWithin(2304, 0, 960);
  let at = 2304;
  for (let n = 0; n < 36; n++) {
    at -= 64;
    newV(c.y, n * 32, v, at);
    for (let k = 0; k < 32; k++) {
      const d = k * 16;
      const base = at + k;
      let sum = 0;
      for (let j = 0; j < 16; j++) sum += v[base + TAPS[j]] * WINDOW[d + j];
      out[n * 32 + k] = sum;
    }
  }
}

/** `mpc_compute_new_V`: the fast DCT (after Byeong Gi Lee) that feeds the filter bank. */
function newV(y: Float32Array, s: number, v: Float32Array, o: number): void {
  let a00, a01, a02, a03, a04, a05, a06, a07, a08, a09, a10, a11, a12, a13, a14, a15: number;
  let b00, b01, b02, b03, b04, b05, b06, b07, b08, b09, b10, b11, b12, b13, b14, b15: number;
  let tmp: number;
  a00 = y[s + 0] + y[s + 31];
  a01 = y[s + 1] + y[s + 30];
  a02 = y[s + 2] + y[s + 29];
  a03 = y[s + 3] + y[s + 28];
  a04 = y[s + 4] + y[s + 27];
  a05 = y[s + 5] + y[s + 26];
  a06 = y[s + 6] + y[s + 25];
  a07 = y[s + 7] + y[s + 24];
  a08 = y[s + 8] + y[s + 23];
  a09 = y[s + 9] + y[s + 22];
  a10 = y[s + 10] + y[s + 21];
  a11 = y[s + 11] + y[s + 20];
  a12 = y[s + 12] + y[s + 19];
  a13 = y[s + 13] + y[s + 18];
  a14 = y[s + 14] + y[s + 17];
  a15 = y[s + 15] + y[s + 16];
  b00 = a00 + a15;
  b01 = a01 + a14;
  b02 = a02 + a13;
  b03 = a03 + a12;
  b04 = a04 + a11;
  b05 = a05 + a10;
  b06 = a06 + a09;
  b07 = a07 + a08;
  b08 = (a00 - a15) * 0.5024192929;
  b09 = (a01 - a14) * 0.5224986076;
  b10 = (a02 - a13) * 0.5669440627;
  b11 = (a03 - a12) * 0.6468217969;
  b12 = (a04 - a11) * 0.7881546021;
  b13 = (a05 - a10) * 1.0606776476;
  b14 = (a06 - a09) * 1.7224471569;
  b15 = (a07 - a08) * 5.1011486053;
  a00 = b00 + b07;
  a01 = b01 + b06;
  a02 = b02 + b05;
  a03 = b03 + b04;
  a04 = (b00 - b07) * 0.5097956061;
  a05 = (b01 - b06) * 0.6013448834;
  a06 = (b02 - b05) * 0.8999761939;
  a07 = (b03 - b04) * 2.5629155636;
  a08 = b08 + b15;
  a09 = b09 + b14;
  a10 = b10 + b13;
  a11 = b11 + b12;
  a12 = (b08 - b15) * 0.5097956061;
  a13 = (b09 - b14) * 0.6013448834;
  a14 = (b10 - b13) * 0.8999761939;
  a15 = (b11 - b12) * 2.5629155636;
  b00 = a00 + a03;
  b01 = a01 + a02;
  b02 = (a00 - a03) * 0.5411961079;
  b03 = (a01 - a02) * 1.3065630198;
  b04 = a04 + a07;
  b05 = a05 + a06;
  b06 = (a04 - a07) * 0.5411961079;
  b07 = (a05 - a06) * 1.3065630198;
  b08 = a08 + a11;
  b09 = a09 + a10;
  b10 = (a08 - a11) * 0.5411961079;
  b11 = (a09 - a10) * 1.3065630198;
  b12 = a12 + a15;
  b13 = a13 + a14;
  b14 = (a12 - a15) * 0.5411961079;
  b15 = (a13 - a14) * 1.3065630198;
  a00 = b00 + b01;
  a01 = (b00 - b01) * 0.7071067691;
  a02 = b02 + b03;
  a03 = (b02 - b03) * 0.7071067691;
  a04 = b04 + b05;
  a05 = (b04 - b05) * 0.7071067691;
  a06 = b06 + b07;
  a07 = (b06 - b07) * 0.7071067691;
  a08 = b08 + b09;
  a09 = (b08 - b09) * 0.7071067691;
  a10 = b10 + b11;
  a11 = (b10 - b11) * 0.7071067691;
  a12 = b12 + b13;
  a13 = (b12 - b13) * 0.7071067691;
  a14 = b14 + b15;
  a15 = (b14 - b15) * 0.7071067691;
  v[o + 48] = -a00;
  v[o + 0] = a01;
  v[o + 40] = -a02 - (v[o + 8] = a03);
  v[o + 36] = -((v[o + 4] = a05 + (v[o + 12] = a07)) + a06);
  v[o + 44] = -a04 - a06 - a07;
  v[o + 6] = (v[o + 10] = a11 + (v[o + 14] = a15)) + a13;
  v[o + 38] = (v[o + 34] = -(v[o + 2] = a09 + a13 + a15) - a14) + a09 - a10 - a11;
  v[o + 46] = (tmp = -(a12 + a14 + a15)) - a08;
  v[o + 42] = tmp - a10 - a11;
  a00 = (y[s + 0] - y[s + 31]) * 0.5006030202;
  a01 = (y[s + 1] - y[s + 30]) * 0.5054709315;
  a02 = (y[s + 2] - y[s + 29]) * 0.5154473186;
  a03 = (y[s + 3] - y[s + 28]) * 0.5310425758;
  a04 = (y[s + 4] - y[s + 27]) * 0.5531039238;
  a05 = (y[s + 5] - y[s + 26]) * 0.5829349756;
  a06 = (y[s + 6] - y[s + 25]) * 0.6225041151;
  a07 = (y[s + 7] - y[s + 24]) * 0.6748083234;
  a08 = (y[s + 8] - y[s + 23]) * 0.7445362806;
  a09 = (y[s + 9] - y[s + 22]) * 0.8393496275;
  a10 = (y[s + 10] - y[s + 21]) * 0.9725682139;
  a11 = (y[s + 11] - y[s + 20]) * 1.1694399118;
  a12 = (y[s + 12] - y[s + 19]) * 1.4841645956;
  a13 = (y[s + 13] - y[s + 18]) * 2.0577809811;
  a14 = (y[s + 14] - y[s + 17]) * 3.4076085091;
  a15 = (y[s + 15] - y[s + 16]) * 10.1900081635;
  b00 = a00 + a15;
  b01 = a01 + a14;
  b02 = a02 + a13;
  b03 = a03 + a12;
  b04 = a04 + a11;
  b05 = a05 + a10;
  b06 = a06 + a09;
  b07 = a07 + a08;
  b08 = (a00 - a15) * 0.5024192929;
  b09 = (a01 - a14) * 0.5224986076;
  b10 = (a02 - a13) * 0.5669440627;
  b11 = (a03 - a12) * 0.6468217969;
  b12 = (a04 - a11) * 0.7881546021;
  b13 = (a05 - a10) * 1.0606776476;
  b14 = (a06 - a09) * 1.7224471569;
  b15 = (a07 - a08) * 5.1011486053;
  a00 = b00 + b07;
  a01 = b01 + b06;
  a02 = b02 + b05;
  a03 = b03 + b04;
  a04 = (b00 - b07) * 0.5097956061;
  a05 = (b01 - b06) * 0.6013448834;
  a06 = (b02 - b05) * 0.8999761939;
  a07 = (b03 - b04) * 2.5629155636;
  a08 = b08 + b15;
  a09 = b09 + b14;
  a10 = b10 + b13;
  a11 = b11 + b12;
  a12 = (b08 - b15) * 0.5097956061;
  a13 = (b09 - b14) * 0.6013448834;
  a14 = (b10 - b13) * 0.8999761939;
  a15 = (b11 - b12) * 2.5629155636;
  b00 = a00 + a03;
  b01 = a01 + a02;
  b02 = (a00 - a03) * 0.5411961079;
  b03 = (a01 - a02) * 1.3065630198;
  b04 = a04 + a07;
  b05 = a05 + a06;
  b06 = (a04 - a07) * 0.5411961079;
  b07 = (a05 - a06) * 1.3065630198;
  b08 = a08 + a11;
  b09 = a09 + a10;
  b10 = (a08 - a11) * 0.5411961079;
  b11 = (a09 - a10) * 1.3065630198;
  b12 = a12 + a15;
  b13 = a13 + a14;
  b14 = (a12 - a15) * 0.5411961079;
  b15 = (a13 - a14) * 1.3065630198;
  a00 = b00 + b01;
  a01 = (b00 - b01) * 0.7071067691;
  a02 = b02 + b03;
  a03 = (b02 - b03) * 0.7071067691;
  a04 = b04 + b05;
  a05 = (b04 - b05) * 0.7071067691;
  a06 = b06 + b07;
  a07 = (b06 - b07) * 0.7071067691;
  a08 = b08 + b09;
  a09 = (b08 - b09) * 0.7071067691;
  a10 = b10 + b11;
  a11 = (b10 - b11) * 0.7071067691;
  a12 = b12 + b13;
  a13 = (b12 - b13) * 0.7071067691;
  a14 = b14 + b15;
  a15 = (b14 - b15) * 0.7071067691;
  v[o + 5] = (v[o + 11] = (v[o + 13] = a07 + (v[o + 15] = a15)) + a11) + a05 + a13;
  v[o + 7] = (v[o + 9] = a03 + a11 + a15) + a13;
  v[o + 33] = -(v[o + 1] = a01 + a09 + a13 + a15) - a14;
  v[o + 35] = -(v[o + 3] = a05 + a07 + a09 + a13 + a15) - a06 - a14;
  v[o + 37] = (tmp = -(a10 + a11 + a13 + a14 + a15)) - a05 - a06 - a07;
  v[o + 39] = tmp - a02 - a03;
  v[o + 41] = (tmp += a13 - a12) - a02 - a03;
  v[o + 43] = tmp - a04 - a06 - a07;
  v[o + 47] = (tmp = -(a08 + a12 + a14 + a15)) - a00;
  v[o + 45] = tmp - a04 - a06 - a07;
  v[o + 32] = -v[o + 0];
  v[o + 31] = -v[o + 1];
  v[o + 30] = -v[o + 2];
  v[o + 29] = -v[o + 3];
  v[o + 28] = -v[o + 4];
  v[o + 27] = -v[o + 5];
  v[o + 26] = -v[o + 6];
  v[o + 25] = -v[o + 7];
  v[o + 24] = -v[o + 8];
  v[o + 23] = -v[o + 9];
  v[o + 22] = -v[o + 10];
  v[o + 21] = -v[o + 11];
  v[o + 20] = -v[o + 12];
  v[o + 19] = -v[o + 13];
  v[o + 18] = -v[o + 14];
  v[o + 17] = -v[o + 15];
  v[o + 63] = v[o + 33];
  v[o + 62] = v[o + 34];
  v[o + 61] = v[o + 35];
  v[o + 60] = v[o + 36];
  v[o + 59] = v[o + 37];
  v[o + 58] = v[o + 38];
  v[o + 57] = v[o + 39];
  v[o + 56] = v[o + 40];
  v[o + 55] = v[o + 41];
  v[o + 54] = v[o + 42];
  v[o + 53] = v[o + 43];
  v[o + 52] = v[o + 44];
  v[o + 51] = v[o + 45];
  v[o + 50] = v[o + 46];
  v[o + 49] = v[o + 47];
}

/** `Di_opt`, over 65536: the synthesis window, 16 taps for each of 32 outputs. */
const WINDOW = Float32Array.from(
  [
    0, -29, 213, -459, 2037, -5153, 6574, -37489, 75038, 37489, 6574, 5153, 2037, 459, 213, 29, -1,
    -31, 218, -519, 2000, -5517, 5959, -39336, 74992, 35640, 7134, 4788, 2063, 401, 208, 26, -1,
    -35, 222, -581, 1952, -5879, 5288, -41176, 74856, 33791, 7640, 4425, 2080, 347, 202, 24, -1,
    -38, 225, -645, 1893, -6237, 4561, -43006, 74630, 31947, 8092, 4063, 2087, 294, 196, 21, -1,
    -41, 227, -711, 1822, -6589, 3776, -44821, 74313, 30112, 8492, 3705, 2085, 244, 190, 19, -1,
    -45, 228, -779, 1739, -6935, 2935, -46617, 73908, 28289, 8840, 3351, 2075, 197, 183, 17, -1,
    -49, 228, -848, 1644, -7271, 2037, -48390, 73415, 26482, 9139, 3004, 2057, 153, 176, 16, -2,
    -53, 227, -919, 1535, -7597, 1082, -50137, 72835, 24694, 9389, 2663, 2032, 111, 169, 14, -2,
    -58, 224, -991, 1414, -7910, 70, -51853, 72169, 22929, 9592, 2330, 2001, 72, 161, 13, -2, -63,
    221, -1064, 1280, -8209, -998, -53534, 71420, 21189, 9750, 2006, 1962, 36, 154, 11, -2, -68,
    215, -1137, 1131, -8491, -2122, -55178, 70590, 19478, 9863, 1692, 1919, 2, 147, 10, -3, -73,
    208, -1210, 970, -8755, -3300, -56778, 69679, 17799, 9935, 1388, 1870, -29, 139, 9, -3, -79,
    200, -1283, 794, -8998, -4533, -58333, 68692, 16155, 9966, 1095, 1817, -57, 132, 8, -4, -85,
    189, -1356, 605, -9219, -5818, -59838, 67629, 14548, 9959, 814, 1759, -83, 125, 7, -4, -91, 177,
    -1428, 402, -9416, -7154, -61289, 66494, 12980, 9916, 545, 1698, -106, 117, 7, -5, -97, 163,
    -1498, 185, -9585, -8540, -62684, 65290, 11455, 9838, 288, 1634, -127, 111, 6, -5, -104, 146,
    -1567, -45, -9727, -9975, -64019, 64019, 9975, 9727, 45, 1567, -146, 104, 5, -6, -111, 127,
    -1634, -288, -9838, -11455, -65290, 62684, 8540, 9585, -185, 1498, -163, 97, 5, -7, -117, 106,
    -1698, -545, -9916, -12980, -66494, 61289, 7154, 9416, -402, 1428, -177, 91, 4, -7, -125, 83,
    -1759, -814, -9959, -14548, -67629, 59838, 5818, 9219, -605, 1356, -189, 85, 4, -8, -132, 57,
    -1817, -1095, -9966, -16155, -68692, 58333, 4533, 8998, -794, 1283, -200, 79, 3, -9, -139, 29,
    -1870, -1388, -9935, -17799, -69679, 56778, 3300, 8755, -970, 1210, -208, 73, 3, -10, -147, -2,
    -1919, -1692, -9863, -19478, -70590, 55178, 2122, 8491, -1131, 1137, -215, 68, 2, -11, -154,
    -36, -1962, -2006, -9750, -21189, -71420, 53534, 998, 8209, -1280, 1064, -221, 63, 2, -13, -161,
    -72, -2001, -2330, -9592, -22929, -72169, 51853, -70, 7910, -1414, 991, -224, 58, 2, -14, -169,
    -111, -2032, -2663, -9389, -24694, -72835, 50137, -1082, 7597, -1535, 919, -227, 53, 2, -16,
    -176, -153, -2057, -3004, -9139, -26482, -73415, 48390, -2037, 7271, -1644, 848, -228, 49, 1,
    -17, -183, -197, -2075, -3351, -8840, -28289, -73908, 46617, -2935, 6935, -1739, 779, -228, 45,
    1, -19, -190, -244, -2085, -3705, -8492, -30112, -74313, 44821, -3776, 6589, -1822, 711, -227,
    41, 1, -21, -196, -294, -2087, -4063, -8092, -31947, -74630, 43006, -4561, 6237, -1893, 645,
    -225, 38, 1, -24, -202, -347, -2080, -4425, -7640, -33791, -74856, 41176, -5288, 5879, -1952,
    581, -222, 35, 1, -26, -208, -401, -2063, -4788, -7134, -35640, -74992, 39336, -5959, 5517,
    -2000, 519, -218, 31, 1,
  ].map(x => x / 65536),
);
