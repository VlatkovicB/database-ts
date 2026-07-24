import { Row, Column, Page, Tuple, newPage } from "./page";
import { TxStatus, Transaction, TxManager } from "./mvcc";
import { FKConstraint } from "./storage";

export type WALOp =
  | "INSERT"
  | "UPDATE"
  | "DELETE"
  | "BEGIN"
  | "COMMIT"
  | "ROLLBACK"
  | "CHECKPOINT";

export const WALInsert: WALOp = "INSERT";
export const WALUpdate: WALOp = "UPDATE";
export const WALDelete: WALOp = "DELETE";
export const WALBegin: WALOp = "BEGIN";
export const WALCommit: WALOp = "COMMIT";
export const WALRollback: WALOp = "ROLLBACK";
export const WALCheckpoint: WALOp = "CHECKPOINT";

export interface WALRecord {
  lsn: bigint;
  xid: bigint;
  op: WALOp;
  table: string;
  oldRows: Row[];
  newRows: Row[];
  timestamp: Date;
}

interface TableSnapshot {
  columns: Column[];
  foreignKeys: FKConstraint[];
  pages: Page[];
}

interface WalCheckpoint {
  lsn: bigint;
  tables: Map<string, TableSnapshot>;
  nextXID: bigint;
  txState: Map<bigint, TxStatus>;
}

/** WALManager manages Write-Ahead Log records and checkpointing. */
export class WALManager {
  private records: WALRecord[] = [];
  private nextLSN: bigint = 1n;
  private checkpoint: WalCheckpoint | null = null;

  append(xid: bigint, op: WALOp, table: string, oldRows: Row[], newRows: Row[]): WALRecord {
    const rec: WALRecord = {
      lsn: this.nextLSN,
      xid,
      op,
      table,
      oldRows,
      newRows,
      timestamp: new Date(),
    };
    this.records.push(rec);
    this.nextLSN++;
    return rec;
  }

  getRecords(): WALRecord[] {
    return this.records.slice();
  }

  checkpointLSN(): bigint {
    return this.checkpoint?.lsn ?? 0n;
  }

  hasCheckpoint(): boolean {
    return this.checkpoint !== null;
  }

  /**
   * TakeCheckpoint snapshots current DB state into WAL.
   * Returns the CHECKPOINT record.
   * db is the Database interface (passed to avoid circular import issues at runtime).
   */
  takeCheckpoint(db: WALDatabase): WALRecord {
    const tables = new Map<string, TableSnapshot>();
    for (const [name, t] of db.tables) {
      const pages: Page[] = t.pages.map((pg) => {
        const tuples: Tuple[] = pg.tuples.map((tpl) => {
          const rowCopy: Row = new Map(tpl.data);
          return { pageNum: tpl.pageNum, slotNum: tpl.slotNum, data: rowCopy, xmin: tpl.xmin, xmax: tpl.xmax };
        });
        const newPg = newPage();
        newPg.header = pg.header;
        newPg.tuples = tuples;
        return newPg;
      });
      tables.set(name, {
        columns: t.columns.slice(),
        foreignKeys: t.foreignKeys.slice(),
        pages,
      });
    }

    const nextXID = db.txManager.nextXID;
    const txState = new Map<bigint, TxStatus>();
    for (const [id, tx] of db.txManager.txs) {
      txState.set(id, tx.status);
    }

    const rec: WALRecord = {
      lsn: this.nextLSN,
      xid: 0n,
      op: WALCheckpoint,
      table: "",
      oldRows: [],
      newRows: [],
      timestamp: new Date(),
    };
    this.records.push(rec);
    this.nextLSN++;
    this.checkpoint = {
      lsn: rec.lsn,
      tables,
      nextXID,
      txState,
    };
    return rec;
  }

