// Where a hub keeps the bytes of the files attached to docs (roadmap 23c). Without a store they stay in the database
// (the desktop app's own hive, a hub without one); with one (SeaweedFS next to the hub) the database keeps what the
// file is, and the store its bytes, by their SHA-256: the same bytes are kept once, and a write is safe to repeat.

export interface BlobStore {
  /** Shown on the Hub page and written in the database next to each file it holds: "seaweedfs". */
  readonly name: string;
  /** Where it is (its URL), for the Hub page. */
  readonly where: string;
  put(sha256: string, bytes: Uint8Array, type: string): Promise<void>;
  /** The bytes, or null when the store has nothing under that id. */
  get(sha256: string): Promise<Uint8Array | null>;
  /** Nothing to remove is not an error. */
  remove(sha256: string): Promise<void>;
}

export const SHA256_HEX = /^[0-9a-f]{64}$/;
