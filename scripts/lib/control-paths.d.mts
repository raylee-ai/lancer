export function controlPaths(
  directory: string,
  platform?: NodeJS.Platform,
  identity?: string,
): { socketPath: string; tokenPath: string };
export function defaultControlDirectory(
  platform?: NodeJS.Platform,
  env?: NodeJS.ProcessEnv,
  home?: string,
): string;
