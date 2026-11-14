/**
 * The ground the screens before the world stand on: which world it is,
 * which placement in it a character is stood on, and the weather over it.
 * Every build ships it as an ordinary map pack; what differs is how the
 * build names it and its stand.
 */

import { TILE_SIZE } from '../formats/tables';
import type { Placement, SelectionGround, ZoneInfo } from '../types';

/** The ground through 2.2.0, kept wherever its pack still holds tiles. */
const FIRST_GROUND = 'human_selection';

/** Where 4.2.2 keeps the stand of its selection ground, which nothing is named after. */
const STAND_FOLDER = 'model/scene/build/login/';

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

/** Which way a body on 4.2.2's plinth faces: the plinth's own way, its steps being at its front. */
export function standFacing(stand: Placement): number {
  const [, y, , w] = stand.rotation;
  return 2 * Math.atan2(y, w);
}

/** The smallest zone on the map whose rectangle holds a point, or none. */
export function zoneOver(
  zones: readonly ZoneInfo[],
  mapId: number,
  x: number,
  z: number,
): ZoneInfo | null {
  const area = (zone: ZoneInfo): number =>
    Math.abs((zone.bounds[2] - zone.bounds[0]) * (zone.bounds[3] - zone.bounds[1]));
  const holding = zones.filter(
    zone =>
      zone.mapId === mapId &&
      x >= Math.min(zone.bounds[0], zone.bounds[2]) &&
      x <= Math.max(zone.bounds[0], zone.bounds[2]) &&
      z >= Math.min(zone.bounds[1], zone.bounds[3]) &&
      z <= Math.max(zone.bounds[1], zone.bounds[3]),
  );
  return holding.sort((a, b) => area(a) - area(b))[0] ?? null;
}

/** The stand nearest the middle of the zone it stands in; none when no zone holds one. */
export function nearestZoneMiddle(
  candidates: readonly StandCandidate[],
  zones: readonly ZoneInfo[],
  mapId: number,
): StandCandidate | null {
  let best: { found: StandCandidate; away: number } | null = null;
  for (const found of candidates) {
    const [x, , z] = found.stand.position;
    const zone = zoneOver(zones, mapId, x, z);
    if (!zone) continue;
    const away = Math.hypot(x - zone.centre[0], z - zone.centre[1]);
    if (!best || away < best.away) best = { found, away };
  }
  return best?.found ?? null;
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
 * nothing in it is a stand.
 *
 * Through 2.2.0 the stand is named after its world (`human_selection01.bdae`)
 * and looked for within `LOOK_OUT` tiles of the middle of the world's zone
 * (one with scenery first); of the two the one with room round it wins
 * (`clearestStand`), the other being hemmed in by a village. That ground
 * keeps the screens' own facing and haze.
 *
 * 4.2.2 names nothing after its world and keeps the stand in its login
 * folder; of its two the one nearest the middle of the zone over it
 * (`nearestZoneMiddle`) is the one ringed by braziers, and the ground
 * takes that zone's weather and the stand's own facing.
 */
export function resolveGround(
  world: GroundWorld,
  tiles: readonly StandCandidate[],
  zones: readonly ZoneInfo[],
): SelectionGround | null {
  const onMap = world.listed ? zones.filter(zone => zone.mapId === world.mapId) : [];
  const where = world.listed ? { mapId: world.mapId } : { mapId: -1, world: world.stem };

  const named = tiles.filter(one => fileStem(one.stand.model).startsWith(world.stem.toLowerCase()));
  if (named.length) {
    const zone = onMap.find(one => one.hasScenery) ?? onMap[0] ?? null;
    const middle = zone ? zone.centre : [0, 0];
    const tx = Math.floor(middle[0] / TILE_SIZE);
    const tz = Math.floor(middle[1] / TILE_SIZE);
    const near = named.filter(
      one => Math.max(Math.abs(one.tile[0] - tx), Math.abs(one.tile[1] - tz)) <= LOOK_OUT,
    );
    const found = clearestStand(near, middle);
    if (!found) return null;
    return {
      ...where,
      stand: found.stand,
      tile: found.tile,
      atmosphere: null,
      ...groundSky(world.stem, zone),
    };
  }

  const filed = tiles.filter(one => one.stand.model.toLowerCase().startsWith(STAND_FOLDER));
  const found = nearestZoneMiddle(filed, onMap, world.mapId);
  if (!found) return null;
  const [x, , z] = found.stand.position;
  const zone = zoneOver(onMap, world.mapId, x, z);
  return {
    ...where,
    stand: found.stand,
    tile: found.tile,
    facing: standFacing(found.stand),
    atmosphere: zone?.atmosphere ?? null,
    ...groundSky(world.stem, zone),
  };
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
