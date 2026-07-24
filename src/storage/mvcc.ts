/** TxStatus represents the lifecycle state of a transaction. */
export enum TxStatus {
  Active = 0,
  Committed = 1,
  Aborted = 2,
}

/**
 * Snapshot captures the database state at BEGIN time (PostgreSQL-style).
 * Used to determine which tuple versions are visible to a transaction.
 */
export interface Snapshot {
  xmin: bigint;    // lowest active xid at snapshot time — all xids below are committed
  xmax: bigint;    // next xid to be assigned — all xids >= this are invisible
  active: bigint[]; // xids in-progress at snapshot time (committed later but invisible now)
}

/** Transaction represents an open database transaction. */
export class Transaction {
  id: bigint;
  status: TxStatus;
  snapshot: Snapshot;

  constructor(id: bigint, status: TxStatus, snapshot: Snapshot) {
    this.id = id;
    this.status = status;
    this.snapshot = snapshot;
  }
}

/**
 * TxManager manages all active and historical transactions.
 * It issues monotonically increasing transaction IDs and tracks their status.
 */
export class TxManager {
  nextXID: bigint = 1n;
  txs: Map<bigint, Transaction> = new Map();

  /** Begin starts a new transaction, takes a snapshot of the current state, and returns it. */
  begin(): Transaction {
    const xid = this.nextXID;
    this.nextXID++;

    // Build snapshot: collect all currently active transaction IDs.
    const active: bigint[] = [];
    let xmin = xid; // default: no lower active xids
    for (const [id, tx] of this.txs) {
      if (tx.status === TxStatus.Active) {
        active.push(id);
        if (id < xmin) xmin = id;
      }
    }
    if (active.length === 0) xmin = xid;

    const tx = new Transaction(xid, TxStatus.Active, {
      xmin,
      xmax: xid, // our own xid and anything higher is invisible
      active,
    });
    this.txs.set(xid, tx);
    return tx;
  }

  /** Commit marks a transaction as committed. */
  commit(xid: bigint): Error | null {
    const tx = this.txs.get(xid);
    if (!tx) return new Error(`transaction ${xid} not found`);
    if (tx.status !== TxStatus.Active) {
      return new Error(`transaction ${xid} is not active (status=${tx.status})`);
    }
    tx.status = TxStatus.Committed;
    return null;
  }

  /** Abort marks a transaction as aborted (rolled back). */
  abort(xid: bigint): Error | null {
    const tx = this.txs.get(xid);
    if (!tx) return new Error(`transaction ${xid} not found`);
    if (tx.status !== TxStatus.Active) {
      return new Error(`transaction ${xid} is not active (status=${tx.status})`);
    }
    tx.status = TxStatus.Aborted;
    return null;
  }

  /** GetTx returns the transaction with the given ID. */
  getTx(xid: bigint): Transaction | undefined {
    return this.txs.get(xid);
  }

  /**
   * IsCommitted reports whether transaction xid has committed.
   * xid == 0n means auto-committed (legacy pre-MVCC), always true.
   */
  isCommitted(xid: bigint): boolean {
    if (xid === 0n) return true;
    const tx = this.txs.get(xid);
    return tx !== undefined && tx.status === TxStatus.Committed;
  }
}

/** isInSlice checks if xid appears in the active list. */
function isInSlice(xid: bigint, active: bigint[]): boolean {
  return active.includes(xid);
}

/**
 * Visible implements PostgreSQL-style MVCC tuple visibility.
 *
 * Rules (mirrors HeapTupleSatisfiesMVCC in PG):
 *  1. xmin == 0n: legacy/auto-committed tuple — always visible (backward compat)
 *  2. xmin == currentXID: we inserted it — visible unless we also deleted it
 *  3. xmin not committed, or xmin >= snap.xmax, or xmin in snap.active:
 *     the inserting transaction wasn't visible at snapshot time → invisible
 *  4. Once xmin is visible, check xmax:
 *     - xmax == 0n: not deleted → visible
 *     - xmax == currentXID: we deleted it → invisible
 *     - xmax not committed, or xmax >= snap.xmax, or xmax in snap.active:
 *       the deleting tx wasn't committed at snapshot time → still visible
 *     - else: deleted and committed → invisible
 */
export function Visible(
  xmin: bigint,
  xmax: bigint,
  snap: Snapshot,
  currentXID: bigint,
  mgr: TxManager
): boolean {
  // Rule 1: legacy auto-committed tuple
  if (xmin === 0n) {
    if (xmax === 0n) return true;
    if (xmax === currentXID) return false;
    if (!mgr.isCommitted(xmax) || xmax >= snap.xmax || isInSlice(xmax, snap.active)) {
      return true;
    }
    return false;
  }

  // Rule 2: we inserted this tuple ourselves
  if (xmin === currentXID) {
    if (xmax === 0n) return true;       // live, inserted by us
    if (xmax === currentXID) return false; // we also deleted it
    return true; // someone else deleted it
  }

  // Rule 3: check if xmin was visible at snapshot time
  const xminCommitted = mgr.isCommitted(xmin);
  if (!xminCommitted || xmin >= snap.xmax || isInSlice(xmin, snap.active)) {
    return false; // inserting tx not yet committed at snapshot time
  }

  // xmin is visible — now check xmax
  if (xmax === 0n) return true; // live
  if (xmax === currentXID) return false; // we deleted it
  // Is the deletion committed and visible at snapshot time?
  if (!mgr.isCommitted(xmax) || xmax >= snap.xmax || isInSlice(xmax, snap.active)) {
    return true; // deletion not committed yet — tuple still visible
  }
  return false; // deleted and deletion committed
}
