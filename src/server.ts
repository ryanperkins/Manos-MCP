import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getContext } from "./tools/context.js";
import { registerTools } from "./tools/register.js";

export const SERVER_INFO = { name: "manos", version: "0.1.0" } as const;

export function createServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "Control Android emulators/devices and iOS simulators for ad-hoc UI testing. " +
      "Workflow: list_devices -> inspect_screen -> act (tap/input_text/swipe) which return the new screen state. " +
      "Use device_capabilities to check platform support, get_logs for crashes, a11y_audit for accessibility, " +
      "and start_recording/export_flow to turn a session into a replayable Maestro flow.",
  });
  registerTools(server, getContext());
  return server;
}

/** Start the stdio MCP server. Nothing must be written to stdout but protocol. */
export async function serve(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("manos MCP server running on stdio\n");
}
