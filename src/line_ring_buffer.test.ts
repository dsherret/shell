import { assertEquals } from "@std/assert";
import { LineRingBuffer } from "./line_ring_buffer.ts";

Deno.test("empty buffer reports zero size and yields nothing", () => {
  const buf = new LineRingBuffer(5);
  assertEquals(buf.size, 0);
  assertEquals(Array.from(buf), []);
  assertEquals(Array.from(buf.takeLast(3)), []);
});

Deno.test("retains all items when count is below capacity", () => {
  const buf = new LineRingBuffer(5);
  buf.push("a");
  buf.push("b");
  buf.push("c");
  assertEquals(buf.size, 3);
  assertEquals(Array.from(buf), ["a", "b", "c"]);
});

Deno.test("retains exactly capacity items at the boundary", () => {
  const buf = new LineRingBuffer(3);
  buf.push("a");
  buf.push("b");
  buf.push("c");
  assertEquals(buf.size, 3);
  assertEquals(Array.from(buf), ["a", "b", "c"]);
});

Deno.test("drops oldest when pushing past capacity", () => {
  const buf = new LineRingBuffer(3);
  for (const v of ["a", "b", "c", "d", "e"]) buf.push(v);
  // oldest two ("a", "b") dropped; ring wrapped around to head=2
  assertEquals(buf.size, 3);
  assertEquals(Array.from(buf), ["c", "d", "e"]);
});

Deno.test("iteration yields items oldest first across multiple wraps", () => {
  const buf = new LineRingBuffer(4);
  // push 13 items into a capacity-4 ring → 3 full wraparounds plus one
  for (let i = 0; i < 13; i++) buf.push(`v${i}`);
  assertEquals(buf.size, 4);
  assertEquals(Array.from(buf), ["v9", "v10", "v11", "v12"]);
});

Deno.test("takeLast(n) returns the last n items oldest-first when n < size", () => {
  const buf = new LineRingBuffer(5);
  for (const v of ["a", "b", "c", "d", "e"]) buf.push(v);
  assertEquals(Array.from(buf.takeLast(2)), ["d", "e"]);
  assertEquals(Array.from(buf.takeLast(3)), ["c", "d", "e"]);
});

Deno.test("takeLast(n) clamps to current size when n > size", () => {
  const buf = new LineRingBuffer(10);
  buf.push("a");
  buf.push("b");
  // requesting 5 from a buffer that only has 2 → returns the 2 we have
  assertEquals(Array.from(buf.takeLast(5)), ["a", "b"]);
});

Deno.test("takeLast(n) returns empty for n <= 0", () => {
  const buf = new LineRingBuffer(5);
  buf.push("a");
  buf.push("b");
  assertEquals(Array.from(buf.takeLast(0)), []);
  assertEquals(Array.from(buf.takeLast(-3)), []);
});

Deno.test("takeLast spans the wrap boundary when buffer is full and head is mid-array", () => {
  const buf = new LineRingBuffer(4);
  // fill, then push more so head wraps to index 2
  // ring layout after pushes: indices [0,1,2,3] hold ["e","f","c","d"], head=2
  for (const v of ["a", "b", "c", "d", "e", "f"]) buf.push(v);
  assertEquals(Array.from(buf), ["c", "d", "e", "f"]);
  // takeLast(2) must read across the wrap (indices 0,1 in storage)
  assertEquals(Array.from(buf.takeLast(2)), ["e", "f"]);
});

Deno.test("capacity is coerced to at least 1", () => {
  // a zero-capacity ring would never retain anything; the constructor
  // floors to 1 to keep `push` meaningful and avoid div-by-zero in
  // `head + 1 % capacity`.
  const buf = new LineRingBuffer(0);
  assertEquals(buf.capacity, 1);
  buf.push("a");
  buf.push("b");
  assertEquals(Array.from(buf), ["b"]);
});
