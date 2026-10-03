/* Service worker minimal : requis pour l'installation de l'appli. Aucun cache : l'appli est toujours à jour. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  var r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== self.location.origin) return;
  e.respondWith(fetch(r).catch(function () { return new Response('Hors connexion : reconnectez-vous pour utiliser Jeux d\u2019Oliv.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); }));
});

/* Notifications push */
self.addEventListener('push', function (e) {
  var d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: 'Jeux d’Oliv', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Jeux d’Oliv', {
    body: d.body || '', icon: 'icon-me.png', badge: 'badge.png', tag: d.tag || undefined, renotify: !!d.tag,
    data: { url: d.url || './' }, lang: 'fr', image: d.image || undefined
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (l) {
    for (var i = 0; i < l.length; i++) if ('focus' in l[i]) return l[i].focus();
    return self.clients.openWindow(url);
  }));
});
