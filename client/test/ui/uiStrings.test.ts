import { describe, expect, it } from 'vitest';

import { readUiStrings } from '../../src/assets/formats/uiStrings';
import { buildUiStrings as file } from '../helpers/fixtures';

describe('readUiStrings', () => {
  it('reads every word of every group, in the order the build numbered them', () => {
    const words = readUiStrings(file([['Quest', 'Trade', 'OK'], ['Warning']]));
    expect(words).toEqual([['Quest', 'Trade', 'OK'], ['Warning']]);
  });

  it('keeps an empty word where the build left one', () => {
    // A number with nothing behind it is a caption the build never set,
    // not a file that failed to read: the numbering has to stay put.
    expect(readUiStrings(file([['Bid', '', 'Auction']]))[0]).toEqual(['Bid', '', 'Auction']);
  });

  it('comes back empty rather than throwing on anything else', () => {
    // A build shipping no words leaves every screen to its own styling,
    // which is a thing screens are allowed to be.
    expect(readUiStrings(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual([]);
    expect(readUiStrings(new Uint8Array(0))).toEqual([]);
  });
});
