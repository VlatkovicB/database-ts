// executor.test.ts — port of internal/executor/executor_test.go and derived_test.go

import { Lexer } from '../lexer/lexer';
import { parse } from '../parser/parser';
import { Executor, Result } from './executor';
import { Database } from '../storage/storage';
import { BinaryExpr, IdentExpr, LiteralExpr } from '../parser/ast';
import { exprString } from './expr';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function execSQL(e: Executor, sql: string): Result {
  const tokens = new Lexer(sql).tokenize();
  const stmt = parse(sql, tokens);
  return e.execute(stmt);
}

function execErr(e: Executor, sql: string): Error | null {
  try {
    const tokens = new Lexer(sql).tokenize();
    const stmt = parse(sql, tokens);
    e.execute(stmt);
    return null;
  } catch (err) {
    return err as Error;
  }
}

function newExecutor(): Executor {
  return new Executor(new Database());
}

function setupPlayers(e: Executor): void {
  execSQL(e, "CREATE TABLE players (id INT PRIMARY KEY, username TEXT, level INT, class TEXT)");
  execSQL(e, "INSERT INTO players (id, username, level, class) VALUES (1, 'Alice', 10, 'Mage')");
  execSQL(e, "INSERT INTO players (id, username, level, class) VALUES (2, 'Bob', 5, 'Warrior')");
  execSQL(e, "INSERT INTO players (id, username, level, class) VALUES (3, 'Carol', 15, 'Mage')");
  execSQL(e, "INSERT INTO players (id, username, level, class) VALUES (4, 'Dan', 8, 'Rogue')");
  execSQL(e, "INSERT INTO players (id, username, level, class) VALUES (5, 'Eve', 15, 'Warrior')");
}

function setupJoinTables(e: Executor): void {
  execSQL(e, "CREATE TABLE users (id INT PRIMARY KEY, name TEXT)");
  execSQL(e, "CREATE TABLE orders (id INT PRIMARY KEY, user_id INT, total INT)");
  execSQL(e, "INSERT INTO users (id, name) VALUES (1, 'Alice')");
  execSQL(e, "INSERT INTO users (id, name) VALUES (2, 'Bob')");
  execSQL(e, "INSERT INTO users (id, name) VALUES (3, 'Carol')");
  execSQL(e, "INSERT INTO orders (id, user_id, total) VALUES (1, 1, 100)");
  execSQL(e, "INSERT INTO orders (id, user_id, total) VALUES (2, 1, 200)");
  execSQL(e, "INSERT INTO orders (id, user_id, total) VALUES (3, 2, 50)");
}

// ---------------------------------------------------------------------------
// CREATE / DROP
// ---------------------------------------------------------------------------

test('TestCreateTable', () => {
  const e = newExecutor();
  const res = execSQL(e, "CREATE TABLE t (id INT PRIMARY KEY, name TEXT)");
  expect(res.message).toContain('created');
});

test('TestCreateTableDuplicate', () => {
  const e = newExecutor();
  execSQL(e, "CREATE TABLE t (id INT)");
  expect(execErr(e, "CREATE TABLE t (id INT)")).not.toBeNull();
});

test('TestDropTable', () => {
  const e = newExecutor();
  execSQL(e, "CREATE TABLE t (id INT)");
  const res = execSQL(e, "DROP TABLE t");
  expect(res.message).toContain('dropped');
});

test('TestDropTableIfExists', () => {
  const e = newExecutor();
  const res = execSQL(e, "DROP TABLE IF EXISTS nonexistent");
  expect(res.message).toContain('does not exist');
});

test('TestDropTableNotExists', () => {
  const e = newExecutor();
  expect(execErr(e, "DROP TABLE nonexistent")).not.toBeNull();
});

// ---------------------------------------------------------------------------
// INSERT
// ---------------------------------------------------------------------------

