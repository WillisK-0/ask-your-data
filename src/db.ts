import { DatabaseSync } from "node:sqlite";
import { fork } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";

export type Row = Record<string, unknown>;

export class ReadOnlyDb {
  private db: DatabaseSync;
  private running = 0;
  constructor(private path: string, private queryTimeoutMs = 5000, private maxConcurrent = 2) {
    this.db = new DatabaseSync(path, { readOnly: true });
  }

  listTables(): { table: string; rows: number }[] {
    const names = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];
    return names.map(({ name }) => {
      const r = this.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number };
      return { table: name, rows: r.n };
    });
  }

  describeTable(table: string) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Invalid table name: ${table}`);
    const columns = this.db.prepare(`PRAGMA table_info("${table}")`).all() as {
      name: string; type: string; notnull: number; pk: number;
    }[];
    if (columns.length === 0) throw new Error(`No such table: ${table}`);
    const fks = this.db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as {
      from: string; table: string; to: string;
    }[];
    const sample = this.db.prepare(`SELECT * FROM "${table}" LIMIT 3`).all() as Row[];
    return {
      table,
      columns: columns.map((c) => ({
        name: c.name,
        type: c.type || "ANY",
        primaryKey: c.pk > 0,
        nullable: c.notnull === 0,
      })),
      foreignKeys: fks.map((f) => `${f.from} -> ${f.table}.${f.to}`),
      sample,
    };
  }

  /**
   * Runs a single read-only SELECT/WITH statement in a child process, capped at `limit` rows.
   * The process is SIGKILLed after `queryTimeoutMs`, which is the only reliable way to stop
   * a runaway query: SQLite runs synchronously in native code, so neither a worker thread
   * nor a keyword filter can be trusted to interrupt it.
   */
  async query(sql: string, limit = 200): Promise<{ rows: Row[]; truncated: boolean }> {
    const cleaned = sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim().replace(/;$/, "");
    if (!/^(select|with)\b/i.test(cleaned)) throw new Error("Only SELECT or WITH statements are allowed.");
    if (cleaned.includes(";")) throw new Error("One statement per query.");
    if (this.running >= this.maxConcurrent) throw new Error("Too many queries running. Try again in a moment.");
    this.running++;
    try {
      const rows = await this.runInChild(cleaned, limit);
      const truncated = rows.length > limit;
      return { rows: truncated ? rows.slice(0, limit) : rows, truncated };
    } finally {
      this.running--;
    }
  }

  private runInChild(sql: string, limit: number): Promise<Row[]> {
    return new Promise((resolve, reject) => {
      const child = fork(new URL("./query-child.mjs", import.meta.url), [], { serialization: "json", stdio: ["ignore", "ignore", "ignore", "ipc"] });
      let settled = false;
      const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(new Error(`Query exceeded ${this.queryTimeoutMs / 1000}s and was cancelled. Add filters or aggregate.`)));
      }, this.queryTimeoutMs);
      child.once("message", (m: { ok: boolean; rows?: Row[]; error?: string }) => {
        finish(() => (m.ok ? resolve(m.rows ?? []) : reject(new Error(m.error))));
      });
      child.once("error", (e) => finish(() => reject(e)));
      child.once("exit", (code, signal) => {
        finish(() => reject(new Error(`Query process exited unexpectedly (${signal ?? code}).`)));
      });
      child.send({ path: this.path, sql, limit });
    });
  }
}

/** Keyword search over markdown docs, split by heading. Good enough for a demo; swap for embeddings in production. */
export class DocSearch {
  private sections: { file: string; heading: string; text: string; terms: Set<string> }[] = [];
  constructor(dir: string) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const body = readFileSync(join(dir, f), "utf8");
      const parts = body.split(/^(?=#{1,3} )/m);
      for (const part of parts) {
        const heading = (part.match(/^#{1,3} (.*)$/m)?.[1] ?? basename(f)).trim();
        const text = part.trim();
        if (!text) continue;
        this.sections.push({ file: f, heading, text, terms: new Set(tokenize(text)) });
      }
    }
  }
  search(query: string, k = 3) {
    const q = tokenize(query);
    return this.sections
      .map((s) => ({ s, score: q.reduce((n, t) => n + (s.terms.has(t) ? 1 : 0), 0) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ s, score }) => ({ file: s.file, heading: s.heading, score, text: s.text.slice(0, 1200) }));
  }
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
}
