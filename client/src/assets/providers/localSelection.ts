/**
 * The ground the screens before the world stand on: which world it is,
 * which placement in it a character is stood on, and the sky over it.
 * Every build ships it as an ordinary map pack.
 */

import { TILE_SIZE } from '../formats/tables';
import type { Placement, SelectionGround, ZoneInfo } from '../types';

/** The ground through 2.2.0, kept wherever its pack still holds tiles. */
const FIRST_GROUND = 'human_selection';

/** Clear ground round a stand that counts as room: about half its width. */
const ELBOW_ROOM = 8;

/** How many tiles out from its zone's middle a stand named after its world is looked for. */
const LOOK_OUT = 5;

/** A world that may be the selection ground: a map row's, or a pack no row names. */
export interface GroundWorld {
  /** The map row's id, or -1 for a world the tables never list. */
  mapId: number;
  /** The pack stem the tiles live under (`world/<stem>/items/…`). */
  stem: string;
  listed: boolean;
}

/** A placement that could be the stand, with what else its tile holds. */
export interface StandCandidate {
  stand: Placement;
  tile: [number, number];
  near: readonly Placement[];
}

/**
 * The worlds named as selection grounds, in the order to try them: the
 * one the screens always stood on first, then the map table's, then
 * unlisted packs.
 */
export function selectionWorlds(
  maps: readonly { id: number; world: string }[],
  unlisted: readonly ZoneInfo[],
): GroundWorld[] {
  const stemOf = (path: string): string =>
    (path.split(/[\\/]/).pop() ?? '').replace(/\.[^.]*$/, '');
  const found: GroundWorld[] = [];
  for (const map of [...maps].sort((a, b) => a.id - b.id)) {
    const stem = stemOf(map.world);
    if (/selection$/i.test(stem)) found.push({ mapId: map.id, stem, listed: true });
  }
  for (const zone of unlisted) {
    const stem = zone.world ?? zone.mapName;
    if (/selection$/i.test(stem)) found.push({ mapId: -1, stem, listed: false });
  }
  const first = (world: GroundWorld): number => (world.stem.toLowerCase() === FIRST_GROUND ? 0 : 1);
  return found.sort((a, b) => first(a) - first(b));
}

function fileStem(model: string): string {
  const base = model.toLowerCase().split('/').pop() ?? model.toLowerCase();
  return base.replace(/\.[^.]*$/, '');
}

/** The stand with the fewest things crowding it; ties go to the one nearer the middle. */
export function clearestStand(
  candidates: readonly StandCandidate[],
  middle: readonly number[],
): StandCandidate | null {
  let best: { found: StandCandidate; crowd: number; away: number } | null = null;
  for (const found of candidates) {
    const crowd = found.near.filter(
      one => one !== found.stand && flatApart(one, found.stand) < ELBOW_ROOM,
    ).length;
    const away = Math.hypot(
      found.stand.position[0] - middle[0],
      found.stand.position[2] - middle[1],
    );
    if (!best || crowd < best.crowd || (crowd === best.crowd && away < best.away)) {
      best = { found, crowd, away };
    }
  }
  return best?.found ?? null;
}

function flatApart(one: Placement, other: Placement): number {
  return Math.hypot(one.position[0] - other.position[0], one.position[2] - other.position[2]);
}

/**
 * The ground on one world, from every placement its tiles hold; none when
 * nothing in it is a stand. The stand is named after its world
 * (`human_selection01.bdae`) and looked for within `LOOK_OUT` tiles of the
 * middle of the world's zone (one with scenery first); of the two the one
 * with room round it wins (`clearestStand`), the other being hemmed in by
 * a village.
 */
export function resolveGround(
  world: GroundWorld,
  tiles: readonly StandCandidate[],
  zones: readonly ZoneInfo[],
): SelectionGround | null {
  const onMap = world.listed ? zones.filter(zone => zone.mapId === world.mapId) : [];
  const where = world.listed ? { mapId: world.mapId } : { mapId: -1, world: world.stem };

  const named = tiles.filter(one => fileStem(one.stand.model).startsWith(world.stem.toLowerCase()));
  const zone = onMap.find(one => one.hasScenery) ?? onMap[0] ?? null;
  const middle = zone ? zone.centre : [0, 0];
  const tx = Math.floor(middle[0] / TILE_SIZE);
  const tz = Math.floor(middle[1] / TILE_SIZE);
  const near = named.filter(
    one => Math.max(Math.abs(one.tile[0] - tx), Math.abs(one.tile[1] - tz)) <= LOOK_OUT,
  );
  const found = clearestStand(near, middle);
  if (!found) return null;
  return { ...where, stand: found.stand, tile: found.tile, ...groundSky(world.stem, zone) };
}

/** The ground's dome and horizon: its zone's, else the ones named after it. */
export function groundSky(
  stem: string,
  zone: ZoneInfo | null,
): Pick<SelectionGround, 'sky' | 'hill'> {
  const sky = `model/scene/sky/general_sky/${stem.replace(/_/g, '')}_sky.bdae`;
  return {
    sky: zone?.atmosphere.skybox || sky,
    hill: zone?.atmosphere.skyHill || sky.replace(/\.bdae$/, '_hill.bdae'),
  };
}