test('TestInsert', () => {
  const e = newExecutor();
  execSQL(e, "CREATE TABLE t (id INT, name TEXT)");
  const res = execSQL(e, "INSERT INTO t (id, name) VALUES (1, 'Alice')");
  expect(res.message).toBe('1 row inserted');
});

test('TestInsertPositional', () => {
  const e = newExecutor();
  execSQL(e, "CREATE TABLE t (id INT, name TEXT)");
  execSQL(e, "INSERT INTO t VALUES (1, 'Alice')");
  const res = execSQL(e, "SELECT * FROM t");
  expect(res.rows.length).toBe(1);
});

test('TestInsertColumnMismatch', () => {
  const e = newExecutor();
  execSQL(e, "CREATE TABLE t (id INT, name TEXT)");
  expect(execErr(e, "INSERT INTO t (id) VALUES (1, 'extra')")).not.toBeNull();
});

// ---------------------------------------------------------------------------
// SELECT
// ---------------------------------------------------------------------------

test('TestSelectStar', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "SELECT * FROM players");
  expect(res.rows.length).toBe(5);
});

test('TestSelectColumns', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "SELECT username, level FROM players");
  expect(res.columns.length).toBe(2);
  expect(res.columns[0]).toBe('username');
  expect(res.columns[1]).toBe('level');
});

test('TestSelectWhere', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "SELECT * FROM players WHERE level > 10");
  expect(res.rows.length).toBe(2);
});

test('TestSelectWhereAnd', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "SELECT * FROM players WHERE level > 5 AND class = 'Mage'");
  expect(res.rows.length).toBe(2);
});

test('TestSelectDistinct', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "SELECT DISTINCT class FROM players");
  expect(res.rows.length).toBe(3);
});

test('TestSelectOrderByAsc', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "SELECT level FROM players ORDER BY level ASC");
  expect(res.rows.length).toBe(5);
  let prev = Number.NEGATIVE_INFINITY;
  for (const row of res.rows) {
    const v = Number(row[0]);
    expect(v).toBeGreaterThanOrEqual(prev);
    prev = v;
  }
});

test('TestSelectOrderByDesc', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "SELECT level FROM players ORDER BY level DESC");
  expect(res.rows.length).toBe(5);
  let prev = Number.POSITIVE_INFINITY;
  for (const row of res.rows) {
    const v = Number(row[0]);
    expect(v).toBeLessThanOrEqual(prev);
    prev = v;
  }
});

test('TestSelectLimit', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "SELECT * FROM players LIMIT 2");
  expect(res.rows.length).toBe(2);
});

test('TestSelectOffset', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "SELECT * FROM players ORDER BY id LIMIT 3 OFFSET 2");
  expect(res.rows.length).toBe(3);
  // with ORDER BY id and OFFSET 2, first row should be id=3
  expect(Number(res.rows[0][0])).toBe(3);
});

test('TestSelectLimitBeyondRowCount', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "SELECT * FROM players LIMIT 100");
  expect(res.rows.length).toBe(5);
});

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

test('TestCount', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "SELECT COUNT(*) FROM players");
  expect(res.rows.length).toBe(1);
  expect(Number(res.rows[0][0])).toBe(5);
});

test('TestSum', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "SELECT SUM(level) FROM players");
  // 10+5+15+8+15 = 53
  expect(res.rows.length).toBe(1);
  expect(Number(res.rows[0][0])).toBe(53);
});

test('TestAvg', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "SELECT AVG(level) FROM players");
  expect(res.rows.length).toBe(1);
  // 53/5 = 10.6
  expect(Number(res.rows[0][0])).toBeCloseTo(10.6, 5);
});

test('TestMin', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "SELECT MIN(level) FROM players");
  expect(res.rows.length).toBe(1);
  expect(Number(res.rows[0][0])).toBe(5);
});

test('TestMax', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "SELECT MAX(level) FROM players");
  expect(res.rows.length).toBe(1);
  expect(Number(res.rows[0][0])).toBe(15);
});

