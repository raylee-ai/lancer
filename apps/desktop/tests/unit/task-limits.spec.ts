import { expect, test } from "@playwright/test";
import type { SessionUsageSnapshot } from "@lancer/session-driver";
import type { OrchestrationChildThreadStatus } from "../../contracts/desktop-state";
import {
  assertTaskTokenBudget,
  TaskAdmission,
  taskAncestry,
  taskLimits,
} from "../../electron/orchestration/task-limits";

const ref = (sessionId: string) => ({ workspaceId: "workspace", sessionId });
const child = (
  id: string,
  parent: string,
  status: OrchestrationChildThreadStatus = "complete",
) => ({
  parentWorkspaceId: "workspace",
  parentSessionId: parent,
  childWorkspaceId: "workspace",
  childSessionId: id,
  status,
});
const limits = { concurrent: 2, depth: 3, children: 4, tokens: 100 };

test("parallel admissions reserve capacity before asynchronous creation and release on failure", () => {
  const admission = new TaskAdmission();
  const releaseA = admission.reserve([], ref("root"), limits);
  const releaseB = admission.reserve([], ref("other"), limits);
  expect(() => admission.reserve([], ref("root"), limits)).toThrow("parallel branches");
  releaseA();
  releaseA();
  const releaseC = admission.reserve([], ref("root"), limits);
  releaseB();
  releaseC();
  expect(() =>
    admission.reserve([child("running", "root", "running")], ref("root"), limits),
  ).not.toThrow();
});

test("grandchildren keep their root budget; independent conversations do not share tree counts", () => {
  const children = [child("a", "root"), child("b", "a"), child("c", "b")];
  expect(taskAncestry(children, ref("c"))).toEqual({ root: ref("root"), depth: 3 });
  const admission = new TaskAdmission();
  expect(() => admission.reserve(children, ref("c"), limits)).toThrow("3-level");
  const release = admission.reserve(children, ref("b"), limits);
  expect(() => admission.reserve(children, ref("root"), limits)).toThrow("4-branch");
  expect(() => admission.reserve(children, ref("another root"), limits)).not.toThrow();
  release();
});

test("cyclic persisted ancestry fails closed instead of recursing forever", () => {
  expect(() => taskAncestry([child("a", "b"), child("b", "a")], ref("a"))).toThrow("cycle");
});

test("provider-reported input, output and cache count once for the whole tree", () => {
  const usage = (n: number): SessionUsageSnapshot => ({
    cache: {},
    subscription: true,
    totals: { input: n, output: n, cacheRead: n, cacheWrite: n, cost: 0 },
  });
  const values = new Map([
    ["root", usage(10)],
    ["a", usage(10)],
    ["b", usage(5)],
    ["other", usage(1000)],
  ]);
  const children = [child("a", "root"), child("b", "a"), child("unrelated", "other")];
  expect(() =>
    assertTaskTokenBudget(children, ref("b"), (r) => values.get(r.sessionId), limits),
  ).toThrow("100 token");
  values.delete("b");
  expect(() =>
    assertTaskTokenBudget(children, ref("a"), (r) => values.get(r.sessionId), limits),
  ).not.toThrow();
});

test("invalid limits cannot silently disable admission checks", () => {
  expect(taskLimits({}).depth).toBe(4);
  for (const value of ["0", "-1", "NaN", "1.5", "1000"])
    expect(() => taskLimits({ LANCER_MAX_CONCURRENT_BRANCHES: value })).toThrow(
      "must be an integer",
    );
});
