import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * @param {readonly string[]} args
 * @param {string} cwd
 */
function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * A pull_request checkout is GitHub's merge of the head into the base.
 * HEAD^1 is that base commit. It must be the base branch tip right now;
 * an older parent means this run is still testing a stale merge.
 *
 * @param {{
 *   eventName: string | undefined;
 *   parents: readonly string[];
 *   baseTip: string | undefined;
 *   baseRef: string | undefined;
 * }} input
 */
export function evaluateMergeParent(input) {
  const parents = input.parents.filter(Boolean);
  const lines = [`Parents: ${parents.join(" ") || "(none)"}`];
  if (input.eventName !== "pull_request") {
    lines.push("Not a pull_request checkout; base parent check skipped.");
    return { ok: true, lines };
  }
  const first = parents[0];
  lines.push(`HEAD^1 ${first ?? "(missing)"}`);
  lines.push(`${input.baseRef ?? "base"} tip ${input.baseTip ?? "(missing)"}`);
  if (!input.baseRef) {
    return {
      ok: false,
      lines,
      message: "GITHUB_BASE_REF is missing, so the pull request merge parent cannot be checked.",
    };
  }
  if (!first) {
    return {
      ok: false,
      lines,
      message:
        "Pull request checkout HEAD is not a merge commit (it has no parents). Refusing to treat it as tested against the base branch.",
    };
  }
  if (!input.baseTip) {
    return {
      ok: false,
      lines,
      message: `Could not resolve the current tip of ${input.baseRef}.`,
    };
  }
  if (first !== input.baseTip) {
    return {
      ok: false,
      lines,
      message: `Stale pull request merge commit: HEAD^1 (${first}) is not the current tip of ${input.baseRef} (${input.baseTip}). Re-run the workflow so GitHub rebuilds the merge against the current base branch.`,
    };
  }
  lines.push(`Pull request merge parent matches the current tip of ${input.baseRef}.`);
  return { ok: true, lines };
}

/**
 * @param {{
 *   cwd?: string;
 *   eventName?: string;
 *   baseRef?: string;
 *   log?: (line: string) => void;
 * }} [options]
 */
export function checkPullRequestMergeParent(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const eventName = options.eventName ?? process.env.GITHUB_EVENT_NAME;
  const baseRef = options.baseRef ?? process.env.GITHUB_BASE_REF;
  const log = options.log ?? console.log;
  const head = git(["rev-parse", "HEAD"], cwd);
  const subject = git(["log", "-1", "--format=%s"], cwd);
  // A depth-1 checkout hides parents from git log. The commit object still lists them.
  const parents = git(["cat-file", "-p", "HEAD"], cwd)
    .split("\n")
    .filter((line) => line.startsWith("parent "))
    .map((line) => line.slice("parent ".length).trim());
  log(`HEAD ${head}`);
  log(`Subject: ${subject}`);
  let baseTip;
  if (eventName === "pull_request") {
    if (!baseRef) {
      const result = evaluateMergeParent({ eventName, parents, baseTip, baseRef });
      for (const line of result.lines) log(line);
      return result;
    }
    execFileSync("git", ["fetch", "--no-tags", "origin", baseRef], { cwd, stdio: "inherit" });
    baseTip = git(["rev-parse", "FETCH_HEAD"], cwd);
  }
  const result = evaluateMergeParent({ eventName, parents, baseTip, baseRef });
  for (const line of result.lines) log(line);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = checkPullRequestMergeParent();
    if (!result.ok) {
      console.error(result.message);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
