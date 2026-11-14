/**
 * The right-edge spell bar: a run of slots and a mount slot, a sliding
 * handle, the movie's sweep, tints and flashes; in a build whose run is
 * taller than its window, the run slides under it. Rules in `spellBarModel`.
 */

import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { getSpellIcon, getSpellName, spellStats, wantSpellStats } from '../../gameplay/SpellBook';
import { barRun } from '../art/faceRuns';
import type { FaceRun } from '../art/faceRuns';
import type { PieceBox, PiecePart, PlanStates } from '../art/piecePlan';
import type { ScreenSpec } from '../art/uiSpec';
import { useWorn, useWornScreen } from '../art/useWorn';
import type { Worn as WornLayer } from '../art/useWorn';
import { rowGestures, rowSlide, useListScroll } from '../art/wornList';
import { iconUrl } from '../iconUrl';
import {
  closedShift,
  barPlacement,
  barSwap,
  spellBarCoversCorner,
  governingCooldown,
  iconBox,
  jumpRoom,
  slotPlace,
  slotRefs,
  slotUse,
  spellBarStates,
  sweepFace,
  windowShown,
} from '../spellBarModel';
import type { SlotCooldown, SlotNames, SlotRef, SlotView } from '../spellBarModel';
import { cx } from './cx';
import { useFlashes } from './useFlashes';
import { spellDrag, spellDragOver, startSpellDrag } from './spellDrag';

/** Our name for this screen. The spec says which dialog wears it. */
export const SPELL_BAR_SCREEN = 'spellBar';

/** The bar stands at its own size down the edge, not at a place on a stage. */
const EDGE = { unplaced: true } as const;

export interface ArtSpellBarProps {
  /** One entry per slot of the numbered run, null for an empty one. */
  spells: ReadonlyArray<number | null>;
  /** The spell the mount's own slot holds. */
  mountSpell: number | null;
  cooldowns: ReadonlyMap<number, SlotCooldown>;
  globalCooldown: SlotCooldown | null;
  castingSpellId: number | null;
  /** What the hero has to spend on a spell. */
  power: number;
  dead: boolean;
  onCast(spellId: number): void;
  /** Put a spell in a slot, or empty it: a slot held and dropped on another trades places with it. */
  onPlace(slot: number, spellId: number | null): void;
  open: boolean;
  onOpenChange(open: boolean): void;
}

/** Null where there is no movie to wear, which means there is no bar. */
export function ArtSpellBar(props: ArtSpellBarProps): JSX.Element | null {
  const spec = useWornScreen(SPELL_BAR_SCREEN);
  return spec?.grids?.slots && spec.groups ? <Worn {...props} spec={spec} /> : null;
}

/** The names the spec gives what lies in and beside a slot. */
function namesOf(spec: ScreenSpec): SlotNames {
  const grid = spec.grids!.slots!;
  const groups = spec.groups!;
  return {
    slot: grid.slot,
    within: grid.within!,
    mount: groups.mount,
    sweep: groups.sweep!,
    unusable: groups.unusable!,
    short: groups.short!,
    lit: groups.lit!,
    resting: groups.resting!,
    flash: groups.flash!,
  };
}

