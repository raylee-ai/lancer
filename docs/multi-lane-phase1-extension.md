# Multi-lane chat — phase 1 extension point

Phase 1 renders **one trajectory lane** from the active session’s Pi session tree (`getSessionTree`). Parallel lanes are modeled but not fully wired in the UI.

## Lane identity

| Source                                  | Maps to                                                                                        |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Current workspace + session             | Primary lane (`buildDefaultLanes` in `session-trajectory/trajectory-model.ts`)                 |
| `DesktopAppState.orchestrationChildren` | Additional lane headers when `childSessionId` shares the same parent session                   |
| Child Git worktree                      | Child worktree is execution isolation; trajectory rendering still uses the active session tree |

## Recommended next steps

1. **Handoff package** — use stable Pi entry ids (`sourceMessageId` / session tree node id) plus content hashes from the session file; avoid inventing a parallel id scheme.
2. **Cross-session trajectories** — if parallel child trajectories are needed, load each child session tree explicitly and add lane identity/offsets; worktree isolation alone does not render additional trajectory lanes.
3. **Cross-lane trajectory** — merge flattened nodes from multiple trees with `laneId` and horizontal offsets (see HTML prototype `mlc.js`).

Rollback / branch navigation remains on the existing `navigateSessionTree` path (`TreeModal`, `use-tree-fork-modals`); the trajectory panel only scrolls/highlights in phase 1.
