/**
 * Creates the PayWay .env infra ticket via the MCP server.
 * Dry-run by default; set SUBMIT=1 to actually submit.
 *   node tests/create-ticket.mjs          # dry-run (no side effects)
 *   SUBMIT=1 node tests/create-ticket.mjs # real submit
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "dist", "index.js");
const submit = process.env.SUBMIT === "1";

const detail =
  "Please add the following PayWay (payment gateway) environment variables to the " +
  ".env file on https://gameshop.mobi/ :\n\n" +
  'PAYWAY_URL="https://checkout.payway.com.kh/"\n' +
  'PAYWAY_MERCHANT_ID="linkit360solution"\n' +
  'PAYWAY_SECRET_KEY="c8354fed-a9a7-4ac5-beaa-3f8e29dc75d6"\n' +
  'PAYWAY_MERCHANT_CODE="MID2023000001"\n\n' +
  "After adding, please clear the Laravel config cache (php artisan config:clear) " +
  "and confirm the service can reach the PayWay checkout endpoint.";

const payload = {
  subject: "Change env gameshop", // auto-prefixed to "LinkIT - Infra - Change env gameshop"
  category: "Server",
  company: "LinkIT.ID",
  serviceType: "project",
  project: "Gameshop",
  country: "Indonesia",
  classification: process.env.CLASSIFICATION || "P2",
  sentTo: (process.env.SENT_TO || "infra@linkit360.com").split(",").map((s) => s.trim()),
  ccEmail: process.env.CC_EMAIL ? process.env.CC_EMAIL.split(",").map((s) => s.trim()) : undefined,
  requestDetail: detail,
  // No `files` → tool auto-generates a neat PDF from attachmentText:
  attachmentText:
    "Infra Request: PayWay Payment Gateway Configuration\n" +
    "Project: Gameshop (https://gameshop.mobi/)\n\n" +
    "Please add the following environment variables to the .env file:\n\n" +
    "PAYWAY_URL=https://checkout.payway.com.kh/\n" +
    "PAYWAY_MERCHANT_ID=linkit360solution\n" +
    "PAYWAY_SECRET_KEY=c8354fed-a9a7-4ac5-beaa-3f8e29dc75d6\n" +
    "PAYWAY_MERCHANT_CODE=MID2023000001\n\n" +
    "Post-deployment steps:\n" +
    "1. Run: php artisan config:clear\n" +
    "2. Verify the application can reach the PayWay checkout endpoint.",
  dryRun: !submit,
};

const child = spawn("node", [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, LINKIT_LOG_LEVEL: process.env.LINKIT_LOG_LEVEL || "warn" },
});
let buffer = "";
const pending = new Map();
child.stdout.on("data", (c) => {
  buffer += c.toString();
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
let id = 0;
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    setTimeout(() => reject(new Error(`timeout ${method}`)), 120000);
  });

try {
  await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ticket", version: "0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  console.log(submit ? ">>> SUBMITTING REAL TICKET <<<" : ">>> DRY RUN (not submitting) <<<");
  const r = await call("tools/call", { name: "create_infra_ticket", arguments: payload });
  if (r.error) throw new Error(JSON.stringify(r.error));
  const text = r.result?.content?.find((c) => c.type === "text")?.text;
  console.log(text || JSON.stringify(r.result, null, 2));
  child.kill("SIGTERM");
  process.exit(0);
} catch (e) {
  console.error("FAILED:", e?.message || e);
  child.kill("SIGTERM");
  process.exit(1);
}
