/**
 * Fixed-capacity ring buffer of bytes. Used to retain the trailing N bytes of
 * a stream so they can be surfaced when a command fails — the live writes go
 * to wherever the user piped the stream, and the ring tap silently keeps
 * a copy of the last `capacity` bytes regardless of where output is going.
 *
 * Differs from {@link LineRingBuffer} in that it caps by *total bytes* rather
 * than by entry count, and is backed by a single `Uint8Array` so each `push`
 * is O(n) on the bytes written without per-entry allocation.
 */
export class ByteRingBuffer {
  readonly capacity: number;
  #buffer: Uint8Array;
  #size = 0;
  /** Index of the next byte to write — equivalently, the oldest retained
   * byte once the ring has wrapped. */
  #head = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.#buffer = new Uint8Array(this.capacity);
  }

  get size(): number {
    return this.#size;
  }

  push(data: Uint8Array): void {
    if (data.length === 0) return;
    // a single write larger than capacity collapses to "keep only the last
    // `capacity` bytes" — short-circuit so we don't loop the wrap math
    // pointlessly when callers stream big chunks at once.
    if (data.length >= this.capacity) {
      this.#buffer.set(data.subarray(data.length - this.capacity), 0);
      this.#size = this.capacity;
      this.#head = 0;
      return;
    }
    const tail = this.capacity - this.#head;
    if (data.length <= tail) {
      this.#buffer.set(data, this.#head);
    } else {
      this.#buffer.set(data.subarray(0, tail), this.#head);
      this.#buffer.set(data.subarray(tail), 0);
    }
    this.#head = (this.#head + data.length) % this.capacity;
    this.#size = Math.min(this.#size + data.length, this.capacity);
  }

  /** Return the retained bytes, oldest first, as a freshly allocated array. */
  toBytes(): Uint8Array {
    const out = new Uint8Array(this.#size);
    if (this.#size === 0) return out;
    const start = this.#size < this.capacity ? 0 : this.#head;
    const tail = this.capacity - start;
    if (this.#size <= tail) {
      out.set(this.#buffer.subarray(start, start + this.#size));
    } else {
      out.set(this.#buffer.subarray(start, this.capacity), 0);
      out.set(this.#buffer.subarray(0, this.#size - tail), tail);
    }
    return out;
  }
}
