'use strict';
(()=>{
 const q=document.getElementById('query'),shell=document.querySelector('.search-shell');
 if(!q||!shell)return;
 let b=document.getElementById('wd-search-submit');
 if(!b){b=document.createElement('button');b.type='button';b.id='wd-search-submit';b.className='primary';b.textContent='Search';b.setAttribute('aria-label','Search designs');shell.append(b)}
 function submit(){
  if(typeof state==='undefined'||typeof refresh!=='function')return;
  if(typeof timer!=='undefined')clearTimeout(timer);
  const term=q.value.trim();
  state.q=term;state.source='All';state.category='All';state.format='All';state.favOnly=false;
  state.recentOnly=false;state.duplicatesOnly=false;state.top20Only=false;state.boardId=null;state.page=1;
  const category=document.getElementById('category'),format=document.getElementById('format');
  if(category)category.value='All';if(format)format.value='All';
  const suggestions=document.getElementById('searchSuggestions');if(suggestions)suggestions.hidden=true;
  const info=document.getElementById('wd-search-feedback');if(info)info.textContent=term?'Searching for “'+term+'”…':'Showing all designs';
  refresh();q.blur();
 }
 b.addEventListener('click',submit);
 q.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();submit()}});
 const feedback=document.createElement('p');feedback.id='wd-search-feedback';feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');feedback.className='wd-search-feedback';shell.after(feedback);
})();