interface WorkspaceWindow {
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export async function reopenWorkspaceWindow(
  applicationReady: Promise<void>,
  foreground: () => WorkspaceWindow | null | undefined,
  createWindow: () => WorkspaceWindow,
): Promise<void> {
  await applicationReady;
  // Keep selection/creation synchronous so bursts reuse the same workspace.
  const window = foreground() ?? createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
