'use strict';
(()=>{const $=id=>document.getElementById(id);const toolbar=document.querySelector('.toolbar');if(!toolbar)return;
const box=document.createElement('section');box.className='wd-extras';box.innerHTML='<button type="button" class="secondary" id="wd-theme-toggle" aria-label="Switch colour theme">Dark mode</button>';toolbar.after(box);
let mode=document.documentElement.dataset.theme==='light'?'light':'dark';
const setMode=v=>{mode=v;document.documentElement.dataset.theme=mode;document.documentElement.style.backgroundColor=mode==='dark'?'#111c24':'#f4f4f3';document.documentElement.style.colorScheme=mode;localStorage.setItem('weardhk-theme',mode);$('wd-theme-toggle').textContent=mode==='dark'?'Light mode':'Dark mode'};
$('wd-theme-toggle').textContent=mode==='dark'?'Light mode':'Dark mode';$('wd-theme-toggle').onclick=()=>setMode(mode==='dark'?'light':'dark');
})();
