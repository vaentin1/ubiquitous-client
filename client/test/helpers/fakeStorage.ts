/**
 * Browser storage held in memory: the origin-private directories and files
 * the pack store keeps a build in, with only the calls it makes.
 */

class FakeFile {
  readonly kind = 'file';
  bytes = new Uint8Array(0);
  constructor(readonly name: string) {}

  async getFile(): Promise<File> {
    return new File([this.bytes as BlobPart], this.name);
  }

  async createWritable(): Promise<{
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }> {
    const parts: Uint8Array[] = [];
    return {
      write: async chunk => {
        parts.push(chunk.slice());
      },
      // Replaced only on close, as the browser's own swap file is.
      close: async () => {
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const part of parts) {
          out.set(part, at);
          at += part.length;
        }
        this.bytes = out;
      },
      abort: async () => {},
    };
  }
}

export class FakeDirectory {
  readonly kind = 'directory';
  readonly children = new Map<string, FakeDirectory | FakeFile>();
  constructor(readonly name: string) {}

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDirectory> {
    const found = this.children.get(name);
    if (found instanceof FakeDirectory) return found;
    if (found || !opts?.create) throw new DOMException(name, 'NotFoundError');
    const made = new FakeDirectory(name);
    this.children.set(name, made);
    return made;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFile> {
    const found = this.children.get(name);
    if (found instanceof FakeFile) return found;
    if (found || !opts?.create) throw new DOMException(name, 'NotFoundError');
    const made = new FakeFile(name);
    this.children.set(name, made);
    return made;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.children.delete(name)) throw new DOMException(name, 'NotFoundError');
  }

  async *entries(): AsyncIterableIterator<[string, FakeDirectory | FakeFile]> {
    yield* this.children.entries();
  }
}

/** A fresh, empty storage root; stub `navigator.storage` with it. */
export function fakeStorage(): { root: FakeDirectory; storage: Partial<StorageManager> } {
  const root = new FakeDirectory('');
  return {
    root,
    storage: {
      getDirectory: async () => root as unknown as FileSystemDirectoryHandle,
      estimate: async () => ({ quota: 1e12, usage: 0 }),
      persist: async () => true,
      persisted: async () => true,
    },
  };
}
