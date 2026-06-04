/**
 * Full end-to-end journey through ONE MCP server process:
 *   1. logout            (clear session)
 *   2. login interactive (browser opens — USER solves the reCAPTCHA)
 *   3. check_session     (proves the session hot-reloaded into the running server)
 *   4. create_infra_ticket (REAL, P2, default recipients = it.support + infra, CC bimo)
 *
 * Run: node tests/full-journey.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const child = spawn("node", [join(__dirname, "..", "dist", "index.js")], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, LINKIT_LOG_LEVEL: "info" },
});
let buf = "";
const pend = new Map();
child.stdout.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const l = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!l) continue;
    let m;
    try { m = JSON.parse(l); } catch { continue; }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  }
});
let id = 0;
const call = (method, params, ms = 60000) =>
  new Promise((res, rej) => {
    const i = ++id;
    pend.set(i, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
    setTimeout(() => rej(new Error(`timeout ${method}`)), ms);
  });
const tool = async (name, args, ms) => {
  const r = await call("tools/call", { name, arguments: args }, ms);
  if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  const t = r.result?.content?.find((c) => c.type === "text")?.text;
  if (!t) return r.result;
  try { return JSON.parse(t); } catch { return { text: t }; }
};

try {
  await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "journey", version: "0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  console.log("STEP 1 — logout (clearing session)…");
  console.log(JSON.stringify(await tool("logout", {})));

  console.log("\nSTEP 2 — login (interactive). A BROWSER WILL OPEN — solve the reCAPTCHA and click Login.");
  const login = await tool("login", { interactive: true, timeoutSeconds: 240 }, 260000);
  console.log("login result:", JSON.stringify(login));
  if (!login.success) throw new Error("login failed");

  console.log("\nSTEP 3 — check_session (verifies hot-reload into the running server)…");
  const sess = await tool("check_session", {});
  console.log("check_session:", JSON.stringify(sess));
  if (!sess.authenticated) throw new Error("session not authenticated after login — hot-reload failed");

  console.log("\nSTEP 4 — create_infra_ticket (REAL, P2, default recipients)…");
  const ticket = await tool(
    "create_infra_ticket",
    {
      subject: "Change env gameshop",
      category: "Server",
      company: "LinkIT.ID",
      serviceType: "project",
      project: "Gameshop",
      country: "Indonesia",
      classification: "P2",
      // sentTo omitted → defaults to it.support@ + infra@
      ccEmail: ["bimo.prakoso@linkit360.com"],
      requestDetail:
        "Please add the following PayWay (payment gateway) environment variables to the " +
        ".env file on https://gameshop.mobi/ :\n\n" +
        'PAYWAY_URL="https://checkout.payway.com.kh/"\n' +
        'PAYWAY_MERCHANT_ID="linkit360solution"\n' +
        'PAYWAY_SECRET_KEY="c8354fed-a9a7-4ac5-beaa-3f8e29dc75d6"\n' +
        'PAYWAY_MERCHANT_CODE="MID2023000001"\n\n' +
        "After adding, run php artisan config:clear and confirm reachability of the PayWay checkout endpoint.",
      attachmentText:
        "Infra Request: PayWay Payment Gateway Configuration\n" +
        "Project: Gameshop (https://gameshop.mobi/)\n\n" +
        "Add the following environment variables to the .env file:\n\n" +
        "PAYWAY_URL=https://checkout.payway.com.kh/\n" +
        "PAYWAY_MERCHANT_ID=linkit360solution\n" +
        "PAYWAY_SECRET_KEY=c8354fed-a9a7-4ac5-beaa-3f8e29dc75d6\n" +
        "PAYWAY_MERCHANT_CODE=MID2023000001\n\n" +
        "Post-deployment:\n1. php artisan config:clear\n2. Verify the PayWay checkout endpoint is reachable.",
      dryRun: false,
    },
    120000,
  );
  console.log("create_infra_ticket:", JSON.stringify(ticket, null, 2));

  console.log(
    ticket.success
      ? "\n✅ FULL JOURNEY PASSED — login (in-client) + hot-reload + real P2 ticket created."
      : "\n⚠️ Ticket not confirmed created — inspect result above.",
  );
  child.kill("SIGTERM");
  process.exit(ticket.success ? 0 : 1);
} catch (e) {
  console.error("JOURNEY FAILED:", e?.message || e);
  child.kill("SIGTERM");
  process.exit(1);
}
