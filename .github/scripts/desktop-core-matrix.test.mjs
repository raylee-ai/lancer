import assert from "node:assert/strict";
import test from "node:test";
import { desktopCoreMatrixInclude, desktopCoreMatrixOutput } from "./desktop-core-matrix.mjs";

test("pull requests schedule four Linux Core shards and no macOS runners", () => {
  const include = desktopCoreMatrixInclude("pull_request");
  assert.deepEqual(
    include.map((cell) => cell.os),
    ["ubuntu-latest", "ubuntu-latest", "ubuntu-latest", "ubuntu-latest"],
  );
  assert.deepEqual(
    include.map((cell) => cell.shard),
    [1, 2, 3, 4],
  );
});

test("pushes schedule Linux and macOS Core shards", () => {
  const include = desktopCoreMatrixInclude("push");
  assert.equal(include.length, 8);
  assert.deepEqual(
    include.filter((cell) => cell.os === "ubuntu-latest").map((cell) => cell.shard),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    include.filter((cell) => cell.os === "macos-latest").map((cell) => cell.shard),
    [1, 2, 3, 4],
  );
  const output = desktopCoreMatrixOutput("push");
  assert.match(output, /^include=\[/);
  assert.equal(output.includes("\n"), false);
  assert.deepEqual(JSON.parse(output.slice("include=".length)), include);
});
