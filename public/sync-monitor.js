'use strict';
/* Sync observability: compares only successfully completed catalogue snapshots.
   Never treats temporary Drive errors as deleted designs. */
(()=>{
 const $=id=>document.getElementById(id);
 const key='weardhk-sync-history-v1';
 let history=[];try{history=JSON.parse(localStorage.getItem(key)||'[]');if(!Array.isArray(history))history=[]}catch{}
 const panel=document.createElement('section');panel.className='wd-sync-history';
 panel.innerHTML='<h3>Catalogue change monitor</h3><p id="wd-sync-summary">Checking last completed catalogue scan…</p><div id="wd-sync-events"></div><button type="button" class="secondary" id="wd-export-sync">↓ Export change history</button><small>Comparison history is saved in this browser. Incomplete or failed scans never mark artwork as removed.</small>';
 const target=$('healthErrors');target?.parentElement?.after(panel);
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 let running=false;
 async function collect(){
  if(running||document.hidden)return;running=true;
  try{
   const response=await fetch('/api/status',{cache:'no-store'});if(!response.ok)throw Error('Status unavailable');
   const status=await response.json();
   if(!status.complete||status.syncing||!status.syncedAt||status.errors?.length){
    $('wd-sync-summary').textContent='Scan incomplete or in progress. Previous catalogue snapshot preserved.';return
   }
   const last=history[history.length-1];
   if(last?.syncedAt===status.syncedAt){render();return}
   if(status.count>15000){$('wd-sync-summary').textContent='Catalogue too large for browser comparison; complete scan: '+status.count+' designs.';return}\n   const ids=[];
   for(let page=1;page<=Math.ceil(status.count/120);page++){
    const q=new URLSearchParams({source:'All',category:'All',format:'All',sort:'newest',view:'all',page:String(page),limit:'120'});
    const r=await fetch('/api/designs?'+q,{cache:'no-store'});if(!r.ok)throw Error('Catalogue page unavailable');
    const body=await r.json();ids.push(...body.items.map(x=>x.id));
    if(page%10===0)await sleep(25);
   }
   // Include exact duplicates from a separate view so IDs represent the complete library.
   for(let page=1;page<=Math.ceil(Number(status.duplicates||0)/120);page++){
    const q=new URLSearchParams({source:'All',category:'All',format:'All',sort:'newest',view:'duplicates',page:String(page),limit:'120'});
    const r=await fetch('/api/designs?'+q,{cache:'no-store'});if(!r.ok)throw Error('Duplicate page unavailable');
    const body=await r.json();ids.push(...body.items.map(x=>x.id));
   }
   const unique=[...new Set(ids)];
   if(unique.length!==status.count)throw Error('Catalogue changed during scan; comparison postponed');
   const previous=last?.ids?new Set(last.ids):null,current=new Set(unique);
   const added=previous?unique.filter(id=>!previous.has(id)):[];
   const missing=previous?last.ids.filter(id=>!current.has(id)):[];
   history.push({syncedAt:status.syncedAt,recordedAt:new Date().toISOString(),count:unique.length,added,missing,ids:unique});
   history=history.slice(-3);
   try{localStorage.setItem(key,JSON.stringify(history))}catch{history=history.slice(-1)}
   render();
  }catch(e){$('wd-sync-summary').textContent='Change comparison unavailable: '+e.message}
  finally{running=false}
 }
 function render(){
  const last=history[history.length-1];if(!last)return;
  $('wd-sync-summary').textContent='Last complete scan: '+new Date(last.syncedAt).toLocaleString()+' · '+last.count+' designs · '+last.added.length+' added · '+last.missing.length+' missing since previous scan';
  const host=$('wd-sync-events');host.replaceChildren();
  for(const entry of history.slice(-5).reverse()){
   const row=document.createElement('p');row.textContent=new Date(entry.syncedAt).toLocaleString()+': '+entry.count+' indexed, +'+entry.added.length+' / −'+entry.missing.length;
   host.append(row)
  }
 }
 $('wd-export-sync').onclick=()=>{
  const blob=new Blob([JSON.stringify({version:1,history},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='weardhk-sync-history.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),2000)
 };
 render();setTimeout(collect,5000);setInterval(collect,5*60*1000);
 $('healthButton')?.addEventListener('click',()=>setTimeout(collect,200));
})();
