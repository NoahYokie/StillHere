const CACHE_NAME = 'stillhere-v1';
const STATIC_ASSETS = [
  '/',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('push', (event) => {
  if (!event.data) return;

  const data = event.data.json();
  const title = data.title || 'StillHere';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-96x96.png',
    tag: data.tag || 'stillhere-notification',
    renotify: true,
    data: { url: data.url || '/' },
    actions: data.tag === 'checkin-reminder'
      ? [{ action: 'checkin', title: "I'm OK" }]
      : [],
  };

  event.waitUntil(
    self.registration.showNotification(title, options).then(() => {
      if (data.tag === 'location-wake') {
        return wakeUpClient();
      }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const url = event.notification.data?.url || '/';

  if (event.action === 'checkin') {
    event.waitUntil(
      fetch('/api/checkin', { method: 'POST', credentials: 'same-origin' })
        .then(() => focusOrOpen(url))
        .catch(() => focusOrOpen(url))
    );
  } else {
    event.waitUntil(focusOrOpen(url));
  }
});

async function focusOrOpen(url) {
  const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windowClients) {
    if (client.url.includes(self.location.origin)) {
      client.focus();
      client.navigate(url);
      return;
    }
  }
  return self.clients.openWindow(url);
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'live-location-sync') {
    event.waitUntil(wakeUpClient());
  }
});

async function wakeUpClient() {
  const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (windowClients.length > 0) {
    windowClients[0].postMessage({ type: 'resume-location-tracking' });
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  
  const url = new URL(event.request.url);
  
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});
