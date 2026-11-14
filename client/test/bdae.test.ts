/**
 * The BDAE reader against a hand-built file.
 *
 * The file is laid out as the reader expects: a 60-byte header ("BRES", the
 * little-endian mark 0xFFFE at +4, header size at +8, file size at +12, the
 * string table at +28, model info at +32, data at +40), a string table the
 * records point into by absolute offset, and a model-info block of
 * (count, offset) pairs at fixed positions.
 */

import { describe, expect, it } from 'vitest';

import { Bdae, BdaeError } from '../src/assets/formats/bdae';

class Layout {
  readonly bytes = new Uint8Array(2048);
  readonly dv = new DataView(this.bytes.buffer);
  private stringsEnd = 0;
  private readonly placed = new Map<string, number>();

  constructor(readonly stringsAt: number) {
    this.stringsEnd = stringsAt;
  }
  str(s: string): number {
    const known = this.placed.get(s);
    if (known !== undefined) return known;
    const at = this.stringsEnd;
    this.bytes.set(new TextEncoder().encode(s), at);
    this.stringsEnd += s.length + 1;
    this.placed.set(s, at);
    return at;
  }
  u32(at: number, ...vs: number[]): void {
    vs.forEach((v, i) => this.dv.setUint32(at + i * 4, v, true));
  }
  f32(at: number, ...vs: number[]): void {
    vs.forEach((v, i) => this.dv.setFloat32(at + i * 4, v, true));
  }
}

const STRINGS = 64;
const INFO = 512;
const TEXTURES = 700;
const TREES = 760;
const NODES = 800;
const INSTANCES = 1000;
const INSTANCE_DATA = 1020;

/** One texture, and one tree: a root node with a child that places a mesh. */
function sample(): Uint8Array {
  const l = new Layout(STRINGS);
  l.bytes.set(new TextEncoder().encode('BRES'), 0);
  l.dv.setUint16(4, 0xfffe, true);
  l.u32(8, 60, 1200);
  l.u32(28, STRINGS, INFO);
  l.u32(40, 1100);

  // Model info: textures at +76, node trees at +148.
  l.u32(INFO + 76, 1, TEXTURES);
  l.u32(TEXTURES, l.str('diffuse-image'), l.str('diffuse'), l.str('texture/wall.tga'));
  l.u32(INFO + 148, 1, TREES);
  l.u32(TREES + 8, 1, NODES);

  // Node record, 80 bytes: id, name, sid, then translation at +12, rotation
  // at +24, scale at +40, visibility at +52, children at +56, instances at +64.
  const node = (
    at: number,
    id: string,
    t: number[],
    children: [number, number],
    inst: [number, number],
  ) => {
    l.u32(at, l.str(id), l.str(`${id}-name`), l.str(`${id}-sid`));
    l.f32(at + 12, ...t);
    l.f32(at + 24, 0, 0, 0, 1);
    l.f32(at + 40, 1, 1, 1);
    l.u32(at + 52, 1);
    l.u32(at + 56, ...children);
    l.u32(at + 64, ...inst);
  };
  node(NODES, 'root', [1, 2, 3], [1, NODES + 80], [0, 0]);
  node(NODES + 80, 'child', [0, 5, 0], [0, 0], [1, INSTANCES]);
  // Instance: type 3 is geometry; its data holds the URL at +4.
  l.u32(INSTANCES, 3, INSTANCE_DATA);
  l.u32(INSTANCE_DATA + 4, l.str('#wall-mesh'));
  return l.bytes.subarray(0, 1200);
}

