/* 仕入れ比較アプリ - localStorage based */

const STORAGE_KEY = 'shiire-hikaku-v1';

const DEFAULT_MASTERS = {
  stores: ['全店舗','神楽坂','男マエ食道','深夜食道','神楽坂/男マエ食道','神楽坂/深夜食道','男マエ食道/深夜食道'],
  units: ['本','枚','個','箱','袋','缶','膳','kg','ケース'],
  vendors: ['ハピネス','コスモス','アマゾン','ヨドバシカメラ','ココデカウ','メルカリ','王子タイムリー','みやこオンライン','容器スタイル','アズキッチン','西原','オーリック']
};

let state = {
  items: [],
  masters: structuredClone(DEFAULT_MASTERS),
  trial: { candidates: [{}, {}] }
};

let editingId = null;
let currentTab = 'list';

/* ============================================================
   Firebase（仕入れ管理アプリ shiire-app と同じプロジェクト）
   - 同じアカウントでログイン → 比較データを全端末で共有
   - データ保存先: users/{uid}/hikaku/data（items と masters をまとめて保存）
   ============================================================ */
const FB_CFG = {
  apiKey:"AIzaSyD3SMCMfXy2qxC8EuukG-ueFdA4FzaTLLM",
  authDomain:"shiire-app.firebaseapp.com",
  projectId:"shiire-app",
  storageBucket:"shiire-app.firebasestorage.app",
  messagingSenderId:"762592354487",
  appId:"1:762592354487:web:133b761485abed213f6d32"
};
let fbAuth = null, fbDb = null, currentUser = null;
let cloudMode = false;          // true=クラウド共有モード / false=この端末のみ
let cloudLoaded = false;        // 初回クラウド読込完了フラグ
let cloudSaveTimer = null;      // 連続保存をまとめるタイマー

function initFirebase(){
  try{
    firebase.initializeApp(FB_CFG);
    fbAuth = firebase.auth();
    fbDb = firebase.firestore();
    return true;
  }catch(e){ console.error('firebase init failed', e); return false; }
}

/* 同期バッジの表示更新 */
function setSyncPill(stateName){
  const el = document.getElementById('syncPill');
  if(!el) return;
  el.classList.remove('on','err','local');
  if(stateName==='on'){ el.textContent='● 同期中'; el.classList.add('on'); }
  else if(stateName==='saving'){ el.textContent='● 保存中…'; el.classList.add('on'); }
  else if(stateName==='err'){ el.textContent='● 同期エラー'; el.classList.add('err'); }
  else if(stateName==='local'){ el.textContent='● この端末のみ'; el.classList.add('local'); }
  else { el.textContent='● 未接続'; }
}

/* ログイン実行 */
async function doLogin(){
  const email = document.getElementById('authEmail').value.trim();
  const pw = document.getElementById('authPw').value;
  const errEl = document.getElementById('authErr');
  const btn = document.getElementById('authBtn');
  errEl.textContent = '';
  if(!email || !pw){ errEl.textContent = 'メールアドレスとパスワードを入力してください'; return; }
  btn.disabled = true; btn.textContent = 'ログイン中…';
  try{
    await fbAuth.signInWithEmailAndPassword(email, pw);
    // 成功時は onAuthStateChanged が後続処理を行う
  }catch(e){
    let msg = 'ログインに失敗しました';
    if(e.code==='auth/invalid-email') msg='メールアドレスの形式が正しくありません';
    else if(e.code==='auth/user-not-found') msg='このメールアドレスは登録されていません';
    else if(e.code==='auth/wrong-password'||e.code==='auth/invalid-credential') msg='メールアドレスかパスワードが違います';
    else if(e.code==='auth/too-many-requests') msg='試行回数が多すぎます。少し時間をおいてください';
    else if(e.code==='auth/network-request-failed') msg='ネット接続を確認してください';
    errEl.textContent = msg;
    console.error('login error', e);
  }finally{
    btn.disabled = false; btn.textContent = 'ログイン';
  }
}

/* ログインせずこの端末だけで使う */
function skipLogin(){
  cloudMode = false;
  localStorage.setItem('hikakuSkipLogin','1');
  document.getElementById('authOverlay').style.display = 'none';
  setSyncPill('local');
}

/* ログアウト */
async function logout(){
  if(!confirm('ログアウトしますか？（この端末のローカルデータは残ります）')) return;
  localStorage.removeItem('hikakuSkipLogin');
  try{ if(fbAuth) await fbAuth.signOut(); }catch(e){}
  location.reload();
}

/* ヘッダー同期バッジのタップ動作 */
function syncPillClick(){
  if(currentUser){
    logout();
  }else{
    // 未ログイン or ローカルモード → ログイン画面を出す
    localStorage.removeItem('hikakuSkipLogin');
    document.getElementById('authOverlay').style.display = 'flex';
  }
}

