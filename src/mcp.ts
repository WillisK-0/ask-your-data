import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ReadOnlyDb, DocSearch } from "./db.js";
import { makeTools } from "./tools.js";

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.ASK_DB ?? join(here, "..", "data", "sample.db");
const docsDir = process.env.ASK_DOCS ?? join(here, "..", "docs");

const db = new ReadOnlyDb(dbPath);
const docs = new DocSearch(docsDir);

const server = new McpServer({ name: "ask-your-data", version: "0.1.0" });

for (const t of makeTools(db, docs)) {
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

const transport = new StdioServerTransport();
await server.connect(transport);
