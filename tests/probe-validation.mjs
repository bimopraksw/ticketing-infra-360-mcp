import { chromium } from "playwright";
import { config as loadEnv } from "dotenv";
import { readFile } from "node:fs/promises";
loadEnv();
const BASE=(process.env.LINKIT_BASE_URL||"https://report.linkit360.com").replace(/\/+$/,"");
const SESSION=process.env.LINKIT_SESSION_PATH||".session/storage-state.json";
const ctx = await (await chromium.launch({headless:true,args:["--no-sandbox"]})).newContext({storageState:JSON.parse(await readFile(SESSION,"utf8"))});
const page = await ctx.newPage();
await page.goto(BASE+"/ticketing-infra/create",{waitUntil:"networkidle"});
const html = await page.content();
// find the validation messages context
for (const needle of ["at least one recipient","at least one file","sent_to","files[]","dropzone","FilePond","filepond","new FormData","ajax","e.preventDefault"]) {
  const idx = html.indexOf(needle);
  if (idx>=0) {
    console.log("\n### '"+needle+"' @"+idx+":");
    console.log(html.slice(Math.max(0,idx-180), idx+180).replace(/\s+/g," "));
  } else {
    console.log("\n### '"+needle+"' : NOT FOUND");
  }
}
// count file inputs and sent_to selects
const counts = await page.evaluate(()=>({
  fileInputs: document.querySelectorAll('input[type=file]').length,
  fileNames: Array.from(document.querySelectorAll('input[type=file]')).map(f=>f.name),
  sentToSelects: document.querySelectorAll('select[name="sent_to[]"]').length,
  forms: document.querySelectorAll('form').length,
}));
console.log("\nCOUNTS:", JSON.stringify(counts));
process.exit(0);
