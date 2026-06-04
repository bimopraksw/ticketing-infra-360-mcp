import { chromium } from "playwright";
import { config as loadEnv } from "dotenv";
import { readFile } from "node:fs/promises";
loadEnv();
const BASE=(process.env.LINKIT_BASE_URL||"https://report.linkit360.com").replace(/\/+$/,"");
const SESSION=process.env.LINKIT_SESSION_PATH||".session/storage-state.json";
const ctx=await (await chromium.launch({headless:true,args:["--no-sandbox"]})).newContext({storageState:JSON.parse(await readFile(SESSION,"utf8"))});
const page=await ctx.newPage();
await page.goto(BASE+"/ticketing-infra/create",{waitUntil:"networkidle"});
const r=await page.evaluate(()=>{
  const reqForm=[...document.querySelectorAll("form")].find(f=>/ticketing-infra\/request/.test(f.getAttribute("action")||""));
  const btns=[...document.querySelectorAll("button, input[type=submit], input[type=button], a.btn")].map(b=>({
    tag:b.tagName.toLowerCase(), type:b.getAttribute("type"), text:(b.innerText||b.value||"").trim().slice(0,30),
    id:b.id||null, cls:b.className.slice(0,40), onclick:b.getAttribute("onclick")||null,
    inReqForm: reqForm? reqForm.contains(b):false
  })).filter(b=>b.text||b.onclick);
  return {reqFormId:reqForm?.id, reqFormAction:reqForm?.getAttribute("action"), reqFormOnsubmit:reqForm?.getAttribute("onsubmit"), buttons:btns};
});
console.log(JSON.stringify(r,null,2));
process.exit(0);
