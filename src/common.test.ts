import { assertEquals } from "@std/assert";
import { Buffer } from "@std/io/buffer";
import * as path from "node:path";
import { delayToMs, errorToString, getExecutableShebang, resolvePath, TreeBox } from "./common.ts";

Deno.test("should get delay value", () => {
  assertEquals(delayToMs(10), 10);
  assertEquals(delayToMs(`10s`), 10_000);
  assertEquals(delayToMs(`10.5s`), 10_500);
  assertEquals(delayToMs(`10.123s`), 10_123);
  assertEquals(delayToMs(`10ms`), 10);
  assertEquals(delayToMs(`10000ms`), 10_000);
  assertEquals(delayToMs(`1m`), 60 * 1000);
  assertEquals(delayToMs(`1.5m`), 90 * 1000);
  assertEquals(delayToMs(`2m`), 120 * 1000);
  assertEquals(delayToMs(`2m10s`), 130 * 1000);
  assertEquals(delayToMs(`2.2m10.2s`), 142.2 * 1000);
  assertEquals(delayToMs(`1h`), 1000 * 60 * 60);
  assertEquals(delayToMs(`1.5h`), 1.5 * 1000 * 60 * 60);
  assertEquals(delayToMs(`1.2h11m`), 1.2 * 1000 * 60 * 60 + 11 * 1000 * 60);
  assertEquals(delayToMs(`1.1h50.2m20.1s`), 1.1 * 1000 * 60 * 60 + 50.2 * 1000 * 60 + 20.1 * 1000);
});

Deno.test("should resolve absolute and relative paths", () => {
  assertEquals(
    resolvePath("/some/path", "./below"),
    path.resolve("/some/path/below"),
  );
  assertEquals(
    resolvePath("/some/path", "../above"),
    path.resolve("/some/above"),
  );
  assertEquals(
    resolvePath("/some/path", "/some/other/path"),
    path.resolve("/some/other/path"),
  );
});

Deno.test("tree box should work storing values in a tree", () => {
  const box = new TreeBox(1);
  const childA = box.createChild();
  const childB = box.createChild();

  box.setValue(2);
  assertEquals(box.getValue(), 2);
  assertEquals(childA.getValue(), 2);
  assertEquals(childB.getValue(), 2);

  childA.setValue(3);
  assertEquals(childA.getValue(), 3);
  assertEquals(box.getValue(), 2);
  assertEquals(childB.getValue(), 2);

  box.setValue(4);
  const grandChildA1 = childA.createChild();
  const grandChildA2 = childA.createChild();
  grandChildA2.setValue(5);
  assertEquals(childA.getValue(), 3);
  assertEquals(grandChildA1.getValue(), 3);
  assertEquals(grandChildA2.getValue(), 5);
  assertEquals(box.getValue(), 4);
  assertEquals(childB.getValue(), 4);
});

Deno.test("errorToString strips libuv error code prefixes", () => {
  // plain Error instance — ENOENT prefix stripped
  assertEquals(
    errorToString(Object.assign(new Error("ENOENT: no such file or directory, open 'x'"), { code: "ENOENT" })),
    "no such file or directory, open 'x'",
  );
  // EISDIR
  assertEquals(
    errorToString(new Error("EISDIR: illegal operation on a directory, unlink 'x'")),
    "illegal operation on a directory, unlink 'x'",
  );
  // other E-prefixed codes with digits/underscore
  assertEquals(errorToString(new Error("EAI_AGAIN: temporary failure")), "temporary failure");
  // plain strings also get stripped
  assertEquals(errorToString("EPERM: operation not permitted"), "operation not permitted");
  // messages without a libuv prefix are returned unchanged
  assertEquals(errorToString(new Error("some other error")), "some other error");
  // only one prefix at the start is stripped
  assertEquals(errorToString(new Error("EACCES: EACCES: nested")), "EACCES: nested");
  // non-Error values coerce via String()
  assertEquals(errorToString(42), "42");
  assertEquals(errorToString(null), "null");
  assertEquals(errorToString(undefined), "undefined");
});

Deno.test("gets the executable shebang when it exists", async () => {
  function get(input: string) {
    const data = new TextEncoder().encode(input);
    const buffer = new Buffer(data);
    return getExecutableShebang(buffer);
  }

  assertEquals(
    await get("#!/usr/bin/env -S deno run --allow-env=PWD --allow-read=."),
    {
      stringSplit: true,
      command: "deno run --allow-env=PWD --allow-read=.",
    },
  );
  assertEquals(
    await get("#!/usr/bin/env -S deno run --allow-env=PWD --allow-read=.\n"),
    {
      stringSplit: true,
      command: "deno run --allow-env=PWD --allow-read=.",
    },
  );
  assertEquals(
    await get("#!/usr/bin/env -S deno run --allow-env=PWD --allow-read=.\ntesting\ntesting"),
    {
      stringSplit: true,
      command: "deno run --allow-env=PWD --allow-read=.",
    },
  );
  assertEquals(
    await get("#!/usr/bin/env -S deno run --allow-env=PWD --allow-read=.\r\ntesting\ntesting"),
    {
      stringSplit: true,
      command: "deno run --allow-env=PWD --allow-read=.",
    },
  );
  assertEquals(
    await get("#!/usr/bin/env deno run --allow-env=PWD --allow-read=.\r\ntesting\ntesting"),
    {
      stringSplit: false,
      command: "deno run --allow-env=PWD --allow-read=.",
    },
  );
  assertEquals(
    await get("#!/bin/sh\r\ntesting\ntesting"),
    undefined,
  );
  assertEquals(
    await get("testing"),
    undefined,
  );
});
