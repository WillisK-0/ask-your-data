// Spawns the MCP server over stdio exactly as Claude Code or Claude Desktop would, lists tools, calls each one.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", join(here, "mcp.ts")],
  stderr: "ignore",
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");

console.log("\n--- list_tables");
console.log(text(await client.callTool({ name: "list_tables", arguments: {} })));

console.log("\n--- describe_table tickets (first 600 chars)");
console.log(text(await client.callTool({ name: "describe_table", arguments: { table: "tickets" } })).slice(0, 600));

console.log("\n--- query: tickets per category with avg hours to resolve");
console.log(text(await client.callTool({ name: "query", arguments: { sql: `
  SELECT category, COUNT(*) AS n,
         ROUND(AVG((julianday(resolved_at) - julianday(opened_at)) * 24), 1) AS avg_hours_to_resolve
  FROM tickets WHERE status = 'resolved' GROUP BY category ORDER BY n DESC` } })));

console.log("\n--- query: blocked write");
console.log(text(await client.callTool({ name: "query", arguments: { sql: "DELETE FROM tickets" } })));

console.log("\n--- search_docs: duplicate charge refund limit");
console.log(text(await client.callTool({ name: "search_docs", arguments: { query: "duplicate charge refund approval limit" } })).slice(0, 500));

await client.close();