  /**
   * RestoreCheckpoint reverts the DB to the last checkpoint state (crash simulation).
   * Returns false if no checkpoint exists.
   */
  restoreCheckpoint(db: WALDatabase): boolean {
    const cp = this.checkpoint;
    if (!cp) return false;

    db.tables = new Map();
    for (const [name, snap] of cp.tables) {
      const pages: Page[] = snap.pages.map((pg) => {
        const tuples: Tuple[] = pg.tuples.map((tpl) => {
          const rowCopy: Row = new Map(tpl.data);
          return { pageNum: tpl.pageNum, slotNum: tpl.slotNum, data: rowCopy, xmin: tpl.xmin, xmax: tpl.xmax };
        });
        const newPg = newPage();
        newPg.header = pg.header;
        newPg.tuples = tuples;
        return newPg;
      });
      db.restoreTable(name, snap.columns.slice(), snap.foreignKeys.slice(), pages);
    }

    db.txManager.nextXID = cp.nextXID;
    db.txManager.txs = new Map();
    for (const [id, status] of cp.txState) {
      db.txManager.txs.set(id, new Transaction(id, status, { xmin: 0n, xmax: 0n, active: [] }));
    }
    return true;
  }

  /**
   * Replay re-applies WAL records written after the last checkpoint.
   * Designed to run after RestoreCheckpoint to recover committed data.
   * Returns [replayed count, error].
   */
  replay(db: WALDatabase): [number, Error | null] {
    const cp = this.checkpoint;
    const toReplay = this.records.filter((r) => !cp || r.lsn > cp.lsn);

    let replayed = 0;
    for (const rec of toReplay) {
      switch (rec.op) {
        case WALInsert:
          for (const row of rec.newRows) {
            const rowCopy: Row = new Map(row);
            const err = db.insert(rec.table, rowCopy, rec.xid);
            if (err) return [replayed, new Error(`WAL replay (LSN ${rec.lsn}, op ${rec.op}): ${err.message}`)];
          }
          break;
        case WALUpdate:
          for (let i = 0; i < rec.oldRows.length; i++) {
            if (i >= rec.newRows.length) break;
            const captured = rec.oldRows[i];
            const newCopy: Row = new Map(rec.newRows[i]);
            const [, , , err] = db.updateRows(
              rec.table,
              (r: Row) => rowsEqual(r, captured),
              (_: Row) => newCopy,
              rec.xid
            );
            if (err) return [replayed, new Error(`WAL replay (LSN ${rec.lsn}, op ${rec.op}): ${err.message}`)];
          }
          break;
        case WALDelete:
          for (const row of rec.oldRows) {
            const captured = row;
            const [, , err] = db.deleteRows(rec.table, (r: Row) => rowsEqual(r, captured), rec.xid);
            if (err) return [replayed, new Error(`WAL replay (LSN ${rec.lsn}, op ${rec.op}): ${err.message}`)];
          }
          break;
        case WALBegin:
          if (!db.txManager.txs.has(rec.xid)) {
            db.txManager.txs.set(rec.xid, new Transaction(rec.xid, 0 /* Active */, { xmin: 0n, xmax: 0n, active: [] }));
            if (rec.xid >= db.txManager.nextXID) {
              db.txManager.nextXID = rec.xid + 1n;
            }
          }
          break;
        case WALCommit:
          {
            const tx = db.txManager.txs.get(rec.xid);
            if (tx) tx.status = TxStatus.Committed;
          }
          break;
        case WALRollback:
          {
            const tx = db.txManager.txs.get(rec.xid);
            if (tx) tx.status = TxStatus.Aborted;
          }
          break;
      }
      replayed++;
    }
    return [replayed, null];
  }
}

export function rowsEqual(a: Row, b: Row): boolean {
  if (a.size !== b.size) return false;
  for (const [k, va] of a) {
    if (!b.has(k) || b.get(k) !== va) return false;
  }
  return true;
}

/**
 * WALDatabase is the minimal interface WALManager needs from Database.
 * Defined here to avoid a circular dependency; Database implements it.
 */
export interface WALDatabase {
  tables: Map<string, WALTableLike>;
  txManager: TxManager;
  insert(tableName: string, row: Row, xid: bigint): Error | null;
  updateRows(
    tableName: string,
    predicate: (r: Row) => boolean,
    update: (r: Row) => Row,
    xid: bigint
  ): [number, Row[], Row[], Error | null];
  deleteRows(tableName: string, predicate: (r: Row) => boolean, xid: bigint): [number, Row[], Error | null];
  restoreTable(name: string, columns: Column[], foreignKeys: FKConstraint[], pages: Page[]): void;
}

export interface WALTableLike {
  columns: Column[];
  foreignKeys: FKConstraint[];
  pages: Page[];
}
