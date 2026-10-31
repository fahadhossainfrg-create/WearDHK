'use strict';
(()=>{const $=id=>document.getElementById(id);const toolbar=document.querySelector('.toolbar');if(!toolbar)return;
const box=document.createElement('section');box.className='wd-extras';box.innerHTML='<button type="button" class="secondary" id="wd-theme-toggle" aria-label="Switch colour theme">◐ Dark mode</button><details class="wd-advanced"><summary>⌕ Advanced search & filters</summary><div class="wd-advanced-fields"><label>Filename contains<input id="wd-filename" placeholder="e.g. Plain Chapter"></label><label>Folder contains<input id="wd-folder" placeholder="e.g. Arabic"></label><label>File size<select id="wd-size"><option value="all">All sizes</option><option value="small">Under 2 MB</option><option value="medium">2–10 MB</option><option value="large">Over 10 MB</option></select></label><label>Modified<select id="wd-age"><option value="all">Any date</option><option value="7">Past 7 days</option><option value="30">Past 30 days</option><option value="90">Past 90 days</option></select></label><label>Suggested subject<select id="wd-subject"><option value="all">All subjects</option><option value="typography">Typography</option><option value="anime">Anime</option><option value="islamic">Arabic / Islamic</option><option value="nature">Nature / animals</option><option value="streetwear">Streetwear</option><option value="plainchapter">PLAIN CHAPTER</option></select></label><button class="secondary" id="wd-filter-reset" type="button">Clear advanced filters</button></div><p>Subject tags are suggested from file and folder names, not image-recognition AI. Exact duplicates are detected by file checksums.</p></details>';
toolbar.after(box);
let mode=localStorage.getItem('weardhk-theme')||'light';
const setMode=v=>{mode=v;document.documentElement.dataset.theme=mode;localStorage.setItem('weardhk-theme',mode);$('wd-theme-toggle').textContent=mode==='dark'?'☀ Light mode':'◐ Dark mode'};
setMode(mode);$('wd-theme-toggle').onclick=()=>setMode(mode==='dark'?'light':'dark');
const fields=['wd-filename','wd-folder','wd-size','wd-age','wd-subject'];
function current(){return {name:$('wd-filename').value.trim(),folder:$('wd-folder').value.trim(),size:$('wd-size').value,days:$('wd-age').value,subject:$('wd-subject').value}}
window.weardhkAdvancedFilters=current;
for(const id of fields){$(id).addEventListener('input',()=>{if(typeof state!=='undefined'){state.page=1;refresh()}})}
$('wd-filter-reset').onclick=()=>{for(const id of fields)$(id).value=id==='wd-filename'||id==='wd-folder'?'':'all';if(typeof state!=='undefined'){state.page=1;refresh()}};
})();
