const MEDIAPIPE_WASM_SRI = new Map([
  // Populate with production hashes during release hardening.
  // ['/assets/vision_wasm_internal.wasm', 'sha384-...'],
]);

async function sha384Base64(buffer) {
  const digest = await crypto.subtle.digest('SHA-384', buffer);
  return `sha384-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.endsWith('.wasm')) return;

  event.respondWith((async () => {
    const response = await fetch(event.request, { cache: 'no-store' });
    const buffer = await response.clone().arrayBuffer();
    const expected = MEDIAPIPE_WASM_SRI.get(url.pathname);
    if (expected && await sha384Base64(buffer) !== expected) {
      return new Response('WASM integrity validation failed', { status: 421, statusText: 'Misdirected Request' });
    }
    return new Response(buffer, response);
  })());
});
