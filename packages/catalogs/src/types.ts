import type {
  SessionLaneMetadata,
  SessionRef,
  SessionStatus,
  WorkspaceId,
} from "@lancer/session-driver";

export type { SessionLaneMetadata, SessionRef, SessionStatus, WorkspaceId };

export interface WorkspaceCatalogEntry {
  workspaceId: WorkspaceId;
  path: string;
  displayName: string;
  lastOpenedAt: string;
  sortOrder: number;
  pinned?: boolean;
  worktreeInitCommand?: string;
}

export type WorktreeId = string;
export type WorktreeKind = "primary" | "linked";
export type WorktreeStatus = "ready" | "missing" | "error";

export interface WorktreeCatalogEntry {
  worktreeId: WorktreeId;
  workspaceId: WorkspaceId;
  path: string;
  displayName: string;
  kind: WorktreeKind;
  status: WorktreeStatus;
  branchName?: string;
  headSha?: string;
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorktreeCatalogSnapshot {
  worktrees: WorktreeCatalogEntry[];
}

export interface SessionCatalogEntry extends SessionLaneMetadata {
  sessionRef: SessionRef;
  workspaceId: WorkspaceId;
  title: string;
  updatedAt: string;
  archivedAt?: string;
  previewSnippet?: string;
  sessionFilePath?: string;
  status: SessionStatus;
}

export interface WorkspaceCatalogSnapshot {
  workspaces: WorkspaceCatalogEntry[];
}

export interface SessionCatalogSnapshot {
  sessions: SessionCatalogEntry[];
}
