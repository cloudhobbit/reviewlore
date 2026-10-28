// Child process that builds a review index (lib/mcp-tools.mjs). Parsing a
// busy repo's cache (hundreds of MB) raises a process's memory past a
// gigabyte and Node doesn't hand it back to the OS, so the long-lived MCP
// server leaves that to a short-lived process and keeps only the index.
// Its stdout is ignored by the parent: that is the server's protocol channel.

import { readFileSync } from "node:fs";
import { buildIndex, EMPTY_DATA } from "./review-index.mjs";

process.once("message", ({ dataPath, rules }) => {
  const data = dataPath ? JSON.parse(readFileSync(dataPath, "utf-8")) : EMPTY_DATA;
  process.send(buildIndex(data, { rules, clusters: true }), () => process.exit(0));
});