test('TestGroupBy', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "SELECT class, COUNT(*) FROM players GROUP BY class ORDER BY class");
  expect(res.rows.length).toBe(3);
  // Mage=2, Rogue=1, Warrior=2 (alphabetical)
  const counts: Record<string, number> = {};
  for (const row of res.rows) {
    counts[row[0] as string] = Number(row[1]);
  }
  expect(counts['Mage']).toBe(2);
  expect(counts['Rogue']).toBe(1);
  expect(counts['Warrior']).toBe(2);
});

test('TestHaving', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "SELECT class, COUNT(*) FROM players GROUP BY class HAVING COUNT(*) > 1");
  expect(res.rows.length).toBe(2);
});

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

test('TestUpdate', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "UPDATE players SET level = 99 WHERE username = 'Alice'");
  expect(res.message).toContain('1 row');
  const res2 = execSQL(e, "SELECT level FROM players WHERE username = 'Alice'");
  expect(Number(res2.rows[0][0])).toBe(99);
});

test('TestUpdateNoWhere', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "UPDATE players SET class = 'Paladin'");
  expect(res.message).toContain('5 row');
});

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

test('TestDelete', () => {
  const e = newExecutor();
  setupPlayers(e);
  execSQL(e, "DELETE FROM players WHERE level < 8");
  const res = execSQL(e, "SELECT * FROM players");
  expect(res.rows.length).toBe(4);
});

test('TestDeleteAll', () => {
  const e = newExecutor();
  setupPlayers(e);
  execSQL(e, "DELETE FROM players");
  const res = execSQL(e, "SELECT * FROM players");
  expect(res.rows.length).toBe(0);
});

// ---------------------------------------------------------------------------
// JOIN
// ---------------------------------------------------------------------------

test('TestInnerJoin', () => {
  const e = newExecutor();
  setupJoinTables(e);
  const res = execSQL(e, "SELECT u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id");
  expect(res.rows.length).toBe(3);
});

test('TestLeftJoin', () => {
  const e = newExecutor();
  setupJoinTables(e);
  // Carol has no orders — left join should include her with null total
  const res = execSQL(e, "SELECT u.name, o.total FROM users u LEFT JOIN orders o ON u.id = o.user_id");
  expect(res.rows.length).toBe(4);
});

// ---------------------------------------------------------------------------
// INDEX
// ---------------------------------------------------------------------------

test('TestCreateDropIndex', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "CREATE INDEX idx_level ON players (level)");
  expect(res.message).toContain('created');
  const res2 = execSQL(e, "DROP INDEX idx_level");
  expect(res2.message).toContain('dropped');
});

test('TestIndexScanUsed', () => {
  const e = newExecutor();
  setupPlayers(e);
  execSQL(e, "CREATE INDEX idx_level ON players (level)");
  const res = execSQL(e, "SELECT * FROM players WHERE level > 10");
  // Range query should use Bitmap Scan (range) or Index Scan (point) — both are index-based.
  let usedIndex = false;
  for (const line of res.trace) {
    if (line.includes('Index Scan') || line.includes('Bitmap')) {
      usedIndex = true;
    }
  }
  expect(usedIndex).toBe(true);
  expect(res.rows.length).toBe(2);
});

test('TestDropIndexIfExists', () => {
  const e = newExecutor();
  const res = execSQL(e, "DROP INDEX IF EXISTS nonexistent");
  expect(res.message).toContain('did not exist');
});

// ---------------------------------------------------------------------------
// ANALYZE
// ---------------------------------------------------------------------------

test('TestAnalyze', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "ANALYZE players");
  expect(res.message).toContain('statistics updated');
  expect(res.trace.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// EXPLAIN
// ---------------------------------------------------------------------------

test('TestExplain', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "EXPLAIN SELECT * FROM players WHERE level > 5");
  expect(res.rows.length).toBeGreaterThan(0);
  let found = false;
  for (const row of res.rows) {
    if ((row[0] as string).includes('Planning Time')) {
      found = true;
    }
  }
  expect(found).toBe(true);
});

