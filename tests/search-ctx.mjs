import { chromium } from "playwright";
import { config as loadEnv } from "dotenv";
import { readFile } from "node:fs/promises";
loadEnv();
const BASE=(process.env.LINKIT_BASE_URL||"https://report.linkit360.com").replace(/\/+$/,"");
const SESSION=process.env.LINKIT_SESSION_PATH||".session/storage-state.json";
const q = process.argv[2]||"gameshop";
const ctx = await (await chromium.launch({headless:true,args:["--no-sandbox"]})).newContext({storageState:JSON.parse(await readFile(SESSION,"utf8"))});
const page = await ctx.newPage();
async function search(url){
  await page.goto(url,{waitUntil:"networkidle",timeout:30000});
  const box = page.locator("input[type=search], .dataTables_filter input").first();
  if(await box.count()){ await box.fill(q); await page.waitForTimeout(1500); }
  await page.waitForLoadState("networkidle").catch(()=>{});
  return page.evaluate(()=>{
    const t=document.querySelector("table.dataTable")||document.querySelector("table");
    if(!t)return{headers:[],rows:[]};
    const headers=Array.from(t.querySelectorAll("thead th")).map(h=>h.textContent.trim());
    const rows=Array.from(t.querySelectorAll("tbody tr")).slice(0,8).map(tr=>Array.from(tr.querySelectorAll("td")).map(td=>td.textContent.trim().replace(/\s+/g," ")));
    return{headers,rows};
  });
}
console.log("=== services search '"+q+"' ===");
console.log(JSON.stringify(await search(BASE+"/service/list"),null,2).slice(0,3000));
console.log("\n=== infra tickets search '"+q+"' ===");
console.log(JSON.stringify(await search(BASE+"/ticketing-infra/list"),null,2).slice(0,2000));
process.exit(0);
