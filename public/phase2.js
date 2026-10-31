'use strict';
/* WearDHK progressive gallery enhancements; no Drive writes or bulk downloads. */
(() => {
 const $=id=>document.getElementById(id);
 const gallery=$('gallery'), toolbar=document.querySelector('.toolbar'), actions=document.querySelector('.head-actions');
 if(!gallery||!toolbar||!actions)return;
 const selectedIds=new Set();
 let selecting=false, previewFilter='all', recentMode=false, decorating=false;
 const toolMenu=document.createElement('details');toolMenu.className='wd-tools-menu';
 toolMenu.innerHTML='<summary class="secondary">⚙ Tools</summary><div class="wd-tools-list"></div>';
 const list=toolMenu.querySelector('.wd-tools-list');
 for(const id of ['analyticsButton','backupDownloads','duplicates','healthButton']){
   const el=$(id);if(el)list.append(el);
 }
 actions.append(toolMenu);
 document.addEventListener('click',e=>{if(!toolMenu.contains(e.target))toolMenu.open=false});
 const quick=document.createElement('div');quick.className='wd-quick-actions';
 quick.innerHTML='<label class="wd-inline-label">Preview <select id="wd-preview-filter"><option value="all">All statuses</option><option value="ready">Ready</option><option value="processing">Processing</option><option value="failed">Failed</option></select></label><button type="button" id="wd-newest" class="secondary" aria-pressed="false">✦ Recently added</button><button type="button" id="wd-select" class="secondary" aria-pressed="false">☑ Select designs</button>';
 toolbar.after(quick);
 const bar=document.createElement('div');bar.className='wd-selection-bar';bar.hidden=true;
 bar.innerHTML='<strong id="wd-selection-count">0 selected</strong><button class="secondary" type="button" id="wd-board-add">＋ Add to board</button><button class="secondary" type="button" id="wd-copy-links">⧉ Copy links</button><button class="secondary" type="button" id="wd-export-list">↓ Export list</button><button class="secondary" type="button" id="wd-selection-clear">Clear</button>';
 quick.after(bar);
 const statusEl=document.createElement('span');statusEl.className='wd-status-summary';statusEl.setAttribute('aria-live','polite');quick.append(statusEl);
 const updateSelection=()=>{
  bar.hidden=!selecting; $('wd-select').setAttribute('aria-pressed',String(selecting));
  $('wd-select').classList.toggle('wd-enabled',selecting);
  $('wd-selection-count').textContent=selectedIds.size+' selected';
  gallery.querySelectorAll('.tile').forEach(tile=>{
   const check=tile.querySelector('.wd-select-check');if(check)check.checked=selectedIds.has(check.dataset.id);
  });
 };
 const getItems=()=>typeof state!=='undefined'&&Array.isArray(state.items)?state.items:[];
 function classify(tile){
  if(tile.querySelector('.preview-error'))return 'failed';
  if(tile.querySelector('img')?.complete&&tile.querySelector('img')?.naturalWidth>0)return 'ready';
  if(tile.querySelector('img'))return 'processing';
  return 'failed';
 }
 function applyFilter(){
  let ready=0,processing=0,failed=0;
  gallery.querySelectorAll('.tile').forEach(tile=>{
   const cls=classify(tile);
   if(cls==='ready')ready++;else if(cls==='processing')processing++;else failed++;
   tile.hidden=previewFilter!=='all'&&cls!==previewFilter;
   tile.dataset.previewStatus=cls;
  });
  statusEl.textContent='On this page: '+ready+' ready · '+processing+' processing · '+failed+' failed';
 }
 function decorate(){
  if(decorating)return;decorating=true;
  const items=getItems();const tiles=[...gallery.querySelectorAll('.tile')];
  tiles.forEach((tile,i)=>{
   const x=items[i];if(!x)return;
   let check=tile.querySelector('.wd-select-check');
   if(!check){check=document.createElement('input');check.type='checkbox';check.className='wd-select-check';check.setAttribute('aria-label','Select '+String(x.name||'design'));tile.prepend(check);}
   check.dataset.id=x.id;check.checked=selectedIds.has(x.id);check.hidden=!selecting;
   check.onclick=e=>e.stopPropagation();
   check.onchange=()=>{check.checked?selectedIds.add(x.id):selectedIds.delete(x.id);updateSelection()};
   const img=tile.querySelector('.image-wrap img');
   if(img&&!img.dataset.wdStatusWired){
    img.dataset.wdStatusWired='1';
    img.addEventListener('load',()=>requestAnimationFrame(applyFilter));
    img.addEventListener('error',()=>setTimeout(applyFilter,20));
   }
  });
  applyFilter();decorating=false;
 }
 const observer=new MutationObserver(records=>{
  if(records.some(r=>r.type==='childList'&&(
   r.target===gallery||r.target.classList?.contains('image-wrap')||
   [...r.addedNodes].some(n=>n.nodeType===1&&(n.classList?.contains('tile')||n.classList?.contains('preview-error')))
  )))requestAnimationFrame(decorate);
 });
 observer.observe(gallery,{childList:true,subtree:true});decorate();
 $('wd-preview-filter').onchange=e=>{previewFilter=e.target.value;applyFilter()};
 $('wd-select').onclick=()=>{selecting=!selecting;if(!selecting)selectedIds.clear();gallery.querySelectorAll('.wd-select-check').forEach(c=>c.hidden=!selecting);updateSelection()};
 $('wd-selection-clear').onclick=()=>{selectedIds.clear();updateSelection()};
 $('wd-newest').onclick=()=>{
   recentMode=!recentMode;
   $('wd-newest').setAttribute('aria-pressed',String(recentMode));
   $('wd-newest').classList.toggle('wd-enabled',recentMode);
   if(recentMode){
    $('sort').value='newest';$('sort').dispatchEvent(new Event('change'));
    document.querySelector('.explore')?.scrollIntoView({behavior:'smooth',block:'start'});
    if(typeof toast==='function')toast('Newest updated designs first');
   } else if(typeof toast==='function')toast('Newest-first sorting remains active');
 };
 const ids=()=>[...selectedIds];
 const links=()=>ids().map(id=>location.origin+'/?design='+encodeURIComponent(id));
 $('wd-copy-links').onclick=async()=>{
  if(!ids().length)return typeof toast==='function'&&toast('Select designs first');
  const value=links().join('\n');
  try{await navigator.clipboard.writeText(value);toast('Copied '+ids().length+' design links')}
  catch{window.prompt('Copy links',value)}
 };
 $('wd-export-list').onclick=()=>{
  if(!ids().length)return typeof toast==='function'&&toast('Select designs first');
  const rows=[['ID','Title','WearDHK URL']];
  ids().forEach(id=>{const x=getItems().find(v=>v.id===id);rows.push([id,x?.name||'',location.origin+'/?design='+encodeURIComponent(id)])});
  const csv=rows.map(row=>row.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download='weardhk-selection.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);
 };
 $('wd-board-add').onclick=()=>{
  if(!ids().length)return toast('Select designs first');
  if(typeof boards==='undefined'||typeof saveBoards!=='function')return toast('Boards are unavailable');
  if(!boards.length){$('boardsButton')?.click();toast('Create a board first');return}
  const names=boards.map((b,i)=>i+1+'. '+b.name).join('\n');
  const input=window.prompt('Add selected designs to which board? Enter its number:\n'+names,'1');
  if(input===null)return;
  const idx=Number(input)-1;
  if(!Number.isInteger(idx)||!boards[idx])return toast('Choose a valid board number');
  boards[idx].items=[...new Set([...boards[idx].items,...ids()])];
  saveBoards();toast('Added '+ids().length+' designs to '+boards[idx].name);
 };
 document.addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){
   e.preventDefault();$('query')?.focus();$('query')?.select();
  }
 });
})();