test('TestExplainAnalyze', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "EXPLAIN ANALYZE SELECT * FROM players");
  let found = false;
  for (const row of res.rows) {
    if ((row[0] as string).includes('Execution Time')) {
      found = true;
    }
  }
  expect(found).toBe(true);
});

test('TestExplainWithIndex', () => {
  const e = newExecutor();
  setupPlayers(e);
  execSQL(e, "CREATE INDEX idx_level ON players (level)");
  // Equality predicate → Index Scan; range predicate → Bitmap Scan. Both are index-based.
  const res = execSQL(e, "EXPLAIN SELECT * FROM players WHERE level = 10");
  let found = false;
  for (const row of res.rows) {
    const s = row[0] as string;
    if (s.includes('Index Scan') || s.includes('Bitmap')) {
      found = true;
    }
  }
  expect(found).toBe(true);
});

test('TestBitmapScanVsIndexScan', () => {
  const e = newExecutor();
  setupPlayers(e);
  execSQL(e, "CREATE INDEX idx_level ON players (level)");

  // Equality → Index Scan (point lookup).
  const res1 = execSQL(e, "EXPLAIN SELECT * FROM players WHERE level = 10");
  let indexFound = false;
  let bitmapFound = false;
  for (const row of res1.rows) {
    const s = row[0] as string;
    if (s.includes('Index Scan') && !s.includes('Bitmap')) {
      indexFound = true;
    }
    if (s.includes('Bitmap')) {
      bitmapFound = true;
    }
  }
  expect(indexFound).toBe(true);
  expect(bitmapFound).toBe(false);

  // Range → Bitmap Scan (sorted TID access).
  const res2 = execSQL(e, "EXPLAIN SELECT * FROM players WHERE level > 5");
  indexFound = false;
  bitmapFound = false;
  for (const row of res2.rows) {
    const s = row[0] as string;
    if (s.includes('Bitmap')) {
      bitmapFound = true;
    }
    if (s.includes('Index Scan') && !s.includes('Bitmap')) {
      indexFound = true;
    }
  }
  expect(indexFound).toBe(false);
  expect(bitmapFound).toBe(true);
});

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

test('TestBeginCommit', () => {
  const e = newExecutor();
  setupPlayers(e);

  const res = execSQL(e, "BEGIN");
  expect(res.message).toBe('BEGIN');

  execSQL(e, "INSERT INTO players (id, username, level, class) VALUES (99, 'Neo', 50, 'Mage')");

  const res2 = execSQL(e, "COMMIT");
  expect(res2.message).toBe('COMMIT');

  // verify row is visible after commit
  const res3 = execSQL(e, "SELECT * FROM players WHERE username = 'Neo'");
  expect(res3.rows.length).toBe(1);
});

test('TestBeginRollback', () => {
  const e = newExecutor();
  setupPlayers(e);

  execSQL(e, "BEGIN");
  execSQL(e, "INSERT INTO players (id, username, level, class) VALUES (99, 'Ghost', 1, 'Mage')");
  execSQL(e, "ROLLBACK");

  // insert was rolled back — should not appear
  const res = execSQL(e, "SELECT * FROM players WHERE username = 'Ghost'");
  expect(res.rows.length).toBe(0);
});

test('TestDoubleBeginError', () => {
  const e = newExecutor();
  execSQL(e, "CREATE TABLE t (id INT)");
  execSQL(e, "BEGIN");
  expect(execErr(e, "BEGIN")).not.toBeNull();
  execSQL(e, "ROLLBACK");
});

test('TestCommitWithoutBegin', () => {
  const e = newExecutor();
  execSQL(e, "CREATE TABLE t (id INT)");
  expect(execErr(e, "COMMIT")).not.toBeNull();
});

test('TestRollbackWithoutBegin', () => {
  const e = newExecutor();
  execSQL(e, "CREATE TABLE t (id INT)");
  expect(execErr(e, "ROLLBACK")).not.toBeNull();
});

