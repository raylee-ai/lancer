import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { join, resolve, win32 } from "node:path";

// Shared by Electron, CLI and relay. Never accepts a TCP endpoint override.
export function controlPaths(
  directory,
  platform = process.platform,
  identity = userInfo().username + "|" + homedir(),
) {
  if (platform === "win32") {
    const profile = win32.resolve(directory).toLowerCase();
    const digest = createHash("sha256")
      .update(identity + "\0" + profile)
      .digest("hex");
    return {
      socketPath: `\\\\.\\pipe\\lancer-control-${digest}`,
      tokenPath: win32.join(directory, "control-local", "control.token"),
    };
  }
  return {
    socketPath: join(directory, "control.sock"),
    tokenPath: join(directory, "control.token"),
  };
}

export function defaultControlDirectory(
  platform = process.platform,
  env = process.env,
  home = homedir(),
) {
  if (platform === "win32")
    return win32.join(env.APPDATA || win32.join(home, "AppData", "Roaming"), "Lancer");
  return resolve(
    platform === "darwin"
      ? join(home, "Library", "Application Support", "Lancer")
      : join(env.XDG_CONFIG_HOME || join(home, ".config"), "Lancer"),
  );
}
