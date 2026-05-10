const CACHE = 'shiire-hikaku-v3';
const ASSETS = [
  './',
  './index.html',
  './src/style.css?v=3',
  './src/app.js?v=3',
  './manifest.webmanifest?v=3',
  './icons/icon-192.png?v=3',
  './icons/icon-512.png?v=3'
];
self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS).catch(()=>{})));
  self.skipWaiting();
});
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e=>{
  if(e.request.method!=='GET') return;
  e.respondWith(
    caches.match(e.request).then(hit=>{
      if(hit) return hit;
      return fetch(e.request).then(res=>{
        const copy = res.clone();
        caches.open(CACHE).then(c=>{ try{ c.put(e.request, copy); }catch(_){}});
        return res;
      }).catch(()=>caches.match('./index.html'));
    })
  );
});