/* クラウドからデータを読み込む（ログイン直後） */
async function cloudLoad(){
  if(!currentUser) return;
  setSyncPill('on');
  try{
    const ref = fbDb.doc(`users/${currentUser.uid}/hikaku/data`);
    const snap = await ref.get();
    if(snap.exists){
      const d = snap.data();
      if(Array.isArray(d.items)){
        state.items = d.items;
        if(d.masters){
          state.masters = {...structuredClone(DEFAULT_MASTERS), ...d.masters};
          for(const k of Object.keys(DEFAULT_MASTERS)){
            if(!Array.isArray(state.masters[k])) state.masters[k] = [...DEFAULT_MASTERS[k]];
          }
        }
        saveLocal();   // クラウド内容をローカルにもキャッシュ
      }
    }else{
      // クラウドにまだデータが無い → この端末のローカルデータを初回アップロードして保全
      if(state.items.length>0) await cloudSaveNow();
    }
    cloudLoaded = true;
    setSyncPill('on');
    renderKpis(); renderList(); renderSettings();
  }catch(e){
    console.error('cloud load failed', e);
    setSyncPill('err');
    toast('クラウド読み込みに失敗しました');
  }
}

/* クラウドへ即保存 */
async function cloudSaveNow(){
  if(!currentUser || !cloudMode) return;
  try{
    setSyncPill('saving');
    await fbDb.doc(`users/${currentUser.uid}/hikaku/data`).set({
      items: state.items,
      masters: state.masters,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    setSyncPill('on');
  }catch(e){
    console.error('cloud save failed', e);
    setSyncPill('err');
  }
}

/* クラウドへ保存（連続操作をまとめて 800ms 後に1回だけ送信） */
function cloudSave(){
  if(!currentUser || !cloudMode) return;
  clearTimeout(cloudSaveTimer);
  setSyncPill('saving');
  cloudSaveTimer = setTimeout(cloudSaveNow, 800);
}

/* ---------- storage ---------- */
function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return;
    const data = JSON.parse(raw);
    state.items = data.items || [];
    state.masters = data.masters || structuredClone(DEFAULT_MASTERS);
    // ensure all default master entries are present
    for(const k of Object.keys(DEFAULT_MASTERS)){
      if(!Array.isArray(state.masters[k])) state.masters[k] = [...DEFAULT_MASTERS[k]];
    }
  }catch(e){console.error('load failed', e)}
}
/* ローカル（この端末）にだけ保存 */
function saveLocal(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify({items:state.items, masters:state.masters}));
}
/* 保存：ローカル＋（ログイン時は）クラウドにも保存 */
function saveState(){
  saveLocal();
  cloudSave();
}

/* ---------- utils ---------- */
const yen = n => (n==null||isNaN(n)) ? '—' : '¥' + Math.round(n).toLocaleString('ja-JP');
const num = v => {
  if(v==='' || v==null) return null;
  const n = parseFloat(String(v).replace(/,/g,''));
  return isNaN(n) ? null : n;
};
const todayStr = () => {
  const d = new Date();
  const w = ['日','月','火','水','木','金','土'][d.getDay()];
  return `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')} (${w})`;
};
function uid(){return Date.now().toString(36) + Math.random().toString(36).slice(2,7)}
function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._tm);
  t._tm = setTimeout(()=>t.classList.remove('show'), 2200);
}

/* ---------- calc ---------- */
function calcItem(it){
  const qty = num(it.qty);
  const oldPrice = num(it.oldPrice), oldShip = num(it.oldShip)||0, oldFreq = num(it.oldFreq);
  const newPrice = num(it.newPrice), newShip = num(it.newShip)||0, newFreq = num(it.newFreq);
  const r = {oldMonGoods:null, newMonGoods:null, oldMonShip:null, newMonShip:null,
             oldMonTotal:null, newMonTotal:null, monthSaving:null, yearSaving:null, savingRate:null,
             oldPerOrder:null, newPerOrder:null};
  if(qty!=null && oldPrice!=null) r.oldMonGoods = qty * oldPrice;
  if(qty!=null && newPrice!=null) r.newMonGoods = qty * newPrice;
  if(oldFreq!=null) r.oldMonShip = oldShip * oldFreq;
  if(newFreq!=null) r.newMonShip = newShip * newFreq;
  if(r.oldMonGoods!=null && r.oldMonShip!=null) r.oldMonTotal = r.oldMonGoods + r.oldMonShip;
  if(r.newMonGoods!=null && r.newMonShip!=null) r.newMonTotal = r.newMonGoods + r.newMonShip;
  if(r.oldMonTotal!=null && r.newMonTotal!=null){
    r.monthSaving = r.oldMonTotal - r.newMonTotal;
    r.yearSaving = r.monthSaving * 12;
    if(r.oldMonTotal>0) r.savingRate = r.monthSaving / r.oldMonTotal;
  }
  if(qty!=null && oldPrice!=null && oldFreq!=null && oldFreq>0) r.oldPerOrder = (qty/oldFreq)*oldPrice + oldShip;
  if(qty!=null && newPrice!=null && newFreq!=null && newFreq>0) r.newPerOrder = (qty/newFreq)*newPrice + newShip;
  return r;
}

/* ---------- tabs ---------- */
function showTab(t){
  currentTab = t;
  ['list','rank','trial','settings'].forEach(name=>{
    const v = document.getElementById('view-'+name);
    const b = document.getElementById('seg-'+name);
    if(v) v.style.display = (t===name) ? '' : 'none';
    if(b) b.classList.toggle('active', t===name);
  });
  if(t==='list') renderList();
  if(t==='rank') renderRanking();
  if(t==='trial') renderTrial();
  if(t==='settings') renderSettings();
}
function toggleFilterPanel(){
  const p = document.getElementById('filter-panel-list');
  const b = document.querySelector('.filter-toggle-btn');
  p.classList.toggle('open');
  b.classList.toggle('open');
}

