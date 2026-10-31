'use strict';
(()=>{const p=document.createElement('div');p.className='wd-sync-safety';p.setAttribute('role','status');p.setAttribute('aria-live','polite');p.hidden=true;const main=document.querySelector('.main');if(!main)return;main.prepend(p);
let last='';
async function check(){if(document.hidden)return;try{const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw Error('Unavailable');const s=await r.json();let message='';
if(s.syncing)message='Google Drive is syncing. The previous catalogue remains available.';
else if(s.errors&&s.errors.length)message='Drive sync needs attention. The last complete catalogue is preserved. Check System Status.';
else if(!s.syncedAt)message='Displaying a saved catalogue while the initial Drive scan completes.';
else if(Date.now()-Date.parse(s.syncedAt)>45*60*1000)message='The last successful Drive sync is over 45 minutes old. Check System Status.';
p.hidden=!message;if(message!==last){p.textContent=message;last=message}
}catch{p.hidden=false;p.textContent='Sync status temporarily unavailable. Existing designs may still be browsed.'}}
setTimeout(check,2500);setInterval(check,120000);
})();
