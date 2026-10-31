'use strict';
/* Phase 3: portable read-only boards, local sync alerts and related artwork.
   No server-side storage, credentials, bulk image processing or Drive writes. */
(()=>{
 const $=id=>document.getElementById(id);
 const show=m=>{if(typeof toast==='function')toast(m);else console.info(m)};
 const shareParams=new URLSearchParams(location.search);
 const shared=shareParams.get('board');
 const b64url=s=>btoa(unescape(encodeURIComponent(s))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 const unb64=s=>decodeURIComponent(escape(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4))));
 function linksForBoard(b){
  if(!b||!Array.isArray(b.items)||!b.items.length)return null;
  // Encode only identifiers; no access tokens or secrets.
  const payload={v:1,n:String(b.name).slice(0,40),i:[...new Set(b.items.map(String))].slice(0,120)};
  const url=new URL(location.origin+location.pathname);url.searchParams.set('board',b64url(JSON.stringify(payload)));
  if(url.href.length>7500)return null;
  return url.href;
 }
 const shareButton=document.createElement('button');shareButton.type='button';shareButton.className='secondary';shareButton.textContent='↗ Share current board';
 shareButton.title='Create a read-only URL containing the board title and design IDs';
 $('boardForm')?.after(shareButton);
 shareButton.onclick=async()=>{
  if(typeof activeBoard!=='function'||!activeBoard()){show('Open a saved board first');return}
  const url=linksForBoard(activeBoard());if(!url){show('Board is too large for a single link. Export selections instead.');return}
  try{await navigator.clipboard.writeText(url);show('Read-only board link copied')}catch{window.prompt('Copy board link:',url)}
 };
 if(shared){
  try{
   if(shared.length>10000)throw Error('Link too long');
   const v=JSON.parse(unb64(shared));
   if(v?.v!==1||!Array.isArray(v.i)||v.i.length>120||!v.i.every(i=>typeof i==='string'&&/^[A-Za-z0-9_-]{3,150}$/.test(i)))throw Error('Invalid design identifiers');
   const box=document.createElement('div');box.className='wd-shared-banner';
   const title=document.createElement('strong');title.textContent='Shared board: '+String(v.n||'Untitled').slice(0,40);
   const detail=document.createElement('span');detail.textContent=' · '+v.i.length+' linked designs · Read-only';
   const button=document.createElement('button');button.className='secondary';button.textContent='View shared designs';
   button.onclick=async()=>{
    if(typeof state==='undefined')return;
    const ids=v.i;
    try{
     const rows=[];
     for(let n=0;n<ids.length;n+=40){
      const q=new URLSearchParams({source:'All',view:'favorites',ids:ids.slice(n,n+40).join(','),limit:'48',page:'1'});
      const response=await fetch('/api/designs?'+q,{cache:'no-store'});
      if(!response.ok)throw Error('Catalogue unavailable');
      const data=await response.json();rows.push(...(data.items||[]));
     }
     const map=new Map(rows.map(x=>[x.id,x]));
     state.items=ids.map(id=>map.get(id)).filter(Boolean);
     state.total=state.items.length;state.pages=1;state.boardId=null;
     if(typeof render==='function')render();
     $('galleryTitle').textContent=String(v.n||'Shared Board').slice(0,40);
     $('count').textContent=state.items.length+' shared designs';
     $('gallery')?.scrollIntoView({block:'start',behavior:'smooth'});
    }catch(e){show('Unable to open shared designs: '+e.message)}
   };
   box.append(title,detail,button);document.querySelector('.explore')?.prepend(box);
  }catch{show('This shared board link is invalid')}
 }
 // Local warnings, surfaced only while browsing; no claims of email or push delivery.
 const alertBox=document.createElement('div');alertBox.className='wd-alert-box';alertBox.hidden=true;alertBox.setAttribute('role','status');
 $('healthDialog')?.querySelector('.health-head')?.after(alertBox);
 let lastGood=0,lastWarning='';
 async function check(){
  if(document.hidden)return;
  try{
   const res=await fetch('/api/status',{cache:'no-store',signal:AbortSignal.timeout(12000)});
   if(!res.ok)throw Error('HTTP '+res.status);
   const x=await res.json();const failures=[];
   if(!x.connected)failures.push('Drive credentials disconnected');
   if(Array.isArray(x.errors)&&x.errors.length)failures.push('Sync reported '+x.errors.length+' error(s)');
   if(x.thumbnails?.pausedForMemory)failures.push('Thumbnail processing paused for memory');
   if(x.complete&&x.syncedAt&&Date.now()-Date.parse(x.syncedAt)>45*60000)failures.push('Last completed sync is over 45 minutes old');
   if(failures.length){const msg=failures.join(' · ');if(msg!==lastWarning){show('System warning: '+failures[0]);lastWarning=msg}if(alertBox){alertBox.hidden=false;alertBox.textContent=msg}}
   else{lastGood=Date.now();lastWarning='';if(alertBox)alertBox.hidden=true}
  }catch{if(lastGood&&Date.now()-lastGood>120000){lastWarning='Status endpoint unavailable';if(alertBox){alertBox.hidden=false;alertBox.textContent=lastWarning}}}
 }
 setTimeout(check,3500);setInterval(check,90000);
 // Related designs: current page only, zero server cost.
 const related=document.createElement('div');related.className='wd-related';related.hidden=true;
 $('modalMetadata')?.after(related);
 let lastSeen='';
 function updateRelated(){
  if(typeof state==='undefined'||!state.selected||!$('preview')?.open){related.hidden=true;return}
  const x=state.selected;if(lastSeen===x.id)return;lastSeen=x.id;
  const candidates=(state.items||[]).filter(y=>y.id!==x.id).map(y=>{
   const terms=s=>new Set(String(s||'').toLowerCase().split(/[^a-z0-9]+/).filter(w=>w.length>3));
   const keys=terms(x.name);let score=0;
   for(const t of terms(y.name))if(keys.has(t))score+=3;
   if(y.category&&x.category===y.category)score+=4;
   if(y.source&&x.source===y.source)score++;
   return {y,score};
  }).filter(v=>v.score>0).sort((a,b)=>b.score-a.score).slice(0,4);
  related.replaceChildren();related.hidden=!candidates.length;
  if(!candidates.length)return;
  const heading=document.createElement('strong');heading.textContent='Related designs (current page)';related.append(heading);
  for(const {y} of candidates){const b=document.createElement('button');b.className='secondary';b.textContent=String(y.name||'Design').slice(0,45);b.onclick=()=>{lastSeen='';if(typeof detail==='function')detail(y)};related.append(b)}
 }
 $('preview')?.addEventListener('close',()=>{lastSeen='';related.hidden=true});
 document.addEventListener('click',()=>setTimeout(updateRelated,60),{capture:true});
})();
