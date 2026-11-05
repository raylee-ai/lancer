import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

/** Matches app-builder-lib toolsets.appimage "1.0.2". */
export const APPIMAGE_TOOLS_ARCHIVE = "appimage-tools-runtime-20251108.tar.gz";
export const APPIMAGE_TOOLS_URL =
  "https://github.com/electron-userland/electron-builder-binaries/releases/download/appimage@1.0.2/appimage-tools-runtime-20251108.tar.gz";
export const APPIMAGE_TOOLS_SHA256 =
  "a784a8c26331ec2e945c23d6bdb14af5c9df27f5939825d84b8709c61dc81eb0";

const PATCH_MARKER = "LANCER_APPIMAGE_TOOL_PATCH";

/**
 * The upstream wrapper exports the toolset's glibc 2.27 libm, then calls
 * basename. On a runner whose coreutils need a newer libm, that fails with
 * `GLIBC_2.43 not found` before mksquashfs starts.
 */
export function patchAppImageTool(source) {
  if (source.includes(PATCH_MARKER)) return source;
  const sourced = 'source "$ROOT_DIR/select-runtime.env"';
  const basename = 'INVOKED_AS="$(basename "$0")"';
  if (!source.includes(sourced) || !source.includes(basename)) {
    throw new Error("AppImage tool wrapper did not match the expected runtime selector");
  }
  const patched = source
    .replace(
      `${sourced}\n\n# Determine tool name\n${basename}\n`,
      `# ${PATCH_MARKER}: name the tool before bundled libm is visible to host coreutils.\nINVOKED_AS="\${0##*/}"\n${sourced}\nSAVED_LD_LIBRARY_PATH="\${LD_LIBRARY_PATH-}"\nunset LD_LIBRARY_PATH\n`,
    )
    .replace('exec "$BIN" "$@"', 'exec env LD_LIBRARY_PATH="$SAVED_LD_LIBRARY_PATH" "$BIN" "$@"');
  if (patched === source || patched.includes(basename)) {
    throw new Error("AppImage tool wrapper patch did not apply");
  }
  return patched;
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function sha256(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

async function downloadArchive(destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  const response = await fetch(APPIMAGE_TOOLS_URL);
  if (!response.ok || !response.body) {
    throw new Error(`AppImage tools download failed: ${response.status} ${APPIMAGE_TOOLS_URL}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
  const actual = await sha256(destination);
  if (actual !== APPIMAGE_TOOLS_SHA256) {
    await rm(destination, { force: true });
    throw new Error(
      `AppImage tools checksum mismatch: expected ${APPIMAGE_TOOLS_SHA256} but downloaded ${actual}`,
    );
  }
}

/**
 * Extract the pinned AppImage toolset and return a directory electron-builder
 * can use via APPIMAGE_TOOLS_PATH. The wrapper is patched before it is used.
 */
export async function prepareAppImageTools(cacheRoot) {
  const root = path.join(cacheRoot, "lancer-appimage-tools");
  const archive = path.join(root, APPIMAGE_TOOLS_ARCHIVE);
  const extracted = path.join(root, "patched");
  const marker = path.join(extracted, ".lancer-appimage-tool-patch");
  if ((await fileExists(marker)) && (await readFile(marker, "utf8")) === APPIMAGE_TOOLS_SHA256) {
    return extracted;
  }
  if (!(await fileExists(archive)) || (await sha256(archive)) !== APPIMAGE_TOOLS_SHA256) {
    await downloadArchive(archive);
  }
  await rm(extracted, { recursive: true, force: true });
  await mkdir(extracted, { recursive: true });
  await execFileAsync("tar", ["-xzf", archive, "-C", extracted]);
  const wrapperPath = path.join(extracted, "appimage-tool");
  const wrapper = await readFile(wrapperPath, "utf8");
  await writeFile(wrapperPath, patchAppImageTool(wrapper), { mode: 0o755 });
  await writeFile(marker, APPIMAGE_TOOLS_SHA256);
  return extracted;
}
