// Worker entry point. This project deploys through Cloudflare's Workers
// Builds pipeline (a native Workers script, not classic Pages Functions),
// so /api/contact has to be routed explicitly here — dropping a file in
// functions/api/ alone does nothing without this file + wrangler.toml's
// [assets] binding.
//
// The actual contact-form logic lives in functions/api/contact.js and is
// reused as-is (its onRequestPost({ request, env }) signature happens to
// be exactly what we need to call here).
import { onRequestPost as handleContact } from '../functions/api/contact.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/contact' && request.method === 'POST') {
      return handleContact({ request, env });
    }
    return env.ASSETS.fetch(request);
  },
};
