/**
 * The streams below were made for these tests with Python's `lzma` module
 * (raw LZMA1, 64 KiB dictionary) from the inputs built beside them, so the
 * expected output is exact and no game data is needed. That encoder always
 * ends its stream with an end marker, which lets one stream check both ways
 * a member can end: on the marker, and on its stated size before it.
 */

import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { bytesSource } from '../src/assets/vfs/ByteSource';
import { decodeLzma, decodeZipLzma, LzmaError, parseProps } from '../src/assets/vfs/lzma';
import { METHOD_LZMA, PackReader } from '../src/assets/vfs/zip';

const hex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g)!.map(b => parseInt(b, 16)));
const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const repeat = (s: string, n: number): string => s.repeat(n);

/** lc=3, lp=0, pb=2 with a 64 KiB dictionary, as the properties byte 0x5d says. */
const PROPS_DEFAULT = hex('5d00000100');
/** lc=0, lp=2, pb=0. */
const PROPS_LP2 = hex('1200000100');

const PROSE = text(
  repeat('The quick brown fox jumps over the lazy dog. ', 3) +
    'Pack your box with five dozen liquor jugs.',
);
const PROSE_LZMA = hex(
  '002a1a08a2032566f14b78c5a205ff2ee6d9d2201aad34f8e21de84136fadc0669bb3ce410342709ebb366e3ed375ae812ed33b251bf292030800450dd2f156646e794cf5e6bd85234d42347b3fc3c83dc76177d511fffadbd8000',
);

const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, i) => i);
const REPEATS = concat(
  text(repeat('abcabcabd', 40) + repeat('xyzxyzxy', 30) + repeat('abcabcabd', 10)),
  ALL_BYTES,
  ALL_BYTES,
);
const REPEATS_LZMA = hex(
  '00309888a5836e0e016066b8826eccc5ae197a5e178cfb14ec3a5d47a38d0ee9805a6f017a99907baa6188cab9c0a88bfd320a9f37b8da5da88a0fc52c08ec5b1c1cb66498bfd966f52ad37893c5a866709c49e8c87302f71588f25bcb8acd09a4c77f9c7d98b925915b086a76c34436ef0462d5c45d8ab03463fd90c5397d1e8dc442fafb43eee0c7db1ce643458a10bff24249d0c3a15d3369bca8db54f5366999672994cb603daabb30dedac0d7474824db9d724759ac2ff1b6ed9ac633d9e6a3608493a9e1576d3040e52712af2f4a0869483dc3bb158295090e2c1765d4cb1f0454e8268da8d827aea50c059558324d8e13f329173610e4370fcc9ccc3e9c54137eaddffcb7b214',
);

const LP2 = text(repeat('lp and pb set ', 20));
const LP2_LZMA = hex('00361ce06839d1bbc7b9ec5450f3ee474efd11300a3ffffeaf5800');

describe('LZMA properties', () => {
  it('splits the properties byte into lc, lp and pb and reads the dictionary size', () => {
    expect(parseProps(PROPS_DEFAULT)).toEqual({ lc: 3, lp: 0, pb: 2, dictSize: 1 << 16 });
    expect(parseProps(PROPS_LP2)).toEqual({ lc: 0, lp: 2, pb: 0, dictSize: 1 << 16 });
  });

  it('refuses a properties byte past the largest lc, lp and pb', () => {
    expect(() => parseProps(hex('e100000100'))).toThrow(LzmaError);
  });
});

