'use strict';
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const pending=new Map(),rates=new Map();
const file=path.join(__dirname,'verified-titles.json');
let titles={};try{titles=JSON.parse(fs.readFileSync(file,'utf8'))}catch{}
const send=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data))};
async function body(req){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>4096)throw Error('Request too large')}return JSON.parse(raw)}
function save(){const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(titles));fs.renameSync(tmp,file)}
function hash(code,id){return crypto.createHash('sha256').update(code+':'+id+':'+(process.env.OTP_SECRET||process.env.RESEND_API_KEY||'')).digest('hex')}
module.exports=async(req,res,u,catalogue)=>{
 if(u.pathname==='/api/verified-titles'&&req.method==='GET')return send(res,200,{titles});
 if(u.pathname!=='/api/title-otp/request'&&u.pathname!=='/api/title-otp/confirm')return false;
 if(req.method!=='POST'){send(res,405,{error:'Method not allowed'});return true}
 try{
  const p=await body(req);
  const id=String(p.id||''),title=String(p.title||'').trim();
  if(!catalogue.some(x=>x.id===id)||title.length<2||title.length>120){send(res,400,{error:'Invalid design or title'});return true}
  const email=process.env.TITLE_APPROVAL_EMAIL,apiKey=process.env.RESEND_API_KEY,from=process.env.OTP_FROM_EMAIL;
  if(!email||!apiKey||!from||!process.env.OTP_SECRET){send(res,503,{error:'Title verification is not configured by the administrator'});return true}
  const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
  const rateKey=crypto.createHash('sha256').update(ip).digest('hex');
  if(u.pathname.endsWith('/request')){
   const t=Date.now();const recent=(rates.get(rateKey)||[]).filter(v=>t-v<3600000);
   if(recent.length>=5){send(res,429,{error:'Too many OTP requests. Try again later.'});return true}
   if(pending.get(id)?.createdAt>t-60000){send(res,429,{error:'Wait a minute before requesting another code'});return true}
   const code=String(crypto.randomInt(0,1000000)).padStart(6,'0');
   const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{authorization:'Bearer '+apiKey,'content-type':'application/json'},body:JSON.stringify({from,to:[email],subject:'WearDHK title change verification',text:'A title change was requested for a WearDHK design.\nDesign ID: '+id+'\nProposed title: '+title+'\nVerification code: '+code+'\nExpires in 10 minutes. If this was not you, ignore this email.'})});
   if(!response.ok)throw Error('Email provider rejected verification email');
   pending.set(id,{digest:hash(code,id),title,createdAt:t,expires:t+600000,attempts:0});
   rates.set(rateKey,[...recent,t]);send(res,200,{message:'Code sent to the configured administrator email'});return true
  }
  const value=pending.get(id);if(!value||value.expires<Date.now()||value.title!==title){send(res,400,{error:'Verification expired or title changed. Request a new code.'});return true}
  if(++value.attempts>5){pending.delete(id);send(res,429,{error:'Too many incorrect attempts'});return true}
  const actual=hash(String(p.code||''),id),a=Buffer.from(actual),b=Buffer.from(value.digest);
  if(!crypto.timingSafeEqual(a,b)){send(res,403,{error:'Incorrect verification code'});return true}
  titles[id]=title;save();pending.delete(id);
  send(res,200,{verified:true,id,title});return true
 }catch(e){send(res,500,{error:e.message==='Request too large'?'Request too large':'Unable to complete verification'});return true}
};

module.exports.titleFor=id=>titles[id]||null;
