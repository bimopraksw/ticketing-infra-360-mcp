import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";

/**
 * Read-only resources the model can fetch for context. No secrets are exposed.
 */
export function registerResources(server: McpServer, ctx: AppContext): void {
  server.registerResource(
    "server-info",
    "ticketing-infra-360://info",
    {
      title: "Ticketing-Infra-360 MCP server info",
      description: "Non-secret configuration and capability summary.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              baseUrl: ctx.cfg.baseUrl,
              loginPath: ctx.cfg.login.path,
              headless: ctx.cfg.headless,
              sessionPath: ctx.cfg.sessionPath,
              timeoutMs: ctx.cfg.timeoutMs,
              tools: [
                "check_session",
                "login",
                "logout",
                "navigate",
                "inspect_form",
                "get_page_content",
                "screenshot",
                "submit_form",
              ],
              workflow:
                "1) inspect_form to discover the record schema. " +
                "2) submit_form with dryRun:true to preview. " +
                "3) submit_form with dryRun:false to create/update.",
            },
            null,
            2,
          ),
        },
      ],
    }),
  );
}
