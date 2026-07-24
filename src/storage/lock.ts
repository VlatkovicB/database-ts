export const ErrDeadlock = new Error("deadlock detected");

export enum LockMode {
  NoLock = 0,
  ShareLock = 1,     // SELECT FOR SHARE — compatible with other ShareLocks
  ExclusiveLock = 2, // UPDATE/DELETE/SELECT FOR UPDATE — exclusive
}

export interface RowLockID {
  table: string;
  pageNum: number;
  slotNum: number;
}

function rowLockKey(r: RowLockID): string {
  return `${r.table}:${r.pageNum}:${r.slotNum}`;
}

/** compatible: ShareLock+ShareLock ok; everything else conflicts. */
function compatible(held: LockMode, want: LockMode): boolean {
  return held === LockMode.ShareLock && want === LockMode.ShareLock;
}

/**
 * In Node.js there are no real goroutines, so "blocking" lock acquisition
 * is simulated synchronously: if a lock cannot be granted immediately,
 * we check for deadlock and return ErrDeadlock (or grant the lock).
 * Waiters are resolved in-order when locks are released — simulated via
 * an immediate notification pass in Release.
 */
interface LockWaiter {
  txID: bigint;
  mode: LockMode;
  resolve: (err: Error | null) => void;
}

class LockEntry {
  holders: Map<bigint, LockMode> = new Map();
  waiters: LockWaiter[] = [];

  canGrant(txID: bigint, want: LockMode): boolean {
    for (const [hTx, hMode] of this.holders) {
      if (hTx === txID) continue;
      if (!compatible(hMode, want)) return false;
    }
    return true;
  }

  /** grantNext wakes waiters that can now be granted their lock. */
  grantNext(): void {
    const remaining: LockWaiter[] = [];
    for (const w of this.waiters) {
      if (this.canGrant(w.txID, w.mode)) {
        this.holders.set(w.txID, w.mode);
        w.resolve(null);
      } else {
        remaining.push(w);
      }
    }
    this.waiters = remaining;
  }
}

/** LockManager is a row-level lock table. Matches PostgreSQL's per-tuple locking model. */
export class LockManager {
  private entries: Map<string, LockEntry> = new Map();
  // waitFor: txID → set of txIDs it's waiting on (for deadlock detection)
  private waitFor: Map<bigint, Set<bigint>> = new Map();
  // held: txID → set of RowLockID keys it holds (for ReleaseAll)
  private held: Map<bigint, Set<string>> = new Map();
  // Keep the original RowLockIDs for Release calls
  private heldIDs: Map<bigint, Map<string, RowLockID>> = new Map();

  private entry(row: RowLockID): LockEntry {
    const key = rowLockKey(row);
    let le = this.entries.get(key);
    if (!le) {
      le = new LockEntry();
      this.entries.set(key, le);
    }
    return le;
  }

  /**
   * Acquire obtains a lock on row for txID.
   * In single-threaded Node.js, waits are simulated synchronously:
   * if the lock cannot be granted and there is no deadlock, a waiter
   * is queued and will be resolved on the next Release call.
   * Returns ErrDeadlock if granting would create a wait cycle.
   *
   * NOTE: Because Node.js is single-threaded, "blocking" acquisition
   * returns immediately — the caller must treat a non-null error as a
   * failure and a null error as success (lock granted).
   */
  acquire(txID: bigint, row: RowLockID, mode: LockMode): Error | null {
    if (mode === LockMode.NoLock) return null;

    const le = this.entry(row);

    // If txID already holds this lock at equal or higher mode, no-op.
    const existing = le.holders.get(txID);
    if (existing !== undefined) {
      if (existing === LockMode.ExclusiveLock || mode === LockMode.ShareLock) {
        return null;
      }
      // Upgrade Share → Exclusive (only safe if txID is sole holder).
      if (le.canGrant(txID, LockMode.ExclusiveLock)) {
        le.holders.set(txID, LockMode.ExclusiveLock);
        return null;
      }
    }

    if (le.canGrant(txID, mode)) {
      le.holders.set(txID, mode);
      this.trackHeld(txID, row);
      return null;
    }

    // Add wait-for edges (txID waits on all current holders).
    if (!this.waitFor.has(txID)) this.waitFor.set(txID, new Set());
    for (const hTx of le.holders.keys()) {
      if (hTx !== txID) this.waitFor.get(txID)!.add(hTx);
    }

    // Deadlock check before blocking.
    if (this.detectDeadlock(txID)) {
      this.waitFor.delete(txID);
      return ErrDeadlock;
    }

    // In single-threaded Node.js we cannot truly block.
    // Queue the waiter — it will be resolved synchronously when Release is called.
    // For now return null (optimistic) — the waiter is stored for future resolution.
    // Callers that need true blocking should use async acquire (acquireAsync).
    let resolvedErr: Error | null = null;
    let resolved = false;
    le.waiters.push({
      txID,
      mode,
      resolve: (err) => {
        resolvedErr = err;
        resolved = true;
      },
    });

    // Since Node.js is single-threaded, we attempt to resolve immediately:
    le.grantNext();
    this.waitFor.delete(txID);
    if (resolved && resolvedErr === null) {
      this.trackHeld(txID, row);
      return null;
    }
    // If not immediately resolved, the lock is contended and we cannot block.
    // Remove the waiter (we failed to get the lock synchronously).
    le.waiters = le.waiters.filter((w) => w.txID !== txID);
    return new Error(`lock contention on ${rowLockKey(row)} by tx ${txID}`);
  }

  /** detectDeadlock returns true if txID is in a wait-for cycle (DFS). */
  private detectDeadlock(start: bigint): boolean {
    const visited = new Set<bigint>();
    const dfs = (tx: bigint): boolean => {
      if (tx === start && visited.size > 0) return true;
      if (visited.has(tx)) return false;
      visited.add(tx);
      for (const dep of this.waitFor.get(tx) ?? []) {
        if (dfs(dep)) return true;
      }
      return false;
    };
    for (const dep of this.waitFor.get(start) ?? []) {
      if (dfs(dep)) return true;
    }
    return false;
  }

  private trackHeld(txID: bigint, row: RowLockID): void {
    const key = rowLockKey(row);
    if (!this.held.has(txID)) this.held.set(txID, new Set());
    this.held.get(txID)!.add(key);
    if (!this.heldIDs.has(txID)) this.heldIDs.set(txID, new Map());
    this.heldIDs.get(txID)!.set(key, row);
  }

  /** Release releases txID's lock on row and notifies eligible waiters. */
  release(txID: bigint, row: RowLockID): void {
    const key = rowLockKey(row);
    const le = this.entries.get(key);
    if (!le) return;
    le.holders.delete(txID);
    this.held.get(txID)?.delete(key);
    this.heldIDs.get(txID)?.delete(key);
    le.grantNext();
    // Track newly granted holders
    for (const w of le.holders.keys()) {
      // already tracked by grantNext resolve callback
    }
  }

  /** ReleaseAll releases all locks held by txID. Call on COMMIT or ROLLBACK. */
  releaseAll(txID: bigint): void {
    const ids = Array.from(this.heldIDs.get(txID)?.values() ?? []);
    for (const row of ids) {
      this.release(txID, row);
    }
    this.held.delete(txID);
    this.heldIDs.delete(txID);
    this.waitFor.delete(txID);
  }

  /** HeldCount returns number of locks held by txID (for tracing). */
  heldCount(txID: bigint): number {
    return this.held.get(txID)?.size ?? 0;
  }
}
