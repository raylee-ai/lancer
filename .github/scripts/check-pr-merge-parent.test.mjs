import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateMergeParent, checkPullRequestMergeParent } from "./check-pr-merge-parent.mjs";

test("a pull request merge parent must be the current base tip", () => {
  const current = evaluateMergeParent({
    eventName: "pull_request",
    parents: ["base-tip", "pr-head"],
    baseTip: "base-tip",
    baseRef: "main",
  });
  assert.equal(current.ok, true);
  assert.match(current.lines.join("\n"), /HEAD\^1 base-tip/);
  assert.match(current.lines.join("\n"), /matches the current tip of main/);

  const stale = evaluateMergeParent({
    eventName: "pull_request",
    parents: ["old-base", "pr-head"],
    baseTip: "base-tip",
    baseRef: "main",
  });
  assert.equal(stale.ok, false);
  assert.match(stale.message, /Stale pull request merge commit/);
  assert.match(stale.message, /old-base/);
  assert.match(stale.message, /base-tip/);

  const notMerge = evaluateMergeParent({
    eventName: "pull_request",
    parents: [],
    baseTip: "base-tip",
    baseRef: "main",
  });
  assert.equal(notMerge.ok, false);
  assert.match(notMerge.message, /not a merge commit/);

  const push = evaluateMergeParent({
    eventName: "push",
    parents: ["whatever"],
    baseTip: undefined,
    baseRef: undefined,
  });
  assert.equal(push.ok, true);
});

test("the checkout reader prints both parents of a real merge commit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lancer-merge-parent-"));
  const git = (args, cwd = root) =>
    execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], {
      cwd,
      encoding: "utf8",
    });
  try {
    git(["init", "-b", "main"]);
    git(["commit", "--allow-empty", "-m", "base"]);
    const baseTip = git(["rev-parse", "HEAD"]).trim();
    git(["checkout", "-b", "pr"]);
    git(["commit", "--allow-empty", "-m", "change"]);
    git(["checkout", "main"]);
    git(["merge", "--no-ff", "pr", "-m", "merge pr"]);
    const lines = [];
    const result = checkPullRequestMergeParent({
      cwd: root,
      eventName: "push",
      log: (line) => lines.push(line),
    });
    assert.equal(result.ok, true);
    const parents = git(["log", "-1", "--format=%P"]).trim().split(/\s+/);
    assert.equal(parents[0], baseTip);
    assert.equal(parents.length, 2);
    assert.match(lines.join("\n"), new RegExp(parents.join(" ")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
