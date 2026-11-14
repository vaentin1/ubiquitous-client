/**
 * LZMA members of real packs decode to exactly what their central directory
 * records: the size and the CRC-32. A decoder that is wrong in any bit
 * produces the right number of the wrong bytes, which only the CRC catches.
 *
 * Needs game data and skips without it: a build under `.cache/<build>/` whose
 * packs use method 14, or `UBIQUITOUS_PACK=/path/to/res.bin`. All of
 * `tables.bin` is checked, and every twentieth LZMA member of `res.bin`.
 */

import { existsSync, readdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';

import { type ByteSource } from '../src/assets/vfs/ByteSource';
import { METHOD_LZMA, PackReader } from '../src/assets/vfs/zip';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function buildDirs(): string[] {
  const dirs = new Set<string>();
  const explicit = (process.env.UBIQUITOUS_PACK ?? '').trim();
  if (explicit && existsSync(explicit)) dirs.add(dirname(resolve(explicit)));
  const cache = join(ROOT, '.cache');
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache)) dirs.add(join(cache, dir));
  }
  return [...dirs].filter(dir => existsSync(join(dir, 'res.bin')));
}

const handles: { close(): Promise<void> }[] = [];

async function fileSource(path: string): Promise<ByteSource> {
  const handle = await open(path, 'r');
  handles.push(handle);
  const { size } = await handle.stat();
  return {
    size,
    async read(offset, length) {
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buf, 0, length, offset);
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
    },
  };
}

afterAll(async () => {
  await Promise.all(handles.map(h => h.close()));
});

async function lzmaPack(path: string): Promise<PackReader | null> {
  if (!existsSync(path)) return null;
  const pack = await PackReader.open(await fileSource(path), path);
  return pack.entries.some(e => e.method === METHOD_LZMA) ? pack : null;
}

/** Members whose decoded bytes disagree with the directory, by name. */
async function mismatches(pack: PackReader, every: number): Promise<string[]> {
  const bad: string[] = [];
  const members = pack.entries.filter(e => !e.isDir && e.method === METHOD_LZMA);
  for (let i = 0; i < members.length; i += every) {
    const entry = members[i];
    const bytes = await pack.read(entry).catch(() => null);
    if (!bytes || bytes.length !== entry.size || crc32(bytes) >>> 0 !== entry.crc) {
      bad.push(entry.name);
    }
  }
  return bad;
}

const DIRS = buildDirs();

describe.skipIf(!DIRS.length)('LZMA members of real packs', () => {
  for (const dir of DIRS) {
    it(`decodes every LZMA member of tables.bin to its size and CRC-32 (${dir.split(/[\\/]/).pop()})`, async () => {
      const pack = await lzmaPack(join(dir, 'tables.bin'));
      if (!pack) return;
      expect(await mismatches(pack, 1)).toEqual([]);
    }, 120_000);

    it(`decodes a spread of LZMA members of res.bin to their size and CRC-32 (${dir.split(/[\\/]/).pop()})`, async () => {
      const pack = await lzmaPack(join(dir, 'res.bin'));
      if (!pack) return;
      expect(await mismatches(pack, 20)).toEqual([]);
    }, 300_000);
  }
});