/** How tall the view is, kept current as it is resized. */
function useViewportHeight(): number {
  const [height, setHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const measure = (): void => setHeight(window.innerHeight);
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  return height;
}

/** Whether a part is `holder` or lies inside it. */
function under(path: string, holder: string): boolean {
  return path === holder || path.startsWith(`${holder}/`);
}

function Worn({
  spells,
  mountSpell,
  cooldowns,
  globalCooldown,
  castingSpellId,
  power,
  dead,
  onCast,
  onPlace,
  open,
  onOpenChange,
  spec,
}: ArtSpellBarProps & { spec: ScreenSpec }): JSX.Element | null {
  const names = namesOf(spec);
  const bars = spec.bars;
  const sweepRun = bars ? barRun(bars, `${names.within}/${names.slot}01/${names.sweep}`) : null;
  const flashRun: FaceRun = { first: 0, last: bars?.own?.flash?.frames ?? 0 };
  /** The run of slots that slides, and the window it slides under, where the build has them. */
  const slider = spec.panels?.slider;
  const windowName = spec.panels?.window;
  const slides = Boolean(slider && windowName);
  const scroll = useListScroll();
  /** Where the run stood when a press began, so a press that slid it does not cast. */
  const pressedAt = useRef<number | null>(null);
  /** The window, for how tall a row is on screen. */
  const windowRef = useRef<HTMLDivElement>(null);

  // One entry per place on the bar, the mount's last.
  const held = [...spells, mountSpell];
  const placeOf = (slot: SlotRef): number | null =>
    slotPlace(slot.index, slot.path === names.mount, spells.length);
  const spellIn = (slot: SlotRef): number | null => {
    const at = placeOf(slot);
    return at === null ? null : (held[at] ?? null);
  };
  const stats = spellStats.value;
  const heldKey = held.join(',');
  useEffect(() => {
    wantSpellStats(held.filter((id): id is number => id !== null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heldKey]);
  const cooling = held.map(id => (id === null ? false : (cooldowns.get(id)?.remaining ?? 0) > 0));
  const flashes = useFlashes(cooling, flashRun);
  const dragOver = spellDragOver.value;
  const [pressedSlot, setPressedSlot] = useState<number | null>(null);
  /** Set by a drag's drop, so the click that ends the same press does not cast. */
  const dropped = useRef(false);
  const viewHeight = useViewportHeight();

  const viewOf = (slot: SlotRef): SlotView => {
    const at = placeOf(slot);
    const spellId = spellIn(slot);
    const cd = spellId === null ? null : governingCooldown(cooldowns.get(spellId), globalCooldown);
    return {
      filled: spellId !== null,
      pressed: at !== null && pressedSlot === at,
      sweep: sweepRun ? sweepFace(cd, sweepRun) : null,
      use:
        spellId === null
          ? 'ready'
          : slotUse({
              cost: stats.get(spellId)?.powerCost,
              power,
              dead,
            }),
      lit: (spellId !== null && spellId === castingSpellId) || (at !== null && dragOver === at),
      flash: at === null ? null : (flashes[at] ?? null),
    };
  };
  const statesFor = (whole: PiecePart[]): ReturnType<typeof spellBarStates> => {
    const refs = slotRefs(whole, names);
    return spellBarStates(refs, refs.map(viewOf), { dialog: spec.dialog, open });
  };
  const baseOf = (whole: PiecePart[]): { hidden: string[]; frames: Record<string, number> } => {
    const { base } = statesFor(whole);
    // The mount's slot is there only while riding.
    const onFoot = mountSpell === null && names.mount ? [names.mount] : [];
    return { hidden: [...(spec.hidden ?? []), ...base.hidden, ...onFoot], frames: base.frames };
  };
  /** What is lit over the slots, the run's or the rest's where the run slides on its own. */
  const overOf = (whole: PiecePart[], inRun: boolean): PlanStates => {
    const { base, over: on } = statesFor(whole);
    const only = slides ? on.only.filter(path => under(path, slider!) === inRun) : on.only;
    return { only, driven: on.driven, frames: { ...base.frames, ...on.frames } };
  };

  const worn = useWorn(
    spec.dialog,
    spec.frame,
    (whole): PlanStates => {
      const base = baseOf(whole);
      return slides ? { ...base, hidden: [...base.hidden, slider!] } : base;
    },
    EDGE,
  );
  const over = useWorn(spec.dialog, spec.frame, whole => overOf(whole, false), EDGE);
  // The run drawn apart, to slide; a bar that does not slide has none.
  const run = useWorn(
    slides ? spec.dialog : undefined,
    slider,
    (whole): PlanStates => ({ ...baseOf(whole), only: slider! }),
    EDGE,
  );
  const runOver = useWorn(
    slides ? spec.dialog : undefined,
    slider,
    whole => overOf(whole, true),
    EDGE,
  );

  if (!worn.image || !worn.frame) return null;
  const frame = worn.frame;
  const refs = slotRefs(worn.whole, names);
  // The control that opens the bar, or the one that stands in its place on the face where it is out.
  const framed = new Set([spec.frame].flat());
  const handle = worn.parts.find(
    part =>
      part.draws &&
      !part.path.includes('/') &&
      (part.path === spec.groups!.handle || !framed.has(part.path)),
  );
  const shift = open || !worn.onStage || !worn.stage ? 0 : closedShift(worn.onStage, worn.stage.w);
  // Between the minimap and the jump button, as the movie leaves room.
  const top = (worn.onStage?.y ?? 0) * worn.perUnit;
  const roomAbove = viewHeight - top - jumpRoom.value;

  /** The window the run slides under, in the frame's space, and how the run slides. */
  const window_ = slides ? worn.find(windowName) : undefined;
  const sliding =
    slides && window_ && run.frame
      ? (() => {
          const whole = worn.whole;
          const inRun = refs.filter(slot => under(slot.path, slider!));
          const boxOf = (path: string): PieceBox | undefined =>
            whole.find(part => part.path === path)?.box;
          const slots = inRun.map(slot => boxOf(slot.path)).filter(Boolean) as PieceBox[];
          const windowWhole = boxOf(windowName!) ?? window_.box;
          const how = rowSlide(slots, windowWhole);
          // What stands beside the window is never cut off: the handle and the mount's slot.
          const beside = worn.parts
            .filter(part => part.draws && !part.path.includes('/'))
            .map(part => part.box.y + part.box.h - window_.box.y);
          const shown = windowShown(
            window_.box.h,
            roomAbove / worn.perUnit,
            Math.max(0, ...beside.filter(bottom => bottom <= window_.box.h)),
          );
          // Shown less than whole, the window's foot moves up, and the run slides further.
          const furthest = rowSlide(slots, { y: windowWhole.y, h: shown }).furthest;
          return { ...how, furthest, shown, inRun };
        })()
      : null;
  const atRow = sliding ? Math.min(scroll.at, sliding.furthest) : 0;
  const tall = (sliding ? window_!.box.y + sliding.shown : frame.h) * worn.perUnit;
  const { covers, fit } = barPlacement(open, roomAbove, viewHeight - top, tall);
  useEffect(() => {
    spellBarCoversCorner.value = covers;
    return () => {
      spellBarCoversCorner.value = false;
    };
  }, [covers]);
  const pct = (units: number, of: number): string => `${(units / of) * 100}%`;
  const atIn = (box: PiecePart['box'], within: PieceBox): JSX.CSSProperties => ({
    position: 'absolute',
    left: pct(box.x, within.w),
    top: pct(box.y, within.h),
    width: pct(box.w, within.w),
    height: pct(box.h, within.h),
  });
  const at = (box: PiecePart['box']): JSX.CSSProperties => atIn(box, frame);

  /** The pictures in a layer's slots, under what is lit over them. */
  const icons = (layer: WornLayer, slots: readonly SlotRef[]): Array<JSX.Element | null> =>
    slots.map(slot => {
      const spellId = spellIn(slot);
      const icon = spellId === null ? undefined : getSpellIcon(spellId);
      const drawn = layer.parts.find(part => part.path === slot.path);
      const whole = layer.whole.find(part => part.path === slot.path);
      const tint = layer.whole.find(part => part.path === slot.unusable);
      if (!drawn || !icon || !whole || !layer.frame) return null;
      return (
        <img
          key={`icon-${slot.path}`}
          data-spell-icon={placeOf(slot) ?? undefined}
          src={iconUrl(icon)}
          alt=""
          aria-hidden="true"
          className="pointer-events-none rounded-full object-cover"
          style={atIn(iconBox(whole.box, tint?.box, drawn.box), layer.frame)}
          draggable={false}
        />
      );
    });
  /** A press area on each of a layer's slots that keeps a place. */
  const presses = (layer: WornLayer, slots: readonly SlotRef[]): Array<JSX.Element | null> =>
    slots.map(slot => {
      const drawn = layer.parts.find(part => part.path === slot.path);
      const place = placeOf(slot);
      if (!drawn || !layer.frame) return null;
      const spellId = spellIn(slot);
      const view = viewOf(slot);
      return (
        <button
          key={slot.path}
          type="button"
          data-spell-slot={place ?? undefined}
          data-use={view.use}
          aria-label={
            spellId === null ? `Empty slot ${(place ?? slot.index) + 1}` : getSpellName(spellId)
          }
          title={spellId === null ? undefined : getSpellName(spellId)}
          aria-disabled={spellId === null || view.sweep !== null}
          onPointerDown={(event: PointerEvent) => {
            if (spellId === null || place === null) return;
            setPressedSlot(place);
            startSpellDrag(event, spellId, (_spell, to) => {
              dropped.current = true;
              setPressedSlot(null);
              for (const [where, id] of barSwap(place, to, held) ?? []) onPlace(where, id);
            });
          }}
          onPointerUp={() => setPressedSlot(null)}
          onPointerLeave={() => setPressedSlot(null)}
          onPointerCancel={() => setPressedSlot(null)}
          onClick={() => {
            if (dropped.current) {
              dropped.current = false;
              return;
            }
            // A press that slid the run was moving it, not casting.
            const slid = pressedAt.current !== null && pressedAt.current !== atRow;
            pressedAt.current = null;
            if (slid) return;
            if (spellId !== null && view.sweep === null) onCast(spellId);
          }}
          className={cx(
            'pointer-events-auto cursor-pointer rounded-full border-0 bg-transparent p-0',
            'focus-visible:outline-none aria-disabled:cursor-default',
          )}
          style={atIn(drawn.box, layer.frame)}
        />
      );
    });

  const fixed = sliding ? refs.filter(slot => !sliding.inRun.includes(slot)) : refs;
  /** How far the run stands from the window's corner, in movie units. */
  const runAt =
    sliding && run.frame
      ? {
          x: run.frame.x - (frame.x + window_!.box.x),
          y: run.frame.y - (frame.y + window_!.box.y) + sliding.rest - atRow * sliding.pitch,
        }
      : null;

  const bar = (
    <div
      data-spell-bar
      data-open={open}
      className="relative transition-transform duration-200 ease-out"
      style={{ ...worn.sized, transform: `translateX(${shift * 100}%)` }}
    >
      <img
        ref={worn.pictureRef}
        src={worn.image.url}
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={worn.sized}
        draggable={false}
      />
      {icons(worn, fixed)}
      {over.image && (
        <img
          src={over.image.url}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={over.sized}
          draggable={false}
        />
      )}
      {presses(worn, fixed)}
      {sliding && window_ && runAt && run.frame && run.image ? (
        <div
          ref={windowRef}
          data-spell-window
          data-row={atRow}
          className="pointer-events-auto absolute touch-none overflow-hidden"
          style={at(window_.box)}
          onPointerDownCapture={() => {
            pressedAt.current = atRow;
          }}
          {...rowGestures(
            scroll,
            () => {
              const box = windowRef.current?.getBoundingClientRect();
              return box && window_.box.h ? (box.height / window_.box.h) * sliding.pitch : 0;
            },
            sliding.furthest,
            () => spellDrag.value !== null,
          )}
        >
          <div
            data-spell-run
            className="absolute"
            style={atIn({ ...run.frame, x: runAt.x, y: runAt.y }, window_.box)}
          >
            <img
              src={run.image.url}
              alt=""
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 h-full w-full"
              draggable={false}
            />
            {icons(run, sliding.inRun)}
            {runOver.image && (
              <img
                src={runOver.image.url}
                alt=""
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 h-full w-full"
                draggable={false}
              />
            )}
            {presses(run, sliding.inRun)}
          </div>
        </div>
      ) : null}
      {handle && (
        <button
          type="button"
          aria-label={open ? 'Hide spell bar' : 'Show spell bar'}
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
          className="pointer-events-auto cursor-pointer border-0 bg-transparent p-0 focus-visible:outline-none"
          style={at(handle.box)}
        />
      )}
    </div>
  );

  return (
    <div
      className="pointer-events-none fixed right-safe-r z-hud-bar origin-bottom-right"
      style={{
        bottom: covers ? 'env(safe-area-inset-bottom)' : `${jumpRoom.value}px`,
        transform: `scale(${fit})`,
      }}
    >
      {sliding ? (
        // Only as much of the window as there is room for: the run slides
        // under what is shown.
        <div className="overflow-hidden" style={{ width: worn.sized.width, height: `${tall}px` }}>
          {bar}
        </div>
      ) : (
        bar
      )}
    </div>
  );
}
