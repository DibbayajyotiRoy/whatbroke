/** `whatbroke mcp` — launch the read-only stdio MCP server for this project (08). */
import { resolveStorePaths } from '../paths.js';
import { startMcpServer } from '../mcp/server.js';

export interface McpArgs {
  cwd: string;
  out?: string;
}

export async function mcpCmd(args: McpArgs): Promise<number> {
  const store = resolveStorePaths(args.cwd, args.out);
  // The server speaks MCP over stdio; nothing else may write to stdout.
  const serverOpts: Parameters<typeof startMcpServer>[0] = {
    bundlesDir: store.bundlesDir,
    projectCwd: args.cwd,
  };
  if (args.out !== undefined) serverOpts.out = args.out;
  await startMcpServer(serverOpts);
  // startMcpServer resolves once connected; keep the process alive.
  return await new Promise<number>(() => {
    /* never resolves — the server runs until the transport closes */
  });
}
