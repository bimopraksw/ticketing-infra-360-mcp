import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dirname=dirname(fileURLToPath(import.meta.url));
const child=spawn("node",[join(__dirname,"..","dist","index.js")],{stdio:["pipe","pipe","inherit"],env:{...process.env,LINKIT_LOG_LEVEL:"error"}});
let buf="";const pend=new Map();
child.stdout.on("data",c=>{buf+=c;let i;while((i=buf.indexOf("\n"))>=0){const l=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!l)continue;let m;try{m=JSON.parse(l);}catch{continue;}if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}}});
let id=0;const call=(method,params)=>new Promise((res,rej)=>{const i=++id;pend.set(i,res);child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:i,method,params})+"\n");setTimeout(()=>rej(new Error("timeout")),90000);});
await call("initialize",{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"x",version:"0"}});
child.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})+"\n");
const r=await call("tools/call",{name:"get_field_options",arguments:{path:"/service/create",fields:["company","service_type","account_manager"],maxOptions:5}});
const txt=r.result?.content?.find(c=>c.type==="text")?.text;
const d=JSON.parse(txt);
for(const [k,v] of Object.entries(d.fields)){ console.log(`\n${k}: total=${v.totalOptions} matched=${v.matched}`); (v.options||[]).forEach(o=>console.log("   "+o.value+" = "+o.label)); }
child.kill("SIGTERM");process.exit(0);
