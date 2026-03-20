
const CACHE_NAME = 'sniper-v15-cache-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/index.css',
  '/manifest.json'
];

// Installation du Service Worker
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

// Activation et nettoyage des anciens caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
    })
  );
});

// Stratégie de cache: Network First
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// Écoute des notifications Push
self.addEventListener('push', (event) => {
  let data = { title: 'Nouveau Signal Sniper', body: 'Une opportunité a été détectée.' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: 'https://cdn-icons-png.flaticon.com/512/2091/2091665.png',
    badge: 'https://cdn-icons-png.flaticon.com/512/2091/2091665.png',
    vibrate: [200, 100, 200],
    data: {
      url: self.location.origin + '/#/signal/' + (data.id || '')
    }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// Clic sur la notification
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url)
  );
});
