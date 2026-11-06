/*
  Gift Planner Cloud Bridge — one account, owner-only Firestore rules.
  No public signup, no passwords in code. GitHub Pages hosts only the interface.
  Sections are independent Firestore documents so changes to gifts do not
  overwrite unrelated edits to people, calendars or handmade materials.
*/
import {firebaseConfig} from './firebase-config.js';

const SECTIONS = [
  'people','personNotes','events','gifts','bundleItems','shopping','steps',
  'materials','materialNeeds','occasionPlans','planTasks','projectTemplates','expenses'
];
const gate=document.getElementById('cloud-gate');
const description=document.getElementById('gp-gate-description');
const error=document.getElementById('gp-gate-error');
const loginFields=document.getElementById('gp-login-fields');
const loginBtn=document.getElementById('gp-login-btn');
const retryBtn=document.getElementById('gp-retry');
const demoBtn=document.getElementById('gp-demo');
const bar=document.getElementById('gp-sync-bar');
let cloudReady=false, lastValues={}, revisions={}, pending={}, timer=null, writeBusy=false;
let currentAuth=null, currentUser=null, stopListeners=[], firebaseApi=null;
let conflict=false, suppressed=false;
let sessionId = Math.random().toString(36).slice(2);
const clone = value=>JSON.parse(JSON.stringify(value));
const normalized = (section, state)=>{
  if(section==='settings') {
    const out={};
    for(const [key,value] of Object.entries(state||{})){
      if(SECTIONS.includes(key)||key.startsWith('_')||typeof value==='function')continue;
      out[key]=value;
    }
    return out;
  }
  return Array.isArray(state?.[section])?state[section]:[];
};
const serial = value=>JSON.stringify(value);
const blank = ()=>({people:[],personNotes:[],events:[],gifts:[],bundleItems:[],shopping:[],steps:[],materials:[],materialNeeds:[],occasionPlans:[],planTasks:[],projectTemplates:[],expenses:[],theme:'light',views:{people:'grid',gifts:'grid'},mobileNav:['calendar','gifts','workshop']});
function showGate(state,message){
  document.body.dataset.cloudStatus=state;
  description.textContent=message;
  error.hidden=true;
  loginFields.hidden=state!=='login';
  retryBtn.hidden=state!=='error';
  if(state==='login') document.getElementById('gp-login-email').focus();
}
function showError(message){error.hidden=false;error.textContent=message;}
function status(text,warning=false){
  bar.hidden=false;bar.textContent=text;bar.classList.toggle('gp-warning',warning);
  const info=document.getElementById('gp-cloud-info');if(info)info.textContent=text;
}
const configPresent = ['apiKey','projectId','appId','authDomain'].every(k=>typeof firebaseConfig[k]==='string' && firebaseConfig[k] && !/PASTE_|^YOUR_/.test(firebaseConfig[k]));
function startDemo(){
  window.giftCloudMode=false;cloudReady=false;
  document.body.dataset.cloudStatus='demo';
  status('Демо · локальные данные, без синхронизации',true);
  window.GiftPlannerBridge?.apply(window.GiftPlannerBridge.get());
}
demoBtn.addEventListener('click',startDemo);
if(new URLSearchParams(location.search).get('demo')==='1'){
  startDemo();
} else if(location.protocol==='file:'){
  showGate('setup','Для подключения Firebase открой сайт через HTTPS (GitHub Pages). Файлы с компьютера не подключаются к базе. Для оценки интерфейса можно открыть деморежим.');
} else if(!configPresent){
  showGate('setup','Проект ещё не подключён к Firebase. Заполни docs/firebase-config.js и опубликуй изменения в GitHub. Пока доступен только деморежим.');
} else {
  try {
    // Firebase modular SDK is loaded only after configuration is provided.
    const SDK='https://www.gstatic.com/firebasejs/12.4.0/';
    const [appSdk,authSdk,storeSdk]=await Promise.all([
      import(SDK+'firebase-app.js'),
      import(SDK+'firebase-auth.js'),
      import(SDK+'firebase-firestore.js'),
    ]);
    firebaseApi={appSdk,authSdk,storeSdk};
    const app=appSdk.initializeApp(firebaseConfig);
    currentAuth=authSdk.getAuth(app);
    await authSdk.setPersistence(currentAuth,authSdk.browserLocalPersistence);
    await authSdk.onAuthStateChanged(currentAuth,async user=>{
      if(!user){
        clearTimeout(timer);timer=null;writeBusy=false;pending={};lastValues={};revisions={};cloudReady=false;currentUser=null;
        stopListeners.forEach(fn=>fn());stopListeners=[];
        window.GiftPlannerBridge?.reset();
        showGate('login','Войди в свой личный аккаунт Firebase Authentication. Он один и тот же на компьютере, iPhone и iPad.');
      } else {
        currentUser=user;
        await initializeCloud(user);
      }
    });
    retryBtn.addEventListener('click',()=>{if(currentUser)initializeCloud(currentUser)});
    loginBtn.addEventListener('click',async()=>{
      loginBtn.disabled=true;error.hidden=true;
      const email=document.getElementById('gp-login-email').value.trim();
      const password=document.getElementById('gp-login-pass').value;
      if(!email||!password){showError('Укажи email и пароль.');loginBtn.disabled=false;return}
      try{await authSdk.signInWithEmailAndPassword(currentAuth,email,password)}
      catch(e){showError('Не удалось войти. Проверь email, пароль и что пользователь создан в Firebase Authentication. Код: '+(e.code||'unknown'))}
      finally{loginBtn.disabled=false;document.getElementById('gp-login-pass').value=''}
    });
    for(const el of [document.getElementById('gp-login-email'),document.getElementById('gp-login-pass')])el.addEventListener('keydown',e=>{if(e.key==='Enter')loginBtn.click()});
  }catch(e){showGate('error','Не удалось загрузить Firebase. Нужен интернет при первом открытии.');showError(String(e.message||e));}
}

