import { chromium } from "playwright";
import { config as loadEnv } from "dotenv";
import { readFile } from "node:fs/promises";
loadEnv();
const BASE=(process.env.LINKIT_BASE_URL||"https://report.linkit360.com").replace(/\/+$/,"");
const SESSION=process.env.LINKIT_SESSION_PATH||".session/storage-state.json";
const ctx = await (await chromium.launch({headless:true,args:["--no-sandbox"]})).newContext({storageState:JSON.parse(await readFile(SESSION,"utf8"))});
const page = await ctx.newPage();
const xhr=[];
page.on("response", r => { const u=r.url(); if(/datatable|ajax|json|list|data|fetch/i.test(u) && r.request().resourceType()==="xhr") xhr.push(r.status()+" "+r.request().method()+" "+u); });
await page.goto(BASE+"/ticketing-infra/list",{waitUntil:"networkidle",timeout:30000});
await page.waitForTimeout(2500);
const t = await page.evaluate(()=>{
  const tables=Array.from(document.querySelectorAll("table"));
  return tables.map(tb=>({
    id: tb.id||null,
    classes: tb.className,
    headers: Array.from(tb.querySelectorAll("thead th")).map(h=>h.textContent.trim()),
    bodyRows: tb.querySelectorAll("tbody tr").length,
    firstRow: Array.from(tb.querySelectorAll("tbody tr")[0]?.querySelectorAll("td")||[]).map(td=>td.textContent.trim().slice(0,40))
  }));
});
console.log("XHR requests during load:"); xhr.forEach(x=>console.log("  "+x));
console.log("\nTables:"); console.log(JSON.stringify(t,null,2));
process.exit(0);
