'use strict';
/* WearDHK gallery tools — lightweight, progressive and safe for 512MB instances. */
(()=>{
 const $=id=>document.getElementById(id), preview=$('preview'), modal=$('modalImage');
 if(!preview||!modal)return;
 let scale=1, background='checker', itemId=null;
 const tools=document.createElement('div');tools.className='wd-viewer-tools';
 tools.innerHTML='<strong>Artwork viewer</strong><div class="wd-viewer-controls"><button type="button" class="secondary" id="wd-fullscreen" aria-label="Expand artwork">⛶ Expand</button><button type="button" class="secondary" id="wd-zoomout" aria-label="Zoom out">−</button><span id="wd-zoomvalue">100%</span><button type="button" class="secondary" id="wd-zoomin" aria-label="Zoom in">＋</button><button type="button" class="secondary" id="wd-zoomreset">Reset</button><select id="wd-background" aria-label="Artwork background"><option value="checker">Checkerboard</option><option value="white">White</option><option value="black">Black</option><option value="grey">Grey</option></select></div>';
 modal.after(tools);
 const setScale=(n)=>{scale=Math.min(4,Math.max(1,n));$('wd-zoomvalue').textContent=Math.round(scale*100)+'%';const img=modal.querySelector('img');if(img){img.style.transform='scale('+scale+')';img.style.transformOrigin='center';img.style.transition='transform .14s ease'}};
 function setBackground(v){background=v;modal.dataset.artBackground=v;}
 $('wd-zoomin').onclick=()=>setScale(scale+.25);
 $('wd-zoomout').onclick=()=>setScale(scale-.25);
 $('wd-zoomreset').onclick=()=>setScale(1);
 $('wd-background').onchange=e=>setBackground(e.target.value);
 $('wd-fullscreen').onclick=()=>{
  preview.classList.toggle('wd-expanded');
  $('wd-fullscreen').textContent=preview.classList.contains('wd-expanded')?'⤢ Normal size':'⛶ Expand';
 };
 preview.addEventListener('close',()=>{preview.classList.remove('wd-expanded');setScale(1)});
 const observe=new MutationObserver(()=>{
  if(typeof state==='undefined')return;
  const id=state.selected?.id;
  if(id!==itemId){itemId=id;setScale(1);}
 });
 observe.observe(modal,{subtree:true,childList:true});
 setBackground(background);
 // Lightweight accessible design quality indicators; only reports what catalogue really provides.
 const fileInfo=document.createElement('div');fileInfo.className='wd-file-info';fileInfo.setAttribute('aria-live','polite');
 tools.after(fileInfo);
 const fillInfo=()=>{
  const x=typeof state!=='undefined'?state.selected:null;
  if(!x||!preview.open){fileInfo.replaceChildren();return}
  const pieces=[];
  if(x.mime)pieces.push('Type: '+x.mime.replace(/^image\//,''));
  if(Number.isFinite(Number(x.size))&&Number(x.size)>0)pieces.push('Size: '+(Number(x.size)/1048576).toFixed(1)+' MB');
  if(x.width&&x.height)pieces.push('Dimensions: '+x.width+' × '+x.height);
  pieces.push('Print readiness: verify original artwork dimensions before printing');
  fileInfo.replaceChildren();
  for(const value of pieces){const span=document.createElement('span');span.textContent=value;fileInfo.append(span)}
 };
 preview.addEventListener('click',()=>setTimeout(fillInfo,25),true);
 document.addEventListener('click',()=>{if(preview.open)setTimeout(fillInfo,30)},true);
 // Move admin tools away from the image, with an explicit disclosure. Never remove controls.
 const editor=document.querySelector('.wd-review-panel');
 if(editor){
  const details=document.createElement('details');details.className='wd-editor-details';
  const title=document.createElement('summary');title.textContent='✎ Edit design information (administrator)';
  editor.before(details);details.append(title,editor);
  preview.addEventListener('close',()=>details.open=false);
 }
 // Filter locally by filename/keywords from the currently loaded page, no AI inference.
 const searchHelp=document.createElement('p');searchHelp.className='wd-search-help';
 searchHelp.textContent='Tip: search titles, file types and folders. Searches use your indexed catalogue; visual similarity requires a separate index.';
 document.querySelector('.toolbar')?.after(searchHelp);
})();