async function initializeCloud(user){
  const {storeSdk}=firebaseApi;
  showGate('loading','Загружаю твою приватную картотеку…');cloudReady=false;conflict=false;
  stopListeners.forEach(fn=>fn());stopListeners=[];
  const authUid=user.uid;
  const database=storeSdk.getFirestore();
  try {
    // First load from the server; never replace a cloud account with an old local draft.
    const sections=[...SECTIONS,'settings'];
    const refs=sections.map(s=>storeSdk.doc(database,'users',authUid,'planner',s));
    const snapshots=await Promise.all(refs.map(ref=>storeSdk.getDocFromServer(ref)));
    if(currentUser?.uid!==authUid)return;
    const remote=blank();
    lastValues={};revisions={};
    for(let i=0;i<sections.length;i++){
      const sec=sections[i];
      const value=snapshots[i].exists()?snapshots[i].data()?.value:(sec==='settings'?normalized('settings',remote):[]);
      const checked=(sec==='settings'&&value&&typeof value==='object'&&!Array.isArray(value))?value:(sec==='settings'?{}:(Array.isArray(value)?value:[]));
      if(sec==='settings')Object.assign(remote,checked);
      else remote[sec]=checked;
      lastValues[sec]=serial(checked);
      revisions[sec]=snapshots[i].exists()?Number(snapshots[i].data()?.revision||0):0;
    }
    window.GiftPlannerBridge.apply(remote);
    window.giftCloudQueueSync=queueSync;
    pending={};cloudReady=true;
    document.body.dataset.cloudStatus='ready';
    status('☁ Данные загружены и защищены');
    // Real-time changes on another device: untouched sections update automatically.
    stopListeners=refs.map((ref,i)=>storeSdk.onSnapshot(ref,snapshot=>{
      if(currentUser?.uid!==authUid || !cloudReady || snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites)return;
      const sec=sections[i];const value=snapshot.exists()?snapshot.data()?.value:(sec==='settings'?{}:[]);
      const checked=sec==='settings'?(value&&typeof value==='object'&&!Array.isArray(value)?value:{}):(Array.isArray(value)?value:[]);
      const incoming=serial(checked);
      if(incoming===lastValues[sec])return;
      const local=window.GiftPlannerBridge.get();
      const localValue=serial(normalized(sec,local));
      // Prefer safety to overwriting unsaved edits on this device.
      if(pending[sec]||writeBusy && localValue!==lastValues[sec]){
        conflict=true;status('⚠ Изменение на другом устройстве. Сохрани JSON и перезагрузи страницу для сверки.',true);
        return;
      }
      lastValues[sec]=incoming;
      revisions[sec]=snapshot.exists()?Number(snapshot.data()?.revision||0):0;
      if(localValue===incoming)return;
      const next=clone(local);
      if(sec==='settings')Object.assign(next,checked);else next[sec]=checked;
      window.GiftPlannerBridge.apply(next,{preserveUi:true});
      status('☁ Обновлено с другого устройства');
    },e=>{status('⚠ Ошибка чтения облака: '+(e.code||'unknown'),true)}));
  }catch(e){
    cloudReady=false;
    showGate('error','Не удалось безопасно загрузить данные из Firestore. Приложение не откроет старые локальные записи вместо облака.');
    showError((e.code||'Ошибка')+': '+(e.message||'')+'. Проверь UID в firestore.rules, доступ Firestore, интернет и тариф Spark.');
  }
}
function queueSync(data){
  if(!cloudReady||!currentUser||conflict)return;
  const snapshot=clone(data);
  for(const section of [...SECTIONS,'settings']){
    const value=normalized(section,snapshot);
    const contents=serial(value);
    if(contents!==lastValues[section])pending[section]=clone(value);
    else delete pending[section];
  }
  if(!Object.keys(pending).length)return;
  status('↻ Сохраняю изменения…');
  clearTimeout(timer);timer=setTimeout(flush,950);
}
async function flush(){
  if(writeBusy||!cloudReady||!currentUser||conflict)return;
  const edits=Object.entries(pending);
  if(!edits.length)return;
  const {storeSdk}=firebaseApi;
  const uid=currentUser.uid;
  pending={};writeBusy=true;
  try{
    // Separate sections prevent unrelated people's and gifts' data from overwriting one another.
    await Promise.all(edits.map(async([section,value])=>{
      const reference=storeSdk.doc(storeSdk.getFirestore(),'users',uid,'planner',section);
      const expected=Number(revisions[section]||0);
      const nextRev=await storeSdk.runTransaction(storeSdk.getFirestore(),async transaction=>{
        const remote=await transaction.get(reference);
        const current=remote.exists()?Number(remote.data()?.revision||0):0;
        if(current!==expected)throw new Error('CLOUD_CONFLICT');
        transaction.set(reference,{value:clone(value),revision:current+1,updatedAt:storeSdk.serverTimestamp(),client:sessionId});
        return current+1;
      });
      revisions[section]=nextRev;
      lastValues[section]=serial(value);
    }));
    if(currentUser?.uid===uid)status('✓ Сохранено в Firebase');
  }catch(e){
    for(const [key,value] of edits)pending[key]=value;
    if(String(e?.message||'').includes('CLOUD_CONFLICT')){conflict=true;status('⚠ Конфликт между устройствами. Сохрани резервный JSON и обнови страницу, чтобы сверить изменения.',true)}
    else status('⚠ Не удалось сохранить. Проверь интернет и права доступа: '+(e.code||'unknown'),true);
  }finally{
    writeBusy=false;
    if(Object.keys(pending).length&&!conflict){clearTimeout(timer);timer=setTimeout(flush,2200)}
  }
}
window.addEventListener('online',()=>{if(cloudReady&&Object.keys(pending).length)flush()});
window.addEventListener('pagehide',()=>{if(timer){clearTimeout(timer);flush()}});

