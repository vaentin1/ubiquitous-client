/**
 * The clips a body plays to loot and to die, by the clip names the user's
 * `c_animationdata` table lists. The same name plays on every model, so the
 * client asks for the clip by name rather than through a table row. Attack
 * clips are in `combatResults.ts`.
 */

import type { GeneralSpells } from '../assets/types';

/**
 * Kneeling at an open body: a one-shot crouch that settles into a held one,
 * held for as long as the loot window is up.
 */
export const LOOT_START_CLIP = 'pickup_start';
export const LOOT_HOLD_CLIP = 'pickup_hold';

/**
 * What a gatherer holds while the gather plays, for show only: it is never
 * equipped. Mining holds item 13, whose icon is the pick's and whose model is
 * the miner's dig (the owner's recollection of play). Other gathers hold nothing.
 */
export const MINING_HELD_ITEM = 13;

/** The item a cast of `spellId` puts in the caster's hand, if it is a gather that shows one. */
export function gatherHeldItem(spells: GeneralSpells | null, spellId: number): number | undefined {
  return spells && spells.mining !== 0 && spellId === spells.mining ? MINING_HELD_ITEM : undefined;
}

/** A gather has no release of its own: the loot window that follows kneels the body. */
export function isGather(spells: GeneralSpells | null, spellId: number): boolean {
  return spells !== null && spells.gathering.includes(spellId);
}

/** The fall a body plays when it dies, and holds as a corpse. */
export const DEATH_CLIP = 'die_ground';

/** Every clip named here, for checking against the user's table. */
export const ACTION_CLIPS: readonly string[] = [LOOT_START_CLIP, LOOT_HOLD_CLIP, DEATH_CLIP];
