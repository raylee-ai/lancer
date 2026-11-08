import assert from "node:assert/strict";
import test from "node:test";

import { installElectron } from "./setup-electron.mjs";

const electron504 =
  "HTTPError: Response code 504 (Gateway Time-out) for https://github.com/electron/electron/releases/download/v43.8.4/electron-v43.8.4-linux-x64.zip\n";

test("retries a transient Electron GitHub 504 and then succeeds", async () => {
  const outputs = [];
  let runs = 0;
  const status = await installElectron({
    attempts: 3,
    baseDelayMs: 1,
    sleep: async () => {},
    log: () => {},
    write: (output) => outputs.push(output),
    spawn: async () => {
      runs += 1;
      if (runs === 1) return { status: 1, output: electron504 };
      return { status: 0, output: "done\n" };
    },
  });
  assert.equal(status, 0);
  assert.equal(runs, 2);
  assert.equal(outputs[0], electron504);
});

test("does not retry an Electron install failure that is not a GitHub 5xx", async () => {
  let runs = 0;
  const status = await installElectron({
    sleep: async () => {
      throw new Error("should not retry");
    },
    log: () => {},
    write: () => {},
    spawn: async () => {
      runs += 1;
      return { status: 1, output: "checksum mismatch\n" };
    },
  });
  assert.equal(status, 1);
  assert.equal(runs, 1);
});