// Buttons inside application are re-created on each draw; event delegation persists.
document.addEventListener('click',async e=>{
  const signout=e.target.closest('#gp-sign-out');
  if(signout && currentAuth){
    if(Object.keys(pending).length && !confirm('Есть несохранённые изменения. Сначала экспортировать JSON? Нажми «Отмена», чтобы остаться.'))return;
    await firebaseApi.authSdk.signOut(currentAuth);
    status('Вы вышли. Данные больше не показаны на этом устройстве.');
  }
  if(e.target.closest('#gp-diagnostics')){
    const data=window.GiftPlannerBridge.get();
    const diagnostics={app:'Gift Planner',kind:'anonymous-diagnostics',schemaVersion:1,createdAt:new Date().toISOString(),
      screen:{width:innerWidth,height:innerHeight},browser:navigator.userAgent.split(' ').slice(0,4).join(' '),
      sections:Object.fromEntries(SECTIONS.map(k=>[k,{count:Array.isArray(data[k])?data[k].length:0}])),
      issues:{giftsWithoutPerson:(data.gifts||[]).filter(g=>g.status!=='idea'&&!g.personId&&!(g.recipientIds||[]).length).length,
        giftsWithoutEvent:(data.gifts||[]).filter(g=>g.status!=='idea'&&!g.eventId).length},
      cloud:{connected:cloudReady,conflict},
      note:'No names, birthdays, preferences, links, notes, passwords or gift names are included.'};
    downloadJson(diagnostics,'gift-planner-diagnostics.json');
  }
},true);
function downloadJson(data,name){
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(link.href),1500);
}