describe('Bdae', () => {
  it('reads the header fields at their offsets', () => {
    const bdae = new Bdae(sample());
    expect(bdae.header).toEqual({
      signature: 'BRES',
      version: 0,
      headerSize: 60,
      fileSize: 1200,
      stringTableOffset: STRINGS,
      modelInfoOffset: INFO,
      modelDataOffset: 1100,
    });
  });

  it('reads texture records as three string pointers', () => {
    expect(new Bdae(sample()).textures()).toEqual([
      { map: 'diffuse-image', mapFriendly: 'diffuse', file: 'texture/wall.tga' },
    ]);
  });

  it('reads the node tree: names, transform, children and instances', () => {
    const [root] = new Bdae(sample()).nodeHierarchy();
    expect(root).toMatchObject({
      id: 'root',
      name: 'root-name',
      sid: 'root-sid',
      translation: [1, 2, 3],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      visible: true,
      instances: [],
    });
    expect(root.children).toHaveLength(1);
    expect(root.children[0]).toMatchObject({
      id: 'child',
      translation: [0, 5, 0],
      // The leading '#' of the URL is dropped.
      instances: [{ type: 3, url: 'wall-mesh' }],
    });
  });

  it('places a geometry instance through its parents', () => {
    const [world] = new Bdae(sample()).placements().get('wall-mesh')!;
    // Identity rotations and unit scale: the translations add up.
    expect(world.slice(9, 12)).toEqual([1, 7, 3]);
  });

  it('reads a clip: samplers and channels by record, curves through self-relative offsets', () => {
    const l = new Layout(STRINGS);
    l.bytes.set(new TextEncoder().encode('BRES'), 0);
    l.dv.setUint16(4, 0xfffe, true);
    l.u32(8, 60, 1600);
    l.u32(28, STRINGS, INFO);

    const ANIM = 700;
    const SAMPLERS = 740;
    const CHANNELS = 780;
    const STORE = 820;
    const SEGMENT = 840;
    const DATA = 900;
    const KEYS = 1000;
    const VALUES = 1100;
    // Animation records: a (count, offset) pair at +36. The store is a single
    // pointer at +48, to (segment count, segment offset).
    l.u32(INFO + 36, 1, ANIM);
    l.u32(INFO + 48, STORE);
    // Animation record, 32 bytes: id, samplers (count, offset), channels.
    l.u32(ANIM, l.str('bob'), 1, SAMPLERS, 1, CHANNELS);
    // Sampler record, 28 bytes: interpolation, then encoding, components and
    // source number for the keys and for the values. Encoding 1 is one byte
    // per key, value type 6 is floats.
    l.u32(SAMPLERS, 1, 1, 1, 0, 6, 1, 1);
    // Channel record, 16 bytes: -1, target, kind, and a detail word whose low
    // byte 0xff names no morph target.
    l.dv.setInt32(CHANNELS, -1, true);
    l.u32(CHANNELS + 4, l.str('root'), 3, 0xff);
    l.u32(STORE, 1, SEGMENT);
    // Segment record, 24 bytes: start and end in ms, then the source table
    // pointer at +20.
    l.u32(SEGMENT, 0, 1000, 1, 0, 0, DATA);
    // Source table: a count, then (count, offset) per source, where the
    // offset counts from its own field.
    l.u32(DATA, 2);
    l.u32(DATA + 4, 2);
    l.dv.setInt32(DATA + 8, KEYS - (DATA + 8), true);
    l.u32(DATA + 12, 2);
    l.dv.setInt32(DATA + 16, VALUES - (DATA + 16), true);
    l.bytes.set([0, 30], KEYS);
    l.f32(VALUES, 7, 9);

    const [clip] = new Bdae(l.bytes.subarray(0, 1600)).animations();
    expect(clip.id).toBe('bob');
    expect(clip.channels).toEqual([{ target: 'root', type: 3, member: null }]);
    expect(clip.samplers[0].input.values).toEqual([0, 30]);
    expect(clip.samplers[0].output.values).toEqual([7, 9]);
  });

  it('rejects the wrong signature, byte order or header size', () => {
    const wrongSig = sample().slice();
    wrongSig[0] = 0x58;
    expect(() => new Bdae(wrongSig)).toThrow(BdaeError);
    const bigEndian = sample().slice();
    new DataView(bigEndian.buffer).setUint16(4, 0xfeff, true);
    expect(() => new Bdae(bigEndian)).toThrow(/little-endian/);
    const oddHeader = sample().slice();
    new DataView(oddHeader.buffer).setUint32(8, 64, true);
    expect(() => new Bdae(oddHeader)).toThrow(/header size/);
    expect(() => new Bdae(new Uint8Array(59))).toThrow(BdaeError);
  });
});

