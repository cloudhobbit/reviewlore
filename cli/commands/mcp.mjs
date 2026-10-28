// MCP server that exposes the PR-feedback corpus to Claude on demand.
//
// Static rule files in .claude/rules/ have a downside: every rule is
// loaded into Claude's context whether relevant or not. This server lets
// Claude query the corpus by topic / path / PR-number, surfacing only
// what's relevant to the current change.
//
// Tools (lib/mcp-tools.mjs): review_feedback_for_path, search_review_feedback,
// list_repos, plus the older search_rules / recent_feedback. Inside a repo
// they need no owner/repo. Data: the per-user cache (~/.reviewlore) or the
// repo's committed corpus, whichever is newer; with neither, tools answer
// with the repo's rule files and a hint on how to get the history.

import { fileURLToPath } from "node:url";
import { TOOLS, INSTRUCTIONS, validateArgs, setClientRoot } from "../../lib/mcp-tools.mjs";
import { PACKAGE_ROOT } from "../../lib/doctor.mjs";

const VERSION = "0.3.0";

const HELP = `reviewlore mcp v${VERSION}

MCP server exposing the PR-feedback corpus to Claude Code on demand.
The Claude Code plugin registers it for you; for other MCP clients
(Cursor, etc.) register it with stdio transport.

Usage:
  reviewlore mcp          Start server on stdio
  reviewlore mcp --version
  reviewlore mcp --help

Tools exposed (owner/repo are optional inside the repository):
  review_feedback_for_path({path, owner?, repo?, months?, limit?})
  search_review_feedback({query, path?, owner?, repo?, limit?})
  list_repos()
  search_rules / recent_feedback   (older names, kept for now)

The repository is the git root of REVIEWLORE_PROJECT_DIR, CLAUDE_PROJECT_DIR,
the client's first root, or the working directory. Data: the newer of
~/.reviewlore/<owner>__<repo>.json (\`reviewlore fetch --cache\`) and the
repository's committed .reviewlore-corpus.json; rules from .claude/rules/.
`;

// Returns an exit code, or null once the server is running (it then
// serves on stdio until the client disconnects).
export async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  // Dynamic import of optional dep so --help/--version work without it.
  let Server, StdioServerTransport, ListToolsRequestSchema, CallToolRequestSchema, RootsListChangedNotificationSchema;
  try {
    ({ Server } = await import("@modelcontextprotocol/sdk/server/index.js"));
    ({ StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js"));
    ({ ListToolsRequestSchema, CallToolRequestSchema, RootsListChangedNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js"));
  } catch {
    process.stderr.write(
      "Error: reviewlore's MCP server needs its npm dependencies (@modelcontextprotocol/sdk).\n" +
        "If you installed the Claude Code plugin, reinstall it (npm must be on your PATH);\n" +
        `otherwise run \`npm install\` in ${PACKAGE_ROOT}.\n`,
    );
    return 1;
  }

  // ------ Server wiring ---------------------------------------------------
  // Low-level Server + JSON Schema tool definitions (see lib/mcp-tools.mjs).

  const server = new Server(
    { name: "reviewlore", version: VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  // The client's workspace root: a fallback when no project directory is
  // passed in the environment.
  const refreshRoots = async () => {
    if (!server.getClientCapabilities()?.roots) return;
    try {
      const { roots } = await server.listRoots();
      const root = roots.find((r) => r.uri.startsWith("file://"));
      setClientRoot(root ? fileURLToPath(root.uri) : null);
    } catch {
      // Roots are optional; the environment or working directory still work.
    }
  };
  server.oninitialized = () => { refreshRoots(); };
  server.setNotificationHandler(RootsListChangedNotificationSchema, () => { refreshRoots(); });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema, _meta }) => ({ name, description, inputSchema, ...(_meta ? { _meta } : {}) })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((t) => t.name === request.params.name);
    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };
    }
    const args = request.params.arguments ?? {};
    const invalid = validateArgs(tool, args);
    if (invalid) return { content: [{ type: "text", text: invalid }], isError: true };
    try {
      const result = await tool.handler(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The stdio transport keeps the process alive; null tells the caller
  // not to exit.
  return null;
}
