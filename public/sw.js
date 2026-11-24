'use strict';
/* 永荣校园墙 · Service Worker（静态资源缓存优先，API 只走网络） */

const CACHE_NAME = 'yr-wall-v6';
const PRECACHE = [
  '/', '/index.html', '/styles.css', '/fonts.css',
  '/app.js', '/manifest.json', '/icon-192.png', '/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key.startsWith('yr-wall-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  // 接口请求不做缓存，始终走网络，保证审核/点赞等状态实时
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) {
      // 先返回缓存，再后台更新缓存
      event.waitUntil(
        fetch(request).then(response => {
          if (response && response.ok) return cache.put(request, response.clone());
        }).catch(() => {})
      );
      return cached;
    }
    try {
      const response = await fetch(request);
      if (response && response.ok) {
        try { await cache.put(request, response.clone()); } catch { /* 缓存写失败不影响返回 */ }
      }
      return response;
    } catch {
      return Response.error();
    }
  })());
});
