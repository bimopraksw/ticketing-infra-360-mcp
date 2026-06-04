import { chromium } from "playwright";
import { config as loadEnv } from "dotenv";
import { readFile } from "node:fs/promises";
loadEnv();
const BASE = (process.env.LINKIT_BASE_URL||"https://report.linkit360.com").replace(/\/+$/,"");
const SESSION = process.env.LINKIT_SESSION_PATH || ".session/storage-state.json";
const candidates = [
  "/notification/create","/notification/notification-create",
  "/ticketing-infra/create","/ticketing-creative/create","/ticketing-media/create","/ticketing-legal/create",
  "/service/edit/1","/service/list"
];
const ctx = await (await chromium.launch({headless:true,args:["--no-sandbox"]})).newContext({storageState: JSON.parse(await readFile(SESSION,"utf8"))});
const page = await ctx.newPage();
for (const path of candidates) {
  try {
    const r = await page.goto(BASE+path,{waitUntil:"domcontentloaded",timeout:20000});
    const isLogin = page.url().includes("login");
    const forms = await page.evaluate(()=>Array.from(document.querySelectorAll("form")).map(f=>({action:f.getAttribute("action"),method:f.getAttribute("method"),fields:Array.from(f.querySelectorAll("input,select,textarea")).filter(e=>(e.getAttribute("type")||"")!=="hidden"&&e.getAttribute("name")).map(e=>e.getAttribute("name"))})));
    console.log(`${r?.status()} ${isLogin?"(LOGIN)":""} ${path} -> finalpath=${new URL(page.url()).pathname} forms=${forms.length} ${forms.map(f=>f.action+"["+f.fields.slice(0,6).join(",")+(f.fields.length>6?"…":"")+"]").join(" | ")}`);
  } catch(e){ console.log(`ERR ${path}: ${e.message.split("\n")[0]}`); }
}
process.exit(0);
