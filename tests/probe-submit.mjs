import { chromium } from "playwright";
import { config as loadEnv } from "dotenv";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv();
const __dirname=dirname(fileURLToPath(import.meta.url));
const BASE=(process.env.LINKIT_BASE_URL||"https://report.linkit360.com").replace(/\/+$/,"");
const SESSION=process.env.LINKIT_SESSION_PATH||".session/storage-state.json";
const pdf=join(__dirname,"..","discovery","payway-gameshop-env.pdf");
const ctx=await (await chromium.launch({headless:true,args:["--no-sandbox"]})).newContext({storageState:JSON.parse(await readFile(SESSION,"utf8"))});
const page=await ctx.newPage();
const responses=[];
page.on("response", async r=>{ if(/ticketing-infra\/(request|store)/.test(r.url())){ let body=""; try{body=(await r.text()).slice(0,300);}catch{} responses.push(r.status()+" "+r.url()+" :: "+body); }});
page.on("dialog", async d=>{ console.log("DIALOG:",d.type(),d.message()); await d.accept().catch(()=>{}); });
await page.goto(BASE+"/ticketing-infra/check","domcontentloaded").catch(()=>{});
await page.goto(BASE+"/ticketing-infra/create",{waitUntil:"networkidle"});
const jqset=(name,vals)=>page.evaluate(({name,vals})=>{window.jQuery(document.querySelector(`select[name="${name}"]`)).val(vals).trigger("change");},{name,vals});
await jqset("category",["3"]);
await jqset("company",["6"]);
await page.evaluate(()=>{const r=[...document.querySelectorAll('input[name=service_type]')].find(x=>x.value==="project");r.click();});
await jqset("country",["1"]); await page.waitForTimeout(1200);
await page.fill('input[name="project"]',"Gameshop");
await jqset("sent_to[]",["infra@linkit360.com"]);
await jqset("cc_email[]",["bimo.prakoso@linkit360.com"]);
await page.fill('input[name="subject"]',"Add PayWay payment credentials to .env - gameshop.mobi");
await jqset("classification",["2"]);
await page.fill('textarea[name="request_detail"]','PayWay env vars for gameshop.mobi: PAYWAY_URL=https://checkout.payway.com.kh/, PAYWAY_MERCHANT_ID=linkit360solution, PAYWAY_SECRET_KEY=c8354fed-a9a7-4ac5-beaa-3f8e29dc75d6, PAYWAY_MERCHANT_CODE=MID2023000001. Then php artisan config:clear.');
await page.locator('input[name="files[]"]').setInputFiles(pdf);
await page.waitForTimeout(1200);
const urlBefore=page.url();
await page.locator('button[type="submit"], input[type="submit"]').first().click();
await page.waitForTimeout(4000);
const post=await page.evaluate(()=>({
  url: location.href,
  swal: document.querySelector('.swal2-popup')?.innerText || null,
  toast: document.querySelector('.toast, .toast-success, .alert-success')?.innerText || null,
  visibleErrors: [...document.querySelectorAll('.text-danger,.invalid-feedback,.alert-danger')].filter(e=>e.offsetParent&&!e.classList.contains('gu-hide')).map(e=>e.innerText.trim()).filter(Boolean),
}));
console.log("urlBefore:",urlBefore);
console.log("POST-SUBMIT:",JSON.stringify(post,null,2));
console.log("NETWORK to request/store:"); responses.forEach(r=>console.log("  "+r));
process.exit(0);
