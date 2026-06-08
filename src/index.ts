#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { logger, setLogLevel } from "./logger.js";
import { createContext } from "./context.js";
import { registerAllTools } from "./tools/index.js";
import { registerPrompts } from "./prompts/index.js";
import { registerResources } from "./resources/index.js";

const VERSION = "0.3.3";

function handleCliFlags(): boolean {
  const args = process.argv.slice(2);
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`ticketing-infra-360-mcp ${VERSION}\n`);
    return true;
  }
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      `ticketing-infra-360-mcp ${VERSION} — MCP server for LinkIT360 Ticketing-Infra.\n\n` +
        `This is a stdio MCP server; it is normally launched by an MCP client\n` +
        `(Claude Code/Desktop, Cursor, VS Code), not run by hand.\n\n` +
        `Required environment variables:\n` +
        `  LINKIT_BASE_URL      e.g. https://report.linkit360.com\n` +
        `  LINKIT_EMAIL         your LinkIT360 email\n` +
        `  LINKIT_PASSWORD      your LinkIT360 password\n\n` +
        `Optional:\n` +
        `  LINKIT_SESSION_PATH  where to store the login session\n` +
        `                       (default: ~/.linkit360/session.json)\n\n` +
        `First-time login (solves the reCAPTCHA in a real browser):\n` +
        `  ticketing-infra-360-login        (or: npm run login)\n\n` +
        `See INSTALL.md for full setup and client configuration.\n`,
    );
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  if (handleCliFlags()) return;
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  logger.info("Starting Ticketing-Infra-360 MCP server", { baseUrl: cfg.baseUrl });

  const ctx = createContext(cfg);

  const server = new McpServer({
    name: "ticketing-infra-360",
    version: VERSION,
  });

  registerAllTools(server, ctx);
  registerPrompts(server);
  registerResources(server, ctx);

  // Clean shutdown: close the browser so Chromium doesn't linger.
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down`);
    await ctx.browser.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server connected over stdio and ready");
}

main().catch((error) => {
  logger.error("Fatal error during startup", error instanceof Error ? error.stack : error);
  process.exit(1);
});
