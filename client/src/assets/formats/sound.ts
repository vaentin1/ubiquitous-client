/**
 * One sound file, of whichever coding it holds. The coding is told by the
 * file's first bytes rather than its name: 4.2.2 ships RIFF/WAVE files under
 * `.mpc` names beside its Musepack ones.
 */

import { decodeMpc, isMusepack } from './musepack';
import { decodeWav, type PcmData } from './wav';

/** Throws `MpcError` or `WavError` on anything it cannot read. */
export function decodeSound(bytes: Uint8Array): PcmData {
  return isMusepack(bytes) ? decodeMpc(bytes) : decodeWav(bytes);
}
