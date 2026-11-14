/**
 * Which spells the client acts on by itself, found in a build's own tables:
 * Switch Target by its English name, the gathers by the static objects that
 * name them. The 1.1.4 fixture holds the shape that build is known to have,
 * so its ids are what the rule must keep giving there.
 */

import { describe, expect, it } from 'vitest';

import { WorldTables } from '../src/assets/formats/tables';
import { gatherHeldItem, isGather, MINING_HELD_ITEM } from '../src/gameplay/actionClips';
import { buildTable, buildTableFiles } from './helpers/fixtures';

/** A `spell_new` row naming string `nameId` in column 5. */
function spell(id: number, nameId: number): number[] {
  const row: number[] = new Array(44).fill(0);
  row[0] = id;
  row[5] = nameId;
  return row;
}

/** A `staticobject_proto` row gathered with `gather` (column 12). */
function proto(entry: number, gather: number): number[] {
  const row: number[] = new Array(20).fill(0);
  row[0] = entry;
  row[7] = 1;
  row[12] = gather;
  return row;
}

async function tablesWith(spells: number[][], protos: number[][]): Promise<WorldTables> {
  const files = new Map(buildTableFiles().map(e => [e.name, e.data]));
  files.set(
    'tables/spell_new.tbl',
    buildTable(
      'u'.repeat(44),
      spells,
      spells.map(r => r[0]!),
    ),
  );
  files.set(
    'tables/staticobject_proto.tbl',
    buildTable(
      'uuuufuufuuuuuuuuuuuu',
      protos,
      protos.map(r => r[0]!),
    ),
  );
  return WorldTables.load(async entry => files.get(entry) ?? null);
}

const NAMES = new Map([
  [1, 'Gathering'],
  [2, 'Switch Target'],
  [3, 'Auto Attack'],
  [4, 'Switch Enemy'],
]);

/** Rows `from`.. that no gather names, to set how many types there are. */
function filler(from: number, count: number, gather = 0): number[][] {
  return Array.from({ length: count }, (_, i) => proto(from + i, gather));
}

describe('the spells the client acts on, from the build tables', () => {
  it('finds 1.1.4 ids in a 1.1.4-shaped table, mining kept though few types name it', async () => {
    // Six ore nodes name 23, too few in 700 types to pass the share on their own.
    const ores = [132, 167, 168, 198, 199, 200].map(entry => proto(entry, 23));
    const tables = await tablesWith(
      [spell(23, 1), spell(57, 1), spell(108, 3), spell(111, 2), spell(1822, 1), spell(900, 1)],
      [
        ...ores,
        ...filler(1000, 500, 57),
        ...filler(2000, 40, 1822),
        // One quest object's gather is no one's.
        proto(3000, 900),
        ...filler(4000, 153),
      ],
    );
    expect(tables.generalSpells(NAMES)).toEqual({
      switchTarget: 111,
      gathering: [23, 57, 1822],
      mining: 23,
    });
  });

  it('finds 4.2.2 ids in a 4.2.2-shaped table, the lowest Switch Target winning', async () => {
    const tables = await tablesWith(
      [
        spell(1, 1),
        spell(2, 1),
        spell(3, 1),
        spell(4, 2),
        spell(5, 3),
        spell(14066, 4),
        spell(20000, 2),
      ],
      [
        proto(132, 2),
        ...filler(200, 11, 2),
        ...filler(1000, 930, 1),
        ...filler(2000, 25, 3),
        // An object gathered with Auto Attack, and seven with a quest's gather.
        proto(3000, 5),
        ...filler(3100, 7, 19040),
        ...filler(4000, 139),
      ],
    );
    expect(tables.generalSpells(NAMES)).toEqual({
      switchTarget: 4,
      gathering: [1, 2, 3],
      mining: 2,
    });
  });

  it('finds nothing in a build with neither', async () => {
    const tables = await tablesWith([spell(5, 3)], [proto(900, 0)]);
    expect(tables.generalSpells(NAMES)).toEqual({ switchTarget: 0, gathering: [], mining: 0 });
  });
});

describe('a gather cast', () => {
  const spells = { switchTarget: 4, gathering: [1, 2, 3], mining: 2 };

  it('holds the pick only for mining', () => {
    expect(gatherHeldItem(spells, 2)).toBe(MINING_HELD_ITEM);
    expect(gatherHeldItem(spells, 1)).toBeUndefined();
    expect(gatherHeldItem(spells, 5)).toBeUndefined();
  });

  it('is told apart by the build, and by nothing before the tables answer', () => {
    expect(isGather(spells, 3)).toBe(true);
    expect(isGather(spells, 4)).toBe(false);
    expect(isGather(null, 3)).toBe(false);
    expect(gatherHeldItem(null, 2)).toBeUndefined();
    expect(gatherHeldItem({ ...spells, mining: 0 }, 0)).toBeUndefined();
  });
});