/* ---------- KPIs / dashboard ---------- */
function renderKpis(){
  let monthSaving=0, yearSaving=0, monthOldTotal=0, monthNewTotal=0;
  let savedItems=0, lossItems=0;
  state.items.forEach(it=>{
    const r = calcItem(it);
    if(r.monthSaving!=null){
      monthSaving += r.monthSaving;
      yearSaving += r.yearSaving;
      monthOldTotal += r.oldMonTotal;
      monthNewTotal += r.newMonTotal;
      if(r.monthSaving > 0.5) savedItems++;
      else if(r.monthSaving < -0.5) lossItems++;
    }
  });
  const rate = monthOldTotal>0 ? (monthSaving/monthOldTotal*100) : 0;
  const cls = monthSaving>=0 ? 'good' : 'warn';
  document.getElementById('dashboard-kpis').innerHTML = `
    <div class="kpi-card ${cls}">
      <div class="kpi-label">月間削減額</div>
      <div class="kpi-value">${yen(monthSaving)}</div>
      <div class="kpi-sub">削減率 ${rate.toFixed(1)}%</div>
    </div>
    <div class="kpi-card ${cls}">
      <div class="kpi-label">年間換算</div>
      <div class="kpi-value">${yen(yearSaving)}</div>
      <div class="kpi-sub">12ヶ月換算</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">登録商品</div>
      <div class="kpi-value">${state.items.length}</div>
      <div class="kpi-sub">削減 ${savedItems} / 増 ${lossItems}</div>
    </div>
  `;
  document.getElementById('hero-stamp').textContent = `更新: ${todayStr().slice(5)}`;
}

/* ---------- list view ---------- */
function renderList(){
  const search = (document.getElementById('search-name')?.value||'').trim().toLowerCase();
  const storeF = document.getElementById('filter-store')?.value || 'all';
  const sortBy = document.getElementById('sort-by')?.value || 'saving_desc';

  // populate filter store options
  const storeSel = document.getElementById('filter-store');
  const cur = storeSel.value;
  const stores = Array.from(new Set(state.items.map(i=>i.store).filter(Boolean)));
  storeSel.innerHTML = '<option value="all">店舗: すべて</option>' +
    stores.map(s=>`<option value="${escapeHtml(s)}">店舗: ${escapeHtml(s)}</option>`).join('');
  storeSel.value = (cur && stores.includes(cur)) ? cur : 'all';

  let arr = state.items.slice();
  if(search) arr = arr.filter(i => (i.name||'').toLowerCase().includes(search));
  if(storeF!=='all') arr = arr.filter(i => i.store===storeF);
  arr = arr.map(i=>({...i, _r: calcItem(i)}));
  arr.sort((a,b)=>{
    switch(sortBy){
      case 'saving_desc': return (b._r.monthSaving||-Infinity) - (a._r.monthSaving||-Infinity);
      case 'saving_asc':  return (a._r.monthSaving||Infinity) - (b._r.monthSaving||Infinity);
      case 'rate_desc':   return (b._r.savingRate||-Infinity) - (a._r.savingRate||-Infinity);
      case 'name_asc':    return (a.name||'').localeCompare(b.name||'','ja');
      case 'created_desc':return (b.createdAt||0) - (a.createdAt||0);
    }
    return 0;
  });

  const wrap = document.getElementById('list-items');
  document.getElementById('list-count-pill').textContent = `${arr.length}件`;
  if(arr.length===0){
    wrap.innerHTML = `<div class="empty-state">${state.items.length===0
      ? '登録された商品がありません。<br>「＋ 新しい商品の比較を追加」から始めるか、<br>設定タブからExcelを読み込んでください。'
      : '条件に一致する商品が見つかりません。'}</div>`;
    return;
  }
  wrap.innerHTML = arr.map(it=>{
    const r = it._r;
    const sCls = r.monthSaving==null ? 'zero' : (r.monthSaving>0.5 ? '' : (r.monthSaving<-0.5 ? 'neg' : 'zero'));
    const rateTxt = r.savingRate==null ? '—' : (r.savingRate*100).toFixed(1)+'%';
    return `
      <div class="item-card" onclick="openItemModal('${it.id}')">
        <div class="top-row">
          <div class="item-name">${escapeHtml(it.name||'(名称未設定)')}</div>
          ${it.store?`<div class="item-store">${escapeHtml(it.store)}</div>`:''}
        </div>
        <div class="vendor-row">
          <div class="vendor-cell">
            <div class="vendor-label">旧 ${it.qty?`/月${it.qty}${escapeHtml(it.unit||'')}`:''}</div>
            <div class="vendor-name">${escapeHtml(it.oldVendor||'—')}</div>
            <div class="vendor-price">${yen(r.oldMonTotal)}/月</div>
          </div>
          <div class="vs-arrow">→</div>
          <div class="vendor-cell alt">
            <div class="vendor-label">新</div>
            <div class="vendor-name">${escapeHtml(it.newVendor||'—')}</div>
            <div class="vendor-price">${yen(r.newMonTotal)}/月</div>
          </div>
        </div>
        <div class="saving-row">
          <div>
            <div class="saving-label">月間削減額</div>
            <div class="saving-amt ${sCls}">${r.monthSaving==null?'—':(r.monthSaving>=0?'+':'')+yen(Math.abs(r.monthSaving)).replace('¥',r.monthSaving>=0?'¥':'-¥')}</div>
          </div>
          <div class="saving-rate ${sCls}">${rateTxt}</div>
        </div>
        ${it.memo?`<div class="item-memo">📝 ${escapeHtml(it.memo)}</div>`:''}
      </div>
    `;
  }).join('');

  document.getElementById('last-updated-list').textContent = (cloudMode && currentUser)
    ? `☁️ クラウド保存中 — パソコン・スマホで同じデータが見られます`
    : `この端末のブラウザにのみ保存中（右上のバッジからログインで全端末共有）`;
}

