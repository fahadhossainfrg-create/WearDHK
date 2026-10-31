'use strict';
/* Local review and metadata overrides. These never modify originals in Drive. */
(()=>{
 const $=id=>document.getElementById(id);const key='weardhk-review-v1';
 function read(){try{return JSON.parse(localStorage.getItem(key)||'{}')}catch{return {}}}
 const data=read();
 function persist(){try{localStorage.setItem(key,JSON.stringify(data))}catch(e){alert('Local storage unavailable: '+e.message)}}
 function toastSafe(s){if(typeof toast==='function')toast(s)}
 const panel=document.createElement('section');panel.className='wd-review-panel';panel.innerHTML='<strong>Design review · browser only</strong><label>Title override <input id="wd-edit-title" maxlength="120" placeholder="Keep original filename unchanged"></label><label>Category override <input id="wd-edit-category" maxlength="60"></label><label>Tags <input id="wd-edit-tags" maxlength="150" placeholder="Comma-separated"></label><label>Duplicate decision <select id="wd-duplicate-decision"><option value="">Unreviewed</option><option value="keep">Keep</option><option value="ignore">Ignore</option><option value="archive">Archive from my review list</option></select></label><div><button id="wd-save-review" class="secondary" type="button">Save metadata</button><button id="wd-reset-review" class="secondary" type="button">Clear overrides</button></div><small>These choices stay in this browser. Archive does not move or delete a Drive file.</small>';
 $('modalMetadata')?.after(panel);
 let currentId=null;
 function populate(){
  const id=typeof state==='undefined'?null:state.selected?.id;
  if(!id||!$('preview')?.open)return;
  if(id===currentId)return;currentId=id;
  const record=data[id]||{};
  $('wd-edit-title').value=verifiedTitles[id]||'';
  $('wd-edit-category').value=record.category||'';
  $('wd-edit-tags').value=record.tags||'';
  $('wd-duplicate-decision').value=record.decision||'';
 }
 document.addEventListener('click',()=>setTimeout(populate,70),true);
 $('preview')?.addEventListener('close',()=>{currentId=null});
 const otpPanel=document.createElement('div');otpPanel.className='wd-otp-panel';otpPanel.innerHTML='<p>Changing a design title requires a six-digit email code. The administrator receives the code; titles stay unchanged until confirmed.</p><button class="secondary" type="button" id="wd-send-title-otp">✉ Send verification code</button><input id="wd-title-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="6-digit email code" aria-label="Verification code"><button class="primary" type="button" id="wd-confirm-title">Confirm title change</button><p id="wd-title-feedback" role="status"></p>';
 panel.append(otpPanel);
 let verifiedTitles={};
 fetch('/api/verified-titles',{cache:'no-store'}).then(r=>r.json()).then(v=>{verifiedTitles=v.titles||{};if(currentId){currentId=null;populate()}}).catch(()=>{});
 async function titleRequest(endpoint,code){
  if(!currentId)throw Error('Select a design first');
  const title=$('wd-edit-title').value.trim();
  if(title.length<2)throw Error('Enter a title with at least two characters');
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:currentId,title,code})});
  const data=await response.json();if(!response.ok)throw Error(data.error||'Verification unavailable');return data
 }
 $('wd-send-title-otp').onclick=async()=>{const feedback=$('wd-title-feedback');feedback.textContent='Sending…';try{await titleRequest('/api/title-otp/request');feedback.textContent='Code sent to administrator email. It expires in 10 minutes.'}catch(e){feedback.textContent=e.message}};
 $('wd-confirm-title').onclick=async()=>{const feedback=$('wd-title-feedback');try{const id=currentId;const result=await titleRequest('/api/title-otp/confirm',$('wd-title-code').value);verifiedTitles[id]=result.title;feedback.textContent='Title verified and saved on server.';$('modalTitle').textContent=result.title;toastSafe('Email verified: title saved')}catch(e){feedback.textContent=e.message}};
 $('wd-save-review').textContent='Save other metadata (not title)';
 $('wd-save-review').onclick=()=>{
  if(!currentId)return;
  data[currentId]={category:$('wd-edit-category').value.trim(),tags:$('wd-edit-tags').value.trim(),decision:$('wd-duplicate-decision').value};
  persist();toastSafe('Other metadata saved locally. Title requires email OTP.');
 };
 $('wd-reset-review').onclick=()=>{if(!currentId)return;delete data[currentId];persist();currentId=null;populate();toastSafe('Local metadata cleared; verified title unchanged')};
 // Portable backup: supports transferring favourites and boards between devices without an account.
 const backup=document.createElement('div');backup.className='wd-personal-backup';
 backup.innerHTML='<button class="secondary" type="button" id="wd-export-personal">↓ Export personal data</button><label class="secondary" for="wd-import-personal">↑ Import personal data</label><input type="file" id="wd-import-personal" accept=".json,application/json" hidden>';
 $('boardsList')?.after(backup);
 $('wd-export-personal').onclick=()=>{
  const out={schema:'weardhk-personal-v1',exportedAt:new Date().toISOString(),favourites:[...(typeof favs!=='undefined'?favs:[])],boards:typeof boards!=='undefined'?boards:[],review:data};
  const url=URL.createObjectURL(new Blob([JSON.stringify(out,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='weardhk-personal-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);
 };
 $('wd-import-personal').onchange=async e=>{
  const file=e.target.files?.[0];if(!file||file.size>2000000)return alert('Choose a personal backup under 2 MB');
  try{
   const parsed=JSON.parse(await file.text());
   if(parsed.schema!=='weardhk-personal-v1'||!Array.isArray(parsed.favourites)||!Array.isArray(parsed.boards)||parsed.boards.length>500||parsed.favourites.length>20000)throw Error('Unexpected backup format');
   if(!confirm('Replace local boards, favourites and metadata with this backup?'))return;
   const safeIds=parsed.favourites.filter(v=>typeof v==='string'&&v.length<200);
   localStorage.setItem('weardhk-favourites',JSON.stringify(safeIds));
   const safeBoards=parsed.boards.filter(v=>v&&typeof v.id==='string'&&typeof v.name==='string'&&v.name.length<100&&Array.isArray(v.items)).map(b=>({id:b.id.slice(0,150),name:b.name.slice(0,40),items:b.items.filter(x=>typeof x==='string').slice(0,2000)}));
   localStorage.setItem('weardhk-boards',JSON.stringify(safeBoards));
   if(parsed.review&&typeof parsed.review==='object'&&!Array.isArray(parsed.review))localStorage.setItem(key,JSON.stringify(Object.fromEntries(Object.entries(parsed.review).map(([id,v])=>[id,{category:v?.category||'',tags:v?.tags||'',decision:v?.decision||''}]))));
   alert('Imported. Refresh the page to load your boards and favourites.');
  }catch(err){alert('Could not import backup: '+err.message)}finally{e.target.value=''}
 };
})();
