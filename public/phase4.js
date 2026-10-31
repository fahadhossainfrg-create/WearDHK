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
  $('wd-edit-title').value=record.title||'';
  $('wd-edit-category').value=record.category||'';
  $('wd-edit-tags').value=record.tags||'';
  $('wd-duplicate-decision').value=record.decision||'';
 }
 document.addEventListener('click',()=>setTimeout(populate,70),true);
 $('preview')?.addEventListener('close',()=>{currentId=null});
 $('wd-save-review').onclick=()=>{
  if(!currentId)return;
  data[currentId]={title:$('wd-edit-title').value.trim(),category:$('wd-edit-category').value.trim(),tags:$('wd-edit-tags').value.trim(),decision:$('wd-duplicate-decision').value};
  persist();toastSafe('Local review saved without changing Drive');
 };
 $('wd-reset-review').onclick=()=>{if(!currentId)return;delete data[currentId];persist();currentId=null;populate();toastSafe('Local overrides cleared')};
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
   if(parsed.review&&typeof parsed.review==='object'&&!Array.isArray(parsed.review))localStorage.setItem(key,JSON.stringify(parsed.review));
   alert('Imported. Refresh the page to load your boards and favourites.');
  }catch(err){alert('Could not import backup: '+err.message)}finally{e.target.value=''}
 };
})();
