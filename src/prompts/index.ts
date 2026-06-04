import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Reusable prompts that guide a model through the discover -> write workflow.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "discover_record_form",
    {
      title: "Discover a record form schema",
      description:
        "Guides the model to use inspect_form to map a create/update page into " +
        "a field schema before writing.",
      argsSchema: {
        path: z.string().describe("Path of the create/edit page, e.g. /reports/create"),
      },
    },
    ({ path }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Use the \`inspect_form\` tool on \`${path}\` to list every form field ` +
              `(name, selector, type, label, required, options). Then summarize the ` +
              `record schema as a table and tell me which fields are required before ` +
              `we attempt any \`submit_form\` write.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "create_record_safely",
    {
      title: "Create a record safely",
      description:
        "Guides the model to dry-run submit_form first, review, then submit for real.",
      argsSchema: {
        path: z.string().describe("Create page path."),
      },
    },
    ({ path }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Create a record at \`${path}\`. First call \`inspect_form\` to confirm ` +
              `the fields, then call \`submit_form\` with \`dryRun: true\` and show me ` +
              `the filled values. Only after I confirm, call \`submit_form\` with ` +
              `\`dryRun: false\` and report success/validation messages.`,
          },
        },
      ],
    }),
  );
}
