'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const roots=[
 {id:'128JL_dyiO2xFXaRKh4zj8al5w2Y6XoNP',name:'Main Library'},
 {id:'1QImLRpunvmjkhHc8_CqewTw7u6lqvoLb',name:'Organised Library'},
 {id:'1MPdvOZSFs0uUwS3qYOzY9m5-_61DloDW',name:'New Designs'},
 {id:'1SpCQMhm_iu7kYEWG81xIbjJbh2FABdoc',name:'Plain Chapter'}];
const port=Number(process.env.PORT||3000),interval=Math.max(1,Number(process.env.SYNC_MINUTES||5)),scanConcurrency=Math.max(5,Math.min(30,Number(process.env.SYNC_CONCURRENCY||20)));
let snapshot=[];try{const names=fs.readdirSync(__dirname).filter(n=>/^catalogue-[a-z0-9-]+\.json$/i.test(n)).sort();const records=names.flatMap(n=>{const v=JSON.parse(fs.readFileSync(path.join(__dirname,n),'utf8'));return Array.isArray(v)?v:[]});snapshot=[...new Map(records.map(x=>[x.id,x])).values()];console.log('Persistent catalogue files:',names.length)}catch(e){console.warn('Catalogue snapshot unavailable:',e.message)}
let catalogue=snapshot.slice(),syncedAt=null,errors=[],scannedFolders=0,syncing=false,syncStartedAt=null,sourceStats={};
const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
const isArabicDesign=name=>{const value=String(name||'');return !/(bangla|bengali)/i.test(value)&&/(?:^|[^a-z])(arabic|kufic|calligraphy|islamic|allah|quran|surah|bismillah|alhamdulillah|tawhid|taqwa|shukr|iman|barakah|noor|sabr|ayat|hadith|masjid|adil|istiqamah|qalb|hasbunallah|sami_allahu)(?:[^a-z]|$)/i.test(value)};
let tokenCache={token:'',expiry:0};
async function token(){
 if(process.env.GOOGLE_DRIVE_ACCESS_TOKEN)return process.env.GOOGLE_DRIVE_ACCESS_TOKEN;
 if(tokenCache.token&&Date.now()<tokenCache.expiry-90000)return tokenCache.token;
 const raw=process.env.GOOGLE_SERVICE_ACCOUNT_JSON||(process.env.GOOGLE_SERVICE_ACCOUNT_FILE?fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE,'utf8'):null);
 if(!raw)throw Error('Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_FILE and share the configured folders with its service-account email.');
 const sa=JSON.parse(raw),now=Math.floor(Date.now()/1000);
 const signed=encode({alg:'RS256',typ:'JWT'})+'.'+encode({iss:sa.client_email,scope:'https://www.googleapis.com/auth/drive.readonly',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600});
 const signature=crypto.sign('RSA-SHA256',Buffer.from(signed),sa.private_key).toString('base64url');
 const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:signed+'.'+signature})});
 const x=await r.json();if(!r.ok)throw Error('Google token request failed: '+(x.error_description||x.error));
 tokenCache={token:x.access_token,expiry:Date.now()+(x.expires_in||3600)*1000};return tokenCache.token;
}
async function drive(url){
 let result;for(let i=0;i<4;i++){result=await fetch(url,{headers:{authorization:'Bearer '+await token()}});if(![429,500,502,503].includes(result.status))break;await new Promise(resolve=>setTimeout(resolve,400*(i+1)**2));}
 if(!result.ok)throw Error('Drive API '+result.status+': '+(await result.text()).slice(0,170));return result;
}
async function children(id){
 const found=[];let next='';
 do{const u=new URL('https://www.googleapis.com/drive/v3/files');u.searchParams.set('q',"'"+id+"' in parents and trashed = false");u.searchParams.set('fields','nextPageToken,files(id,name,mimeType,modifiedTime,size,description,webViewLink,thumbnailLink,md5Checksum)');u.searchParams.set('pageSize','1000');u.searchParams.set('supportsAllDrives','true');u.searchParams.set('includeItemsFromAllDrives','true');if(next)u.searchParams.set('pageToken',next);
 const data=await(await drive(u)).json();found.push(...(data.files||[]));next=data.nextPageToken||'';}while(next);return found;
}
async function sync(){
 if(syncing)return false;syncing=true;syncStartedAt=new Date().toISOString();const rows=[],failures=[],seen=new Set(),stats=Object.fromEntries(roots.map(x=>[x.name,{files:0,folders:0,errors:0}]));let count=0;
 try{const queue=roots.map(root=>({id:root.id,source:root.name,path:[]}));while(queue.length){
 const batch=queue.splice(0,scanConcurrency);await Promise.all(batch.map(async task=>{if(seen.has(task.source+':'+task.id))return;seen.add(task.source+':'+task.id);
 try{const files=await children(task.id);count++;stats[task.source].folders++;for(const file of files){
 if(file.mimeType==='application/vnd.google-apps.folder'){queue.push({id:file.id,source:task.source,path:[...task.path,file.name]});continue;}
 if(!(/^image\//.test(file.mimeType||'')||/\.(ai|eps|svg|pdf|psd|webp|png|jpe?g|avif|tiff?)$/i.test(file.name)))continue;
 stats[task.source].files++;rows.push({id:file.id,name:file.name,source:task.source,category:task.path[0]||'Uncategorised',folder:task.path.join(' / '),mime:file.mimeType||'',preview:/^image\//.test(file.mimeType||'')||!!file.thumbnailLink,thumbnail:file.thumbnailLink||'',checksum:file.md5Checksum||'',updated:file.modifiedTime||'',size:Number(file.size||0),description:file.description||'',url:file.webViewLink||'https://drive.google.com/file/d/'+file.id+'/view'});}
 }catch(e){stats[task.source].errors++;failures.push(task.source+' / '+task.path.join('/')+': '+e.message)}}));scannedFolders=count;sourceStats=stats;}
 if(!failures.length&&rows.length){catalogue=rows.sort((a,b)=>b.updated.localeCompare(a.updated));syncedAt=new Date().toISOString();console.log('Drive sync complete:',rows.length,'designs across',count,'folders');}else{if(!rows.length&&!failures.length)failures.push('Drive returned zero design files; retaining saved catalogue');console.error('Drive sync incomplete:',failures.slice(0,20).join(' | '));}
 errors=failures;scannedFolders=count;sourceStats=stats;
 }catch(e){errors=[e.message]}finally{syncing=false;}
 return !errors.length;
}
function isExplicitDuplicate(x){return !!x.confirmedDuplicate||/^_?Confirmed Duplicates\b/i.test(x.category||'')||/(^| \/ )_?Confirmed Duplicates\b/i.test(x.folder||'')}
function duplicateIds(){const hashes=new Map(),dupes=new Set();for(const x of catalogue){if(isExplicitDuplicate(x))dupes.add(x.id);if(!x.checksum)continue;const key=x.checksum+':'+x.size;if(!hashes.has(key))hashes.set(key,[]);hashes.get(key).push(x)}for(const group of hashes.values()){if(group.length<2)continue;group.sort((a,b)=>Number(isExplicitDuplicate(a))-Number(isExplicitDuplicate(b))||a.updated.localeCompare(b.updated)||a.id.localeCompare(b.id));const canonical=group.find(x=>!isExplicitDuplicate(x));for(const x of group)if(!canonical||x.id!==canonical.id)dupes.add(x.id)}return dupes}
function json(res,obj,status=200){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(obj))}
const SESSION_COOKIE='weardhk_session';
function loginHtml(message=''){
 return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WearDHK sign in</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f1eb;color:#20231f;font:16px system-ui,-apple-system,sans-serif;padding:24px}.card{width:min(100%,420px);background:#fff;border:1px solid #e5e0d8;border-radius:22px;padding:30px;box-shadow:0 18px 60px #28231a18}h1{font-size:26px;margin:0 0 8px}.muted{color:#68706a;margin:0 0 24px}label{display:block;font-weight:650;margin:0 0 8px}input{width:100%;font:inherit;padding:14px 15px;border:1px solid #cfcfc7;border-radius:12px;margin-bottom:18px}button{width:100%;border:0;border-radius:12px;background:#243c2d;color:white;font:inherit;font-weight:700;padding:14px;cursor:pointer}.error{color:#a32424;background:#fff0ef;border-radius:10px;padding:10px 12px;margin:0 0 16px}</style><main class="card"><h1>WearDHK Design Hub</h1><p class="muted">Enter your catalogue password to continue.</p>${message?'<p class="error">Password not recognised. Please try again.</p>':''}<form method="post" action="/login"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">Sign in</button></form></main></html>`;
}
function validSession(req){
 const expected=process.env.APP_PASSWORD;if(!expected)return true;
 const cookies=Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return i<0?[x,'']:[x.slice(0,i),x.slice(i+1)]}));
 const raw=cookies[SESSION_COOKIE]||'',parts=raw.split('.');if(parts.length!==2)return false;
 const expiry=Number(parts[0]);if(!Number.isFinite(expiry)||expiry<Date.now())return false;
 const wanted=crypto.createHmac('sha256',expected).update(String(expiry)).digest();
 let supplied;try{supplied=Buffer.from(parts[1],'base64url')}catch{return false}
 return supplied.length===wanted.length&&crypto.timingSafeEqual(supplied,wanted);
}
function issueSession(res){
 const expiry=Date.now()+7*24*60*60*1000;
 const sig=crypto.createHmac('sha256',process.env.APP_PASSWORD).update(String(expiry)).digest('base64url');
 res.writeHead(303,{'location':'/','set-cookie':SESSION_COOKIE+'='+expiry+'.'+sig+'; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800','cache-control':'no-store'});res.end();
}
function requireSession(req,res,u){
 if(validSession(req))return true;
 if(u.pathname.startsWith('/api/'))return json(res,{error:'Please sign in to continue'},401),false;
 res.writeHead(303,{'location':'/login','cache-control':'no-store'});res.end();return false;
}
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
async function handler(req,res){
 const u=new URL(req.url,'http://localhost');
 if(u.pathname==='/login'){
  if(req.method==='GET'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});return res.end(loginHtml());}
  if(req.method==='POST'){
   let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>4096)break;}
   const submitted=new URLSearchParams(raw).get('password')||'',expected=process.env.APP_PASSWORD||'';
   const a=Buffer.from(submitted),b=Buffer.from(expected);
   if(expected&&a.length===b.length&&crypto.timingSafeEqual(a,b))return issueSession(res);
   res.writeHead(401,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});return res.end(loginHtml(true));
  }
  res.writeHead(405,{'allow':'GET, POST'});return res.end();
 }
 if(!requireSession(req,res,u))return;
 try{
 if(u.pathname==='/api/status')return json(res,{duplicates:duplicateIds().size,count:catalogue.length,syncedAt,errors:errors.slice(0,15),scannedFolders,sourceStats,snapshotCount:snapshot.length,usingSnapshot:!syncedAt,complete:!!syncedAt&&!errors.length,syncing,syncStartedAt,connected:!!(process.env.GOOGLE_DRIVE_ACCESS_TOKEN||process.env.GOOGLE_SERVICE_ACCOUNT_JSON||process.env.GOOGLE_SERVICE_ACCOUNT_FILE),roots,interval});
 if(u.pathname==='/api/categories'){const duplicateSet=duplicateIds(),view=u.searchParams.get('view')||'all',map=new Map();for(const x of catalogue){if(view==='duplicates'?!duplicateSet.has(x.id):duplicateSet.has(x.id))continue;for(const [source,name] of [[x.source,x.category],...(isArabicDesign(x.name)?[['Arabic Designs','Arabic Designs']]:[])]){const key=source+'|||'+name;map.set(key,(map.get(key)||0)+1);}}return json(res,{categories:[...map].map(([k,count])=>({source:k.split('|||')[0],name:k.split('|||')[1],count})).sort((a,b)=>b.count-a.count)})}
 if(u.pathname==='/api/designs'){const q=(u.searchParams.get('q')||'').toLowerCase(),source=u.searchParams.get('source')||'All',cat=u.searchParams.get('category')||'All',sort=u.searchParams.get('sort')||'newest';const view=u.searchParams.get('view')||'all',duplicateSet=duplicateIds();const limit=Math.max(1,Math.min(120,Number(u.searchParams.get('limit')||48))),page=Math.max(1,Number(u.searchParams.get('page')||1));
 let list=catalogue.filter(x=>(view==='favorites'?(u.searchParams.get('ids')||'').split(',').includes(x.id):(view==='duplicates'?duplicateSet.has(x.id):!duplicateSet.has(x.id)))&&(source==='All'||(source==='Arabic Designs'?isArabicDesign(x.name):x.source===source))&&(cat==='All'||(cat==='Arabic Designs'?isArabicDesign(x.name):x.category===cat))&&(!q||(x.name+' '+x.source+' '+x.category+' '+x.folder+' '+x.description+(isArabicDesign(x.name)?' Arabic Designs':'')).toLowerCase().includes(q)));
 if(sort==='name')list.sort((a,b)=>a.name.localeCompare(b.name));else if(sort==='oldest')list.sort((a,b)=>a.updated.localeCompare(b.updated));const total=list.length,duplicateCount=list.filter(x=>duplicateSet.has(x.id)).length;return json(res,{items:list.slice((page-1)*limit,page*limit).map(x=>({...x,isDuplicate:duplicateSet.has(x.id)})),total,duplicateCount,uniqueCount:total-duplicateCount,page,pages:Math.ceil(total/limit)||1});}
 if(u.pathname==='/api/sync'&&req.method==='POST'){if(!process.env.GOOGLE_DRIVE_ACCESS_TOKEN&&!process.env.GOOGLE_SERVICE_ACCOUNT_JSON&&!process.env.GOOGLE_SERVICE_ACCOUNT_FILE)return json(res,{error:'Google Drive credentials not configured'},503);const alreadyRunning=syncing;sync().catch(console.error);return json(res,{started:!alreadyRunning,alreadyRunning},alreadyRunning?200:202)}
 if(u.pathname.startsWith('/api/download/')){const id=u.pathname.slice('/api/download/'.length);const item=catalogue.find(x=>x.id===id);if(!item)return json(res,{error:'Not found'},404);const upstream=await drive('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id)+'?alt=media&supportsAllDrives=true');const bytes=Buffer.from(await upstream.arrayBuffer());if(bytes.length>80*1024*1024)return json(res,{error:'File exceeds download limit; use Drive link'},413);const safe=item.name.replace(/[\\\"\r\n]/g,'_');res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':'attachment; filename="'+safe+'"','content-length':bytes.length,'cache-control':'no-store'});return res.end(bytes);}
 if(u.pathname.startsWith('/api/image/')){const id=u.pathname.slice('/api/image/'.length);const item=catalogue.find(x=>x.id===id);if(!item||!item.preview)return json(res,{error:'Not found'},404);const upstream=await drive(item.thumbnail&&!/^image\//.test(item.mime)?item.thumbnail:'https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id)+'?alt=media&supportsAllDrives=true');const size=Number(upstream.headers.get('content-length')||0);if(size>15*1024*1024)return json(res,{error:'Image too large'},413);const data=Buffer.from(await upstream.arrayBuffer());if(data.length>15*1024*1024)return json(res,{error:'Image too large'},413);res.writeHead(200,{'content-type':item.thumbnail&&!/^image\//.test(item.mime)?'image/jpeg':item.mime,'cache-control':'private, max-age=900','x-content-type-options':'nosniff'});return res.end(data);}
 if(req.method!=='GET')return json(res,{error:'Method not allowed'},405);
 const name=u.pathname==='/'?'index.html':u.pathname.slice(1),root=path.join(__dirname,'public'),file=path.resolve(root,name);if(!file.startsWith(root+path.sep))return json(res,{error:'Forbidden'},403);if(!fs.existsSync(file)||!fs.statSync(file).isFile())return json(res,{error:'Not found'},404);
 res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream','cache-control':name.endsWith('.css')?'public, max-age=300':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"});res.end(fs.readFileSync(file));
 }catch(e){console.error(e);return json(res,{error:e.message},500)}
}
http.createServer((req,res)=>handler(req,res).catch(console.error)).listen(port,()=>{console.log('WearDHK Design Hub on port '+port+'; saved catalogue: '+catalogue.length+' designs');if(process.env.GOOGLE_SERVICE_ACCOUNT_JSON||process.env.GOOGLE_SERVICE_ACCOUNT_FILE||process.env.GOOGLE_DRIVE_ACCESS_TOKEN)sync().catch(console.error)});
setInterval(()=>sync().catch(console.error),interval*60000).unref();
