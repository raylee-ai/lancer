import { expect, test } from "@playwright/test";
import { resolveTerminalCommand } from "../../electron/platform/terminal-service";

const noShell = { getIntegratedTerminalShell: () => undefined };

test("a pinned prompt starts bash with no profile and a silent deprecation warning", () => {
  expect(
    resolveTerminalCommand(
      "darwin",
      { SHELL: "/bin/zsh", PI_APP_TERMINAL_PROMPT: "LANCER_READY$ " },
      noShell,
    ),
  ).toEqual({ shell: "/bin/bash", args: ["--noprofile", "--norc", "-i"] });
  expect(
    resolveTerminalCommand("linux", { PI_APP_TERMINAL_PROMPT: "LANCER_READY$ " }, noShell),
  ).toEqual({ shell: "/bin/bash", args: ["--noprofile", "--norc", "-i"] });
});

test("without a pinned prompt the configured shell is unchanged", () => {
  expect(resolveTerminalCommand("darwin", { SHELL: "/bin/zsh" }, noShell)).toEqual({
    shell: "/bin/zsh",
    args: [],
  });
  expect(resolveTerminalCommand("linux", {}, noShell)).toEqual({
    shell: "/bin/bash",
    args: [],
  });
  expect(
    resolveTerminalCommand(
      "linux",
      { SHELL: "/bin/zsh" },
      { getIntegratedTerminalShell: () => "/bin/bash" },
    ),
  ).toEqual({ shell: "/bin/bash", args: [] });
});
