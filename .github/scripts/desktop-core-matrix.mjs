import { pathToFileURL } from "node:url";

const shards = [1, 2, 3, 4];

/** Pull requests stay on Linux. Pushes to main also schedule the macOS lane. */
export function desktopCoreMatrixInclude(eventName) {
  const systems =
    eventName === "pull_request" ? ["ubuntu-latest"] : ["ubuntu-latest", "macos-latest"];
  return systems.flatMap((os) => shards.map((shard) => ({ os, shard })));
}

export function desktopCoreMatrixOutput(eventName) {
  return `include=${JSON.stringify(desktopCoreMatrixInclude(eventName))}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${desktopCoreMatrixOutput(process.env.EVENT_NAME ?? "")}\n`);
}
