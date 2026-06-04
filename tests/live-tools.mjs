/**
 * Live end-to-end tool test (requires a valid session from `npm run login`).
 * Spawns the MCP server and calls the real tools against LinkIT360:
 *   - list_tickets (infra)            [read]
 *   - list_services                   [read]
 *   - create_infra_ticket dryRun=true [fills real form, does NOT submit]
 * No real ticket is created (dry-run). Run: node tests/live-tools.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "dist", "index.js");

const child = spawn("node", [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, LINKIT_LOG_LEVEL: process.env.LINKIT_LOG_LEVEL || "warn" },
});

let buffer = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

let id = 0;
function call(method, params) {
  const myId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    setTimeout(() => reject(new Error(`timeout on ${method}`)), 90000);
  });
}
const tool = async (name, args) => {
  const r = await call("tools/call", { name, arguments: args });
  if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  const text = r.result?.content?.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : r.result;
};

try {
  await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "live", version: "0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  console.log("== list_tickets(infra, maxRows=5) ==");
  const tickets = await tool("list_tickets", { module: "infra", maxRows: 5 });
  console.log("headers:", tickets.headers?.join(" | "));
  console.log("rows returned:", tickets.rows?.length, "| total on page:", tickets.totalRowsOnPage);
  if (tickets.rows?.[0]) console.log("sample row:", JSON.stringify(tickets.rows[0]));

  console.log("\n== list_services(maxRows=5) ==");
  const services = await tool("list_services", { maxRows: 5 });
  console.log("headers:", services.headers?.join(" | "));
  console.log("rows returned:", services.rows?.length, "| total on page:", services.totalRowsOnPage);
  if (services.rows?.[0]) console.log("sample row:", JSON.stringify(services.rows[0]));

  console.log("\n== create_infra_ticket (DRY RUN — not submitted) ==");
  const dry = await tool("create_infra_ticket", {
    subject: "[TEST-DRYRUN] MCP connectivity check",
    category: "Server",
    company: "LinkIT.MENA",
    serviceType: "service",
    classification: "P3",
    requestDetail: "Dry-run validation from MCP server. No submission.",
    sentTo: ["infra@linkit360.com"],
    dryRun: true,
  });
  console.log(JSON.stringify(dry, null, 2));

  if (!tickets.headers?.length) throw new Error("list_tickets returned no headers");
  if (!dry.dryRun) throw new Error("create_infra_ticket did not honor dryRun");

  console.log("\nLIVE TOOL TEST PASSED ✅ — reads work; create form fills correctly (dry-run).");
  child.kill("SIGTERM");
  process.exit(0);
} catch (e) {
  console.error("\nLIVE TOOL TEST FAILED ❌:", e?.message || e);
  child.kill("SIGTERM");
  process.exit(1);
}
