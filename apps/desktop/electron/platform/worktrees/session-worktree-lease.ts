import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * In-process lease for one session worktree directory.
 * A mutation (merge or discard) excludes every other mutation and every
 * execution that is still binding that directory. Execution leases are shared
 * with each other so a parent and a child can both use the checkout, and they
 * exclude a mutation so the directory cannot disappear underneath them.
 * The check and the reservation happen synchronously after the path is canonical.
 */
interface WorktreeLease {
  mutation: boolean;
  executions: number;
}

const leases = new Map<string, WorktreeLease>();

export async function canonicalWorktreePath(path: string): Promise<string> {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error("Worktree path is required.");
  }
  try {
    return await realpath(trimmed);
  } catch {
    return resolve(trimmed);
  }
}

export function reserveWorktreeMutation(canonicalPath: string): () => void {
  return reserve(canonicalPath, "mutation");
}

export function reserveWorktreeExecution(canonicalPath: string): () => void {
  return reserve(canonicalPath, "execution");
}

function reserve(canonicalPath: string, mode: "mutation" | "execution"): () => void {
  const key = resolve(canonicalPath);
  const lease = leases.get(key) ?? { mutation: false, executions: 0 };
  if (mode === "mutation") {
    if (lease.mutation) {
      throw new Error("This worktree is already being merged or discarded.");
    }
    if (lease.executions > 0) {
      throw new Error(
        "This worktree is in use by a session that is still starting. Wait for it to finish starting, then try again.",
      );
    }
    lease.mutation = true;
  } else if (lease.mutation) {
    throw new Error("Cannot start work in a worktree that is being merged or discarded.");
  } else {
    lease.executions += 1;
  }
  leases.set(key, lease);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (mode === "mutation") {
      lease.mutation = false;
    } else {
      lease.executions = Math.max(0, lease.executions - 1);
    }
    if (!lease.mutation && lease.executions === 0) {
      leases.delete(key);
    }
  };
}
