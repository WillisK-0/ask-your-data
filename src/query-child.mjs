// Runs one read-only query in its own process so the parent can SIGKILL it on timeout.
// A worker thread can't be stopped mid-way through a native SQLite call; a process can.
import { DatabaseSync } from "node:sqlite";

process.once("message", ({ path, sql, limit }) => {
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare(`SELECT * FROM (${sql}) LIMIT ${limit + 1}`).all();
    db.close();
    process.send({ ok: true, rows }, () => process.exit(0));
  } catch (err) {
    process.send({ ok: false, error: err.message }, () => process.exit(0));
  }
});
