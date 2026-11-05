import { pathToFileURL } from "node:url";

const shards = [1, 2, 3, 4];

/** Linux and macOS both run for pull requests, main pushes, and manual dispatch. */
export function desktopCoreMatrixInclude(_eventName) {
  return ["ubuntu-latest", "macos-latest"].flatMap((os) => shards.map((shard) => ({ os, shard })));
}

export function desktopCoreMatrixOutput(eventName) {
  return `include=${JSON.stringify(desktopCoreMatrixInclude(eventName))}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${desktopCoreMatrixOutput(process.env.EVENT_NAME ?? "")}\n`);
}
