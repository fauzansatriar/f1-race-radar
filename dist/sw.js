"use strict";

const CACHE_PREFIX = "f1-race-radar-";
const CACHE = CACHE_PREFIX + "8a72060de3f99d05";
const SHELL = ["./","./assets/cars/alpine.webp","./assets/cars/astonmartin.webp","./assets/cars/audi.webp","./assets/cars/cadillac.webp","./assets/cars/ferrari.webp","./assets/cars/haasf1team.webp","./assets/cars/mclaren.webp","./assets/cars/mercedes.webp","./assets/cars/racingbulls.webp","./assets/cars/redbullracing.webp","./assets/cars/williams.webp","./assets/icon-180.png","./assets/icon-192.png","./assets/icon-512.png","./assets/icon-maskable-512.png","./index.html","./manifest.webmanifest","./pwa.js"];
const entry = new URL("./", self.registration.scope).href;
const assetPaths = new Set(SHELL.map((route) => new URL(route, entry).href));

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL.map((route) => new Request(new URL(route, entry), { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || !request.url.startsWith(entry)) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () => (await caches.open(CACHE)).match(entry)));
    return;
  }
  if (assetPaths.has(request.url)) {
    event.respondWith((async () => (await (await caches.open(CACHE)).match(request)) ?? fetch(request))());
  }
});
