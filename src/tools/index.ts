import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { registerSessionTools } from "./session.js";
import { registerNavigateTools } from "./navigate.js";
import { registerInspectTools } from "./inspect.js";
import { registerContentTools } from "./content.js";
import { registerScreenshotTools } from "./screenshot.js";
import { registerRecordTools } from "./records.js";
import { registerTicketingTools } from "./ticketing.js";
import { registerServiceTools } from "./services.js";
import { registerOptionsTools } from "./options.js";

export function registerAllTools(server: McpServer, ctx: AppContext): void {
  registerSessionTools(server, ctx);
  registerNavigateTools(server, ctx);
  registerInspectTools(server, ctx);
  registerContentTools(server, ctx);
  registerScreenshotTools(server, ctx);
  registerRecordTools(server, ctx);
  registerTicketingTools(server, ctx);
  registerServiceTools(server, ctx);
  registerOptionsTools(server, ctx);
}