/* ---------- ranking view ---------- */
function renderRanking(){
  // store summary
  const byStore = {};
  state.items.forEach(it=>{
    const r = calcItem(it);
    if(r.monthSaving==null) return;
    const key = it.store || '(店舗未設定)';
    if(!byStore[key]) byStore[key] = {month:0, year:0, count:0};
    byStore[key].month += r.monthSaving;
    byStore[key].year += r.yearSaving;
    byStore[key].count += 1;
  });
  const storeArr = Object.entries(byStore).sort((a,b)=>b[1].month - a[1].month);
  document.getElementById('store-summary').innerHTML = storeArr.length===0
    ? `<div class="empty-state">データがまだありません。</div>`
    : storeArr.map(([s,v])=>`
      <div class="summary-card">
        <div class="summary-store">${escapeHtml(s)}</div>
        <div class="summary-amt">${(v.month>=0?'+':'')}${yen(Math.abs(v.month)).replace('¥', v.month>=0?'¥':'-¥')}/月</div>
        <div class="summary-sub">年間 ${yen(v.year)} / ${v.count}品</div>
      </div>`).join('');

  // saving ranking
  const ranked = state.items
    .map(it=>({it, r: calcItem(it)}))
    .filter(x=>x.r.monthSaving!=null)
    .sort((a,b)=>b.r.monthSaving - a.r.monthSaving);
  const wrap = document.getElementById('rank-items');
  if(ranked.length===0){
    wrap.innerHTML = `<div class="empty-state">削減データがまだありません。</div>`;
    return;
  }
  wrap.innerHTML = ranked.map((x,i)=>{
    const cls = i===0?'gold':i===1?'silver':i===2?'bronze':'';
    const s = x.r.monthSaving;
    const sign = s>=0?'+':'-';
    return `
      <div class="rank-item" onclick="openItemModal('${x.it.id}')">
        <div class="rank-num ${cls}">${i+1}</div>
        <div class="rank-body">
          <div class="rank-name">${escapeHtml(x.it.name||'(名称未設定)')}</div>
          <div class="rank-meta">${escapeHtml(x.it.oldVendor||'—')} → ${escapeHtml(x.it.newVendor||'—')} / ${escapeHtml(x.it.store||'—')}</div>
        </div>
        <div class="rank-amt">${sign}${yen(Math.abs(s))}</div>
      </div>
    `;
  }).join('');
}

/* ---------- trial view ---------- */
function renderTrial(){
  const wrap = document.getElementById('trial-candidates');
  wrap.innerHTML = state.trial.candidates.map((c,i)=>`
    <div class="toolbar-row">
      <input type="text" class="search-input" placeholder="新候補${i+1}: 仕入先" value="${escapeHtml(c.vendor||'')}" onchange="updateTrial(${i},'vendor',this.value)">
      <input type="number" step="0.01" class="search-input" placeholder="単価" value="${c.price??''}" onchange="updateTrial(${i},'price',this.value)" style="max-width:110px">
      <input type="number" step="0.01" class="search-input" placeholder="送料" value="${c.ship??''}" onchange="updateTrial(${i},'ship',this.value)" style="max-width:110px">
      <input type="number" step="0.01" class="search-input" placeholder="月発注回数" value="${c.freq??''}" onchange="updateTrial(${i},'freq',this.value)" style="max-width:130px">
      ${state.trial.candidates.length>1?`<button class="danger-btn" onclick="removeTrialCandidate(${i})" style="flex:0">削除</button>`:''}
    </div>
  `).join('');
}
function addTrialCandidate(){state.trial.candidates.push({}); renderTrial()}
function removeTrialCandidate(i){state.trial.candidates.splice(i,1); renderTrial()}
function updateTrial(i,k,v){state.trial.candidates[i][k] = v}
function resetTrial(){
  // 入力済みの内容があるときだけ確認する
  const hasInput = ['trial-product','trial-qty','trial-old-vendor','trial-old-price','trial-old-ship','trial-old-freq']
    .some(id=>{const el=document.getElementById(id); return el && el.value.trim()!=='';})
    || state.trial.candidates.some(c=>c.vendor||c.price!=null||c.ship!=null||c.freq!=null);
  if(hasInput && !confirm('試算の入力内容をすべてリセットしますか？')) return;
  // 旧側の入力欄をクリア
  ['trial-product','trial-qty','trial-old-vendor','trial-old-price','trial-old-ship','trial-old-freq']
    .forEach(id=>{const el=document.getElementById(id); if(el) el.value='';});
  // 新候補を初期状態(空2枠)に戻す
  state.trial.candidates = [{}, {}];
  renderTrial();
  // 結果表示と候補カウントをクリア
  document.getElementById('trial-result').innerHTML = '';
  document.getElementById('trial-count-pill').textContent = '0件';
  toast('試算をリセットしました');
}

