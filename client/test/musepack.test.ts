/**
 * The Musepack reader against streams built here, bit by bit, from the
 * public SV8 packet layout and frames hand-coded with the decoder's tables.
 */

import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { decodeMpc, isMusepack, MpcError, readMpcHeader } from '../src/assets/formats/musepack';
import { decodeSound } from '../src/assets/formats/sound';

function varint(v: number): number[] {
  const groups = [v & 0x7f];
  for (v = Math.floor(v / 128); v > 0; v = Math.floor(v / 128)) groups.unshift((v & 0x7f) | 0x80);
  return groups;
}

/** A packet: key, size counting itself, payload. Sizes here stay under 128. */
function packet(key: string, payload: number[]): number[] {
  return [key.charCodeAt(0), key.charCodeAt(1), payload.length + 3, ...payload];
}

/** A bit string such as "1001" packed most significant bit first, zero-padded. */
function bits(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 8)
    out.push(parseInt(text.slice(i, i + 8).padEnd(8, '0'), 2));
  return out;
}

interface Shape {
  samples: number;
  beginSilence?: number;
  /** Index into 44100, 48000, 37800, 32000. */
  rate?: number;
  bands?: number;
  channels?: number;
  midSide?: boolean;
  /** Frames per packet are 4 to this. */
  blockField?: number;
}

function sh(shape: Shape): number[] {
  const field =
    ((shape.rate ?? 3) << 13) |
    (((shape.bands ?? 1) - 1) << 8) |
    (((shape.channels ?? 1) - 1) << 4) |
    ((shape.midSide ? 1 : 0) << 3) |
    (shape.blockField ?? 0);
  const body = [
    8,
    ...varint(shape.samples),
    ...varint(shape.beginSilence ?? 0),
    field >> 8,
    field & 0xff,
  ];
  const crc = crc32(Uint8Array.from(body));
  return packet('SH', [
    (crc >>> 24) & 0xff,
    (crc >>> 16) & 0xff,
    (crc >>> 8) & 0xff,
    crc & 0xff,
    ...body,
  ]);
}

function stream(shape: Shape, frames: number[][]): Uint8Array {
  return Uint8Array.from([
    ...[...'MPCK'].map(c => c.charCodeAt(0)),
    ...sh(shape),
    ...frames.flatMap(frame => packet('AP', frame)),
    ...packet('SE', []),
  ]);
}

/** Frames needed for `samples` once the filter bank's 481-sample lag is decoded through. */
const framesFor = (samples: number): number => Math.ceil((samples + 481) / 1152);

/** A key frame using no band: the band count, 0 of 0..2, is the single bit 0. */
const SILENT = bits('0');

/**
 * A key frame whose one band is noise: band count 1 (`10`), left resolution
 * -1 (`001`, symbol 16), right 0 (`1`), the left band's scale factor pattern
 * 2 (`1`, so its second third repeats the first), a first scale factor index
 * of 20 - 6 (`0010100`) and a third at +10 (`111`, symbol 35). Noise takes
 * no bits of its own.
 */
const NOISE_BAND = bits('10' + '001' + '1' + '1' + '0010100' + '111');

describe('decodeMpc', () => {
  it('reads the stream header', () => {
    const bytes = stream(
      { samples: 1000, rate: 1, channels: 2, bands: 31, midSide: true, blockField: 3 },
      [SILENT],
    );
    expect(isMusepack(bytes)).toBe(true);
    expect(readMpcHeader(bytes)).toEqual({
      sampleRate: 48000,
      channels: 2,
      samples: 1000,
      beginSilence: 0,
      bands: 31,
      midSide: true,
      framesPerPacket: 64,
    });
  });

  it('gives exactly the samples the header promises, after the leading silence', () => {
    const frames = Array.from({ length: framesFor(3000) }, () => SILENT);
    const pcm = decodeMpc(stream({ samples: 3000, beginSilence: 700, channels: 2 }, frames));
    expect(pcm.sampleRate).toBe(32000);
    expect(pcm.channels.length).toBe(2);
    for (const channel of pcm.channels) {
      expect(channel.length).toBe(2300);
      expect(channel.every(v => v === 0)).toBe(true);
    }
  });

  it('turns a noise band into low, band-limited sound in that channel only', () => {
    const frames = Array.from({ length: framesFor(4000) }, () => NOISE_BAND);
    const decode = (): Float32Array[] =>
      decodeMpc(stream({ samples: 4000, channels: 2 }, frames)).channels;
    const [left, right] = decode();
    expect(right.every(v => v === 0)).toBe(true);
    let level = 0;
    let step = 0;
    let peak = 0;
    for (let i = 1; i < left.length; i++) {
      level += Math.abs(left[i]);
      step += Math.abs(left[i] - left[i - 1]);
      peak = Math.max(peak, Math.abs(left[i]));
    }
    expect(level / left.length).toBeGreaterThan(1e-3);
    expect(peak).toBeLessThan(0.5);
    // The lowest of 32 sub-bands holds nothing above 1/64 of the sample
    // rate, so neighbouring samples barely differ. A wrong window or DCT
    // spreads it across the spectrum and the ratio climbs towards 1.
    expect(step / level).toBeLessThan(0.08);
    // The noise comes from a fixed generator: the same stream decodes the same.
    expect(decode()[0]).toEqual(left);
  });

  it('refuses what is not a whole SV8 stream', () => {
    const good = stream({ samples: 100 }, [SILENT]);
    expect(() => decodeMpc(new Uint8Array(16))).toThrow(MpcError);

    const badCrc = good.slice();
    badCrc[8] ^= 1;
    expect(() => decodeMpc(badCrc)).toThrow(/checksum/);

    const noHeader = Uint8Array.from([
      0x4d,
      0x50,
      0x43,
      0x4b,
      ...packet('AP', SILENT),
      ...packet('SE', []),
    ]);
    expect(() => decodeMpc(noHeader)).toThrow(/no SH/);

    expect(() => decodeMpc(good.subarray(0, good.length - 3))).toThrow(/before its SE/);
    // Fewer frames than the header's sample count needs.
    expect(() => decodeMpc(stream({ samples: 5000 }, [SILENT]))).toThrow(/holds/);
    expect(() => decodeMpc(stream({ samples: 100, channels: 3 }, [SILENT]))).toThrow(/channels/);
  });
});

describe('decodeSound', () => {
  it('tells the coding by the first bytes, not the name', () => {
    const mpc = stream({ samples: 100 }, [SILENT]);
    expect(decodeSound(mpc).channels[0].length).toBe(100);
    expect(() => decodeSound(new Uint8Array(40))).toThrow(/RIFF/);
  });
});
