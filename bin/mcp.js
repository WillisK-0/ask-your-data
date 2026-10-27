#!/usr/bin/env node
// Entry point for `npx @willisk-0/ask-your-data` and the `ask-your-data-mcp` bin: starts the stdio MCP server.
import { main } from "../dist/mcp.js";
await main();
