/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** What every picture of the bar was asked to draw. */
const asked: Array<{
  frames?: Record<string, number>;
  driven?: readonly string[];
  hidden?: readonly string[];
  only?: string | readonly string[];
}> = [];
vi.mock('../../src/ui/art/pieceCanvas', () => ({
  drawPiece: () => ({ url: 'blob:bar', width: 100, height: 100 }),
}));
vi.mock('../../src/ui/iconUrl', () => ({ iconUrl: () => 'blob:icon' }));
vi.mock('../../src/ui/art/piecePlan', async actual => {
  const real = await actual<typeof import('../../src/ui/art/piecePlan')>();
  return {
    ...real,
    planPiece: (...args: Parameters<typeof real.planPiece>) => {
      if ((args[1] === 'bar' || args[1] === 'slidingBar') && args[2]) asked.push(args[2]);
      return real.planPiece(...args);
    },
  };
});

import { setSpellIcon, setSpellName, setSpellStats } from '../../src/gameplay/SpellBook';
import { setMovie } from '../../src/ui/art/pieceStore';
import { uiSpec } from '../../src/ui/art/uiSpec';
import { ArtSpellBar } from '../../src/ui/components/ArtSpellBar';
import type { ArtSpellBarProps } from '../../src/ui/components/ArtSpellBar';
import { spellDragOver } from '../../src/ui/components/spellDrag';
import { clearMovies } from '../helpers/stores';
import {
  SLIDING_BAR_SPEC,
  SPELL_BAR_SPEC,
  slidingBarMovie,
  spellBarMovie,
} from '../helpers/spellBarMovie';

afterEach(() => {
  asked.length = 0;
  cleanup();
  clearMovies();
  uiSpec.value = null;
  spellDragOver.value = null;
});

function props(over: Partial<ArtSpellBarProps> = {}): ArtSpellBarProps {
  return {
    spells: [101, 102],
    mountSpell: 900,
    cooldowns: new Map(),
    globalCooldown: null,
    castingSpellId: null,
    power: 1000,
    dead: false,
    onCast: () => {},
    onPlace: () => {},
    open: true,
    onOpenChange: () => {},
    ...over,
  };
}

function wear(): void {
  uiSpec.value = { screens: { spellBar: SPELL_BAR_SPEC } };
  setMovie({ skin: spellBarMovie(), art: new Map() });
  setSpellName(101, 'Sample Bolt');
  setSpellName(102, 'Sample Ward');
  setSpellName(900, 'Sample Mount');
}

