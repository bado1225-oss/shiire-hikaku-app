const CACHE = 'shiire-hikaku-v5';
const ASSETS = [
  './',
  './index.html',
  './src/style.css?v=4',
  './src/app.js?v=5',
  './manifest.webmanifest?v=3',
  './icons/icon-192.png?v=3',
  './icons/icon-512.png?v=3'
];
self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS).catch(()=>{})));
  self.skipWaiting();   // 新しいSWを即座に有効化（更新を早く反映）
});
self.addEventListener('activate', e=>{
  // 古いバージョンのキャッシュを削除
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e=>{
  if(e.request.method!=='GET') return;
  const req = e.request;
  const url = new URL(req.url);

  // 別オリジン（Firebase / Google など）はキャッシュに介入せず、そのまま通す
  if(url.origin !== self.location.origin) return;

  // HTML（ページ本体）は常に最新をネットから取得する。
  // ※ ここをキャッシュ優先にすると、アプリを更新しても古い画面が出続けてしまうため。
  const isHTML = req.mode==='navigate' || (req.headers.get('accept')||'').includes('text/html');
  if(isHTML){
    e.respondWith(
      fetch(req).then(res=>{
        const copy = res.clone();
        caches.open(CACHE).then(c=>{ try{ c.put(req, copy); }catch(_){}});
        return res;
      }).catch(()=>caches.match(req).then(hit=>hit||caches.match('./index.html')))
    );
    return;
  }

  // それ以外（CSS / JS / 画像）はキャッシュ優先（?v= でバージョン管理しているため高速）
  e.respondWith(
    caches.match(req).then(hit=>{
      if(hit) return hit;
      return fetch(req).then(res=>{
        const copy = res.clone();
        caches.open(CACHE).then(c=>{ try{ c.put(req, copy); }catch(_){}});
        return res;
      }).catch(()=>caches.match('./index.html'));
    })
  );
});
