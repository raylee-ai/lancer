import assert from "node:assert/strict";
import test from "node:test";
import { patchAppImageTool } from "./appimage-tools.mjs";

const wrapper = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  "",
  'ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
  "",
  "# Load shared runtime selector",
  'source "$ROOT_DIR/select-runtime.env"',
  "",
  "# Determine tool name",
  'INVOKED_AS="$(basename "$0")"',
  "",
  'if [[ "$INVOKED_AS" == "appimage-tool" ]]; then',
  "  exit 1",
  "fi",
  "",
  'exec "$BIN" "$@"',
  "",
].join("\n");

test("the AppImage wrapper resolves its name before bundled libm is exported", () => {
  const patched = patchAppImageTool(wrapper);
  const nameAt = patched.indexOf('INVOKED_AS="${0##*/}"');
  const sourceAt = patched.indexOf('source "$ROOT_DIR/select-runtime.env"');
  assert.ok(nameAt >= 0 && sourceAt > nameAt);
  assert.equal(patched.includes("basename"), false);
  assert.match(patched, /unset LD_LIBRARY_PATH/);
  assert.match(patched, /exec env LD_LIBRARY_PATH="\$SAVED_LD_LIBRARY_PATH" "\$BIN"/);
  assert.equal(patchAppImageTool(patched), patched);
});
