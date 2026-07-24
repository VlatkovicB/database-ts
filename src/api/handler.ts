// =============================================================================
// handler.ts — port of api/handler.go
// Express route handlers for MiniDB.
// =============================================================================

import { Router, Request, Response } from 'express';
import { Lexer } from '../lexer/lexer';
import { parse } from '../parser/parser';
import { Executor, newExecutor, IndexSuggestion } from '../executor/executor';
import { Database } from '../storage/storage';
import { HistoryStore } from './history';
import { seedStatements } from './seed';
import { serializeTokens, stmtToTrace, TraceToken } from './trace';

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

interface QueryRequest {
  sql: string;
  session_id?: string;
}

interface QueryResponse {
  columns?: string[];
  rows?: unknown[][];
  message?: string;
  error?: string;
  tokens?: TraceToken[];
  ast?: unknown;
  execTrace?: string[];
  session_id?: string;
  indexSuggestions?: IndexSuggestion[];
}

// ---------------------------------------------------------------------------
// Handler class — holds the shared DB and session map
// ---------------------------------------------------------------------------

export class Handler {
  private db: Database;
  private history: HistoryStore | null;
  // session_id → stateful Executor that has an open transaction
  private sessions: Map<string, Executor> = new Map();

  constructor(db: Database, history: HistoryStore | null) {
    this.db = db;
    this.history = history;
  }

  // -------------------------------------------------------------------------
  // POST /query
  // -------------------------------------------------------------------------

  handleQuery = (req: Request, res: Response): void => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    const body = req.body as QueryRequest;
    if (!body || !body.sql) {
      res.json({ error: 'sql is required' } satisfies QueryResponse);
      return;
    }

    const sql = body.sql;
    const reqSessionID = body.session_id ?? '';

    // Stage 1: Lex
    const tokens = new Lexer(sql).tokenize();
    const traceTokens = serializeTokens(tokens);

    // Stage 2: Parse
    let stmt;
    try {
      stmt = parse(sql, tokens);
    } catch (err: any) {
      res.json({
        error: 'parse error: ' + (err?.message ?? String(err)),
        tokens: traceTokens,
      } satisfies QueryResponse);
      return;
    }

    const ast = stmtToTrace(stmt);

    // Stage 3: Resolve executor (session-aware)
    let exec: Executor;
    let sessionID = '';

    if (stmt.kind === 'begin') {
      // BEGIN: always create a fresh executor.
      exec = newExecutor(this.db);
      let result;
      try {
        result = exec.execute(stmt);
      } catch (err: any) {
        res.json({ error: err?.message ?? String(err), tokens: traceTokens, ast } satisfies QueryResponse);
        return;
      }
      // Store session keyed by tx ID.
      sessionID = `tx-${exec.currentTx!.id}`;
      this.sessions.set(sessionID, exec);
      if (this.history) {
        setImmediate(() => this.history!.upsert(sql));
      }
      res.json({
        message: result.message,
        tokens: traceTokens,
        ast,
        execTrace: result.trace,
        session_id: sessionID,
      } satisfies QueryResponse);
      return;
    }

    if (stmt.kind === 'commit' || stmt.kind === 'rollback') {
      // COMMIT / ROLLBACK require an existing session.
      if (!reqSessionID) {
        res.json({
          error: 'COMMIT/ROLLBACK requires a session_id',
          tokens: traceTokens,
          ast,
        } satisfies QueryResponse);
        return;
      }
      const existing = this.sessions.get(reqSessionID);
      if (!existing) {
        res.json({
          error: `session "${reqSessionID}" not found`,
          tokens: traceTokens,
          ast,
        } satisfies QueryResponse);
        return;
      }
      exec = existing;
      let result;
      try {
        result = exec.execute(stmt);
      } catch (err: any) {
        this.sessions.delete(reqSessionID);
        res.json({ error: err?.message ?? String(err), tokens: traceTokens, ast } satisfies QueryResponse);
        return;
      }
      // Always remove the session after COMMIT/ROLLBACK.
      this.sessions.delete(reqSessionID);
      res.json({
        message: result.message,
        tokens: traceTokens,
        ast,
        execTrace: result.trace,
      } satisfies QueryResponse);
      return;
    }

    // Default: auto-commit or session-bound statement.
    if (reqSessionID) {
      const existing = this.sessions.get(reqSessionID);
      if (!existing) {
        res.json({
          error: `session "${reqSessionID}" not found`,
          tokens: traceTokens,
          ast,
        } satisfies QueryResponse);
        return;
      }
      exec = existing;
      sessionID = reqSessionID;
    } else {
      exec = newExecutor(this.db);
    }

    let result;
    try {
      result = exec.execute(stmt);
    } catch (err: any) {
      res.json({
        error: err?.message ?? String(err),
        tokens: traceTokens,
        ast,
        session_id: sessionID || undefined,
      } satisfies QueryResponse);
      return;
    }

    if (this.history) {
      setImmediate(() => this.history!.upsert(sql));
    }

