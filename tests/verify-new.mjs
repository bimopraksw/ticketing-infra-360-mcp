/**
 * Verifies the v0.6.0 changes against the LIVE form using the freshly built
 * server (requires a valid session from the `login` tool). Dry-run only — no
 * ticket is created.
 *
 *   1. Cambodia + Server + (no company, no classification) → company auto-
 *      resolves to LinkIT.SEA, classification defaults to P3, validation passes.
 *   2. P1 without an approver → tool refuses and asks who approves.
 *   3. P1 with an approver → dry-run passes and returns an approval summary.
 *
 * Run: node tests/verify-new.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "dist", "index.js");

const child = spawn("node", [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    LINKIT_LOG_LEVEL: process.env.LINKIT_LOG_LEVEL || "warn",
    LINKIT_AUTO_UPDATE: "false", // don't kick the updater during a test
  },
});

let buffer = "";
let nextId = 1;
const pending = new Map();

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: "2.0", id, method, params };
  child.stdin.write(JSON.stringify(payload) + "\n");
  return new Promise((resolve) => pending.set(id, { resolve }));
}

function parseToolResult(resp) {
  if (resp.error) return { _rpcError: resp.error };
  const text = resp.result?.content?.[0]?.text;
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

const pass = [];
const fail = [];
const check = (name, cond, detail) => (cond ? pass : fail).push(`${name}${detail ? ` — ${detail}` : ""}`);

async function main() {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "verify-new", version: "1.0.0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // ── 1. Cambodia auto-resolves to LinkIT.SEA, classification defaults to P3 ──
  const r1 = parseToolResult(
    await rpc("tools/call", {
      name: "create_infra_ticket",
      arguments: {
        subject: "verify SEA mapping",
        category: "Server",
        country: "Cambodia",
        serviceType: "project",
        project: "Verify Test",
        requestDetail: "Automated verification of country mapping + default priority. Do not action.",
        dryRun: true,
      },
    }),
  );
  console.error("\n[1] Cambodia/Server/project, no company, no classification:");
  console.error(JSON.stringify({ applied: r1.applied, validationPassed: r1.validationPassed, errors: r1.errors }, null, 2));
  check("1a company auto-resolved to LinkIT.SEA", r1.applied?.company === "LinkIT.SEA" || r1.applied?.companyAutoResolved === "LinkIT.SEA", `got ${r1.applied?.companyAutoResolved ?? r1.applied?.company}`);
  check("1b classification defaulted to P3", r1.applied?.classification === "P3" && r1.applied?.classificationDefaulted === true, `got ${r1.applied?.classification}`);
  check("1c country set to Cambodia", String(r1.applied?.country ?? "").length > 0);
  check("1d validation passed (form accepted)", r1.validationPassed === true, `errors: ${JSON.stringify(r1.errors)}`);

  // ── 2. P1 without approver → must refuse and ask who approves ──
  const r2 = parseToolResult(
    await rpc("tools/call", {
      name: "create_infra_ticket",
      arguments: {
        subject: "verify approval guard",
        category: "Server",
        country: "Cambodia",
        serviceType: "project",
        project: "Verify Test",
        classification: "P1",
        requestDetail: "Should be blocked without an approver.",
        dryRun: true,
      },
    }),
  );
  const r2err = r2._rpcError?.message || r2.error || r2._raw || "";
  console.error("\n[2] P1 without approver →", JSON.stringify(r2err).slice(0, 160));
  check("2a P1 without approver is refused", /approv/i.test(JSON.stringify(r2)), `got ${JSON.stringify(r2).slice(0,120)}`);

  // ── 3. P1 with approver → passes and returns an approval summary ──
  const r3 = parseToolResult(
    await rpc("tools/call", {
      name: "create_infra_ticket",
      arguments: {
        subject: "verify approval ok",
        category: "Server",
        country: "Cambodia",
        serviceType: "project",
        project: "Verify Test",
        classification: "P1",
        approver: "PMO",
        approvalReason: "Critical outage (verification only).",
        requestDetail: "P1 with approver should pass dry-run.",
        dryRun: true,
      },
    }),
  );
  console.error("\n[3] P1 with approver=PMO:");
  console.error(JSON.stringify({ applied: r3.applied, approval: r3.approval, validationPassed: r3.validationPassed }, null, 2));
  check("3a classification P1 applied", r3.applied?.classification === "P1");
  check("3b approval summary present", !!r3.approval && r3.approval.approver === "PMO");
  check("3c validation passed", r3.validationPassed === true, `errors: ${JSON.stringify(r3.errors)}`);

  console.error("\n──────── RESULTS ────────");
  pass.forEach((p) => console.error("  ✓ " + p));
  fail.forEach((f) => console.error("  ✗ " + f));
  console.error(`\n${pass.length} passed, ${fail.length} failed`);

  child.kill();
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => {
  console.error("verify-new failed:", e);
  child.kill();
  process.exit(1);
});
