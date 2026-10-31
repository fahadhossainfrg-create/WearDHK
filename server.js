'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{Readable}=require('node:stream'),{pipeline}=require('node:stream/promises');
const sharp=require('sharp');
// Keep thumbnail generation within the 512 MiB Render instance.
sharp.cache(false);
sharp.concurrency(1);
const roots=[
 {id:'128JL_dyiO2xFXaRKh4zj8al5w2Y6XoNP',name:'Main Library'},
 {id:'1QImLRpunvmjkhHc8_CqewTw7u6lqvoLb',name:'Organised Library'},
 {id:'1MPdvOZSFs0uUwS3qYOzY9m5-_61DloDW',name:'New Designs'},
 {id:'1SpCQMhm_iu7kYEWG81xIbjJbh2FABdoc',name:'Plain Chapter'}];
const port=Number(process.env.PORT||3000),interval=Math.max(1,Number(process.env.SYNC_MINUTES||5)),scanConcurrency=Math.max(4,Math.min(12,Number(process.env.SYNC_CONCURRENCY||8)));
let catalogue=[],snapshotCount=0;try{const names=fs.readdirSync(__dirname).filter(n=>/^catalogue-[a-z0-9-]+\.json$/i.test(n)).sort(),byId=new Map();for(const name of names){const rows=JSON.parse(fs.readFileSync(path.join(__dirname,name),'utf8'));if(Array.isArray(rows))for(const row of rows)if(row?.id)byId.set(row.id,row)}catalogue=Array.from(byId.values());snapshotCount=catalogue.length;console.log('Persistent catalogue files:',names.length,'unique designs:',snapshotCount)}catch(e){console.warn('Catalogue snapshot unavailable:',e.message)}
const previewCache=new Map();
let syncedAt=null,errors=[],scannedFolders=0,syncing=false,syncStartedAt=null,sourceStats={};
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
let oauthTokenCache={token:'',expiry:0};
async function thumbnailUploadToken(){
 const refresh=process.env.GOOGLE_OAUTH_REFRESH_TOKEN,clientId=process.env.GOOGLE_OAUTH_CLIENT_ID,clientSecret=process.env.GOOGLE_OAUTH_CLIENT_SECRET;
 if(!refresh||!clientId||!clientSecret)return token();
 if(oauthTokenCache.token&&Date.now()<oauthTokenCache.expiry-60000)return oauthTokenCache.token;
 const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:refresh,grant_type:'refresh_token'})});
 const result=await response.json();if(!response.ok)throw Error('Google OAuth token refresh failed: '+(result.error_description||result.error));
 oauthTokenCache={token:result.access_token,expiry:Date.now()+(result.expires_in||3600)*1000};return oauthTokenCache.token;
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
const thumbnailFiles=new Map(),thumbnailRetry=new Map(),persistedThumbnailIds=new Set(),queuedThumbnailIds=new Set();
const MAX_THUMBNAILS_IN_MEMORY=12,MAX_PREVIEWS_IN_MEMORY=8;
function cacheThumbnail(id,value){
 if(thumbnailFiles.has(id))thumbnailFiles.delete(id);
 thumbnailFiles.set(id,value);
 while(thumbnailFiles.size>MAX_THUMBNAILS_IN_MEMORY)thumbnailFiles.delete(thumbnailFiles.keys().next().value);
 return value;
}
let thumbnailPreparationQueue=[],thumbnailPreparationRunning=false;
async function refreshThumbnailIndex(){
 const folder=process.env.GOOGLE_THUMBNAILS_FOLDER_ID;if(!folder)return;
 try{const files=await children(folder);persistedThumbnailIds.clear();for(const file of files){const name=String(file.name||'');if(/\.webp$/i.test(name))persistedThumbnailIds.add(name.replace(/\.webp$/i,''));}}
 catch(e){console.warn('Could not refresh saved thumbnail index:',e.message)}
}
async function drainThumbnailQueue(){
 if(thumbnailPreparationRunning)return;thumbnailPreparationRunning=true;
 try{while(thumbnailPreparationQueue.length){if(process.memoryUsage().rss>190*1024*1024){await new Promise(resolve=>setTimeout(resolve,30000));continue}const item=thumbnailPreparationQueue.shift();try{const preview=await getOrCreateThumbnail(item);if(preview.stored===false){thumbnailFiles.delete(item.id);thumbnailRetry.set(item.id,Date.now()+30*60*1000);console.warn('Thumbnail generated but not saved; retry scheduled:',item.id)}else{persistedThumbnailIds.add(item.id);thumbnailRetry.delete(item.id);console.log('Prepared preview for design:',item.name)}}catch(e){thumbnailRetry.set(item.id,Date.now()+30*60*1000);console.warn('Could not create Drive thumbnail; retry scheduled:',item.id,e.message)}finally{thumbnailFiles.delete(item.id);queuedThumbnailIds.delete(item.id)}await new Promise(resolve=>setTimeout(resolve,8000));}}
 finally{thumbnailPreparationRunning=false;if(thumbnailPreparationQueue.length)void drainThumbnailQueue();}
}
function scheduleThumbnailPreparation(rows,previousIds){
 // Background conversions are opt-in on small instances to avoid OOM restarts.
 if(process.env.ENABLE_BACKGROUND_THUMBNAILS==='false')return;
 const folder=process.env.GOOGLE_THUMBNAILS_FOLDER_ID;if(!folder)return;
 const candidates=rows.filter(item=>(/^image\/(png|jpeg|webp)$/i.test(item.mime||'')&&Number(item.size||0)<=10*1024*1024)||/\.(ai|eps|pdf)$/i.test(item.name||''));
 const fresh=[],backfill=[],now=Date.now();
 for(const item of candidates){if(persistedThumbnailIds.has(item.id)||queuedThumbnailIds.has(item.id)||(thumbnailRetry.get(item.id)||0)>now)continue;queuedThumbnailIds.add(item.id);(previousIds.has(item.id)?backfill:fresh).push(item);}
 const byName=(a,b)=>a.name.localeCompare(b.name);
 fresh.sort(byName);backfill.sort(byName);
 const all=[...fresh,...thumbnailPreparationQueue,...backfill];thumbnailPreparationQueue=all.slice(0,8);const chosen=new Set(thumbnailPreparationQueue.map(x=>x.id));for(const item of all)if(!chosen.has(item.id))queuedThumbnailIds.delete(item.id);
 void drainThumbnailQueue();
}
async function loadGeneratedThumbnail(sourceId){
 const folder=process.env.GOOGLE_THUMBNAILS_FOLDER_ID;if(!folder)return null;
 const query=new URL('https://www.googleapis.com/drive/v3/files');
 query.searchParams.set('q',"'"+folder+"' in parents and appProperties has { key='wearDhkSourceId' and value='"+sourceId+"' } and trashed = false");
 query.searchParams.set('fields','files(id,name,mimeType)');query.searchParams.set('pageSize','1');query.searchParams.set('supportsAllDrives','true');query.searchParams.set('includeItemsFromAllDrives','true');
 const data=await(await drive(query)).json();let file=data.files?.[0];if(!file){const byName=new URL('https://www.googleapis.com/drive/v3/files');byName.searchParams.set('q',"'"+folder+"' in parents and name='"+sourceId+".webp' and trashed = false");byName.searchParams.set('fields','files(id,name,mimeType)');byName.searchParams.set('pageSize','1');byName.searchParams.set('supportsAllDrives','true');byName.searchParams.set('includeItemsFromAllDrives','true');const named=await(await drive(byName)).json();file=named.files?.[0];}if(!file)return null;
 const response=await drive('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(file.id)+'?alt=media&supportsAllDrives=true');
 return {bytes:Buffer.from(await response.arrayBuffer()),mime:file.mimeType||'image/webp',driveThumbnailId:file.id};
}
async function createDriveThumbnail(item){
 const folder=process.env.GOOGLE_THUMBNAILS_FOLDER_ID;if(!folder)throw Error('GOOGLE_THUMBNAILS_FOLDER_ID is not configured');
 let bytes,sourceError;
 try{if(/\.(ai|eps|pdf)$/i.test(item.name||''))throw Error('Vector/document preview uses Google Drive thumbnail');const original=await drive('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(item.id)+'?alt=media&supportsAllDrives=true');const input=Buffer.from(await original.arrayBuffer());if(input.length>40*1024*1024)throw Error('Original exceeds thumbnail input limit');bytes=await sharp(input,{limitInputPixels:50000000}).rotate().resize({width:480,height:480,fit:'inside',withoutEnlargement:true}).webp({quality:76}).toBuffer();}
 catch(e){sourceError=e;const metadata=await(await drive('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(item.id)+'?fields=thumbnailLink&supportsAllDrives=true')).json();const link=item.thumbnail||metadata.thumbnailLink;if(!link)throw sourceError;const fallback=await fetch(link,{headers:{authorization:'Bearer '+await token()}});if(!fallback.ok)throw Error('Original preview failed ('+sourceError.message+'); Drive thumbnail HTTP '+fallback.status);if(Number(fallback.headers.get('content-length')||0)>4*1024*1024)throw Error('Drive preview exceeds 4 MB limit');const fallbackBytes=Buffer.from(await fallback.arrayBuffer());if(fallbackBytes.length>4*1024*1024)throw Error('Drive preview exceeds 4 MB limit');bytes=await sharp(fallbackBytes,{limitInputPixels:12000000}).rotate().resize({width:480,height:480,fit:'inside',withoutEnlargement:true}).webp({quality:76}).toBuffer();}
 const metadata={name:item.id+'.webp',mimeType:'image/webp',parents:[folder],appProperties:{wearDhkSourceId:item.id}};
 const form=new FormData();form.append('metadata',new Blob([JSON.stringify(metadata)],{type:'application/json'}));form.append('file',new Blob([bytes],{type:'image/webp'}),metadata.name);
 const response=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,mimeType',{method:'POST',headers:{authorization:'Bearer '+await thumbnailUploadToken()},body:form});
 if(!response.ok){const detail=(await response.text()).slice(0,180);console.warn('Thumbnail generated but Drive storage is unavailable; keeping preview in memory:',item.id,response.status,detail);return {bytes,mime:'image/webp',driveThumbnailId:null,stored:false};}
 const saved=await response.json();return {bytes,mime:'image/webp',driveThumbnailId:saved.id,stored:true};
}
async function getOrCreateThumbnail(item){
 if(thumbnailFiles.has(item.id))return thumbnailFiles.get(item.id);
 const existing=await loadGeneratedThumbnail(item.id);if(existing)return cacheThumbnail(item.id,existing);
 const generated=await createDriveThumbnail(item);return cacheThumbnail(item.id,generated);
}
async function sync(){
 if(syncing)return false;syncing=true;syncStartedAt=new Date().toISOString();const rows=[],failures=[],seen=new Set(),stats=Object.fromEntries(roots.map(x=>[x.name,{files:0,folders:0,errors:0}]));let count=0;
 try{
 const queue=roots.map(root=>({id:root.id,source:root.name,path:[]}));while(queue.length){
 const batch=queue.splice(0,scanConcurrency);await Promise.all(batch.map(async task=>{if(seen.has(task.source+':'+task.id))return;seen.add(task.source+':'+task.id);
 try{const files=await children(task.id);count++;stats[task.source].folders++;for(const file of files){
 if(file.mimeType==='application/vnd.google-apps.folder'){queue.push({id:file.id,source:task.source,path:[...task.path,file.name]});continue;}
 if(!(/^image\//.test(file.mimeType||'')||/\.(ai|eps|svg|pdf|psd|webp|png|jpe?g|avif|tiff?)$/i.test(file.name)))continue;
 stats[task.source].files++;rows.push({id:file.id,name:file.name,source:task.source,category:task.path[0]||'Uncategorised',folder:task.path.join(' / '),mime:file.mimeType||'',preview:/^image\//.test(file.mimeType||'')||!!file.thumbnailLink||/\.(ai|eps|pdf)$/i.test(file.name),thumbnail:file.thumbnailLink||'',checksum:file.md5Checksum||'',updated:file.modifiedTime||'',size:Number(file.size||0),description:file.description||'',url:file.webViewLink||'https://drive.google.com/file/d/'+file.id+'/view'});}
 }catch(e){stats[task.source].errors++;failures.push(task.source+' / '+task.path.join('/')+': '+e.message)}}));scannedFolders=count;sourceStats=stats;}
 if(!failures.length&&rows.length){const previousIds=new Set(catalogue.map(x=>x.id));catalogue=rows.sort((a,b)=>b.updated.localeCompare(a.updated));duplicateCache=null;snapshotCount=0;syncedAt=new Date().toISOString();console.log('Drive sync complete:',rows.length,'designs across',count,'folders');
 if(process.env.GOOGLE_THUMBNAILS_FOLDER_ID){await refreshThumbnailIndex();scheduleThumbnailPreparation(rows,previousIds);}}else{if(!rows.length&&!failures.length)failures.push('Drive returned zero design files; retaining saved catalogue');console.error('Drive sync incomplete:',failures.slice(0,20).join(' | '));}
 errors=failures;scannedFolders=count;sourceStats=stats;
 }catch(e){errors=[e.message]}finally{syncing=false;}
 return !errors.length;
}
function isExplicitDuplicate(x){return !!x.confirmedDuplicate||/^_?Confirmed Duplicates\b/i.test(x.category||'')||/(^| \/ )_?Confirmed Duplicates\b/i.test(x.folder||'')}
let duplicateCache=null;function duplicateIds(){if(duplicateCache)return duplicateCache;const hashes=new Map(),dupes=new Set();for(const x of catalogue){if(isExplicitDuplicate(x))dupes.add(x.id);if(!x.checksum)continue;const key=x.checksum+':'+x.size;if(!hashes.has(key))hashes.set(key,[]);hashes.get(key).push(x)}for(const group of hashes.values()){if(group.length<2)continue;group.sort((a,b)=>Number(isExplicitDuplicate(a))-Number(isExplicitDuplicate(b))||a.updated.localeCompare(b.updated)||a.id.localeCompare(b.id));const canonical=group.find(x=>!isExplicitDuplicate(x));for(const x of group)if(!canonical||x.id!==canonical.id)dupes.add(x.id)}duplicateCache=dupes;return duplicateCache}
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
 if(u.pathname==='/oauth/google'&&req.method==='GET'){
  const clientId=process.env.GOOGLE_OAUTH_CLIENT_ID,redirectUri=process.env.GOOGLE_OAUTH_REDIRECT_URI||'https://weardhk-design-hub.onrender.com/oauth/google/callback';
  if(!clientId||!process.env.GOOGLE_OAUTH_CLIENT_SECRET)return json(res,{error:'Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in Render first.'},503);
  const state=crypto.randomBytes(32).toString('hex'),params=new URLSearchParams({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:'https://www.googleapis.com/auth/drive',access_type:'offline',prompt:'consent',include_granted_scopes:'true',state});
  res.writeHead(302,{'location':'https://accounts.google.com/o/oauth2/v2/auth?'+params.toString(),'set-cookie':'weardhk_oauth_state='+state+'; HttpOnly; Secure; SameSite=Lax; Path=/oauth/google; Max-Age=600','cache-control':'no-store'});return res.end();
 }
 if(u.pathname==='/oauth/google/callback'&&req.method==='GET'){
  const cookies=Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return i<0?[x,'']:[x.slice(0,i),x.slice(i+1)]}));
  const sent=u.searchParams.get('state')||'',saved=cookies.weardhk_oauth_state||'';
  if(!sent||!saved||sent!==saved)return json(res,{error:'Google authorization state expired or did not match. Start again at /oauth/google.'},400);
  const code=u.searchParams.get('code');if(!code)return json(res,{error:'Google did not return an authorization code.'},400);
  const redirectUri=process.env.GOOGLE_OAUTH_REDIRECT_URI||'https://weardhk-design-hub.onrender.com/oauth/google/callback';
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:process.env.GOOGLE_OAUTH_CLIENT_ID||'',client_secret:process.env.GOOGLE_OAUTH_CLIENT_SECRET||'',redirect_uri:redirectUri,grant_type:'authorization_code'})});
  const result=await response.json();res.setHeader('set-cookie','weardhk_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/oauth/google; Max-Age=0');
  if(!response.ok||!result.refresh_token){res.writeHead(400,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"});return res.end('<!doctype html><meta charset="utf-8"><title>Google Drive connection</title><p>Google authorization did not return a refresh token. Check the OAuth client settings and try again with consent.</p>');}
  const safe=result.refresh_token.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"});return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google Drive connection</title><main style="max-width:720px;margin:40px auto;padding:24px;font:16px system-ui;color:#20323a"><h1>Google authorization complete</h1><p>Copy this refresh token and add it to the Render environment variable <strong>GOOGLE_OAUTH_REFRESH_TOKEN</strong>. Keep it private.</p><textarea readonly style="width:100%;height:110px;font:14px monospace">'+safe+'</textarea><p>Then redeploy the WearDHK service. The site will use your Google account to store thumbnails in the configured Drive folder.</p></main>');
 }
 if(!requireSession(req,res,u))return;
 try{
 if(u.pathname==='/api/status')return json(res,{thumbnailStatus:{saved:persistedThumbnailIds.size,queued:thumbnailPreparationQueue.length,processing:thumbnailPreparationRunning,backgroundEnabled:process.env.ENABLE_BACKGROUND_THUMBNAILS!=='false',memoryMB:Math.round(process.memoryUsage().rss/1048576),memoryLimitMB:512},duplicates:duplicateIds().size,count:catalogue.length,syncedAt,errors:errors.slice(0,15),scannedFolders,sourceStats,snapshotCount,usingSnapshot:!syncedAt&&snapshotCount>0,complete:!!syncedAt&&!errors.length,syncing,syncStartedAt,connected:!!(process.env.GOOGLE_DRIVE_ACCESS_TOKEN||process.env.GOOGLE_SERVICE_ACCOUNT_JSON||process.env.GOOGLE_SERVICE_ACCOUNT_FILE),roots,interval});
 if(u.pathname==='/api/categories'){const duplicateSet=duplicateIds(),view=u.searchParams.get('view')||'all',map=new Map();for(const x of catalogue){if(view==='duplicates'?!duplicateSet.has(x.id):duplicateSet.has(x.id))continue;for(const [source,name] of [[x.source,x.category],...(isArabicDesign(x.name)?[['Arabic Designs','Arabic Designs']]:[])]){const key=source+'|||'+name;map.set(key,(map.get(key)||0)+1);}}return json(res,{categories:[...map].map(([k,count])=>({source:k.split('|||')[0],name:k.split('|||')[1],count})).sort((a,b)=>b.count-a.count)})}
 if(u.pathname==='/api/designs'){const q=(u.searchParams.get('q')||'').toLowerCase(),normalizeSearch=value=>String(value||'').toLowerCase().replace(/[_-]+/g,' ').replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim(),normalizedQ=normalizeSearch(q),source=u.searchParams.get('source')||'All',cat=u.searchParams.get('category')||'All',sort=u.searchParams.get('sort')||'newest';const view=u.searchParams.get('view')||'all',duplicateSet=duplicateIds();const limit=Math.max(1,Math.min(120,Number(u.searchParams.get('limit')||48))),page=Math.max(1,Number(u.searchParams.get('page')||1));
 let list=catalogue.filter(x=>(view==='favorites'?(u.searchParams.get('ids')||'').split(',').includes(x.id):(view==='duplicates'?duplicateSet.has(x.id):!duplicateSet.has(x.id)))&&(source==='All'||(source==='Arabic Designs'?isArabicDesign(x.name):x.source===source))&&(cat==='All'||(cat==='Arabic Designs'?isArabicDesign(x.name):x.category===cat))&&(!normalizedQ||normalizeSearch(x.name+' '+x.source+' '+x.category+' '+x.folder+' '+x.description+(isArabicDesign(x.name)?' Arabic Designs':'')).includes(normalizedQ)));
 if(sort==='name')list.sort((a,b)=>a.name.localeCompare(b.name));else if(sort==='oldest')list.sort((a,b)=>a.updated.localeCompare(b.updated));const total=list.length,duplicateCount=list.filter(x=>duplicateSet.has(x.id)).length;return json(res,{items:list.slice((page-1)*limit,page*limit).map(x=>({...x,isDuplicate:duplicateSet.has(x.id)})),total,duplicateCount,uniqueCount:total-duplicateCount,page,pages:Math.ceil(total/limit)||1});}
 if(u.pathname==='/api/sync'&&req.method==='POST'){if(!process.env.GOOGLE_DRIVE_ACCESS_TOKEN&&!process.env.GOOGLE_SERVICE_ACCOUNT_JSON&&!process.env.GOOGLE_SERVICE_ACCOUNT_FILE)return json(res,{error:'Google Drive credentials not configured'},503);const alreadyRunning=syncing;sync().catch(console.error);return json(res,{started:!alreadyRunning,alreadyRunning},alreadyRunning?200:202)}
 if(u.pathname.startsWith('/api/open/')){const id=decodeURIComponent(u.pathname.slice('/api/open/'.length));const item=catalogue.find(x=>x.id===id);if(!item)return json(res,{error:'Not found'},404);res.writeHead(302,{'location':item.url,'cache-control':'no-store','referrer-policy':'no-referrer'});return res.end()}
 if(u.pathname.startsWith('/api/download/')){const id=u.pathname.slice('/api/download/'.length);const item=catalogue.find(x=>x.id===id);if(!item)return json(res,{error:'Not found'},404);const upstream=await drive('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id)+'?alt=media&supportsAllDrives=true');const size=Number(item.size||upstream.headers.get('content-length')||0);if(size>80*1024*1024){upstream.body?.cancel();return json(res,{error:'File exceeds download limit; use Drive link'},413)}const extension=path.extname(item.name||'').toLowerCase();const mimeByExtension={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.pdf':'application/pdf','.ai':'application/postscript','.eps':'application/postscript','.psd':'image/vnd.adobe.photoshop','.avif':'image/avif','.tif':'image/tiff','.tiff':'image/tiff'};const safe=String(item.name||('design-'+id)).replace(/[\\\"\r\n]/g,'_');const encoded=encodeURIComponent(safe);res.writeHead(200,{'content-type':mimeByExtension[extension]||item.mime||'application/octet-stream','content-disposition':'attachment; filename="'+safe.replace(/[^\x20-\x7e]/g,'_')+'"; filename*=UTF-8\x27\x27'+encoded,...(size?{'content-length':size}:{}),'cache-control':'no-store','x-content-type-options':'nosniff'});if(upstream.body)await pipeline(Readable.fromWeb(upstream.body),res);else res.end();return;}
 if(u.pathname.startsWith('/api/image/')){
  const id=u.pathname.slice('/api/image/'.length),item=catalogue.find(x=>x.id===id);
  if(!item||!item.preview)return json(res,{error:'Preview unavailable'},404);
  const media='https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id)+'?alt=media&supportsAllDrives=true';
  const requestThumbnail=async()=>{
   const metadata=await(await drive('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id)+'?fields=thumbnailLink,mimeType&supportsAllDrives=true')).json();
   const link=item.thumbnail||metadata.thumbnailLink;
   if(!link)return getOrCreateThumbnail(item);
   try{const response=await fetch(link,{headers:{authorization:'Bearer '+await token()}});
    if(!response.ok)throw Error('Thumbnail HTTP '+response.status);
    return {bytes:Buffer.from(await response.arrayBuffer()),mime:response.headers.get('content-type')||'image/jpeg'};
   }catch(e){console.warn('Drive thumbnail failed; generating a stored thumbnail:',id,e.message);return getOrCreateThumbnail(item)}
  };
  const thumbOnly=u.searchParams.get('thumb')==='1',cacheKey=id+(thumbOnly?':thumb':':full');
  const cached=previewCache.get(cacheKey);let image=cached&&cached.expires>Date.now()?cached.image:null;
  if(!image&&thumbOnly){try{image=await requestThumbnail()}catch(e){console.warn('Quick thumbnail unavailable; trying original:',id,e.message)}}
  if(!image)try{
    if(/^image\//.test(item.mime||'') && item.size<=12*1024*1024){
      const response=await drive(media);
      const bytes=Buffer.from(await response.arrayBuffer());
      if(bytes.length<=15*1024*1024)image={bytes,mime:item.mime};
    }
  }catch(e){console.warn('Full image preview failed; trying thumbnail:',id,e.message)}
  if(!image){try{image=await requestThumbnail()}catch(e){console.warn('Thumbnail unavailable:',id,e.message);return json(res,{error:'Cannot generate preview for this file',driveUrl:item.url},502)}}
  if(image.bytes.length>15*1024*1024)return json(res,{error:'Preview exceeds size limit'},413);
  if(image.bytes.length<=2*1024*1024){if(previewCache.has(cacheKey))previewCache.delete(cacheKey);while(previewCache.size>=MAX_PREVIEWS_IN_MEMORY)previewCache.delete(previewCache.keys().next().value);previewCache.set(cacheKey,{image,expires:Date.now()+10*60*1000})}
  res.writeHead(200,{'content-type':image.mime,'content-length':image.bytes.length,'cache-control':'private,max-age=900','x-content-type-options':'nosniff'});
  return res.end(image.bytes);
 }
 if(req.method!=='GET')return json(res,{error:'Method not allowed'},405);
 const name=u.pathname==='/'?'index.html':u.pathname.slice(1),root=path.join(__dirname,'public'),file=path.resolve(root,name);if(!file.startsWith(root+path.sep))return json(res,{error:'Forbidden'},403);if(!fs.existsSync(file)||!fs.statSync(file).isFile())return json(res,{error:'Not found'},404);
 res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream','cache-control':name.endsWith('.css')?'public, max-age=300':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'"});res.end(fs.readFileSync(file));
 }catch(e){console.error(e);if(res.headersSent)return res.destroy(e);return json(res,{error:e.message},500)}
}
http.createServer((req,res)=>handler(req,res).catch(console.error)).listen(port,()=>{console.log('WearDHK Design Hub on port '+port+'; saved catalogue: '+catalogue.length+' designs');if(process.env.GOOGLE_SERVICE_ACCOUNT_JSON||process.env.GOOGLE_SERVICE_ACCOUNT_FILE||process.env.GOOGLE_DRIVE_ACCESS_TOKEN)sync().catch(console.error)});
setInterval(()=>sync().catch(console.error),interval*60000).unref();
