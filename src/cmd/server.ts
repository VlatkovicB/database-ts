// =============================================================================
// server.ts — port of cmd/server/main.go
// Entry point: creates the Express app, registers all routes, and starts
// listening on port 8080.
// =============================================================================

import express from 'express';
import path from 'path';
import { Database } from '../storage/storage';
import { HistoryStore } from '../api/history';
import { createRouter } from '../api/handler';

const PORT = 3000;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const db = new Database();
const history = new HistoryStore();

const app = express();

// Parse JSON bodies for all routes.
app.use(express.json());

// Mount API routes.
app.use('/', createRouter(db, history));

// Serve the static frontend from src/cmd/web/.
// In development ts-node runs from the project root, so __dirname resolves to
// src/cmd/ — the web/ subdirectory lives next to this file.
const webDir = path.join(__dirname, 'web');
app.use(express.static(webDir));

// Catch-all: for any non-API path, return index.html (SPA fallback).
app.get('*', (_req, res) => {
  res.sendFile(path.join(webDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`MiniDB running at http://localhost:${PORT}`);
});

export default app;