describe('LZMA decoding', () => {
  const cases = [
    { name: 'prose', props: PROPS_DEFAULT, stream: PROSE_LZMA, plain: PROSE },
    {
      name: 'long repeats and every byte value',
      props: PROPS_DEFAULT,
      stream: REPEATS_LZMA,
      plain: REPEATS,
    },
    { name: 'literal position bits', props: PROPS_LP2, stream: LP2_LZMA, plain: LP2 },
  ];

  for (const c of cases) {
    it(`decodes ${c.name} to its end marker`, () => {
      const out = decodeLzma(c.stream, 0, parseProps(c.props), c.plain.length, true);
      expect(out).toEqual(c.plain);
    });

    it(`decodes ${c.name} to its stated size, without reading a marker`, () => {
      const out = decodeLzma(c.stream, 0, parseProps(c.props), c.plain.length, false);
      expect(out).toEqual(c.plain);
    });
  }

  it('refuses an end marker that comes before the stated size', () => {
    expect(() =>
      decodeLzma(PROSE_LZMA, 0, parseProps(PROPS_DEFAULT), PROSE.length + 10, true),
    ).toThrow(LzmaError);
  });

  it('refuses a stream whose first byte is not zero', () => {
    const bad = PROSE_LZMA.slice();
    bad[0] = 1;
    expect(() => decodeLzma(bad, 0, parseProps(PROPS_DEFAULT), PROSE.length, false)).toThrow(
      LzmaError,
    );
  });

  it('unwraps the ZIP framing: version, properties size, properties, stream', () => {
    const framed = concat(hex('0914'), hex('0500'), PROPS_DEFAULT, REPEATS_LZMA);
    expect(decodeZipLzma(framed, REPEATS.length, false)).toEqual(REPEATS);
  });

  it('refuses ZIP framing whose properties are not five bytes', () => {
    const framed = concat(hex('0914'), hex('0400'), PROPS_DEFAULT, REPEATS_LZMA);
    expect(() => decodeZipLzma(framed, REPEATS.length, false)).toThrow(LzmaError);
  });
});

/** One member stored with method 14, in a plain ZIP. */
function lzmaPack(name: string, plain: Uint8Array, stream: Uint8Array, flags: number): Uint8Array {
  const nameBytes = text(name);
  const data = concat(hex('0914'), hex('0500'), PROPS_DEFAULT, stream);
  const crc = crc32(plain) >>> 0;

  const lfh = new Uint8Array(30 + nameBytes.length);
  const l = new DataView(lfh.buffer);
  l.setUint32(0, 0x04034b50, true);
  l.setUint16(6, flags, true);
  l.setUint16(8, METHOD_LZMA, true);
  l.setUint32(14, crc, true);
  l.setUint32(18, data.length, true);
  l.setUint32(22, plain.length, true);
  l.setUint16(26, nameBytes.length, true);
  lfh.set(nameBytes, 30);

  const cd = new Uint8Array(46 + nameBytes.length);
  const c = new DataView(cd.buffer);
  c.setUint32(0, 0x02014b50, true);
  c.setUint16(8, flags, true);
  c.setUint16(10, METHOD_LZMA, true);
  c.setUint32(16, crc, true);
  c.setUint32(20, data.length, true);
  c.setUint32(24, plain.length, true);
  c.setUint16(28, nameBytes.length, true);
  cd.set(nameBytes, 46);

  const eocd = new Uint8Array(22);
  const e = new DataView(eocd.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, 1, true);
  e.setUint16(10, 1, true);
  e.setUint32(12, cd.length, true);
  e.setUint32(16, lfh.length + data.length, true);
  return concat(lfh, data, cd, eocd);
}

describe('LZMA members in a pack', () => {
  it('reads a member stored with method 14, and keeps its CRC from the directory', async () => {
    const pack = await PackReader.open(bytesSource(lzmaPack('a.txt', PROSE, PROSE_LZMA, 0)));
    const entry = pack.get('a.txt')!;
    expect(entry.method).toBe(METHOD_LZMA);
    expect(entry.crc).toBe(crc32(PROSE) >>> 0);
    expect(await pack.read(entry)).toEqual(PROSE);
  });

  it('honours the end-marker flag', async () => {
    const pack = await PackReader.open(bytesSource(lzmaPack('b.txt', REPEATS, REPEATS_LZMA, 2)));
    expect(await pack.read('b.txt')).toEqual(REPEATS);
  });

  it('streams a method 14 member', async () => {
    const pack = await PackReader.open(bytesSource(lzmaPack('c.txt', PROSE, PROSE_LZMA, 0)));
    const out = new Uint8Array(await new Response(await pack.stream('c.txt')).arrayBuffer());
    expect(out).toEqual(PROSE);
  });
});