function runTrial(){
  const product = document.getElementById('trial-product').value.trim() || '商品';
  const qty = num(document.getElementById('trial-qty').value);
  const oldVendor = document.getElementById('trial-old-vendor').value.trim() || '旧';
  const oldPrice = num(document.getElementById('trial-old-price').value);
  const oldShip = num(document.getElementById('trial-old-ship').value)||0;
  const oldFreq = num(document.getElementById('trial-old-freq').value);
  if(qty==null || oldPrice==null || oldFreq==null){
    toast('月間使用量・旧単価・旧月発注回数 を入力してください');
    return;
  }
  const oldMon = qty*oldPrice + oldShip*oldFreq;
  const cands = state.trial.candidates.map((c,i)=>{
    const p = num(c.price), s = num(c.ship)||0, f = num(c.freq);
    if(p==null || f==null) return null;
    const mon = qty*p + s*f;
    return {idx:i, vendor:c.vendor||`候補${i+1}`, price:p, ship:s, freq:f, mon, save:oldMon-mon};
  }).filter(Boolean);
  if(cands.length===0){
    toast('新候補の単価と月発注回数を最低1つ入力してください');
    return;
  }
  cands.sort((a,b)=>b.save - a.save);
  const best = cands[0];
  document.getElementById('trial-result').innerHTML = `
    <div class="settings-card">
      <div class="settings-label">${escapeHtml(product)} の試算結果</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:8px">
        旧: ${escapeHtml(oldVendor)} / ${yen(oldPrice)}×${qty}+送料${yen(oldShip)}×${oldFreq}回 = <b style="color:var(--navy)">${yen(oldMon)}/月</b>
      </div>
      ${cands.map((c,i)=>{
        const isBest = i===0 && c.save>0;
        const rate = oldMon>0 ? (c.save/oldMon*100).toFixed(1)+'%' : '—';
        return `<div class="trial-cand-card ${isBest?'best':''}">
          <div class="cand-vendor">${escapeHtml(c.vendor)}${isBest?'<span class="best-badge">BEST</span>':''}<div style="font-size:11px;color:var(--muted);font-weight:400">${yen(c.price)}×${qty}+送料${yen(c.ship)}×${c.freq}回</div></div>
          <div class="cand-mon">${yen(c.mon)}/月</div>
          <div class="cand-save ${c.save<0?'neg':''}">${c.save>=0?'+':''}${yen(Math.abs(c.save)).replace('¥',c.save>=0?'¥':'-¥')} (${rate})</div>
        </div>`;
      }).join('')}
      ${best.save>0?`<p class="hint" style="margin-top:10px">💡 BEST候補に切り替えると、年間 <b style="color:var(--green)">${yen(best.save*12)}</b> の削減になります。</p>`:''}
      <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
        <button class="primary-btn" onclick='registerTrialAsItem(${JSON.stringify({product,qty,oldVendor,oldPrice,oldShip,oldFreq,best}).replace(/"/g,"&quot;")})'>BEST候補をこの商品として登録</button>
      </div>
    </div>
  `;
  document.getElementById('trial-count-pill').textContent = `${cands.length}候補`;
}
function registerTrialAsItem(obj){
  if(typeof obj === 'string'){ try{obj = JSON.parse(obj.replace(/&quot;/g,'"'))}catch{return} }
  const b = obj.best;
  const it = {
    id: uid(), createdAt: Date.now(),
    name: obj.product, store:'', unit:'',
    qty: obj.qty,
    oldVendor: obj.oldVendor, oldPrice: obj.oldPrice, oldShip: obj.oldShip, oldFreq: obj.oldFreq,
    newVendor: b.vendor, newPrice: b.price, newShip: b.ship, newFreq: b.freq,
    memo: '試算から登録'
  };
  state.items.push(it); saveState(); renderKpis(); toast('比較リストに登録しました');
  showTab('list');
}

/* ---------- settings ---------- */
function renderSettings(){
  ['stores','units','vendors'].forEach(k=>{
    const wrap = document.getElementById('master-'+k);
    wrap.innerHTML = state.masters[k].map((v,i)=>`
      <span class="chip">${escapeHtml(v)}<span class="x" onclick="removeMaster('${k}',${i})">×</span></span>
    `).join('');
  });
}
function addMaster(k){
  const inputId = k==='stores'?'add-store-input':k==='units'?'add-unit-input':'add-vendor-input';
  const el = document.getElementById(inputId);
  const v = el.value.trim(); if(!v) return;
  if(state.masters[k].includes(v)){ toast('既に存在します'); return; }
  state.masters[k].push(v); saveState(); el.value=''; renderSettings();
}
function removeMaster(k,i){
  if(!confirm(`「${state.masters[k][i]}」を削除しますか？`)) return;
  state.masters[k].splice(i,1); saveState(); renderSettings();
}

