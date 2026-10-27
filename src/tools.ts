import { z } from "zod";
import { ReadOnlyDb, DocSearch } from "./db.js";

/** One tool definition, adaptable to both the Anthropic SDK tool runner and an MCP server. */
export interface ToolDef<S extends z.ZodRawShape> {
  name: string;
  description: string;
  shape: S;
  run: (input: z.infer<z.ZodObject<S>>) => Promise<string> | string;
}

function def<S extends z.ZodRawShape>(t: ToolDef<S>): ToolDef<S> { return t; }

export function makeTools(db: ReadOnlyDb, docs: DocSearch) {
  return [
    def({
      name: "list_tables",
      description: "List every table in the database with its row count. Call this first when you don't know the schema.",
      shape: {},
      run: () => JSON.stringify(db.listTables(), null, 2),
    }),
    def({
      name: "describe_table",
      description: "Columns, types, foreign keys, and three sample rows for one table.",
      shape: { table: z.string().describe("Exact table name from list_tables") },
      run: ({ table }) => JSON.stringify(db.describeTable(table), null, 2),
    }),
    def({
      name: "query",
      description: "Run a read-only SQL query (SQLite dialect). Only SELECT or WITH. Results are capped at 200 rows, so aggregate in SQL rather than pulling raw rows. Dates are ISO strings; use date() and strftime().",
      shape: { sql: z.string().describe("A single SELECT or WITH statement") },
      run: async ({ sql }) => {
        const { rows, truncated } = await db.query(sql);
        return JSON.stringify({ rowCount: rows.length, truncated, rows }, null, 2);
      },
    }),
    def({
      name: "search_docs",
      description: "Search the company's policy and runbook documents (refund policy, SLAs, escalation procedures). Use for questions about rules and process, not for numbers.",
      shape: { query: z.string().describe("Plain-language search terms") },
      run: ({ query }) => JSON.stringify(docs.search(query), null, 2),
    }),
  ];
}

export type AnyTool = ReturnType<typeof makeTools>[number];