describe('ArtSpellBar', () => {
  it('draws nothing until the shipped bar has arrived', () => {
    const { container } = render(<ArtSpellBar {...props()} />);
    expect(container.innerHTML).toBe('');
  });

  it('puts one press area on each slot, the mount’s after the numbered ones', () => {
    wear();
    const { container } = render(<ArtSpellBar {...props()} />);
    const slots = [...container.querySelectorAll<HTMLElement>('[data-spell-slot]')];
    expect(slots.map(slot => slot.dataset.spellSlot)).toEqual(['0', '1', '2']);
    expect(slots.map(slot => slot.getAttribute('aria-label'))).toEqual([
      'Sample Bolt',
      'Sample Ward',
      'Sample Mount',
    ]);
  });

  it('has no mount slot on foot', () => {
    wear();
    const { container } = render(<ArtSpellBar {...props({ mountSpell: null })} />);
    const slots = [...container.querySelectorAll<HTMLElement>('[data-spell-slot]')];
    expect(slots.map(slot => slot.dataset.spellSlot)).toEqual(['0', '1']);
  });

  it('casts what is in a slot when it is pressed, the mount’s included', () => {
    wear();
    const onCast = vi.fn();
    const { getByLabelText } = render(<ArtSpellBar {...props({ onCast })} />);
    fireEvent.click(getByLabelText('Sample Bolt'));
    fireEvent.click(getByLabelText('Sample Mount'));
    expect(onCast.mock.calls).toEqual([[101], [900]]);
  });

  it('casts nothing from an empty slot', () => {
    wear();
    const onCast = vi.fn();
    const { getByLabelText } = render(<ArtSpellBar {...props({ spells: [101, null], onCast })} />);
    fireEvent.click(getByLabelText('Empty slot 2'));
    expect(onCast).not.toHaveBeenCalled();
  });

  it('casts nothing from a slot that is cooling, and sweeps it', () => {
    wear();
    const onCast = vi.fn();
    const { getByLabelText } = render(
      <ArtSpellBar
        {...props({ onCast, cooldowns: new Map([[101, { remaining: 500, total: 1000 }]]) })}
      />,
    );
    fireEvent.click(getByLabelText('Sample Bolt'));
    expect(onCast).not.toHaveBeenCalled();
    const overlay = asked.find(states => states.driven?.length);
    expect(overlay?.driven).toEqual(['panelButton/btn01/rectcooldown']);
    // Half the cooldown is left, so the clip is turned half way along its two faces.
    expect(overlay?.frames?.['panelButton/btn01/rectcooldown']).toBe(1);
  });

  it('tints a slot blue whose spell costs more than the hero has, and not one it can pay for', () => {
    wear();
    setSpellStats(101, {
      powerCost: 500,
      castMs: 0,
      cooldownMs: 0,
      range: 0,
      mount: false,
      pet: false,
      skillSet: 11,
      skillSetIcon: null,
    });
    setSpellStats(102, {
      powerCost: 5,
      castMs: 0,
      cooldownMs: 0,
      range: 0,
      mount: false,
      pet: false,
      skillSet: 11,
      skillSetIcon: null,
    });
    const { container } = render(<ArtSpellBar {...props({ power: 10 })} />);
    expect(container.querySelector('[data-spell-slot="0"]')!.getAttribute('data-use')).toBe(
      'short',
    );
    expect(container.querySelector('[data-spell-slot="1"]')!.getAttribute('data-use')).toBe(
      'ready',
    );
    const tinted = asked.flatMap(states => states.driven ?? []);
    expect(tinted).toEqual(['panelButton/btn01/bluemask']);
  });

  it('tints every filled slot red for a dead hero', () => {
    wear();
    const { container } = render(<ArtSpellBar {...props({ dead: true, spells: [101, null] })} />);
    expect(container.querySelector('[data-spell-slot="0"]')!.getAttribute('data-use')).toBe(
      'blocked',
    );
    const tinted = asked.flatMap(states => states.driven ?? []);
    expect(tinted).toContain('panelButton/btn01/redmask');
    expect(tinted).not.toContain('panelButton/btn02/redmask');
  });

  it('plays the flash on a slot whose own spell comes off cooldown, but not for the global one', () => {
    wear();
    const cooling = new Map([[101, { remaining: 500, total: 1000 }]]);
    const { rerender } = render(<ArtSpellBar {...props({ cooldowns: cooling })} />);
    expect(
      asked.some(states => states.frames?.['panelButton/cooldownFinish01'] !== undefined),
    ).toBe(false);
    asked.length = 0;
    rerender(<ArtSpellBar {...props()} />);
    expect(asked.some(states => states.frames?.['panelButton/cooldownFinish01'] === 0)).toBe(true);

    asked.length = 0;
    const global = { remaining: 800, total: 1500 };
    const { rerender: again } = render(<ArtSpellBar {...props({ globalCooldown: global })} />);
    again(<ArtSpellBar {...props()} />);
    expect(
      asked.some(states => states.frames?.['panelButton/cooldownFinish02'] !== undefined),
    ).toBe(false);
  });

  it('lights the slot being cast, and the one a dragged spell is over', () => {
    wear();
    spellDragOver.value = 1;
    render(<ArtSpellBar {...props({ castingSpellId: 101 })} />);
    const lit = asked.flatMap(states => states.driven ?? []);
    expect(lit).toContain('panelButton/btn01/hot');
    expect(lit).toContain('panelButton/btn02/hot');
  });

  it('turns the bar to the face that offers to close it while open, and to open it while closed', () => {
    wear();
    render(<ArtSpellBar {...props({ open: true })} />);
    expect(asked.at(-1)?.frames?.bar).toBe(1);
    cleanup();
    asked.length = 0;
    render(<ArtSpellBar {...props({ open: false })} />);
    expect(asked.at(-1)?.frames?.bar).toBe(0);
  });

  it('opens and closes from its handle', () => {
    wear();
    const onOpenChange = vi.fn();
    const { getByLabelText, rerender } = render(<ArtSpellBar {...props({ onOpenChange })} />);
    fireEvent.click(getByLabelText('Hide spell bar'));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    rerender(<ArtSpellBar {...props({ onOpenChange, open: false })} />);
    fireEvent.click(getByLabelText('Show spell bar'));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
  });

  it('shows the swirl on a slot only while it is pressed', () => {
    wear();
    const { getByLabelText } = render(<ArtSpellBar {...props()} />);
    const swirl = () => asked.at(-1)?.only ?? [];
    expect(swirl()).not.toContain('panelButton/beforeAttack01');
    fireEvent.pointerDown(getByLabelText('Sample Bolt'));
    expect(swirl()).toContain('panelButton/beforeAttack01');
    fireEvent.pointerUp(getByLabelText('Sample Bolt'));
    expect(swirl()).not.toContain('panelButton/beforeAttack01');
  });

  it('sets a spell’s icon in its slot', () => {
    wear();
    setSpellIcon(101, {} as ImageBitmap);
    const { container } = render(<ArtSpellBar {...props()} />);
    expect(container.querySelector('[data-spell-icon="0"]')).not.toBeNull();
    expect(container.querySelector('[data-spell-icon="1"]')).toBeNull();
  });

  it('has no window to slide under where the build’s bar shows whole', () => {
    wear();
    const { container } = render(<ArtSpellBar {...props()} />);
    expect(container.querySelector('[data-spell-window]')).toBeNull();
  });
});

