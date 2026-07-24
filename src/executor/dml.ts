// =============================================================================
// DML statements — port of internal/executor/dml.go
// =============================================================================

import { InsertStatement, UpdateStatement, DeleteStatement } from '../parser/ast';
import { Row } from '../storage/storage';
import { Result } from './executor';
import { evalExpr, boolVal, exprString } from './expr';

export function execInsert(exec: any, s: InsertStatement): Result {
  const [tbl, tblErr] = exec.db.getTable(s.table);
  if (tblErr) throw tblErr;
  const row: Row = new Map();

  if (s.columns.length === 0) {
    if (s.values.length !== tbl.columns.length) {
      throw new Error(
        `column count mismatch: got ${s.values.length} values but table "${s.table}" has ${tbl.columns.length} columns`
      );
    }
    for (let i = 0; i < tbl.columns.length; i++) {
      row.set(tbl.columns[i].name, s.values[i]);
    }
  } else {
    if (s.columns.length !== s.values.length) {
      throw new Error(`column/value count mismatch: ${s.columns.length} columns, ${s.values.length} values`);
    }
    for (let i = 0; i < s.columns.length; i++) {
      row.set(s.columns[i], s.values[i]);
    }
  }

  const xid = exec.currentXID();
  const insertErr = exec.db.insert(s.table, row, xid);
  if (insertErr) throw insertErr;
  exec.db.wal.append(xid, 'INSERT', s.table, [], [row]);
  const traceXmin = xid === 0n ? 'xmin=0 (auto-commit)' : `xmin=${xid}`;
  return {
    columns: [],
    rows: [],
    message: '1 row inserted',
    trace: [
      `Build row from ${s.values.length} value(s)`,
      `Append tuple to "${s.table}" (${traceXmin} xmax=0)`,
    ],
  };
}

export function execUpdate(exec: any, s: UpdateStatement): Result {
  const xid = exec.currentXID();
  const [count, oldRows, newRows, updateErr] = exec.db.updateRows(
    s.table,
    (row: Row) => {
      if (s.where == null) return true;
      const match = evalExpr(s.where, row, null);
      return boolVal(match);
    },
    (row: Row) => {
      const newRow: Row = new Map(row);
      for (const [k, v] of Object.entries(s.assignments)) {
        newRow.set(k, v);
      }
      return newRow;
    },
    xid
  );
  if (updateErr) throw updateErr;
  if (count > 0) {
    exec.db.wal.append(xid, 'UPDATE', s.table, oldRows, newRows);
  }
  const whereDesc = s.where == null ? 'none (all rows)' : exprString(s.where);
  const trace = [
    `Scan "${s.table}" for rows matching WHERE ${whereDesc}`,
    `Apply ${Object.keys(s.assignments).length} assignment(s) to ${count} matching row(s)`,
  ];
  if (xid !== 0n) {
    trace.push(`MVCC: stamped ${count} old tuple(s) xmax=${xid}`);
    trace.push(`MVCC: inserted ${count} new tuple version(s) xmin=${xid}`);
  }
  return {
    columns: [],
    rows: [],
    message: `${count} row(s) updated`,
    trace,
  };
}

export function execDelete(exec: any, s: DeleteStatement): Result {
  const xid = exec.currentXID();
  const [count, deletedRows, deleteErr] = exec.db.deleteRows(
    s.table,
    (row: Row) => {
      if (s.where == null) return true;
      const match = evalExpr(s.where, row, null);
      return boolVal(match);
    },
    xid
  );
  if (deleteErr) throw deleteErr;
  if (count > 0) {
    exec.db.wal.append(xid, 'DELETE', s.table, deletedRows, []);
  }
  const whereDesc = s.where == null ? 'none (all rows)' : exprString(s.where);
  const trace = [`Scan "${s.table}" for rows matching WHERE ${whereDesc}`];
  if (xid !== 0n) {
    trace.push(`MVCC: stamped ${count} tuple(s) xmax=${xid} (soft-delete)`);
  } else {
    trace.push(`Remove ${count} row(s), keep remainder`);
  }
  return {
    columns: [],
    rows: [],
    message: `${count} row(s) deleted`,
    trace,
  };
}
