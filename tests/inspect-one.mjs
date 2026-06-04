import { chromium } from "playwright";
import { config as loadEnv } from "dotenv";
import { readFile, mkdir, writeFile } from "node:fs/promises";
loadEnv();
const BASE=(process.env.LINKIT_BASE_URL||"https://report.linkit360.com").replace(/\/+$/,"");
const SESSION=process.env.LINKIT_SESSION_PATH||".session/storage-state.json";
const path = process.argv[2] || "/ticketing-infra/create";
const ctx = await (await chromium.launch({headless:true,args:["--no-sandbox"]})).newContext({storageState:JSON.parse(await readFile(SESSION,"utf8"))});
const page = await ctx.newPage();
await page.goto(BASE+path,{waitUntil:"networkidle",timeout:30000});
const data = await page.evaluate(()=>{
  const sel=(el)=>{const n=el.getAttribute("name");if(n)return `${el.tagName.toLowerCase()}[name="${n}"]`;if(el.id)return "#"+el.id;return el.tagName.toLowerCase();};
  const label=(el)=>{const id=el.getAttribute("id");if(id){const l=document.querySelector(`label[for="${id}"]`);if(l?.textContent)return l.textContent.trim().replace(/\s+/g," ");}const p=el.closest(".form-group,.mb-3,.col,div");const lab=p?.querySelector("label");return lab?.textContent?.trim().replace(/\s+/g," ")||el.getAttribute("placeholder")||el.getAttribute("aria-label")||null;};
  return Array.from(document.querySelectorAll("form")).filter(f=>!/logout/i.test(f.getAttribute("action")||"")).map(f=>({
    action:f.getAttribute("action"),method:(f.getAttribute("method")||"get").toLowerCase(),
    fields:(()=>{const out=[];const radios=new Set();
      f.querySelectorAll("input,select,textarea").forEach(el=>{
        const type=(el.getAttribute("type")||el.tagName.toLowerCase()).toLowerCase();
        if(type==="hidden")return;const name=el.getAttribute("name");
        if(type==="radio"&&name){if(radios.has(name))return;radios.add(name);
          const grp=Array.from(f.querySelectorAll(`input[type=radio][name="${name}"]`));
          out.push({name,type:"radio",label:label(el),required:el.hasAttribute("required"),options:grp.map(g=>({value:g.value,label:label(g)}))});return;}
        const o={name,selector:sel(el),tag:el.tagName.toLowerCase(),type:el.tagName.toLowerCase()==="select"?"select":type,label:label(el),required:el.hasAttribute("required")};
        if(el.tagName.toLowerCase()==="select"){const opts=Array.from(el.options);o.optionCount=opts.length;o.options=opts.slice(0,12).map(x=>({value:x.value,label:x.textContent?.trim()}));o.multiple=el.multiple;}
        out.push(o);});
      return out;})()
  }));
});
await mkdir("discovery",{recursive:true});
const file="discovery/form-"+path.replace(/\//g,"_")+".json";
await writeFile(file,JSON.stringify(data,null,2));
console.log("Saved",file);
console.log(JSON.stringify(data,null,2).slice(0,9000));
process.exit(0);
