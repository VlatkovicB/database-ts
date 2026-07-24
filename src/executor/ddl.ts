// =============================================================================
// DDL statements — port of internal/executor/ddl.go
// =============================================================================

import {
  CreateTableStatement,
  DropTableStatement,
  CreateIndexStatement,
  DropIndexStatement,
  AnalyzeStatement,
} from '../parser/ast';
import { Column, FKConstraint } from '../storage/storage';
import { Result } from './executor';

export function execCreate(exec: any, s: CreateTableStatement): Result {
  const cols: Column[] = s.columns.map(cd => ({
    name: cd.name,
    type: cd.type as Column['type'],
    primary: cd.primary,
  }));
  const createErr = exec.db.createTable(s.table, cols);
  if (createErr) throw createErr;
  if (s.foreignKeys.length > 0) {
    const fks: FKConstraint[] = s.foreignKeys.map(fk => ({
      column: fk.column,
      refTable: fk.refTable,
      refColumn: fk.refColumn,
    }));
    const fkErr = exec.db.setForeignKeys(s.table, fks);
    if (fkErr) throw fkErr;
  }
  const trace = [
    `Validate ${cols.length} column definition(s)`,
    `Register "${s.table}" in database catalog`,
    'Initialize empty row storage',
  ];
  if (s.foreignKeys.length > 0) {
    trace.push(`Register ${s.foreignKeys.length} foreign key constraint(s)`);
  }
  return {
    columns: [],
    rows: [],
    message: `table "${s.table}" created`,
    trace,
  };
}

export function execDrop(exec: any, s: DropTableStatement): Result {
  const dropErr = exec.db.dropTable(s.table);
  if (dropErr) {
    if (s.ifExists) {
      return {
        columns: [],
        rows: [],
        message: `table "${s.table}" does not exist, skipped`,
        trace: [],
      };
    }
    throw dropErr;
  }
  return {
    columns: [],
    rows: [],
    message: `table "${s.table}" dropped`,
    trace: [
      `Verify "${s.table}" exists in catalog`,
      `Remove "${s.table}" and all its rows`,
    ],
  };
}

export function execCreateIndex(exec: any, s: CreateIndexStatement): Result {
  const idxErr = exec.db.createIndex(s.name, s.table, s.column);
  if (idxErr) throw idxErr;
  return {
    columns: [],
    rows: [],
    message: `index "${s.name}" created on "${s.table}" (${s.column})`,
    trace: [
      `Scan all pages of "${s.table}"`,
      `Build B+ tree on column "${s.column}"`,
      `Register index "${s.name}" in table catalog`,
    ],
  };
}

export function execDropIndex(exec: any, s: DropIndexStatement): Result {
  const dropIdxErr = exec.db.dropIndexByName(s.name, s.ifExists);
  if (dropIdxErr) throw dropIdxErr;
  if (s.ifExists) {
    return {
      columns: [],
      rows: [],
      message: `index "${s.name}" dropped (or did not exist)`,
      trace: [],
    };
  }
  return {
    columns: [],
    rows: [],
    message: `index "${s.name}" dropped`,
    trace: [`Remove index "${s.name}" from table catalog`],
  };
}

export function execAnalyze(exec: any, s: AnalyzeStatement): Result {
  const [lines, analyzeErr] = exec.db.analyzeTable(s.table);
  if (analyzeErr) throw analyzeErr;
  return {
    columns: [],
    rows: [],
    message: `ANALYZE "${s.table}" — statistics updated`,
    trace: lines,
  };
}