// ---------------------------------------------------------------------------
// VACUUM
// ---------------------------------------------------------------------------

test('TestVacuum', () => {
  const e = newExecutor();
  setupPlayers(e);

  execSQL(e, "BEGIN");
  execSQL(e, "DELETE FROM players WHERE level < 8");
  execSQL(e, "COMMIT");

  const res = execSQL(e, "VACUUM players");
  expect(res.message).toContain('reclaimed');
});

// ---------------------------------------------------------------------------
// Expression evaluation edge cases
// ---------------------------------------------------------------------------

test('TestWhereNEQ', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "SELECT * FROM players WHERE class != 'Mage'");
  expect(res.rows.length).toBe(3);
});

test('TestWhereLTE', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "SELECT * FROM players WHERE level <= 8");
  expect(res.rows.length).toBe(2);
});

test('TestWhereGTE', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "SELECT * FROM players WHERE level >= 15");
  expect(res.rows.length).toBe(2);
});

test('TestWhereOr', () => {
  const e = newExecutor();
  setupPlayers(e);
  const res = execSQL(e, "SELECT * FROM players WHERE class = 'Mage' OR class = 'Rogue'");
  expect(res.rows.length).toBe(3);
});

// ---------------------------------------------------------------------------
// exprString
// ---------------------------------------------------------------------------

test('TestExprString', () => {
  const expr: BinaryExpr = {
    kind: 'binary',
    left: { kind: 'ident', table: '', name: 'age' } as IdentExpr,
    op: '>',
    right: { kind: 'literal', value: 25 } as LiteralExpr,
  };
  const s = exprString(expr);
  expect(s).toBe('(age > 25)');
});

test('TestExprStringNull', () => {
  // exprString is not exported to handle null directly, but we can test the identity case
  // In the Go test, ExprString(nil) returns "". In TS, exprString requires Expression.
  // We verify the ident and literal cases work as expected.
  const ident: IdentExpr = { kind: 'ident', table: '', name: 'age' };
  expect(exprString(ident)).toBe('age');
  const lit: LiteralExpr = { kind: 'literal', value: null };
  expect(exprString(lit)).toBe('null');
});

// ---------------------------------------------------------------------------
// Derived table (from derived_test.go)
// ---------------------------------------------------------------------------

test('TestDerivedTableFromSubquery', () => {
  const e = newExecutor();
  setupPlayers(e);

  // Inner WHERE level > 10 matches Carol (15) and Eve (15).
  const r = execSQL(e, "SELECT t.username, t.level FROM (SELECT username, level FROM players WHERE level > 10) t ORDER BY t.level DESC");
  expect(r.rows.length).toBe(2);
  expect(r.columns[0]).toBe('username');
  expect(r.columns[1]).toBe('level');
  // First row should be highest level (15).
  expect(Number(r.rows[0][1])).toBe(15);
});

test('TestDerivedTableSelectStar', () => {
  const e = newExecutor();
  setupPlayers(e);

  // SELECT * from derived table — Bob(5) and Dan(8)
  const r = execSQL(e, "SELECT * FROM (SELECT username, level FROM players WHERE level < 10) t");
  expect(r.rows.length).toBe(2);
});

test('TestDerivedTableWithAgg', () => {
  const e = newExecutor();
  setupPlayers(e);

  // Derived table containing aggregated results.
  const r = execSQL(e, "SELECT t.class FROM (SELECT class, COUNT(*) FROM players GROUP BY class HAVING COUNT(*) > 1) t");
  expect(r.rows.length).toBeGreaterThan(0);
});

test('TestDerivedTableJoin', () => {
  const e = newExecutor();
  setupPlayers(e);

  // JOIN a derived table.
  const r = execSQL(e, "SELECT p.username, sub.class FROM players p JOIN (SELECT DISTINCT class FROM players WHERE level > 10) sub ON p.class = sub.class");
  expect(r.rows.length).toBeGreaterThan(0);
});
