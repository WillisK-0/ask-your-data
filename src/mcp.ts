import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { z } from "zod";
import { ReadOnlyDb, DocSearch } from "./db.js";
import { makeTools } from "./tools.js";
import { customerDetail } from "./detail.js";
import { refundQueue, decideRefund, createTicket } from "./panels.js";

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.ASK_DB ?? join(here, "..", "data", "sample.db");
const docsDir = process.env.ASK_DOCS ?? join(here, "..", "docs");

const db = new ReadOnlyDb(dbPath);
const docs = new DocSearch(docsDir);

/** The four panels Claude Desktop can render. Each is a ui:// resource whose HTML lives in src/ui/. */
export const UI = {
  table: "ui://ask-your-data/table",
  docs: "ui://ask-your-data/docs",
  approvals: "ui://ask-your-data/approvals",
  ticket: "ui://ask-your-data/ticket",
} as const;
const html = (name: string) => readFileSync(join(here, "ui", `${name}.html`), "utf8");
const UI_META = { ui: { csp: { resourceDomains: ["https://unpkg.com"] }, prefersBorder: true } };

const ok = (data: unknown, text?: string) => ({ content: [{ type: "text" as const, text: text ?? JSON.stringify(data, null, 2) }], structuredContent: data as Record<string, unknown> });
const fail = (err: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true });

export function buildServer() {
  const server = new McpServer({ name: "ask-your-data", version: "0.3.0" });

  // Plain tools (text only): list_tables, describe_table.
  for (const t of makeTools(db, docs)) {
    if (t.name === "query" || t.name === "search_docs") continue;
    server.registerTool(t.name, { description: t.description, inputSchema: t.shape }, async (input: Record<string, unknown>) => {
      try { return { content: [{ type: "text" as const, text: await t.run(input as never) }] }; } catch (err) { return fail(err); }
    });
  }

  // 1. query → sortable table / chart with a customer drill-in.
  registerAppTool(server, "query", {
    title: "Query the database",
    description: "Run a read-only SQL query (SQLite dialect). Only SELECT or WITH. Results are capped at 200 rows, so aggregate in SQL rather than pulling raw rows. Dates are ISO strings; use date() and strftime(). Include customer_id (or id plus name) in the columns when rows are customers, so the user can open each one.",
    inputSchema: { sql: z.string().describe("A single SELECT or WITH statement") },
    _meta: { ui: { resourceUri: UI.table } },
  }, async ({ sql }) => {
    try {
      const { rows, truncated } = await db.query(sql);
      const columns = rows.length ? Object.keys(rows[0] as object) : [];
      return ok({ sql, columns, rows, rowCount: rows.length, truncated }, JSON.stringify({ rowCount: rows.length, truncated, rows }, null, 2));
    } catch (err) { return fail(err); }
  });

  server.registerTool("customer_detail", {
    description: "One customer's profile, lifetime totals, open tickets and invoices. Use when the user asks about a specific customer by id.",
    inputSchema: { id: z.number().int().describe("customers.id") },
  }, async ({ id }) => { try { return ok(await customerDetail(db, id)); } catch (err) { return fail(err); } });

  // 2. search_docs → policy answer with the source section highlighted.
  registerAppTool(server, "search_docs", {
    title: "Search the policy handbook",
    description: "Search the company's policy and runbook documents (refund policy, SLAs, escalation procedures). Use for questions about rules and process, not for numbers. Returns the matching sections with their source file and heading; cite them.",
    inputSchema: { query: z.string().describe("Plain-language search terms") },
    _meta: { ui: { resourceUri: UI.docs } },
  }, async ({ query }) => {
    try { const results = docs.search(query, 3); return ok({ query, results }); } catch (err) { return fail(err); }
  });

  // 3. refund_queue + decide_refund → an approval queue with the policy rule on each request.
  registerAppTool(server, "refund_queue", {
    title: "Refund requests awaiting a decision",
    description: "List refund requests waiting on an approver, each with the policy rule that applies and whether Tier 1 can approve it. The user approves, rejects or escalates from the panel.",
    inputSchema: {},
    _meta: { ui: { resourceUri: UI.approvals } },
  }, async () => { try { const requests = await refundQueue(db); return ok({ requests }); } catch (err) { return fail(err); } });

  server.registerTool("decide_refund", {
    description: "Record a decision on a refund request: approved, rejected or escalated. Decisions are kept for the life of the server; nothing moves money.",
    inputSchema: { id: z.number().int().describe("refund request id (the invoice id)"), decision: z.enum(["approved", "rejected", "escalated"]), note: z.string().optional() },
  }, async ({ id, decision, note }) => ok(decideRefund(id, decision, note)));

  // 4. draft_ticket + create_ticket → a form Claude pre-fills and the user confirms.
  registerAppTool(server, "draft_ticket", {
    title: "Draft a support ticket",
    description: "Open a pre-filled ticket form for the user to check and submit. Fill every field from the conversation; the user edits what's wrong and clicks Create. Do not call create_ticket yourself.",
    inputSchema: {
      customer_id: z.number().int(), customer: z.string().describe("Customer name, for display"),
      subject: z.string(), category: z.enum(["bug", "billing", "integration", "performance", "account", "feature-request"]),
      priority: z.enum(["low", "normal", "high", "urgent"]), body: z.string().describe("What's wrong, steps so far, what the customer wants"),
    },
    _meta: { ui: { resourceUri: UI.ticket } },
  }, async (draft) => ok(draft, `Ticket form opened for ${draft.customer}: "${draft.subject}" (${draft.priority}, ${draft.category}). Waiting for the user to create or discard it.`));

  server.registerTool("create_ticket", {
    description: "Create the ticket. Only the ticket form calls this after the user clicks Create. Kept in memory: the sample database is read-only.",
    inputSchema: { customer_id: z.number().int(), subject: z.string(), category: z.string(), priority: z.string(), body: z.string() },
  }, async (t) => ok(createTicket(t)));

  for (const [name, uri] of Object.entries(UI)) {
    const titles: Record<string, string> = { table: "Data view", docs: "Policy answer", approvals: "Refund approvals", ticket: "New ticket" };
    registerAppResource(server, titles[name], uri, { description: `${titles[name]} panel` }, async () => ({
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html(name), _meta: UI_META }],
    }));
  }
  return server;
}

export async function main() {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) await main();
