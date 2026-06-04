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
const jq=(name,vals)=>page.evaluate(({name,vals})=>{window.jQuery(document.querySelector(`select[name="${name}"]`)).val(vals).trigger("change");},{name,vals});
await jq("category",["3"]); await page.waitForTimeout(1500);
await jq("company",["6"]); await page.waitForTimeout(1500);
await page.evaluate(()=>{const r=[...document.querySelectorAll('input[name=service_type]')].find(x=>x.value==="project");r.click();});
await jq("country",["1"]); await page.waitForTimeout(1800);
await page.fill('input[name="project"]',"Gameshop");
await jq("sent_to[]",["infra@linkit360.com"]);
await page.fill('input[name="subject"]',"LinkIT - Infra - Change env gameshop");
await jq("classification",["2"]);
await page.fill('textarea[name="request_detail"]',"PayWay env vars for gameshop.mobi.");
await page.locator('input[name="files[]"]').setInputFiles(pdf);
await page.waitForTimeout(1200);
const d=await page.evaluate(()=>{
  const $=window.jQuery;
  const vals={
    company:$("#company").val(), category:$("#category").val(), country:$("#country").val(),
    operator:$("#operator").val(), service:$("#service").val(), project:$("#project").val(),
    subject:$("#subject").val(), classification:$("#classification").val(),
    sentTo_byId:$("#sent_to").val(), sentTo_byName:$('select[name="sent_to[]"]').val(),
    requestDetail:$("#request_detail").val(),
    nameCategory:$("#category").find('option:selected').data('name'),
    type:document.querySelector('input[name="service_type"]:checked')?.value,
  };
  const fileErrText=document.getElementById("errorFileRequestInfra")?.textContent;
  let uf=[]; try{ uf = uploadedFiles.map(x=>({hasFile: !!x.file, size: x.file?.size, keys:Object.keys(x)})); }catch(e){ uf="err "+e.message; }
  return { vals, fileErrText, uploadedFiles: uf, ccc: (typeof categoryCheckCountry!=="undefined")?categoryCheckCountry:"?" };
});
console.log(JSON.stringify(d,null,2));
process.exit(0);
