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
await page.goto(BASE+"/ticketing-infra/create",{waitUntil:"networkidle"});
// set recipient via jQuery val+trigger (same as tool)
await page.evaluate(()=>{const el=document.querySelector('select[name="sent_to[]"]');window.jQuery(el).val(["infra@linkit360.com"]).trigger("change");});
// attach PDF to the hidden file input (fires onchange=handleFiles)
await page.locator('input[name="files[]"]').setInputFiles(pdf);
await page.waitForTimeout(1000);
const state=await page.evaluate(()=>({
  sentToVal: window.jQuery('select[name="sent_to[]"]').val(),
  chips: Array.from(document.querySelectorAll('.select2-selection__choice')).map(c=>c.getAttribute('title')||c.textContent.trim()),
  uploadedFilesLen: (typeof uploadedFiles!=="undefined")?uploadedFiles.length:"N/A",
  fileInputCount: document.querySelector('input[name="files[]"]').files.length,
  fileErr: document.getElementById('errorFileRequestInfra')?.textContent,
}));
console.log(JSON.stringify(state,null,2));
process.exit(0);
