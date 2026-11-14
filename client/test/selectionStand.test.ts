/**
 * Which dais a character is stood on before the world loads.
 *
 * The selection map holds two placements of the piece the screens stand
 * a character on, and only one of them is meant: the other is sunk into
 * the village with houses and trees packed round it, and a character put
 * there is left standing in a treetop. The one in the open is the stand.
 */

import { describe, expect, it } from 'vitest';

import {
  clearestStand,
  resolveGround,
  selectionWorlds,
  type StandCandidate,
} from '../src/assets/providers/localSelection';
import { resourceKey, tileId } from '../src/assets/ids';
import type { Placement, ZoneInfo } from '../src/assets/types';
import { atmosphereFrom } from '../src/assets/providers/localZone';

function standing(model: string, at: [number, number, number]): Placement {
  return {
    model,
    position: at,
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
    entry: 0,
    kind: 'scenery',
  };
}

/** `count` things stood close enough to a dais to be in the way of it. */
function crowd(around: Placement, count: number): Placement[] {
  return Array.from({ length: count }, (_, n) =>
    standing(`model/scene/nature/tree${n}.bdae`, [
      around.position[0] + (n % 5) - 2,
      around.position[1],
      around.position[2] + Math.floor(n / 5) - 2,
    ]),
  );
}

describe('the dais a character is stood on', () => {
  // The two the human selection map holds, where the build puts them.
  const inTheVillage = standing('model/scene/build/human/human_selection.bdae', [58.6, 4, 44.8]);
  const inTheOpen = standing(
    'model/scene/build/human/human_selection01.bdae',
    [232.8, 15.2, 214.8],
  );

  const candidates: StandCandidate[] = [
    { stand: inTheVillage, tile: [0, 0], near: [inTheVillage, ...crowd(inTheVillage, 44)] },
    { stand: inTheOpen, tile: [3, 3], near: [inTheOpen, ...crowd(inTheOpen, 2)] },
  ];

  it('is the one with room around it, not the first one found', () => {
    const chosen = clearestStand(candidates, [0, 0]);
    expect(chosen?.stand).toBe(inTheOpen);
    expect(chosen?.tile).toEqual([3, 3]);
  });

  it('is still the one with room when the search starts beside the other', () => {
    // The build that lists this map starts the search from the middle of
    // the zone; the one that does not starts from the map's corner. The
    // answer may not depend on which.
    expect(clearestStand(candidates, [58, 44])?.stand).toBe(inTheOpen);
  });

  it('is the nearer of two that are as clear as each other', () => {
    const far = standing('model/scene/build/human/human_selection.bdae', [400, 0, 400]);
    const near = standing('model/scene/build/human/human_selection.bdae', [10, 0, 10]);
    const both: StandCandidate[] = [
      { stand: far, tile: [6, 6], near: [far] },
      { stand: near, tile: [0, 0], near: [near] },
    ];
    expect(clearestStand(both, [0, 0])?.stand).toBe(near);
  });

  it('is nothing at all where the map holds none', () => {
    expect(clearestStand([], [0, 0])).toBeNull();
  });
});

describe('a tile asked for by the world it belongs to', () => {
  it('is kept apart from a tile of the same number on a listed map', () => {
    expect(resourceKey(tileId(-1, 3, 3, 'human_selection'))).not.toBe(
      resourceKey(tileId(-1, 3, 3)),
    );
  });

  it('is the same tile however often it is asked for', () => {
    expect(resourceKey(tileId(-1, 3, 3, 'human_selection'))).toBe(
      resourceKey(tileId(-1, 3, 3, 'human_selection')),
    );
  });
});

function zone(id: number, mapId: number, bounds: [number, number, number, number]): ZoneInfo {
  return {
    id,
    name: `zone ${id}`,
    mapId,
    mapName: 'ground',
    centre: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
    bounds,
    hasScenery: false,
    parentId: -1,
    priority: 0,
    icon: '',
    friendly: 0,
    atmosphere: {
      ...atmosphereFrom(undefined),
      skybox: `sky${id}.bdae`,
      skyHill: `hill${id}.bdae`,
    },
    sound: { music: 0, ambience: 0 },
  };
}

describe('which world the screens before the world stand on', () => {
  it('is the human ground first, then the selection maps in table order', () => {
    const worlds = selectionWorlds(
      [
        { id: 35, world: 'world/selection.wld' },
        { id: 1, world: 'world/land1.wld' },
        { id: 24, world: 'world/mendel_selection.wld' },
        { id: 2, world: 'world/human_selection.wld' },
      ],
      [],
    );
    expect(worlds.map(world => world.stem)).toEqual([
      'human_selection',
      'mendel_selection',
      'selection',
    ]);
  });

  it('takes a world no map row names by its pack', () => {
    const unlisted = {
      ...zone(900_000, -1, [0, 0, 0, 0]),
      mapName: 'human_selection',
      world: 'human_selection',
    };
    expect(selectionWorlds([], [unlisted])).toEqual([
      { mapId: -1, stem: 'human_selection', listed: false },
    ]);
  });
});

describe('the ground on a world named after itself', () => {
  const village = standing('model/scene/build/human/human_selection.bdae', [58.6, 4, 44.8]);
  const open = standing('model/scene/build/human/human_selection01.bdae', [232.8, 15.2, 214.8]);
  const login = standing('model/scene/build/login/login01.bdae', [60, 4, 45]);
  const tiles: StandCandidate[] = [
    { stand: village, tile: [0, 0], near: [village, ...crowd(village, 44)] },
    { stand: open, tile: [3, 3], near: [open, ...crowd(open, 2)] },
    { stand: login, tile: [0, 0], near: [login] },
  ];
  const unlisted = { mapId: -1, stem: 'human_selection', listed: false };

  it('is asked for by pack, on the open dais, under the dome named after it', () => {
    expect(resolveGround(unlisted, tiles, [])).toEqual({
      mapId: -1,
      world: 'human_selection',
      stand: open,
      tile: [3, 3],
      sky: 'model/scene/sky/general_sky/humanselection_sky.bdae',
      hill: 'model/scene/sky/general_sky/humanselection_sky_hill.bdae',
    });
  });

  it('looks for its dais only within five tiles of the middle', () => {
    const far = standing('model/scene/build/human/human_selection_stone01.bdae', [600, 0, 600]);
    const ground = resolveGround(
      unlisted,
      [...tiles, { stand: far, tile: [9, 9], near: [far] }],
      [],
    );
    expect(ground?.stand).toBe(open);
  });

  it('takes the sky of its zone where its map is listed', () => {
    const listed = { mapId: 2, stem: 'human_selection', listed: true };
    const ground = resolveGround(listed, tiles, [zone(323, 2, [-364, -64, 648, 648])]);
    expect(ground?.mapId).toBe(2);
    expect(ground?.world).toBeUndefined();
    expect(ground?.stand).toBe(open);
    expect(ground?.sky).toBe('sky323.bdae');
  });

  it('is none where nothing is named after it', () => {
    const tree = standing('model/scene/nature/tree.bdae', [0, 0, 0]);
    expect(resolveGround(unlisted, [{ stand: tree, tile: [0, 0], near: [tree] }], [])).toBeNull();
  });
});