    res.json({
      columns: result.columns,
      rows: result.rows,
      message: result.message,
      tokens: traceTokens,
      ast,
      execTrace: result.trace,
      session_id: sessionID || undefined,
      indexSuggestions: result.indexSuggestions,
    } satisfies QueryResponse);
  };

  // -------------------------------------------------------------------------
  // GET /history
  // -------------------------------------------------------------------------

  handleHistory = (_req: Request, res: Response): void => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const queries = this.history ? this.history.list() : [];
    res.json({ queries });
  };

  // -------------------------------------------------------------------------
  // GET /tables
  // -------------------------------------------------------------------------

  handleTables = (_req: Request, res: Response): void => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    interface ColInfo {
      name: string;
      type: string;
      primary: boolean;
      indexed?: boolean;
      indexName?: string;
    }
    interface TblInfo {
      name: string;
      columns: ColInfo[];
      rowCount: number;
    }

    const result: TblInfo[] = [];
    for (const t of this.db.listTables()) {
      const idxes = this.db.listIndexesForTable(t.name);
      const colIdx = new Map<string, string>();
      for (const idx of idxes) {
        colIdx.set(idx.column, idx.name);
      }
      const cols: ColInfo[] = t.columns.map((c) => {
        const idxName = colIdx.get(c.name);
        return {
          name: c.name,
          type: c.type,
          primary: c.primary,
          ...(idxName ? { indexed: true, indexName: idxName } : {}),
        };
      });
      result.push({ name: t.name, columns: cols, rowCount: t.rowCount });
    }
    res.json({ tables: result });
  };

  // -------------------------------------------------------------------------
  // POST /vacuum
  // -------------------------------------------------------------------------

  handleVacuum = (req: Request, res: Response): void => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    const body = req.body as { table?: string };
    if (!body || !body.table) {
      res.json({ error: 'table is required' });
      return;
    }

    const [reclaimed, err] = this.db.vacuum(body.table);
    if (err) {
      res.json({ error: err.message });
      return;
    }
    res.json({ reclaimed });
  };

  // -------------------------------------------------------------------------
  // GET /wal
  // -------------------------------------------------------------------------

  handleWAL = (_req: Request, res: Response): void => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const records = this.db.wal.getRecords();
    // Serialise bigints as strings for JSON transport.
    res.json({
      records: records.map((r) => ({
        ...r,
        lsn: String(r.lsn),
        xid: String(r.xid),
      })),
      checkpointLSN: String(this.db.wal.checkpointLSN()),
      hasCheckpoint: this.db.wal.hasCheckpoint(),
    });
  };

  // -------------------------------------------------------------------------
  // POST /wal/checkpoint
  // -------------------------------------------------------------------------

  handleWALCheckpoint = (_req: Request, res: Response): void => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const rec = this.db.wal.takeCheckpoint(this.db);
    res.json({
      lsn: String(rec.lsn),
      message: `CHECKPOINT written at LSN ${rec.lsn}`,
    });
  };

  // -------------------------------------------------------------------------
  // POST /wal/crash
  // -------------------------------------------------------------------------

  handleWALCrash = (_req: Request, res: Response): void => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const ok = this.db.wal.restoreCheckpoint(this.db);
    if (!ok) {
      res.json({ error: 'no checkpoint exists — take a checkpoint first' });
      return;
    }
    res.json({
      ok: true,
      message: `CRASH simulated — DB reverted to checkpoint LSN ${this.db.wal.checkpointLSN()}`,
    });
  };

  // -------------------------------------------------------------------------
  // POST /wal/recover
  // -------------------------------------------------------------------------

  handleWALRecover = (_req: Request, res: Response): void => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const [replayed, err] = this.db.wal.replay(this.db);
    if (err) {
      res.json({ error: err.message });
      return;
    }
    res.json({
      replayed,
      message: `RECOVERY complete — replayed ${replayed} WAL record(s)`,
    });
  };

  // -------------------------------------------------------------------------
  // GET or POST /seed
  // -------------------------------------------------------------------------

  handleSeed = (req: Request, res: Response): void => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }

    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(seedStatements.map((s) => `${s};`).join('\n') + '\n');
      return;
    }

    res.setHeader('Content-Type', 'application/json');

    const exec = newExecutor(this.db);
    const errs: string[] = [];
    let ok = 0;

    for (const sql of seedStatements) {
      try {
        const toks = new Lexer(sql).tokenize();
        const stmt = parse(sql, toks);
        exec.execute(stmt);
        ok++;
      } catch (err: any) {
        const preview = sql.slice(0, 40);
        errs.push(`${preview}: ${err?.message ?? String(err)}`);
      }
    }

    res.json({ ok, errors: errs });
  };
}

// ---------------------------------------------------------------------------
// Factory: build an Express Router with all routes wired up
// ---------------------------------------------------------------------------

export function createRouter(db: Database, history: HistoryStore | null): Router {
  const router = Router();
  const h = new Handler(db, history);

  router.post('/query', h.handleQuery);
  router.options('/query', (_req, res) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.sendStatus(200); });

  router.get('/history', h.handleHistory);

  router.get('/tables', h.handleTables);

  router.get('/seed', h.handleSeed);
  router.post('/seed', h.handleSeed);
  router.options('/seed', (_req, res) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.sendStatus(200); });

  router.post('/vacuum', h.handleVacuum);
  router.options('/vacuum', (_req, res) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.sendStatus(200); });

  router.get('/wal', h.handleWAL);
  router.post('/wal/checkpoint', h.handleWALCheckpoint);
  router.post('/wal/crash', h.handleWALCrash);
  router.post('/wal/recover', h.handleWALRecover);

  return router;
}