describe('ArtSpellBar, where its run is taller than its window', () => {
  function wearSliding(): void {
    uiSpec.value = { screens: { spellBar: SLIDING_BAR_SPEC } };
    setMovie({ skin: slidingBarMovie(), art: new Map() });
    setSpellName(101, 'Sample Bolt');
    setSpellName(102, 'Sample Ward');
    setSpellName(900, 'Sample Mount');
  }

  it('draws the run apart, inside a window that cuts it off, and the rest of the bar outside', () => {
    wearSliding();
    const { container } = render(<ArtSpellBar {...props()} />);
    const window_ = container.querySelector<HTMLElement>('[data-spell-window]')!;
    expect(window_).not.toBeNull();
    expect(window_.className).toContain('overflow-hidden');
    const run = window_.querySelector('[data-spell-run]')!;
    expect(run.querySelectorAll('button')).toHaveLength(6);
    // The mount's slot stands beside the window, not in the run.
    expect(window_.querySelector('[aria-label="Sample Mount"]')).toBeNull();
    expect(container.querySelector('[aria-label="Sample Mount"]')).not.toBeNull();
    // The run alone is drawn to slide, and the rest is drawn without it.
    expect(asked.some(states => states.only === 'panelButton')).toBe(true);
    expect(asked.some(states => states.hidden?.includes('panelButton'))).toBe(true);
  });

  it('keeps a place for as many slots as the bar has places, and the mount’s after them', () => {
    wearSliding();
    const { container } = render(<ArtSpellBar {...props()} />);
    const slots = [...container.querySelectorAll<HTMLElement>('[data-spell-slot]')];
    // Two places and the mount's: the four slots past them take nothing.
    expect(slots.map(slot => slot.dataset.spellSlot).sort()).toEqual(['0', '1', '2']);
    expect(container.querySelector('[data-spell-slot="2"]')!.getAttribute('aria-label')).toBe(
      'Sample Mount',
    );
    expect(container.querySelector('[data-spell-run]')!.querySelectorAll('button')).toHaveLength(6);
  });

  it('slides a row at a time under a wheel, as far as its last row and no further', () => {
    wearSliding();
    const { container } = render(<ArtSpellBar {...props()} />);
    const window_ = () => container.querySelector<HTMLElement>('[data-spell-window]')!;
    expect(window_().dataset.row).toBe('0');
    const run = () => container.querySelector<HTMLElement>('[data-spell-run]')!.style.top;
    const atRest = run();
    fireEvent.wheel(window_(), { deltaY: 100 });
    expect(window_().dataset.row).toBe('1');
    expect(run()).not.toBe(atRest);
    for (let turn = 0; turn < 5; turn++) fireEvent.wheel(window_(), { deltaY: 100 });
    // Three rows in a window two rows tall: two rows to slide.
    expect(window_().dataset.row).toBe('2');
    fireEvent.wheel(window_(), { deltaY: -100 });
    expect(window_().dataset.row).toBe('1');
  });

  it('casts nothing from a press that slid the run, and casts from the next', () => {
    wearSliding();
    const onCast = vi.fn();
    const { container, getByLabelText } = render(<ArtSpellBar {...props({ onCast })} />);
    const window_ = container.querySelector<HTMLElement>('[data-spell-window]')!;
    const slot = getByLabelText('Sample Bolt');
    fireEvent.pointerDown(slot);
    fireEvent.wheel(window_, { deltaY: 100 });
    fireEvent.pointerUp(slot);
    fireEvent.click(slot);
    expect(onCast).not.toHaveBeenCalled();
    fireEvent.pointerDown(slot);
    fireEvent.pointerUp(slot);
    fireEvent.click(slot);
    expect(onCast).toHaveBeenCalledWith(101);
  });
});
