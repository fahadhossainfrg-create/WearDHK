'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sharp=require('sharp');
const titleOtp=require('./title-otp');
// Keep thumbnail generation within the 512 MiB Render instance.
sharp.cache(false);
sharp.concurrency(1);
const roots=[
 {id:'128JL_dyiO2xFXaRKh4zj8al5w2Y6XoNP',name:'Main Library'},
 {id:'1QImLRpunvmjkhHc8_CqewTw7u6lqvoLb',name:'Organised Library'},
 {id:'1MPdvOZSFs0uUwS3qYOzY9m5-_61DloDW',name:'New Designs'},
 {id:'1SpCQMhm_iu7kYEWG81xIbjJbh2FABdoc',name:'Plain Chapter'}];
const portArgIndex=process.argv.indexOf('--port'),portArg=portArgIndex>=0?process.argv[portArgIndex+1]:null;
const port=Number(process.env.PORT||portArg||3000),interval=Math.max(1,Number(process.env.SYNC_MINUTES||5)),scanConcurrency=Math.max(5,Math.min(30,Number(process.env.SYNC_CONCURRENCY||20)));
let snapshot=[];try{const names=fs.readdirSync(__dirname).filter(n=>/^catalogue-[a-z0-9-]+\.json$/i.test(n)).sort();const records=names.flatMap(n=>{const v=JSON.parse(fs.readFileSync(path.join(__dirname,n),'utf8'));return Array.isArray(v)?v:[]});snapshot=[...new Map(records.map(x=>[x.id,x])).values()];console.log('Persistent catalogue files:',names.length)}catch(e){console.warn('Catalogue snapshot unavailable:',e.message)}
const previewCache=new Map();
let visualResult=null,visualScanRunning=false,aiClassifyRunning=false,aiLastRequest=0;
const visualHashIndex=new Map();
const syncAuthAttempts=new Map();
const downloadsPath=path.join(__dirname,'download-counts.json');
let personalSync={favourites:[],boards:[],updatedAt:null};
let downloadCounts={};try{const parsed=JSON.parse(fs.readFileSync(downloadsPath,'utf8'));if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))downloadCounts=parsed}catch{}
function saveDownloads(){try{const tmp=downloadsPath+'.tmp';fs.writeFileSync(tmp,JSON.stringify(downloadCounts));fs.renameSync(tmp,downloadsPath)}catch(e){console.warn('Download tracking is runtime-only:',e.message)}}
function downloadTotal(){return Object.values(downloadCounts).reduce((total,n)=>total+(Number(n)||0),0)}
let statsStorage={mode:process.env.GOOGLE_DOWNLOAD_STATS_FILE_ID?'google-drive':'temporary',ready:false,error:null,lastSaved:null};
let writeQueue=Promise.resolve();
async function driveStatsCall(method,url,body){
 const response=await fetch(url,{method,headers:{authorization:'Bearer '+await token(),'content-type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
 if(!response.ok)throw Error('Drive stats storage HTTP '+response.status+': '+(await response.text()).slice(0,160));
 return response.json();
}
async function restoreDriveStats(){
 titleOtp.setStorageReady(false);
 const id=process.env.GOOGLE_DOWNLOAD_STATS_FILE_ID;if(!id)return;
 try{const result=await(await drive('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id)+'?alt=media')).json();
 if(!result||typeof result.counts!=='object'||Array.isArray(result.counts))throw Error('Unexpected statistics backup format');
 titleOtp.restoreTitles(result.verifiedTitles);
 if(result.personalSync&&Array.isArray(result.personalSync.favourites)&&Array.isArray(result.personalSync.boards))personalSync=result.personalSync;
 const incoming=Object.fromEntries(Object.entries(result.counts).filter(([id,n])=>id&&Number.isSafeInteger(n)&&n>=0));
 // Never replace newer local increments with an older Drive snapshot.
 for(const [key,value] of Object.entries(incoming))downloadCounts[key]=Math.max(Number(downloadCounts[key]||0),value);
 const driveBehind=Object.entries(downloadCounts).some(([key,value])=>value>Number(incoming[key]||0));
 if(driveBehind)await persistDriveStats();
 statsStorage.ready=true;statsStorage.error=null;statsStorage.lastSaved=result.updatedAt||null;titleOtp.setStorageReady(true);saveDownloads();console.log('Restored Google Drive download counts:',Object.keys(downloadCounts).length);
 }catch(e){statsStorage.error=e.message;console.error('Google Drive statistics restore failed:',e.message)}
}
async function persistDriveStats(){
 const id=process.env.GOOGLE_DOWNLOAD_STATS_FILE_ID;if(!id)return;
 const body={version:2,updatedAt:new Date().toISOString(),counts:downloadCounts,verifiedTitles:titleOtp.exportTitles(),personalSync};
 const url='https://www.googleapis.com/upload/drive/v3/files/'+encodeURIComponent(id)+'?uploadType=media';
 const response=await fetch(url,{method:'PATCH',headers:{authorization:'Bearer '+await token(),'content-type':'application/json'},body:JSON.stringify(body)});
 if(!response.ok)throw Error('Drive backup HTTP '+response.status+': '+(await response.text()).slice(0,160));
 statsStorage.ready=true;statsStorage.error=null;statsStorage.lastSaved=body.updatedAt;
}
titleOtp.configurePersistence(async()=>{if(!process.env.GOOGLE_DOWNLOAD_STATS_FILE_ID)throw Error('Backup not configured');const operation=writeQueue.then(()=>persistDriveStats());writeQueue=operation.catch(e=>{statsStorage.ready=false;statsStorage.error=e.message;throw e});try{await writeQueue}finally{writeQueue=writeQueue.catch(()=>{})}});
function persistStatsQueued(){
 if(!process.env.GOOGLE_DOWNLOAD_STATS_FILE_ID)return;
 writeQueue=writeQueue.then(()=>persistDriveStats()).catch(e=>{statsStorage.ready=false;statsStorage.error=e.message;console.error('Could not save download counts to Drive:',e.message)});
 return writeQueue;
}

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
 const signed=encode({alg:'RS256',typ:'JWT'})+'.'+encode({iss:sa.client_email,scope:process.env.GOOGLE_DOWNLOAD_STATS_FILE_ID?'https://www.googleapis.com/auth/drive':'https://www.googleapis.com/auth/drive.readonly',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600});
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
const thumbnailFiles=new Map(),thumbnailRetry=new Map(),thumbnailFailures=new Map(),persistedThumbnailIds=new Set(),queuedThumbnailIds=new Set();
function delayFailedThumbnail(id){const attempts=Math.min(8,(thumbnailFailures.get(id)||0)+1);thumbnailFailures.set(id,attempts);const minutes=Math.min(360,5*Math.pow(2,attempts-1));thumbnailRetry.set(id,Date.now()+minutes*60000);return minutes}
const MAX_THUMBNAILS_IN_MEMORY=8,MAX_PREVIEWS_IN_MEMORY=16;
const THUMBNAIL_INPUT_LIMIT=Math.max(4,Math.min(32,Number(process.env.THUMBNAIL_INPUT_LIMIT_MB||16)))*1024*1024;
const THUMBNAIL_MEMORY_GUARD=Math.max(256,Math.min(460,Number(process.env.THUMBNAIL_MEMORY_GUARD_MB||380)))*1024*1024;
const THUMBNAIL_PAUSE_MS=Math.max(250,Math.min(5000,Number(process.env.THUMBNAIL_PAUSE_MS||750)));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function cacheThumbnail(id,value){
 if(thumbnailFiles.has(id))thumbnailFiles.delete(id);
 thumbnailFiles.set(id,value);
 while(thumbnailFiles.size>MAX_THUMBNAILS_IN_MEMORY)thumbnailFiles.delete(thumbnailFiles.keys().next().value);
 return value;
}
let thumbnailPreparationQueue=[],thumbnailPreparationRunning=false;
const thumbnailWorker={current:'',prepared:0,failed:0,startedAt:null,lastPreparedAt:null,pausedForMemory:false};
async function waitForThumbnailMemory(){
 thumbnailWorker.pausedForMemory=false;
 while(process.memoryUsage().rss>THUMBNAIL_MEMORY_GUARD){thumbnailWorker.pausedForMemory=true;await sleep(15000)}
 thumbnailWorker.pausedForMemory=false;
}
async function refreshThumbnailIndex(){
 const folder=process.env.GOOGLE_THUMBNAILS_FOLDER_ID;if(!folder)return;
 try{const files=await children(folder);persistedThumbnailIds.clear();for(const file of files){const name=String(file.name||'');if(/\.webp$/i.test(name))persistedThumbnailIds.add(name.replace(/\.webp$/i,''));}}
 catch(e){console.warn('Could not refresh saved thumbnail index:',e.message)}
}
async function drainThumbnailQueue(){
 if(thumbnailPreparationRunning)return;thumbnailPreparationRunning=true;thumbnailWorker.startedAt=thumbnailWorker.startedAt||new Date().toISOString();
 try{while(thumbnailPreparationQueue.length){await waitForThumbnailMemory();const item=thumbnailPreparationQueue.shift();thumbnailWorker.current=item.name;try{const preview=await getOrCreateThumbnail(item);if(preview.stored===false){thumbnailFiles.delete(item.id);const minutes=delayFailedThumbnail(item.id);thumbnailWorker.failed++;console.warn('Thumbnail generated but not saved; retry in '+minutes+' minutes:',item.id)}else{persistedThumbnailIds.add(item.id);thumbnailRetry.delete(item.id);thumbnailFailures.delete(item.id);thumbnailWorker.prepared++;thumbnailWorker.lastPreparedAt=new Date().toISOString();console.log('Prepared preview for design:',item.name)}}catch(e){const minutes=delayFailedThumbnail(item.id);thumbnailWorker.failed++;console.warn('Could not create Drive thumbnail; retry in '+minutes+' minutes:',item.id,e.message)}finally{thumbnailFiles.delete(item.id);queuedThumbnailIds.delete(item.id);thumbnailWorker.current=''}await sleep(THUMBNAIL_PAUSE_MS)}}
 finally{thumbnailPreparationRunning=false;thumbnailWorker.current='';thumbnailWorker.pausedForMemory=false;if(thumbnailPreparationQueue.length)void drainThumbnailQueue();}
}
function scheduleThumbnailPreparation(rows,previousIds){
 const folder=process.env.GOOGLE_THUMBNAILS_FOLDER_ID;if(!folder)return;
 const candidates=rows.filter(item=>/^image\//.test(item.mime||'')||/\.(ai|eps|pdf)$/i.test(item.name||''));
 const fresh=[],backfill=[],now=Date.now();
 for(const item of candidates){if(persistedThumbnailIds.has(item.id)||queuedThumbnailIds.has(item.id)||(thumbnailRetry.get(item.id)||0)>now)continue;queuedThumbnailIds.add(item.id);(previousIds.has(item.id)?backfill:fresh).push(item);}
 const byPopularity=(a,b)=>(Number(downloadCounts[b.id]||0)-Number(downloadCounts[a.id]||0))||a.name.localeCompare(b.name);
 fresh.sort(byPopularity);backfill.sort(byPopularity);
 thumbnailPreparationQueue=[...fresh,...thumbnailPreparationQueue,...backfill];
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
 try{if(!/^image\//.test(item.mime||'')||Number(item.size||0)>THUMBNAIL_INPUT_LIMIT)throw Error('Using the Drive preview to protect server memory');const original=await drive('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(item.id)+'?alt=media&supportsAllDrives=true');const input=Buffer.from(await original.arrayBuffer());if(input.length>THUMBNAIL_INPUT_LIMIT)throw Error('Original exceeds the safe thumbnail input limit');bytes=await sharp(input,{limitInputPixels:36000000}).rotate().resize({width:480,height:480,fit:'inside',withoutEnlargement:true}).webp({quality:74}).toBuffer();}
 catch(e){sourceError=e;const metadata=await(await drive('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(item.id)+'?fields=thumbnailLink&supportsAllDrives=true')).json();const link=item.thumbnail||metadata.thumbnailLink;if(!link)throw sourceError;const fallback=await fetch(link,{headers:{authorization:'Bearer '+await token()}});if(!fallback.ok)throw Error('Original preview failed ('+sourceError.message+'); Drive thumbnail HTTP '+fallback.status);const fallbackBytes=Buffer.from(await fallback.arrayBuffer());bytes=await sharp(fallbackBytes,{limitInputPixels:50000000}).rotate().resize({width:480,height:480,fit:'inside',withoutEnlargement:true}).webp({quality:76}).toBuffer();}
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
async function childrenWithRetry(id){let error;for(let attempt=0;attempt<3;attempt++){try{return await children(id)}catch(e){error=e;if(attempt<2)await sleep(600*Math.pow(2,attempt)+Math.floor(Math.random()*250))}}throw error}
async function sync(){
 if(syncing)return false;syncing=true;syncStartedAt=new Date().toISOString();const rows=[],failures=[],seen=new Set(),stats=Object.fromEntries(roots.map(x=>[x.name,{files:0,folders:0,errors:0}]));let count=0;
 try{
 // Every catalogue sync also refreshes download statistics from their persistent Drive backup.
 // Serialise with download writes to prevent overwriting a freshly incremented count.
 if(process.env.GOOGLE_DOWNLOAD_STATS_FILE_ID){writeQueue=writeQueue.catch(()=>{}).then(()=>restoreDriveStats());await writeQueue;}
 const queue=roots.map(root=>({id:root.id,source:root.name,path:[]}));while(queue.length){
 const batch=queue.splice(0,scanConcurrency);await Promise.all(batch.map(async task=>{if(seen.has(task.source+':'+task.id))return;seen.add(task.source+':'+task.id);
 try{const files=await childrenWithRetry(task.id);count++;stats[task.source].folders++;for(const file of files){
 if(file.mimeType==='application/vnd.google-apps.folder'){queue.push({id:file.id,source:task.source,path:[...task.path,file.name]});continue;}
 if(!(/^image\//.test(file.mimeType||'')||/\.(ai|eps|svg|pdf|psd|webp|png|jpe?g|avif|tiff?)$/i.test(file.name)))continue;
 stats[task.source].files++;rows.push({id:file.id,name:file.name,source:task.source,category:task.path[0]||'Uncategorised',folder:task.path.join(' / '),mime:file.mimeType||'',preview:/^image\//.test(file.mimeType||'')||!!file.thumbnailLink||/\.ai$/i.test(file.name),thumbnail:file.thumbnailLink||'',checksum:file.md5Checksum||'',updated:file.modifiedTime||'',size:Number(file.size||0),description:file.description||'',url:file.webViewLink||'https://drive.google.com/file/d/'+file.id+'/view'});}
 }catch(e){stats[task.source].errors++;failures.push(task.source+' / '+task.path.join('/')+': '+e.message)}}));scannedFolders=count;sourceStats=stats;}
 if(!failures.length&&catalogue.length>0&&rows.length<catalogue.length*0.65)failures.push('Sudden catalogue reduction; preserving previous complete catalogue');
 if(!failures.length&&rows.length){const previousIds=new Set(catalogue.map(x=>x.id));catalogue=rows.sort((a,b)=>b.updated.localeCompare(a.updated));syncedAt=new Date().toISOString();console.log('Drive sync complete:',rows.length,'designs across',count,'folders');
 if(process.env.GOOGLE_THUMBNAILS_FOLDER_ID){await refreshThumbnailIndex();scheduleThumbnailPreparation(rows,previousIds);}}else{if(!rows.length&&!failures.length)failures.push('Drive returned zero design files; retaining saved catalogue');console.error('Drive sync incomplete:',failures.slice(0,20).join(' | '));}
 errors=failures;scannedFolders=count;sourceStats=stats;
 }catch(e){errors=[e.message]}finally{syncing=false;}
 return !errors.length;
}
function isExplicitDuplicate(x){return !!x.confirmedDuplicate||/^_?Confirmed Duplicates\b/i.test(x.category||'')||/(^| \/ )_?Confirmed Duplicates\b/i.test(x.folder||'')}
function duplicateIds(){const hashes=new Map(),dupes=new Set();for(const x of catalogue){if(isExplicitDuplicate(x))dupes.add(x.id);if(!x.checksum)continue;const key=x.checksum+':'+x.size;if(!hashes.has(key))hashes.set(key,[]);hashes.get(key).push(x)}for(const group of hashes.values()){if(group.length<2)continue;group.sort((a,b)=>Number(isExplicitDuplicate(a))-Number(isExplicitDuplicate(b))||a.updated.localeCompare(b.updated)||a.id.localeCompare(b.id));const canonical=group.find(x=>!isExplicitDuplicate(x));for(const x of group)if(!canonical||x.id!==canonical.id)dupes.add(x.id)}return dupes}
function duplicateRelations(){const groups=new Map(),relations=new Map();for(const item of catalogue){if(!item.checksum)continue;const key=item.checksum+':'+item.size;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item)}for(const group of groups.values()){if(group.length<2)continue;group.sort((a,b)=>Number(isExplicitDuplicate(a))-Number(isExplicitDuplicate(b))||a.updated.localeCompare(b.updated)||a.id.localeCompare(b.id));const original=group.find(x=>!isExplicitDuplicate(x))||group[0];for(const item of group)if(item.id!==original.id)relations.set(item.id,{id:original.id,name:original.name,source:original.source,folder:original.folder})}return relations}
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
function publicStatus(){const memory=process.memoryUsage(),queued=queuedThumbnailIds.size,retrying=thumbnailRetry.size,total=persistedThumbnailIds.size+queued+retrying,elapsedMinutes=thumbnailWorker.startedAt?Math.max((Date.now()-Date.parse(thumbnailWorker.startedAt))/60000,1/60):0,ratePerMinute=elapsedMinutes?thumbnailWorker.prepared/elapsedMinutes:0,etaMinutes=ratePerMinute>0.05?Math.ceil(queued/ratePerMinute):null;return {duplicates:duplicateIds().size,count:catalogue.length,syncedAt,errors:errors.slice(0,15),scannedFolders,sourceStats,snapshotCount:snapshot.length,usingSnapshot:!syncedAt,complete:!!syncedAt&&!errors.length,syncing,syncStartedAt,statsStorage,connected:!!(process.env.GOOGLE_DRIVE_ACCESS_TOKEN||process.env.GOOGLE_SERVICE_ACCOUNT_JSON||process.env.GOOGLE_SERVICE_ACCOUNT_FILE),roots,interval,memory:{rssMB:Math.round(memory.rss/1048576),heapMB:Math.round(memory.heapUsed/1048576),guardMB:Math.round(THUMBNAIL_MEMORY_GUARD/1048576),limitMB:Number(process.env.RENDER_MEMORY_LIMIT_MB||512)},thumbnails:{saved:persistedThumbnailIds.size,queued,retrying,running:thumbnailPreparationRunning,progress:total?Math.round(persistedThumbnailIds.size/total*100):100,current:thumbnailWorker.current,preparedThisRun:thumbnailWorker.prepared,failedThisRun:thumbnailWorker.failed,startedAt:thumbnailWorker.startedAt,lastPreparedAt:thumbnailWorker.lastPreparedAt,pausedForMemory:thumbnailWorker.pausedForMemory,ratePerMinute:Number(ratePerMinute.toFixed(1)),etaMinutes}}}
function suggestedSubject(item){const text=[item.name,item.category,item.folder,item.description].join(' ').toLowerCase();if(/plain[ _-]?chapter/.test(text))return 'plainchapter';if(/arabic|islam|kufic|calligraphy|quran|masjid|allah|bismillah|\u0627\u0644\u0644\u0647/.test(text))return 'islamic';if(/naruto|anime|manga|one piece|dragon ball|itachi|gojo|jujutsu|pokemon/.test(text))return 'anime';if(/tiger|flower|wildlife|nature|forest|bird|mountain|botanical/.test(text))return 'nature';if(/streetwear|graffiti|urban|hip hop|skate/.test(text))return 'streetwear';if(/typography|lettering|quote|text|font|wordmark|slogan/.test(text))return 'typography';return 'uncategorised'}
function advancedMatches(x,u){const name=(u.searchParams.get('name')||'').toLowerCase().trim(),folder=(u.searchParams.get('folder')||'').toLowerCase().trim(),size=u.searchParams.get('size')||'all',days=Number(u.searchParams.get('days')||0),subject=u.searchParams.get('subject')||'all';const bytes=Number(x.size||0);return (!name||x.name.toLowerCase().includes(name))&&(!folder||x.folder.toLowerCase().includes(folder))&&(size==='all'||(size==='small'&&bytes<2097152)||(size==='medium'&&bytes>=2097152&&bytes<=10485760)||(size==='large'&&bytes>10485760))&&(!days||(days>=1&&days<=365&&Date.now()-Date.parse(x.updated||0)<=days*86400000))&&(subject==='all'||suggestedSubject(x)===subject)}
function formatMatches(item,format){if(!format||format==='All')return true;const name=String(item.name||'').toLowerCase(),mime=String(item.mime||'').toLowerCase();if(format==='image')return mime.startsWith('image/')||/\.(png|jpe?g|webp|avif|tiff?)$/.test(name);if(format==='vector')return /\.(ai|eps|svg)$/.test(name);if(format==='pdf')return mime==='application/pdf'||name.endsWith('.pdf');if(format==='psd')return name.endsWith('.psd')||mime.includes('photoshop');return true}
async function handler(req,res){
 const u=new URL(req.url,'http://localhost');
 if(await titleOtp(req,res,u,catalogue)!==false)return;
 if(u.pathname==='/healthz'){const memory=process.memoryUsage();return json(res,{status:'ok',timestamp:new Date().toISOString(),uptimeSeconds:Math.round(process.uptime()),catalogueCount:catalogue.length,memoryMB:Math.round(memory.rss/1048576),thumbnailWorker:thumbnailPreparationRunning?'running':'idle'})}
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
 if(u.pathname==='/api/status')return json(res,publicStatus());
 if(u.pathname==='/api/download-backup'){const payload={schema:'weardhk-download-counts-v1',exportedAt:new Date().toISOString(),countedDownloads:downloadTotal(),note:'Counts only downloads through WearDHK, while current Render instance data remains available.',designs:catalogue.map(x=>({id:x.id,name:x.name,source:x.source,category:x.category,downloads:Number(downloadCounts[x.id]||0)}))};const ext=u.searchParams.get('format')==='csv'?'csv':'json';let body,type;if(ext==='csv'){const esc=v=>'"'+String(v??'').replace(/"/g,'""')+'"';body=['file_id,name,source,category,downloads',...payload.designs.map(x=>[x.id,x.name,x.source,x.category,x.downloads].map(esc).join(','))].join('\n');type='text/csv; charset=utf-8'}else{body=JSON.stringify(payload,null,2);type='application/json; charset=utf-8'}res.writeHead(200,{'content-type':type,'content-disposition':'attachment; filename="weardhk-download-backup-'+new Date().toISOString().slice(0,10)+'.'+ext+'"','cache-control':'no-store','x-content-type-options':'nosniff'});return res.end(body)}
 if(u.pathname==='/api/download-stats'){const all=catalogue.map(x=>({id:x.id,name:x.name,source:x.source,category:x.category,count:Number(downloadCounts[x.id]||0)})).filter(x=>x.count>0),ranked=[...all].sort((a,b)=>b.count-a.count).slice(0,20),categoryMap=new Map();for(const item of all)categoryMap.set(item.category,(categoryMap.get(item.category)||0)+item.count);const topCategories=[...categoryMap].map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count).slice(0,8);return json(res,{total:downloadTotal(),trackedDesigns:all.length,top:ranked,topCategories,persistent:statsStorage.ready,scope:'Counts include both direct downloads and Open in Drive clicks through WearDHK. Opening Drive does not confirm a file was downloaded.'})}
 if(u.pathname.startsWith('/api/design/')){const id=decodeURIComponent(u.pathname.slice('/api/design/'.length)),item=catalogue.find(x=>x.id===id);if(!item)return json(res,{error:'Design not found'},404);return json(res,{item:{...item,downloads:Number(downloadCounts[item.id]||0),isDuplicate:duplicateIds().has(item.id),duplicateOf:duplicateRelations().get(item.id)||null}})}
 if(u.pathname==='/api/suggestions'){const normalize=value=>String(value||'').toLowerCase().replace(/[_-]+/g,' ').replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim(),q=normalize(u.searchParams.get('q')||'');if(q.length<2)return json(res,{items:[]});const items=catalogue.filter(x=>!duplicateIds().has(x.id)&&normalize(x.name+' '+x.category+' '+x.folder).includes(q)).sort((a,b)=>{const an=normalize(a.name),bn=normalize(b.name);return Number(bn.startsWith(q))-Number(an.startsWith(q))||Number(downloadCounts[b.id]||0)-Number(downloadCounts[a.id]||0)||a.name.localeCompare(b.name)}).slice(0,8).map(x=>({id:x.id,name:x.name,category:x.category,mime:x.mime,size:x.size,updated:x.updated,preview:x.preview}));return json(res,{items})}
 if(u.pathname==='/api/categories'){const duplicateSet=duplicateIds(),view=u.searchParams.get('view')||'all',map=new Map();for(const x of catalogue){if(view==='duplicates'?!duplicateSet.has(x.id):duplicateSet.has(x.id))continue;for(const [source,name] of [[x.source,x.category],...(isArabicDesign(x.name)?[['Arabic Designs','Arabic Designs']]:[])]){const key=source+'|||'+name;map.set(key,(map.get(key)||0)+1);}}return json(res,{categories:[...map].map(([k,count])=>({source:k.split('|||')[0],name:k.split('|||')[1],count})).sort((a,b)=>b.count-a.count)})}
 if(u.pathname==='/api/ai-category'){
  if(req.method!=='POST')return json(res,{error:'Use POST'},405);
  if(!process.env.GEMINI_API_KEY)return json(res,{error:'Image recognition not configured. Set GEMINI_API_KEY in Render.'},503);
  let raw='';try{for await(const chunk of req){raw+=chunk;if(raw.length>2048)return json(res,{error:'Request too large'},413)}}catch{return json(res,{error:'Invalid request'},400)}
  let data;try{data=JSON.parse(raw)}catch{return json(res,{error:'Invalid JSON'},400)}
  const expected=process.env.TITLE_EDIT_PASSWORD||'';
  if(!expected||typeof data.password!=='string'||!crypto.timingSafeEqual(crypto.createHash('sha256').update(data.password).digest(),crypto.createHash('sha256').update(expected).digest()))return json(res,{error:'Administrator password required'},403);
  const item=catalogue.find(x=>x.id===data.id);if(!item)return json(res,{error:'Design not found'},404);
  if(!/^image\/(png|jpeg|webp)$/i.test(item.mime||'')||Number(item.size)>12*1048576)return json(res,{error:'Only PNG, JPG or WEBP images up to 12 MB are supported'},422);
  if(aiClassifyRunning||Date.now()-aiLastRequest<30000)return json(res,{error:'AI classification is limited to one request every 30 seconds'},429);
  aiLastRequest=Date.now();
  aiClassifyRunning=true;
  try{
   const imageResponse=await drive('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(item.id)+'?alt=media&supportsAllDrives=true');
   const imageBuffer=Buffer.from(await imageResponse.arrayBuffer());if(imageBuffer.length>12*1048576)return json(res,{error:'Original image exceeds 12 MB limit'},413);
   const jpeg=await sharp(imageBuffer,{limitInputPixels:24000000}).resize({width:512,height:512,fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'}).jpeg({quality:72}).toBuffer();
   const model=process.env.GEMINI_IMAGE_MODEL||'gemini-2.5-flash';
   const url='https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent';
   const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
   let response;try{response=await fetch(url,{method:'POST',headers:{'x-goog-api-key':process.env.GEMINI_API_KEY,'content-type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:'Classify this design by its visual contents, not its filename. Return ONLY JSON with keys category (one of: Arabic / Islamic, Anime / Manga, Typography, Nature / Animals, Streetwear, Abstract / Geometric, Other), tags (array of at most 6 short visible-subject tags), and confidence (low, medium or high). Avoid naming people whose identities you cannot verify.'},{inline_data:{mime_type:'image/jpeg',data:jpeg.toString('base64')}}]}],generationConfig:{responseMimeType:'application/json',temperature:0.2}}),signal:controller.signal})}finally{clearTimeout(timeout)}
   if(!response.ok){let reason='';try{const failure=await response.json();reason=String(failure.error?.message||'').slice(0,170)}catch{}const label=response.status===429?'Gemini quota or rate limit exceeded':response.status===403?'Gemini API key or project permission denied':response.status===400?'Gemini request or model configuration invalid':response.status===404?'Gemini model unavailable':'Gemini provider error '+response.status;return json(res,{error:label+(reason?' — '+reason:'')},502)}
   const result=await response.json();let candidate;try{candidate=JSON.parse(result.candidates?.[0]?.content?.parts?.[0]?.text||'{}')}catch{return json(res,{error:'Invalid AI response'},502)}
   const allowed=['Arabic / Islamic','Anime / Manga','Typography','Nature / Animals','Streetwear','Abstract / Geometric','Other'];
   const category=allowed.includes(candidate.category)?candidate.category:'Other';
   return json(res,{id:item.id,category,tags:Array.isArray(candidate.tags)?candidate.tags.filter(x=>typeof x==='string').slice(0,6).map(x=>x.slice(0,40)):[],confidence:['low','medium','high'].includes(candidate.confidence)?candidate.confidence:'low',note:'AI-generated suggestion. No Google Drive files or metadata were modified.'});
  }catch(e){return json(res,{error:e.name==='AbortError'?'AI request timed out':'Classification failed'},502)}finally{aiClassifyRunning=false}
 }
 if(u.pathname==='/api/visual-candidates'){
  const samplePage=Math.max(0,Math.min(100,Number.parseInt(u.searchParams.get('page')||'0',10)||0));
  if(visualResult&&visualResult.page===samplePage&&Date.now()-visualResult.at<600000)return json(res,visualResult.data);
  if(visualScanRunning)return json(res,{error:'Visual scan in progress; retry shortly'},429);
  visualScanRunning=true;
  try{
  const candidates=catalogue.filter(x=>/^image\/(png|jpeg|webp)/i.test(x.mime||'')&&Number(x.size||0)>0&&Number(x.size)<2*1048576).slice(samplePage*12,samplePage*12+12);
  const hashes=[];
  for(const item of candidates){try{
   const source=await drive('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(item.id)+'?alt=media&supportsAllDrives=true');
   const buf=Buffer.from(await source.arrayBuffer());if(buf.length>2*1048576)continue;
   const raw=await sharp(buf,{limitInputPixels:24000000}).resize(9,8,{fit:'fill'}).greyscale().raw().toBuffer();
   let bits='';for(let y=0;y<8;y++)for(let x=0;x<8;x++)bits+=raw[y*9+x]>raw[y*9+x+1]?'1':'0';
   const record={id:item.id,name:item.name,hash:bits};hashes.push(record);visualHashIndex.set(item.id,record);if(visualHashIndex.size>1500)visualHashIndex.delete(visualHashIndex.keys().next().value);
  }catch(e){continue}}
  const groups=[];const indexed=[...visualHashIndex.values()];for(let i=0;i<hashes.length;i++)for(let j=0;j<indexed.length;j++){const a=hashes[i],b=indexed[j];if(a.id>=b.id)continue;let distance=0;for(let k=0;k<64;k++)if(a.hash[k]!==b.hash[k])distance++;if(distance<=7)groups.push({a:{id:a.id,name:a.name},b:{id:b.id,name:b.name},distance,confidence:'review-needed'});}
  const result={inspected:hashes.length,indexed:visualHashIndex.size,limit:12,page:samplePage,groups:groups.slice(0,30),disclaimer:'Perceptual-hash suggestions from a bounded sample only. Verify each match visually; no files are moved or deleted.'};visualResult={at:Date.now(),page:samplePage,data:result};return json(res,result);
  }finally{visualScanRunning=false}
 }
 if(u.pathname==='/api/personal-sync'){
  if(!process.env.GOOGLE_DOWNLOAD_STATS_FILE_ID||!statsStorage.ready)return json(res,{error:'Persistent Drive backup unavailable'},503);
  if(req.method!=='POST')return json(res,{error:'Use POST'},405);
  let raw='';try{for await(const chunk of req){raw+=chunk;if(raw.length>50000)return json(res,{error:'Payload too large'},413)}}catch{return json(res,{error:'Invalid request'},400)}
  let request;try{request=JSON.parse(raw)}catch{return json(res,{error:'Invalid JSON'},400)}
  const ip=String(req.socket.remoteAddress||'unknown');const authKey=crypto.createHash('sha256').update(ip).digest('hex');const auth=syncAuthAttempts.get(authKey)||{failures:0,until:0};
  if(auth.until>Date.now())return json(res,{error:'Too many incorrect attempts. Please retry later.'},429);
  const expected=process.env.TITLE_EDIT_PASSWORD||'',provided=String(request.password||'');
  const ha=crypto.createHash('sha256').update(expected).digest(),hb=crypto.createHash('sha256').update(provided).digest();
  if(!expected||!crypto.timingSafeEqual(ha,hb)){const failures=auth.failures+1;syncAuthAttempts.set(authKey,{failures:failures>=5?0:failures,until:failures>=5?Date.now()+900000:0});return json(res,{error:'Invalid administrator password'},403)}
  syncAuthAttempts.delete(authKey);
  if(request.action==='load')return json(res,{personalSync});
  if(request.action!=='save')return json(res,{error:'Unknown action'},400);
  const incoming=request.personalSync;
  if(!incoming||!Array.isArray(incoming.favourites)||!Array.isArray(incoming.boards)||incoming.favourites.length>10000||incoming.boards.length>100)return json(res,{error:'Invalid backup format'},400);
  const favourites=incoming.favourites.filter(x=>typeof x==='string'&&x.length<160).slice(0,10000);
  const boards=incoming.boards.filter(b=>b&&typeof b.id==='string'&&typeof b.name==='string'&&Array.isArray(b.items)).slice(0,100).map(b=>({id:b.id.slice(0,80),name:b.name.slice(0,80),items:b.items.filter(id=>typeof id==='string'&&id.length<160).slice(0,1000)}));
  const previous=personalSync;personalSync={favourites,boards,updatedAt:new Date().toISOString()};
  const job=writeQueue.then(()=>persistDriveStats());writeQueue=job.catch(()=>{});
  try{await job;return json(res,{saved:true,updatedAt:personalSync.updatedAt})}catch(e){personalSync=previous;return json(res,{error:'Drive backup write failed; preferences not saved'},503)}
 }
 if(u.pathname==='/api/duplicate-candidates'){
  const groups=new Map(),exact=duplicateIds();const compact=v=>String(v||'').toLowerCase().replace(/\.(png|jpe?g|webp|ai|eps|svg|pdf|psd)$/,'').replace(/\b(copy|final|v\d+|duplicate|new|design|artwork|\d+)\b/g,' ').replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim();
  for(const x of catalogue){if(exact.has(x.id))continue;const key=compact(x.name);if(key.length<7)continue;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(x)}
  const candidates=[];for(const [label,items] of groups){if(items.length<2)continue;const files=items.slice(0,10).map(x=>({id:x.id,name:x.name,source:x.source,size:x.size,checksum:!!x.checksum}));const distinctChecksums=new Set(items.map(x=>x.checksum).filter(Boolean));if(distinctChecksums.size>1||items.some(x=>!x.checksum))candidates.push({label,reason:'Similar filename; verify artwork visually',confidence:'review-needed',files});}
  return json(res,{count:candidates.length,groups:candidates.slice(0,100),disclaimer:'These are filename-based review candidates, not confirmed visual duplicates. No files were altered.'})
 }
 if(u.pathname==='/api/designs'){
  const q=(u.searchParams.get('q')||'').toLowerCase(),normalizeSearch=value=>String(value||'').toLowerCase().replace(/[_-]+/g,' ').replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim(),normalizedQ=normalizeSearch(q),source=u.searchParams.get('source')||'All',cat=u.searchParams.get('category')||'All',format=u.searchParams.get('format')||'All',sort=u.searchParams.get('sort')||'newest',view=u.searchParams.get('view')||'all',duplicateSet=duplicateIds(),relations=duplicateRelations(),limit=Math.max(1,Math.min(120,Number(u.searchParams.get('limit')||48))),page=Math.max(1,Number(u.searchParams.get('page')||1));
  let list=catalogue.filter(x=>(view==='top20'?true:view==='favorites'?(u.searchParams.get('ids')||'').split(',').includes(x.id):(view==='duplicates'?duplicateSet.has(x.id):!duplicateSet.has(x.id)))&&(source==='All'||(source==='Arabic Designs'?isArabicDesign(x.name):x.source===source))&&(cat==='All'||(cat==='Arabic Designs'?isArabicDesign(x.name):x.category===cat))&&formatMatches(x,format)&&advancedMatches(x,u)&&(!normalizedQ||normalizeSearch((titleOtp.titleFor(x.id)||x.name)+' '+x.source+' '+x.category+' '+x.folder+' '+x.description+(isArabicDesign(x.name)?' Arabic Designs':'')).includes(normalizedQ)));
  if(view==='top20')list=list.filter(x=>Number(downloadCounts[x.id]||0)>0).sort((a,b)=>Number(downloadCounts[b.id]||0)-Number(downloadCounts[a.id]||0)||a.name.localeCompare(b.name)).slice(0,20);
  if(sort==='popular')list.sort((a,b)=>(Number(downloadCounts[b.id]||0)-Number(downloadCounts[a.id]||0))||b.updated.localeCompare(a.updated));else if(sort==='name')list.sort((a,b)=>a.name.localeCompare(b.name));else if(sort==='oldest')list.sort((a,b)=>a.updated.localeCompare(b.updated));const total=list.length,duplicateCount=list.filter(x=>duplicateSet.has(x.id)).length;return json(res,{items:list.slice((page-1)*limit,page*limit).map(x=>({...x,name:titleOtp.titleFor(x.id)||x.name,downloads:Number(downloadCounts[x.id]||0),isDuplicate:duplicateSet.has(x.id),duplicateOf:relations.get(x.id)||null})),total,duplicateCount,uniqueCount:total-duplicateCount,page,pages:Math.ceil(total/limit)||1});
 }
 if(u.pathname==='/api/sync'&&req.method==='POST'){if(!process.env.GOOGLE_DRIVE_ACCESS_TOKEN&&!process.env.GOOGLE_SERVICE_ACCOUNT_JSON&&!process.env.GOOGLE_SERVICE_ACCOUNT_FILE)return json(res,{error:'Google Drive credentials not configured'},503);const alreadyRunning=syncing;sync().catch(console.error);return json(res,{started:!alreadyRunning,alreadyRunning},alreadyRunning?200:202)}
 if(u.pathname.startsWith('/api/open/')){const id=decodeURIComponent(u.pathname.slice('/api/open/'.length));const item=catalogue.find(x=>x.id===id);if(!item)return json(res,{error:'Not found'},404);downloadCounts[id]=Number(downloadCounts[id]||0)+1;saveDownloads();await persistStatsQueued();res.writeHead(302,{'location':item.url,'cache-control':'no-store','referrer-policy':'no-referrer'});return res.end()}
 if(u.pathname.startsWith('/api/download/')){const id=u.pathname.slice('/api/download/'.length);const item=catalogue.find(x=>x.id===id);if(!item)return json(res,{error:'Not found'},404);const upstream=await drive('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id)+'?alt=media&supportsAllDrives=true');const bytes=Buffer.from(await upstream.arrayBuffer());if(bytes.length>80*1024*1024)return json(res,{error:'File exceeds download limit; use Drive link'},413);const extension=path.extname(item.name||'').toLowerCase();const mimeByExtension={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.pdf':'application/pdf','.ai':'application/postscript','.eps':'application/postscript','.psd':'image/vnd.adobe.photoshop','.avif':'image/avif','.tif':'image/tiff','.tiff':'image/tiff'};const safe=String(item.name||('design-'+id)).replace(/[\\\"\r\n]/g,'_');const encoded=encodeURIComponent(safe);res.writeHead(200,{'content-type':mimeByExtension[extension]||item.mime||'application/octet-stream','content-disposition':'attachment; filename="'+safe.replace(/[^\x20-\x7e]/g,'_')+'"; filename*=UTF-8\x27\x27'+encoded,'content-length':bytes.length,'cache-control':'no-store','x-content-type-options':'nosniff'});downloadCounts[id]=Number(downloadCounts[id]||0)+1;saveDownloads();await persistStatsQueued();return res.end(bytes);}
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
 }catch(e){console.error(e);return json(res,{error:e.message},500)}
}
http.createServer((req,res)=>handler(req,res).catch(console.error)).listen(port,()=>{console.log('WearDHK Design Hub on port '+port+'; saved catalogue: '+catalogue.length+' designs');if(process.env.GOOGLE_SERVICE_ACCOUNT_JSON||process.env.GOOGLE_SERVICE_ACCOUNT_FILE||process.env.GOOGLE_DRIVE_ACCESS_TOKEN)restoreDriveStats().then(()=>sync()).catch(console.error)});
setInterval(()=>sync().catch(console.error),interval*60000).unref();