/**
 * The wide layout: an 80-byte header whose pointers take 8 bytes, strings and
 * data blocks reached by those 8-byte pointers, and every link from one
 * record to another counted from its own field.
 */
class WideFile {
  readonly bytes = new Uint8Array(4096);
  readonly dv = new DataView(this.bytes.buffer);
  private strings = 128;
  private end = 1024;
  readonly info = 800;

  str(s: string): number {
    this.dv.setUint32(this.strings, s.length, true);
    const text = this.strings + 4;
    this.bytes.set(new TextEncoder().encode(s), text);
    this.strings = text + Math.ceil((s.length + 1) / 4) * 4;
    return text;
  }
  alloc(size: number): number {
    const at = this.end;
    this.end += Math.ceil(size / 8) * 8;
    return at;
  }
  u32(at: number, ...vs: number[]): void {
    vs.forEach((v, i) => this.dv.setUint32(at + i * 4, v >>> 0, true));
  }
  f32(at: number, ...vs: number[]): void {
    vs.forEach((v, i) => this.dv.setFloat32(at + i * 4, v, true));
  }
  /** An 8-byte pointer from the file start. */
  ptr(at: number, target: number): void {
    this.u32(at, target, 0);
  }
  /** A link that counts from its own field. */
  link(at: number, target: number): void {
    this.dv.setInt32(at, target - at, true);
  }
  list(at: number, count: number, size: number): number {
    const records = this.alloc(count * size);
    this.u32(at, count);
    this.link(at + 4, records);
    return records;
  }
  done(): Uint8Array {
    const size = this.end;
    this.bytes.set(new TextEncoder().encode('BRES'), 0);
    this.dv.setUint16(4, 0xfffe, true);
    this.u32(8, 80, size);
    this.ptr(24, 80);
    this.ptr(32, 128);
    this.ptr(40, this.info);
    this.ptr(48, this.info + 208);
    this.ptr(56, size);
    this.ptr(this.info, this.str('synthetic'));
    return this.bytes.slice(0, size);
  }
}

/**
 * A triangle mesh placed by a child node, skinned to one joint and blended
 * towards a second geometry, with one clip that drives the blend weight.
 */
