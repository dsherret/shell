import { assertEquals } from "@std/assert";
import { ByteRingBuffer } from "./byteRingBuffer.ts";

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

Deno.test("empty buffer reports zero size and yields no bytes", () => {
  const buf = new ByteRingBuffer(8);
  assertEquals(buf.size, 0);
  assertEquals(buf.toBytes(), new Uint8Array());
});

Deno.test("retains all bytes when total is below capacity", () => {
  const buf = new ByteRingBuffer(8);
  buf.push(bytes(1, 2, 3));
  buf.push(bytes(4, 5));
  assertEquals(buf.size, 5);
  assertEquals(buf.toBytes(), bytes(1, 2, 3, 4, 5));
});

Deno.test("retains exactly capacity bytes at the boundary", () => {
  const buf = new ByteRingBuffer(4);
  buf.push(bytes(1, 2, 3, 4));
  assertEquals(buf.size, 4);
  assertEquals(buf.toBytes(), bytes(1, 2, 3, 4));
});

Deno.test("drops oldest bytes when pushing past capacity", () => {
  const buf = new ByteRingBuffer(4);
  buf.push(bytes(1, 2, 3));
  buf.push(bytes(4, 5, 6));
  assertEquals(buf.size, 4);
  assertEquals(buf.toBytes(), bytes(3, 4, 5, 6));
});

Deno.test("a single push larger than capacity keeps only the trailing bytes", () => {
  const buf = new ByteRingBuffer(3);
  buf.push(bytes(1, 2, 3, 4, 5, 6, 7));
  assertEquals(buf.size, 3);
  assertEquals(buf.toBytes(), bytes(5, 6, 7));
});

Deno.test("a single push exactly at capacity fills the buffer", () => {
  const buf = new ByteRingBuffer(3);
  buf.push(bytes(1, 2, 3));
  assertEquals(buf.toBytes(), bytes(1, 2, 3));
});

Deno.test("toBytes is correct after multiple wraps", () => {
  const buf = new ByteRingBuffer(4);
  for (let i = 1; i <= 10; i++) buf.push(bytes(i));
  // last 4 bytes pushed: 7, 8, 9, 10
  assertEquals(buf.toBytes(), bytes(7, 8, 9, 10));
});

Deno.test("toBytes spans the wrap boundary", () => {
  const buf = new ByteRingBuffer(5);
  buf.push(bytes(1, 2, 3, 4));
  buf.push(bytes(5, 6, 7));
  // ring storage now holds [6, 7, 3, 4, 5] with head=2
  assertEquals(buf.toBytes(), bytes(3, 4, 5, 6, 7));
});

Deno.test("ignores empty pushes", () => {
  const buf = new ByteRingBuffer(4);
  buf.push(new Uint8Array());
  buf.push(bytes(1, 2));
  buf.push(new Uint8Array());
  assertEquals(buf.size, 2);
  assertEquals(buf.toBytes(), bytes(1, 2));
});

Deno.test("capacity is coerced to at least 1", () => {
  const buf = new ByteRingBuffer(0);
  assertEquals(buf.capacity, 1);
  buf.push(bytes(1, 2, 3));
  assertEquals(buf.toBytes(), bytes(3));
});

Deno.test("toBytes returns a fresh copy each call", () => {
  const buf = new ByteRingBuffer(4);
  buf.push(bytes(1, 2, 3));
  const a = buf.toBytes();
  const b = buf.toBytes();
  assertEquals(a, b);
  // mutating one must not affect the other or the internal ring
  a[0] = 99;
  assertEquals(b[0], 1);
  assertEquals(buf.toBytes()[0], 1);
});