/* ---------- modal ---------- */
function openItemModal(id){
  editingId = id || null;
  const m = document.getElementById('item-modal');
  fillSelect('f-store', state.masters.stores, true);
  fillSelect('f-unit', state.masters.units, true);
  fillSelect('f-old-vendor', state.masters.vendors, true);
  fillSelect('f-new-vendor', state.masters.vendors, true);
  if(id){
    const it = state.items.find(x=>x.id===id);
    if(!it) return;
    document.getElementById('item-modal-title').textContent = '商品の比較を編集';
    setVal('f-name', it.name); setVal('f-store', it.store); setVal('f-unit', it.unit); setVal('f-qty', it.qty);
    setVal('f-old-vendor', it.oldVendor); setVal('f-old-price', it.oldPrice); setVal('f-old-ship', it.oldShip); setVal('f-old-freq', it.oldFreq);
    setVal('f-new-vendor', it.newVendor); setVal('f-new-price', it.newPrice); setVal('f-new-ship', it.newShip); setVal('f-new-freq', it.newFreq);
    setVal('f-memo', it.memo);
    document.getElementById('btn-delete').style.display = '';
  } else {
    document.getElementById('item-modal-title').textContent = '商品の比較を追加';
    ['f-name','f-store','f-unit','f-qty','f-old-vendor','f-old-price','f-old-ship','f-old-freq','f-new-vendor','f-new-price','f-new-ship','f-new-freq','f-memo'].forEach(id=>setVal(id,''));
    document.getElementById('btn-delete').style.display = 'none';
  }
  m.style.display = 'flex';
  updatePreview();
  ['f-name','f-store','f-unit','f-qty','f-old-vendor','f-old-price','f-old-ship','f-old-freq','f-new-vendor','f-new-price','f-new-ship','f-new-freq','f-memo']
    .forEach(id=>{
      const el = document.getElementById(id);
      el.oninput = updatePreview; el.onchange = updatePreview;
    });
}
function closeItemModal(){
  document.getElementById('item-modal').style.display = 'none';
  editingId = null;
}
function fillSelect(id, list, allowEmpty){
  const sel = document.getElementById(id);
  sel.innerHTML = (allowEmpty?'<option value="">— 選択 —</option>':'') +
    list.map(v=>`<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
}
function setVal(id,v){const el=document.getElementById(id); if(el) el.value = (v==null||v==='')?'':v}
function getVal(id){return document.getElementById(id).value}
function updatePreview(){
  const it = collectForm();
  const r = calcItem(it);
  const sCls = r.monthSaving==null?'zero':(r.monthSaving>=0?'':'neg');
  const rateTxt = r.savingRate==null?'—':(r.savingRate*100).toFixed(1)+'%';
  document.getElementById('modal-preview').innerHTML = `
    <div class="pv-row"><span>旧 月間合計</span><span class="pv-amt">${yen(r.oldMonTotal)}</span></div>
    <div class="pv-row"><span>新 月間合計</span><span class="pv-amt">${yen(r.newMonTotal)}</span></div>
    <div class="pv-row" style="margin-top:6px;border-top:1px dashed #e6c982;padding-top:6px">
      <span><b>月間削減額</b> (${rateTxt})</span>
      <span class="pv-saving ${sCls}">${r.monthSaving==null?'—':(r.monthSaving>=0?'+':'')+yen(Math.abs(r.monthSaving)).replace('¥',r.monthSaving>=0?'¥':'-¥')}</span>
    </div>
    <div class="pv-row"><span>年間換算</span><span class="pv-amt">${yen(r.yearSaving)}</span></div>
  `;
}
function collectForm(){
  return {
    name: getVal('f-name').trim(),
    store: getVal('f-store'), unit: getVal('f-unit'),
    qty: getVal('f-qty'),
    oldVendor: getVal('f-old-vendor'), oldPrice: getVal('f-old-price'), oldShip: getVal('f-old-ship'), oldFreq: getVal('f-old-freq'),
    newVendor: getVal('f-new-vendor'), newPrice: getVal('f-new-price'), newShip: getVal('f-new-ship'), newFreq: getVal('f-new-freq'),
    memo: getVal('f-memo').trim()
  };
}
function saveItem(){
  const it = collectForm();
  if(!it.name){ toast('商品名を入力してください'); return; }
  it.qty = num(it.qty); it.oldPrice = num(it.oldPrice); it.oldShip = num(it.oldShip); it.oldFreq = num(it.oldFreq);
  it.newPrice = num(it.newPrice); it.newShip = num(it.newShip); it.newFreq = num(it.newFreq);
  if(editingId){
    const i = state.items.findIndex(x=>x.id===editingId);
    if(i>=0) state.items[i] = {...state.items[i], ...it};
  } else {
    it.id = uid(); it.createdAt = Date.now();
    state.items.push(it);
  }
  saveState(); closeItemModal(); renderKpis(); renderList();
  toast('保存しました');
}
function deleteItem(){
  if(!editingId) return;
  if(!confirm('この商品を削除しますか？')) return;
  state.items = state.items.filter(x=>x.id!==editingId);
  saveState(); closeItemModal(); renderKpis(); renderList();
  toast('削除しました');
}

/* ---------- import / export ---------- */
function importXlsx(ev){
  const file = ev.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = e=>{
    try{
      const wb = XLSX.read(e.target.result, {type:'array'});
      // try main sheet
      const sheetName = wb.SheetNames.find(n=>n.includes('入力')) || wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, {header:1, defval:''});
      // header at row 3 (0-indexed: 2)
      let headerRow = -1;
      for(let r=0; r<Math.min(rows.length,10); r++){
        if((rows[r]||[]).some(c=>String(c||'').includes('商品名'))){ headerRow=r; break; }
      }
      if(headerRow<0){ toast('商品データのヘッダーが見つかりません'); return; }
      const head = rows[headerRow].map(s=>String(s||'').trim());
      const idx = label => head.findIndex(h=>h.includes(label));
      const cIdx = {
        name: idx('商品名'), store: idx('使用店舗'), unit: idx('単位'), qty: idx('月間使用量'),
        oV: idx('旧_仕入先'), oP: idx('旧_仕入単価'), oS: idx('旧_送料'), oF: idx('旧_発注頻度'),
        nV: idx('新_仕入先'), nP: idx('新_仕入単価'), nS: idx('新_送料'), nF: idx('新_発注頻度')
      };
      let added = 0, replaced = 0;
      const importedNames = new Set();
      for(let r=headerRow+1; r<rows.length; r++){
        const row = rows[r]||[];
        const name = String(row[cIdx.name]||'').trim();
        if(!name) continue;
        const it = {
          id: uid(), createdAt: Date.now()+r,
          name,
          store: String(row[cIdx.store]||'').trim(),
          unit: String(row[cIdx.unit]||'').trim(),
          qty: num(row[cIdx.qty]),
          oldVendor: String(row[cIdx.oV]||'').trim(),
          oldPrice: num(row[cIdx.oP]), oldShip: num(row[cIdx.oS]), oldFreq: num(row[cIdx.oF]),
          newVendor: String(row[cIdx.nV]||'').trim(),
          newPrice: num(row[cIdx.nP]), newShip: num(row[cIdx.nS]), newFreq: num(row[cIdx.nF]),
          memo: ''
        };
        // dedupe by name (within same import + against existing)
        if(importedNames.has(name)) continue;
        importedNames.add(name);
        const ex = state.items.findIndex(x=>x.name===name);
        if(ex>=0){ state.items[ex] = {...state.items[ex], ...it, id: state.items[ex].id, createdAt: state.items[ex].createdAt}; replaced++; }
        else { state.items.push(it); added++; }
        // master enrichment
        if(it.store && !state.masters.stores.includes(it.store)) state.masters.stores.push(it.store);
        if(it.unit && !state.masters.units.includes(it.unit)) state.masters.units.push(it.unit);
        if(it.oldVendor && !state.masters.vendors.includes(it.oldVendor)) state.masters.vendors.push(it.oldVendor);
        if(it.newVendor && !state.masters.vendors.includes(it.newVendor)) state.masters.vendors.push(it.newVendor);
      }
      saveState(); renderKpis(); renderList();
      toast(`新規${added}件 / 更新${replaced}件 を取り込みました`);
    }catch(err){
      console.error(err); toast('読み込みに失敗しました: '+err.message);
    }
    ev.target.value = '';
  };
  reader.readAsArrayBuffer(file);
}
function exportJson(){
  const data = {items: state.items, masters: state.masters, exportedAt: new Date().toISOString()};
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  downloadBlob(blob, `shiire-hikaku-backup-${todayStr().replace(/\W/g,'')}.json`);
}
function importJson(ev){
  const file = ev.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = e=>{
    try{
      const data = JSON.parse(e.target.result);
      if(!Array.isArray(data.items)) throw new Error('itemsがありません');
      if(!confirm('現在のデータを上書きします。よろしいですか？')) return;
      state.items = data.items;
      if(data.masters) state.masters = {...DEFAULT_MASTERS, ...data.masters};
      saveState(); renderKpis(); renderList(); renderSettings();
      toast('読み込みました');
    }catch(err){ toast('JSONが不正です: '+err.message); }
    ev.target.value='';
  };
  reader.readAsText(file);
}
function exportCsv(){
  const head = ['商品名','店舗','単位','月間使用量','旧仕入先','旧単価','旧送料','旧月発注','新仕入先','新単価','新送料','新月発注','月間削減額','年間削減額','削減率(%)','メモ'];
  const lines = [head.join(',')];
  state.items.forEach(it=>{
    const r = calcItem(it);
    const row = [it.name, it.store, it.unit, it.qty, it.oldVendor, it.oldPrice, it.oldShip, it.oldFreq,
                 it.newVendor, it.newPrice, it.newShip, it.newFreq,
                 r.monthSaving==null?'':Math.round(r.monthSaving),
                 r.yearSaving==null?'':Math.round(r.yearSaving),
                 r.savingRate==null?'':(r.savingRate*100).toFixed(1),
                 it.memo];
    lines.push(row.map(v=>{
      if(v==null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
    }).join(','));
  });
  const bom = '﻿';
  const blob = new Blob([bom+lines.join('\n')], {type:'text/csv;charset=utf-8'});
  downloadBlob(blob, `shiire-hikaku-${todayStr().replace(/\W/g,'')}.csv`);
}
function downloadBlob(blob, fname){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = fname; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
}

/* ---------- sample / clear ---------- */
function loadSample(){
  if(state.items.length>0 && !confirm('既存データに追加します。よろしいですか？')) return;
  const samples = [
    {name:'天然水 SPARKLING', store:'神楽坂/男マエ食道', unit:'本', qty:155,
     oldVendor:'オーリック', oldPrice:116.1, oldShip:0, oldFreq:20,
     newVendor:'アマゾン',   newPrice:76.45, newShip:0, newFreq:2, memo:''},
    {name:'割り箸(双生8寸)', store:'神楽坂/男マエ食道', unit:'膳', qty:900,
     oldVendor:'ハピネス',     oldPrice:3.03, oldShip:0, oldFreq:8,
     newVendor:'みやこオンライン', newPrice:2.57, newShip:0, newFreq:1, memo:''},
    {name:'おしぼり タイムリー', store:'神楽坂/男マエ食道', unit:'枚', qty:900,
     oldVendor:'ハピネス',     oldPrice:8.91, oldShip:0, oldFreq:5,
     newVendor:'王子タイムリー', newPrice:7.7, newShip:0, newFreq:1, memo:''},
    {name:'サラダ油16.5kg', store:'全店舗', unit:'缶', qty:2,
     oldVendor:'西原', oldPrice:7214, oldShip:0, oldFreq:2,
     newVendor:'ハピネス', newPrice:5562, newShip:0, newFreq:2, memo:''}
  ];
  samples.forEach(s=>{ s.id=uid(); s.createdAt=Date.now()+Math.random(); state.items.push(s); });
  saveState(); renderKpis(); renderList();
  toast('サンプルを追加しました');
}
function clearAll(){
  if(!confirm('すべてのデータを削除します。よろしいですか？')) return;
  if(!confirm('本当によろしいですか？元に戻せません。')) return;
  state.items = []; state.masters = structuredClone(DEFAULT_MASTERS);
  saveState(); renderKpis(); renderList(); renderSettings();
  toast('全データを削除しました');
}

/* ---------- helpers ---------- */
function escapeHtml(s){
  if(s==null) return '';
  return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}

/* ---------- URL params (shiire-app linkage) ---------- */
function handleUrlParams(){
  const p = new URLSearchParams(window.location.search);
  if(!p.get('name') && !p.get('source')) return false;
  // Pre-fill modal with old-side from shiire-app
  showTab('list');
  setTimeout(()=>{
    openItemModal();
    const fields = {
      'f-name':'name','f-store':'store','f-unit':'unit','f-qty':'qty',
      'f-old-vendor':'oldVendor','f-old-price':'oldPrice','f-old-ship':'oldShip','f-old-freq':'oldFreq'
    };
    Object.entries(fields).forEach(([elId, key])=>{
      const v = p.get(key); if(v!=null && v!=='') setVal(elId, v);
    });
    const note = p.get('source') ? `※ ${p.get('source')} から自動入力（旧側）。新仕入先を入力して保存してください。` : '';
    if(note){
      const memo = document.getElementById('f-memo');
      if(memo && !memo.value) memo.value = note;
    }
    updatePreview();
    // Clean URL so reload doesn't re-trigger
    if(window.history && window.history.replaceState){
      window.history.replaceState({}, '', window.location.pathname);
    }
    toast('shiire-app から旧側を自動入力しました');
  }, 80);
  return true;
}

/* ---------- init ---------- */
function init(){
  // まずローカルデータを読み込んで即表示（オフラインでも使える）
  loadState();
  document.getElementById('header-date').textContent = todayStr();
  renderKpis();
  showTab('list');
  handleUrlParams();
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }

  // Firebase 初期化＋ログイン状態の監視
  const ok = (typeof firebase !== 'undefined') && initFirebase();
  if(!ok){
    // Firebaseが使えない環境 → ローカルのみで動作
    cloudMode = false;
    setSyncPill('local');
    return;
  }
  setSyncPill('off');

  fbAuth.onAuthStateChanged(user=>{
    currentUser = user || null;
    if(user){
      // ログイン済み → クラウド共有モード
      cloudMode = true;
      document.getElementById('authOverlay').style.display = 'none';
      const pill = document.getElementById('syncPill');
      if(pill) pill.title = 'タップでログアウト（' + (user.email||'') + '）';
      cloudLoad();
    }else{
      // 未ログイン
      cloudMode = false;
      if(localStorage.getItem('hikakuSkipLogin')==='1'){
        // 「この端末だけで使う」を選んでいる → ログイン画面は出さない
        setSyncPill('local');
        document.getElementById('authOverlay').style.display = 'none';
      }else{
        // ログイン画面を表示
        setSyncPill('off');
        document.getElementById('authOverlay').style.display = 'flex';
      }
    }
  });
}
window.addEventListener('DOMContentLoaded', init);
