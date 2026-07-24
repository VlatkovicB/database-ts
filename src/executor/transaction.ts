// =============================================================================
// Transaction control (MVCC) — port of internal/executor/transaction.go
// =============================================================================

import { VacuumStatement } from '../parser/ast';
import { Result } from './executor';

export function execBegin(exec: any): Result {
  if (exec.currentTx != null) {
    throw new Error(`there is already an open transaction (xid=${exec.currentTx.id})`);
  }
  exec.currentTx = exec.db.txManager.begin();
  exec.db.wal.append(exec.currentTx.id, 'BEGIN', '', [], []);
  const snap = exec.currentTx.snapshot;
  return {
    columns: [],
    rows: [],
    message: 'BEGIN',
    trace: [
      `Assigned xid=${exec.currentTx.id}`,
      `Snapshot: xmin=${snap.xmin} xmax=${snap.xmax} active=[${snap.active.join(', ')}]`,
    ],
  };
}

export function execCommit(exec: any): Result {
  if (exec.currentTx == null) {
    throw new Error('there is no open transaction');
  }
  const xid = exec.currentTx.id;
  const commitErr = exec.db.txManager.commit(xid);
  if (commitErr) throw commitErr;
  const lockCount = exec.db.lockMgr != null ? exec.db.lockMgr.heldCount(xid) : 0;
  if (exec.db.lockMgr != null) exec.db.lockMgr.releaseAll(xid);
  exec.db.wal.append(xid, 'COMMIT', '', [], []);
  exec.currentTx = null;
  return {
    columns: [],
    rows: [],
    message: 'COMMIT',
    trace: [
      `xid=${xid} marked COMMITTED`,
      'Tuple versions written by this tx are now visible to other transactions',
      `Released ${lockCount} row lock(s)`,
    ],
  };
}

export function execRollback(exec: any): Result {
  if (exec.currentTx == null) {
    throw new Error('there is no open transaction');
  }
  const xid = exec.currentTx.id;
  const abortErr = exec.db.txManager.abort(xid);
  if (abortErr) throw abortErr;
  const lockCount = exec.db.lockMgr != null ? exec.db.lockMgr.heldCount(xid) : 0;
  if (exec.db.lockMgr != null) exec.db.lockMgr.releaseAll(xid);
  exec.db.wal.append(xid, 'ROLLBACK', '', [], []);
  exec.currentTx = null;
  return {
    columns: [],
    rows: [],
    message: 'ROLLBACK',
    trace: [
      `xid=${xid} marked ABORTED`,
      'Tuple versions written by this tx are invisible (xmin not committed)',
      'Dead tuples will be reclaimed by VACUUM',
      `Released ${lockCount} row lock(s)`,
    ],
  };
}

export function execVacuum(exec: any, s: VacuumStatement): Result {
  const [reclaimed, vacuumErr] = exec.db.vacuum(s.table);
  if (vacuumErr) throw vacuumErr;
  return {
    columns: [],
    rows: [],
    message: `VACUUM "${s.table}" — ${reclaimed} dead tuple(s) reclaimed`,
    trace: [
      `Scan "${s.table}" for tuples where xmax != 0 AND xmax is committed`,
      `Reclaimed ${reclaimed} dead tuple(s)`,
      'Rebuilt indexes',
    ],
  };
}
