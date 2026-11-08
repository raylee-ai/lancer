import { spawnSync } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_GITHUB_DOWNLOAD_ATTEMPTS,
  githubDownloadRetryDelayMs,
  isTransientGithubDownloadFailure,
} from "./github-download-retry.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export async function installElectron(options = {}) {
  const attempts = options.attempts ?? DEFAULT_GITHUB_DOWNLOAD_ATTEMPTS;
  const spawn = options.spawn ?? defaultSpawn;
  const sleep = options.sleep ?? delay;
  const log = options.log ?? ((message) => console.error(message));
  const write = options.write ?? ((output) => process.stdout.write(output));

  let lastStatus = 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await spawn();
    const output = typeof result?.output === "string" ? result.output : "";
    if (output) write(output);
    lastStatus = result?.status ?? 1;
    if (lastStatus === 0) return 0;
    if (attempt < attempts && isTransientGithubDownloadFailure(output)) {
      const delayMs = githubDownloadRetryDelayMs(attempt, options.baseDelayMs);
      log(
        `Electron GitHub download returned a transient 5xx; retrying in ${delayMs}ms (attempt ${attempt + 1}/${attempts})`,
      );
      await sleep(delayMs);
      continue;
    }
    return lastStatus;
  }
  return lastStatus;
}

function defaultSpawn() {
  const result = spawnSync(process.execPath, ["node_modules/electron/install.js"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await installElectron());
}