function wideSample(): Uint8Array {
  const f = new WideFile();
  const info = f.info;

  const texture = f.list(info + 96, 1, 40);
  f.ptr(texture, f.str('wall-image'));
  f.ptr(texture + 8, f.str('wall'));
  f.ptr(texture + 16, f.str('texture/wall.tga'));

  // Material, 56 bytes, with one 32-byte sampler parameter whose value links
  // to a surface naming texture 0.
  const material = f.list(info + 112, 1, 56);
  f.ptr(material, f.str('stone'));
  f.ptr(material + 24, f.str('#stone-fx'));
  const param = f.list(material + 32, 1, 32);
  f.ptr(param, f.str('diffuse'));
  f.u32(param + 16, 11, 1);
  const value = f.alloc(16);
  const surface = f.alloc(8);
  f.u32(value, 1);
  f.link(value + 8, surface);
  f.link(param + 28, value + 8);
  f.u32(surface, 0);

  // Two geometries, 24 bytes each: the mesh, then a morph target of it.
  const geometries = f.list(info + 120, 2, 24);
  const mesh = (at: number, id: string, lift: number): void => {
    f.ptr(at, f.str(id));
    const data = f.alloc(48);
    f.link(at + 20, data);
    f.u32(data, 1, 3);
    const format = f.alloc(56);
    f.link(data + 8, format);
    f.u32(format, 12);
    f.u32(f.list(format + 4, 1, 4), 0);
    f.u32(f.list(format + 12, 1, 4), 6);
    f.u32(f.list(format + 20, 1, 4), 3);
    const vertices = f.alloc(4 + 36);
    f.u32(vertices, 1);
    f.f32(vertices + 4, 0, 0, lift, 1, 0, lift, 0, 1, lift);
    f.ptr(format + 40, vertices);
    f.f32(data + 20, 0, 0, lift, 1, 1, lift);
    // Part, 80 bytes: material at +8, slot map at +20, indices at +48, +56.
    const part = f.list(data + 12, 1, 80);
    f.ptr(part + 8, f.str('stone'));
    f.u32(part + 16, 1);
    f.bytes.fill(0xff, part + 20, part + 36);
    f.bytes[part + 20] = 0;
    f.u32(part + 48, 3);
    const indices = f.alloc(4 + 8);
    f.u32(indices, 1);
    new Uint16Array(f.bytes.buffer, indices + 4, 3).set([0, 1, 2]);
    f.ptr(part + 56, indices);
  };
  mesh(geometries, 'wall-mesh', 0);
  mesh(geometries + 24, 'wall-lifted', 2);

  // Controllers, 24 bytes: a skin, then a morph.
  const controllers = f.list(info + 128, 2, 24);
  f.u32(controllers, 0);
  f.ptr(controllers + 8, f.str('wall-mesh-skin'));
  const skin = f.alloc(184);
  f.link(controllers + 16, skin);
  const binds = f.alloc(64);
  f.f32(binds, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  f.u32(skin, 16);
  f.link(skin + 4, binds);
  f.f32(skin + 16, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  f.ptr(skin + 112, f.str('#wall-mesh'));
  f.ptr(f.list(skin + 120, 1, 8), f.str('bone'));
  f.u32(skin + 128, 3 * 2);
  const weights = f.alloc(4 + 3 * 8);
  f.u32(weights, 2);
  for (let i = 0; i < 3; i++) f.f32(weights + 4 + i * 8 + 4, 1);
  f.ptr(skin + 136, weights);
  f.u32(skin + 176, 1);

  f.u32(controllers + 24, 1);
  f.ptr(controllers + 32, f.str('wall-mesh-morpher'));
  const morph = f.alloc(40);
  f.link(controllers + 40, morph);
  f.ptr(morph, f.str('#wall-mesh'));
  f.ptr(f.list(morph + 12, 1, 8), f.str('wall-lifted'));
  // Target indices take 8 bytes each.
  f.u32(f.list(morph + 20, 1, 8), 1, 0);
  f.f32(f.list(morph + 28, 1, 4), 0.25);

  // Node tree, 24 bytes; nodes, 96 bytes; the child instances the morph.
  const tree = f.list(info + 168, 1, 24);
  const root = f.list(tree + 16, 1, 96);
  f.ptr(root, f.str('root'));
  f.f32(root + 24, 1, 2, 3);
  f.f32(root + 36, 0, 0, 0, 1);
  f.f32(root + 52, 1, 1, 1);
  f.u32(root + 64, 1);
  const child = f.list(root + 68, 1, 96);
  f.ptr(child, f.str('child'));
  f.f32(child + 24, 0, 5, 0);
  f.f32(child + 36, 0, 0, 0, 1);
  f.f32(child + 52, 1, 1, 1);
  f.u32(child + 64, 1);
  const instance = f.list(child + 76, 1, 8);
  const instanceData = f.alloc(32);
  f.u32(instance, 2);
  f.link(instance + 4, instanceData);
  f.ptr(instanceData + 8, f.str('#wall-mesh-morpher'));

  // One 40-byte animation record: a 28-byte sampler and a 24-byte channel
  // whose target sits at +0 and whose detail, at +16, names morph target 0.
  const record = f.list(info + 56, 1, 40);
  f.ptr(record, f.str('blend'));
  const sampler = f.list(record + 8, 1, 28);
  f.u32(sampler, 1, 1, 1, 0, 6, 1, 1);
  const channel = f.list(record + 16, 1, 24);
  f.ptr(channel, f.str('wall-mesh-morpher'));
  f.u32(channel + 8, 14);
  f.u32(channel + 16, 0xff00);
  const store = f.alloc(8);
  const segment = f.alloc(24);
  const table = f.alloc(20);
  const keys = f.alloc(4);
  const values = f.alloc(8);
  f.link(info + 68, store);
  f.u32(store, 1);
  f.link(store + 4, segment);
  f.u32(segment, 0, 1000, 1);
  f.link(segment + 20, table);
  f.u32(table, 2, 2);
  f.link(table + 8, keys);
  f.u32(table + 12, 2);
  f.link(table + 16, values);
  f.bytes.set([0, 30], keys);
  f.f32(values, 0, 1);
  return f.done();
}

describe('Bdae, wide layout', () => {
  it('reads the 80-byte header, whose pointers take 8 bytes', () => {
    const bytes = wideSample();
    expect(new Bdae(bytes).header).toEqual({
      signature: 'BRES',
      version: 0,
      headerSize: 80,
      fileSize: bytes.length,
      stringTableOffset: 128,
      modelInfoOffset: 800,
      modelDataOffset: bytes.length,
    });
  });

  it('reads textures and materials through 8-byte string pointers', () => {
    const doc = new Bdae(wideSample());
    expect(doc.textures()).toEqual([
      { map: 'wall-image', mapFriendly: 'wall', file: 'texture/wall.tga' },
    ]);
    expect(doc.materials()).toEqual([
      expect.objectContaining({ name: 'stone', shader: '#stone-fx', textureIndex: 0 }),
    ]);
  });

  it('reads a mesh through linked records and 8-byte block pointers, placed by its node', () => {
    const doc = new Bdae(wideSample());
    const [mesh] = doc.meshes();
    expect(doc.warnings).toEqual([
      'geometry wall-lifted: placed by no node, so left out as a morph target',
    ]);
    expect(mesh.name).toBe('wall-mesh');
    expect([...mesh.indices!]).toEqual([0, 1, 2]);
    // Identity rotations: the node translations add onto each vertex.
    expect([...mesh.positions!]).toEqual([1, 7, 3, 2, 7, 3, 1, 8, 3]);
    expect(mesh.groups).toEqual([
      expect.objectContaining({ material: 'stone', texture: 'texture/wall.tga', count: 3 }),
    ]);
    expect(mesh.morph?.targets.map(t => [t.name, t.weight])).toEqual([['wall-lifted', 0.25]]);
  });

  it('reads a skin and a morph from the controller table', () => {
    const doc = new Bdae(wideSample());
    const skin = doc.allSkins()['wall-mesh-skin'];
    expect(skin).toMatchObject({
      source: '#wall-mesh',
      jointNames: ['bone'],
      maxInfluence: 1,
      vertexCount: 3,
    });
    expect(skin.weights.map(w => w.weights[0])).toEqual([1, 1, 1]);
    expect(doc.morphers()).toEqual([
      {
        name: 'wall-mesh-morpher',
        source: 'wall-mesh',
        targets: ['wall-lifted'],
        indices: [1],
        weights: [0.25],
      },
    ]);
  });

  it('reads a clip whose channel names its target first and its morph member at +16', () => {
    const [clip] = new Bdae(wideSample()).animations();
    expect(clip.id).toBe('blend');
    expect(clip.channels).toEqual([{ target: 'wall-mesh-morpher', type: 14, member: 0 }]);
    expect(clip.samplers[0].input.values).toEqual([0, 30]);
    expect(clip.samplers[0].output.values).toEqual([0, 1]);
  });

  it('rejects a file cut short of its 80-byte header, or a pointer past 4 GB', () => {
    expect(() => new Bdae(wideSample().slice(0, 70))).toThrow(/under a header/);
    const far = wideSample();
    new DataView(far.buffer).setUint32(44, 1, true);
    expect(() => new Bdae(far)).toThrow(BdaeError);
  });
});
