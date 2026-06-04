/**
 * Protocol smoke test — no credentials required.
 *
 * Spawns the built MCP server over stdio, performs the JSON-RPC initialize
 * handshake, lists tools, and asserts the expected tools are present.
 * This verifies the server starts and speaks MCP correctly without touching
 * LinkIT360. Run AFTER `npm run build`:  node tests/smoke.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "dist", "index.js");

// Minimal env so config validation passes; we never actually log in here.
const env = {
  ...process.env,
  LINKIT_BASE_URL: process.env.LINKIT_BASE_URL || "https://report.linkit360.com",
  LINKIT_EMAIL: process.env.LINKIT_EMAIL || "smoke@example.com",
  LINKIT_PASSWORD: process.env.LINKIT_PASSWORD || "smoke-password",
  LINKIT_LOG_LEVEL: "error",
};

const child = spawn("node", [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env,
});

let buffer = "";
const pending = new Map();

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function send(id, method, params) {
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function fail(msg) {
  console.error("SMOKE TEST FAILED:", msg);
  child.kill("SIGTERM");
  process.exit(1);
}

const timeout = setTimeout(() => fail("timed out waiting for responses"), 20000);

try {
  const init = await send(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.0" },
  });
  if (!init.result) fail("no initialize result");
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );

  const tools = await send(2, "tools/list", {});
  const names = (tools.result?.tools || []).map((t) => t.name).sort();
  console.log("Tools advertised:", names.join(", "));

  const expected = [
    "check_session",
    "get_page_content",
    "inspect_form",
    "login",
    "logout",
    "navigate",
    "screenshot",
    "submit_form",
  ];
  for (const name of expected) {
    if (!names.includes(name)) fail(`missing tool: ${name}`);
  }

  const prompts = await send(3, "prompts/list", {});
  console.log(
    "Prompts advertised:",
    (prompts.result?.prompts || []).map((p) => p.name).join(", "),
  );

  const resources = await send(4, "resources/list", {});
  console.log(
    "Resources advertised:",
    (resources.result?.resources || []).map((r) => r.uri).join(", "),
  );

  clearTimeout(timeout);
  console.log("\nSMOKE TEST PASSED ✅ — server starts and speaks MCP correctly.");
  child.kill("SIGTERM");
  process.exit(0);
} catch (err) {
  fail(err?.stack || String(err));
}
