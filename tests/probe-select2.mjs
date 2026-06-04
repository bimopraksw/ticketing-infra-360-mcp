import { chromium } from "playwright";
import { config as loadEnv } from "dotenv";
import { readFile } from "node:fs/promises";
loadEnv();
const BASE=(process.env.LINKIT_BASE_URL||"https://report.linkit360.com").replace(/\/+$/,"");
const SESSION=process.env.LINKIT_SESSION_PATH||".session/storage-state.json";
const ctx = await (await chromium.launch({headless:true,args:["--no-sandbox"]})).newContext({storageState:JSON.parse(await readFile(SESSION,"utf8"))});
const page = await ctx.newPage();
await page.goto(BASE+"/ticketing-infra/create",{waitUntil:"networkidle"});
const r = await page.evaluate(()=>{
  const w = window;
  const hasJQ = typeof w.jQuery === "function";
  const el = document.querySelector('select[name="sent_to[]"]');
  const isSelect2 = !!(el && (el.nextElementSibling?.classList.contains("select2") || document.querySelector(".select2")));
  let after=null, chips=null;
  if (hasJQ && el) {
    w.jQuery(el).val(["infra@linkit360.com"]).trigger("change");
    after = w.jQuery(el).val();
    // rendered chips
    const cont = el.nextElementSibling;
    chips = cont ? Array.from(cont.querySelectorAll(".select2-selection__choice")).map(c=>c.getAttribute("title")||c.textContent.trim()) : null;
  }
  // also list select2 containers and the files input requirement
  const filesInput = document.querySelector('input[name="files[]"]');
  return { hasJQ, isSelect2, jqVal: after, chips, filesRequired: filesInput?.hasAttribute("required"), filesAccept: filesInput?.getAttribute("accept") };
});
console.log(JSON.stringify(r,null,2));
process.exit(0);
