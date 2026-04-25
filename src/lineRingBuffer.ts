/**
 * Fixed-capacity ring buffer of strings. `push` is O(1); bounded-size
 * append-dropping doesn't need the `shift()` copies that an `array.shift()`
 * path would pay on every overflowing line.
 */
export class LineRingBuffer implements Iterable<string> {
  readonly capacity: number;
  #buffer: string[];
  #size = 0;
  #head = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
    this.#buffer = new Array(this.capacity);
  }

  get size(): number {
    return this.#size;
  }

  push(item: string): void {
    this.#buffer[this.#head] = item;
    this.#head = (this.#head + 1) % this.capacity;
    if (this.#size < this.capacity) this.#size++;
  }

  /** Iterate every retained item, oldest first. */
  *[Symbol.iterator](): IterableIterator<string> {
    const start = this.#size < this.capacity ? 0 : this.#head;
    for (let i = 0; i < this.#size; i++) {
      yield this.#buffer[(start + i) % this.capacity];
    }
  }

  /** Iterate the last `n` retained items, oldest first. */
  *takeLast(n: number): IterableIterator<string> {
    const count = Math.min(Math.max(0, n), this.#size);
    const start = (this.#head - count + this.capacity) % this.capacity;
    for (let i = 0; i < count; i++) {
      yield this.#buffer[(start + i) % this.capacity];
    }
  }
}
