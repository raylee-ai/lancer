export const TERMINAL_REPLAY_BUFFER_LENGTH = 1_000_000;

/**
 * The shell the integrated terminal starts when no override is configured.
 * Shared with the settings placeholder so the hint cannot promise another
 * platform's shell (it used to say /bin/zsh on Windows).
 */
export function defaultTerminalShell(
  platform: string,
  env?: Readonly<Record<string, string | undefined>>,
): string {
  if (platform === "win32") {
    return env?.ComSpec || "cmd.exe";
  }
  return platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

export interface TerminalReplayUpdate {
  readonly replay: string;
  readonly truncated: boolean;
}

export function appendTerminalReplay(
  replay: string,
  data: string,
  alreadyTruncated = false,
): TerminalReplayUpdate {
  const nextReplay = replay + data;
  if (nextReplay.length <= TERMINAL_REPLAY_BUFFER_LENGTH) {
    return { replay: nextReplay, truncated: alreadyTruncated };
  }

  return {
    replay: nextReplay.slice(-TERMINAL_REPLAY_BUFFER_LENGTH),
    truncated: true,
  };
}
