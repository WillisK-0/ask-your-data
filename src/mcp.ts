import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ReadOnlyDb, DocSearch } from "./db.js";
import { makeTools } from "./tools.js";
import { customerDetail } from "./detail.js";

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.ASK_DB ?? join(here, "..", "data", "sample.db");
const docsDir = process.env.ASK_DOCS ?? join(here, "..", "docs");

const db = new ReadOnlyDb(dbPath);
const docs = new DocSearch(docsDir);

export const TABLE_UI = "ui://ask-your-data/table";
const TABLE_HTML = readFileSync(join(here, "ui", "table.html"), "utf8");

export function buildServer() {
  const server = new McpServer({ name: "ask-your-data", version: "0.2.0" });

  for (const t of makeTools(db, docs)) {
    if (t.name === "query") continue; // registered below with a UI
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.shape },
      async (input: Record<string, unknown>) => {
        try {
          const text = await t.run(input as never);
          return { content: [{ type: "text" as const, text }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
        }
      },
    );
  }

  // query: same tool as before, plus an interactive table/chart panel in hosts that render MCP Apps.
  registerAppTool(
    server,
    "query",
    {
      title: "Query the database",
      description:
        "Run a read-only SQL query (SQLite dialect). Only SELECT or WITH. Results are capped at 200 rows, so aggregate in SQL rather than pulling raw rows. Dates are ISO strings; use date() and strftime(). Include customer_id (or id plus name) in the columns when rows are customers, so the user can open each one.",
      inputSchema: { sql: z.string().describe("A single SELECT or WITH statement") },
      _meta: { ui: { resourceUri: TABLE_UI } },
    },
    async ({ sql }) => {
      try {
        const { rows, truncated } = await db.query(sql);
        const columns = rows.length ? Object.keys(rows[0] as object) : [];
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ rowCount: rows.length, truncated, rows }, null, 2) }],
          structuredContent: { sql, columns, rows, rowCount: rows.length, truncated },
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // customer_detail: one customer with their tickets and invoices. The panel calls this when a row is clicked.
  server.registerTool(
    "customer_detail",
    {
      description: "One customer's profile, lifetime totals, open tickets and invoices. Use when the user asks about a specific customer by id.",
      inputSchema: { id: z.number().int().describe("customers.id") },
    },
    async ({ id }) => {
      try {
        const detail = await customerDetail(db, id);
        return { content: [{ type: "text" as const, text: JSON.stringify(detail, null, 2) }], structuredContent: detail as Record<string, unknown> };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  registerAppResource(server, "Data view", TABLE_UI, { description: "Interactive table and chart for query results, with a customer drill-in." }, async () => ({
    contents: [{ uri: TABLE_UI, mimeType: RESOURCE_MIME_TYPE, text: TABLE_HTML, _meta: { ui: { csp: { resourceDomains: ["https://unpkg.com"] }, prefersBorder: true } } }],
  }));

  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
