import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// On Windows the runner's `bash` is WSL, which cannot execute a script at a
// Windows drive path; this Linux release verifier is POSIX-only anyway.
const skipReason =
  process.platform === "win32" ? "the Linux release verifier needs a POSIX bash" : false;

const verifier = fileURLToPath(new URL("./verify-linux-release.sh", import.meta.url));

function normalize(version) {
  return execFileSync("bash", [verifier, "--normalize-debian-version", version], {
    encoding: "utf8",
    env: { ...process.env, HOME: "/home/runner" },
  }).trimEnd();
}

test("normalizes Debian prerelease versions without expanding HOME", { skip: skipReason }, () => {
  assert.equal(normalize("0.1.0-beta.33"), "0.1.0~beta.33");
});

test("leaves stable Debian versions unchanged", { skip: skipReason }, () => {
  assert.equal(normalize("1.2.3"), "1.2.3");
});
