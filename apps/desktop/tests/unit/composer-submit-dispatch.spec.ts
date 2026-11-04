import { expect, test } from "@playwright/test";
import type { RuntimeCommandRecord } from "@lancer/session-driver/runtime-types";
import {
  composerSubmitNeedsSenderView,
  incompleteComposerCommandMessage,
  isIncompleteComposerCommand,
} from "../../contracts/composer-commands";

function command(name: string, source: RuntimeCommandRecord["source"]): RuntimeCommandRecord {
  return {
    name,
    source,
    sourceInfo: { path: `/tmp/${name}`, source: "local", scope: "user", origin: "top-level" },
  };
}

const commands = [
  command("skill:review", "skill"),
  command("draft-pr", "prompt"),
  command("spawn-child", "extension"),
];

test("skills, prompt templates and plain text do not hold the sender window's queue", () => {
  expect(composerSubmitNeedsSenderView("/skill:review the diff", undefined, commands)).toBe(false);
  expect(composerSubmitNeedsSenderView("/draft-pr", undefined, commands)).toBe(false);
  expect(
    composerSubmitNeedsSenderView("/Users/me/foo.ts why is this slow", undefined, commands),
  ).toBe(false);
  expect(composerSubmitNeedsSenderView("fix the build", undefined, commands)).toBe(false);
});

test("extension and local commands keep the serialized sender view", () => {
  expect(composerSubmitNeedsSenderView("/spawn-child now", undefined, commands)).toBe(true);
  expect(composerSubmitNeedsSenderView("/name New title", undefined, commands)).toBe(true);
  expect(composerSubmitNeedsSenderView("/compact", undefined, commands)).toBe(true);
  expect(composerSubmitNeedsSenderView("/model", undefined, commands)).toBe(true);
});

test("slash text stays serialized until the session's commands are known", () => {
  expect(composerSubmitNeedsSenderView("/skill:review", undefined, undefined)).toBe(true);
  expect(composerSubmitNeedsSenderView("plain text", undefined, undefined)).toBe(false);
});

test("incomplete commands are detected without any platform data", () => {
  expect(isIncompleteComposerCommand("/model")).toBe(true);
  expect(isIncompleteComposerCommand("  /settings  ")).toBe(true);
  expect(isIncompleteComposerCommand("/model gpt-5")).toBe(true);
  expect(isIncompleteComposerCommand("/unknown")).toBe(false);
  expect(isIncompleteComposerCommand("plain text")).toBe(false);
  expect(isIncompleteComposerCommand("/")).toBe(false);
});

test("the settings hint teaches the platform's real shortcut", () => {
  expect(incompleteComposerCommandMessage("/settings", "darwin")).toContain("Cmd+,");
  expect(incompleteComposerCommandMessage("/settings", "win32")).toContain("Ctrl+,");
  expect(incompleteComposerCommandMessage("/settings", "linux")).toContain("Ctrl+,");
  expect(incompleteComposerCommandMessage("/unknown", "darwin")).toBeUndefined();
  expect(incompleteComposerCommandMessage("plain text", "darwin")).toBeUndefined();
});
