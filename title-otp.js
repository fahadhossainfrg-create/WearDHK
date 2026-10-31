'use strict';
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const file=path.join(__dirname,'verified-titles.json');
let titles={};try{titles=JSON.parse(fs.readFileSync(file,'utf8'))}catch{}
const failures=new Map();
let persistTitles=null;
let storageReady=false;
function reply(res,status,data){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data))}
async function parse(req){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>4096)throw Error('Request too large')}return JSON.parse(raw)}
function save(){const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(titles));fs.renameSync(tmp,file)}
function equals(a,b){const ah=crypto.createHash('sha256').update(a).digest(),bh=crypto.createHash('sha256').update(b).digest();return crypto.timingSafeEqual(ah,bh)}
async function route(req,res,u,catalogue){
 if(u.pathname==='/api/verified-titles'&&req.method==='GET'){reply(res,200,{titles});return true}
 if(u.pathname.startsWith('/api/title-otp/')){reply(res,410,{error:'Email OTP verification has been removed'});return true}
 if(u.pathname!=='/api/title-password/save')return false;
 if(req.method!=='POST'){reply(res,405,{error:'Method not allowed'});return true}
 const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
 const rateKey=crypto.createHash('sha256').update(ip).digest('hex');
 const now=Date.now(),previous=failures.get(rateKey)||{count:0,until:0};
 if(previous.until>now){reply(res,429,{error:'Too many incorrect attempts. Try again later.'});return true}
 try{
  const p=await parse(req),id=String(p.id||''),title=String(p.title||'').trim(),password=String(p.password||'');
  if(!catalogue.some(x=>x.id===id)||title.length<2||title.length>120){reply(res,400,{error:'Invalid design or title'});return true}
  const expected=process.env.TITLE_EDIT_PASSWORD;
  if(!expected){reply(res,503,{error:'Title editing is not configured'});return true}
  if(!equals(password,expected)){
   const count=previous.count+1;
   failures.set(rateKey,{count:count>=5?0:count,until:count>=5?now+15*60000:0});
   reply(res,403,{error:'Incorrect password'});return true
  }
  failures.delete(rateKey);
  if(!persistTitles||!storageReady){reply(res,503,{error:'Persistent title backup is not ready. No changes were saved.'});return true}
  const before=titles[id];titles[id]=title;
  try{await persistTitles();save()}catch(e){if(before===undefined)delete titles[id];else titles[id]=before;reply(res,503,{error:'Could not persist title to Google Drive backup. No changes were saved.'});return true}
  reply(res,200,{verified:true,id,title});return true
 }catch(e){reply(res,500,{error:'Could not save title'});return true}
}
module.exports=route;
module.exports.titleFor=id=>titles[id]||null;
module.exports.configurePersistence=fn=>{persistTitles=fn};
module.exports.setStorageReady=value=>{storageReady=!!value};
module.exports.restoreTitles=incoming=>{if(!incoming||typeof incoming!=='object'||Array.isArray(incoming))return;for(const [id,title] of Object.entries(incoming)){if(/^[A-Za-z0-9_-]{3,150}$/.test(id)&&typeof title==='string'&&title.length>=2&&title.length<=120)titles[id]=title}save()};
module.exports.exportTitles=()=>({...titles});

