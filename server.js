'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const roots=[
 {id:'128JL_dyiO2xFXaRKh4zj8al5w2Y6XoNP',name:'Main Library'},
 {id:'1QImLRpunvmjkhHc8_CqewTw7u6lqvoLb',name:'Organised Library'},
 {id:'1MPdvOZSFs0uUwS3qYOzY9m5-_61DloDW',name:'New Designs'}];
const port=Number(process.env.PORT||3000),interval=Math.max(1,Number(process.env.SYNC_MINUTES||5));
let catalogue=[],syncedAt=null,errors=[],scannedFolders=0,syncing=false;
const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
let tokenCache={token:'',expiry:0};
async function token(){
 if(process.env.GOOGLE_DRIVE_ACCESS_TOKEN)return process.env.GOOGLE_DRIVE_ACCESS_TOKEN;
 if(tokenCache.token&&Date.now()<tokenCache.expiry-90000)return tokenCache.token;
 const raw=process.env.GOOGLE_SERVICE_ACCOUNT_JSON||(process.env.GOOGLE_SERVICE_ACCOUNT_FILE?fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE,'utf8'):null);
 if(!raw)throw Error('Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_FILE and share the three folders with its service-account email.');
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
 do{const u=new URL('https://www.googleapis.com/drive/v3/files');u.searchParams.set('q',"'"+id+"' in parents and trashed = false");u.searchParams.set('fields','nextPageToken,files(id,name,mimeType,modifiedTime,size,description,webViewLink)');u.searchParams.set('pageSize','1000');u.searchParams.set('supportsAllDrives','true');u.searchParams.set('includeItemsFromAllDrives','true');if(next)u.searchParams.set('pageToken',next);
 const data=await(await drive(u)).json();found.push(...(data.files||[]));next=data.nextPageToken||'';}while(next);return found;
}
async function sync(){
 if(syncing)return;syncing=true;const rows=[],failures=[],seen=new Set();let count=0;
 try{const queue=roots.map(root=>({id:root.id,source:root.name,path:[]}));while(queue.length){
 const batch=queue.splice(0,5);await Promise.all(batch.map(async task=>{if(seen.has(task.id))return;seen.add(task.id);
 try{const files=await children(task.id);count++;for(const file of files){
 if(file.mimeType==='application/vnd.google-apps.folder'){queue.push({id:file.id,source:task.source,path:[...task.path,file.name]});continue;}
 if(!(/^image\//.test(file.mimeType||'')||/\.(ai|eps|svg|pdf|psd|webp|png|jpe?g|avif|tiff?)$/i.test(file.name)))continue;
 rows.push({id:file.id,name:file.name,source:task.source,category:task.path[0]||'Uncategorised',folder:task.path.join(' / '),mime:file.mimeType||'',preview:/^image\//.test(file.mimeType||''),updated:file.modifiedTime||'',size:Number(file.size||0),description:file.description||'',url:file.webViewLink||'https://drive.google.com/file/d/'+file.id+'/view'});}
 }catch(e){failures.push(task.source+' / '+task.path.join('/')+': '+e.message)}}));}
 if(!failures.length||rows.length||!catalogue.length){catalogue=rows.sort((a,b)=>b.updated.localeCompare(a.updated));syncedAt=new Date().toISOString();}
 errors=failures;scannedFolders=count;
 }catch(e){errors=[e.message]}finally{syncing=false;}
}
function json(res,obj,status=200){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(obj))}
function pass(req,res){
 const expected=process.env.APP_PASSWORD;if(!expected)return true;let actual='';
 try{actual=Buffer.from((req.headers.authorization||'').replace(/^Basic /i,''),'base64').toString().split(':').slice(1).join(':')}catch{}
 const a=Buffer.from(actual),b=Buffer.from(expected);
 if(a.length===b.length&&crypto.timingSafeEqual(a,b))return true;
 res.writeHead(401,{'www-authenticate':'Basic realm="WearDHK Design Hub"'});res.end('Authentication required');return false;
}
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
async function handler(req,res){
 if(!pass(req,res))return;const u=new URL(req.url,'http://localhost');
 try{
 if(u.pathname==='/api/status')return json(res,{count:catalogue.length,syncedAt,errors:errors.slice(0,15),scannedFolders,syncing,connected:!!(process.env.GOOGLE_DRIVE_ACCESS_TOKEN||process.env.GOOGLE_SERVICE_ACCOUNT_JSON||process.env.GOOGLE_SERVICE_ACCOUNT_FILE),roots,interval});
 if(u.pathname==='/api/categories'){const map=new Map();for(const x of catalogue){const key=x.source+'|||'+x.category;map.set(key,(map.get(key)||0)+1);}return json(res,{categories:[...map].map(([k,count])=>({source:k.split('|||')[0],name:k.split('|||')[1],count})).sort((a,b)=>b.count-a.count)})}
 if(u.pathname==='/api/designs'){const q=(u.searchParams.get('q')||'').toLowerCase(),source=u.searchParams.get('source')||'All',cat=u.searchParams.get('category')||'All',sort=u.searchParams.get('sort')||'newest';const limit=Math.max(1,Math.min(120,Number(u.searchParams.get('limit')||48))),page=Math.max(1,Number(u.searchParams.get('page')||1));
 let list=catalogue.filter(x=>(source==='All'||x.source===source)&&(cat==='All'||x.category===cat)&&(!q||(x.name+' '+x.folder+' '+x.description).toLowerCase().includes(q)));
 if(sort==='name')list.sort((a,b)=>a.name.localeCompare(b.name));else if(sort==='oldest')list.sort((a,b)=>a.updated.localeCompare(b.updated));const total=list.length;return json(res,{items:list.slice((page-1)*limit,page*limit),total,page,pages:Math.ceil(total/limit)||1});}
 if(u.pathname==='/api/sync'&&req.method==='POST'){if(!process.env.GOOGLE_DRIVE_ACCESS_TOKEN&&!process.env.GOOGLE_SERVICE_ACCOUNT_JSON&&!process.env.GOOGLE_SERVICE_ACCOUNT_FILE)return json(res,{error:'Google Drive credentials not configured'},503);sync().catch(console.error);return json(res,{started:true},202)}
 if(u.pathname.startsWith('/api/image/')){const id=u.pathname.slice('/api/image/'.length);const item=catalogue.find(x=>x.id===id);if(!item||!item.preview)return json(res,{error:'Not found'},404);const upstream=await drive('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id)+'?alt=media&supportsAllDrives=true');const size=Number(upstream.headers.get('content-length')||0);if(size>15*1024*1024)return json(res,{error:'Image too large'},413);const data=Buffer.from(await upstream.arrayBuffer());if(data.length>15*1024*1024)return json(res,{error:'Image too large'},413);res.writeHead(200,{'content-type':item.mime,'cache-control':'private, max-age=900','x-content-type-options':'nosniff'});return res.end(data);}
 if(req.method!=='GET')return json(res,{error:'Method not allowed'},405);
 const name=u.pathname==='/'?'index.html':u.pathname.slice(1),root=path.join(__dirname,'public'),file=path.resolve(root,name);if(!file.startsWith(root+path.sep))return json(res,{error:'Forbidden'},403);if(!fs.existsSync(file)||!fs.statSync(file).isFile())return json(res,{error:'Not found'},404);
 res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"});res.end(fs.readFileSync(file));
 }catch(e){console.error(e);return json(res,{error:e.message},500)}
}
http.createServer((req,res)=>handler(req,res).catch(console.error)).listen(port,()=>{console.log('WearDHK Design Hub on port '+port);if(process.env.GOOGLE_SERVICE_ACCOUNT_JSON||process.env.GOOGLE_SERVICE_ACCOUNT_FILE||process.env.GOOGLE_DRIVE_ACCESS_TOKEN)sync().catch(console.error)});
setInterval(()=>sync().catch(console.error),interval*60000).unref();
