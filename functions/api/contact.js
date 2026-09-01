// Same-origin contact-form handler. Not auto-routed — src/index.js's
// Worker fetch handler calls onRequestPost() directly for POST /api/contact
// (see wrangler.toml / src/index.js; this project deploys as a Workers
// Builds project, not classic Pages, so the functions/ folder convention
// alone does nothing). Re-validates everything server-side — the client
// checks in public/js/app.js are UX only.
//
// env.TURNSTILE_SECRET / env.APPS_SCRIPT_URL / env.SHARED_SECRET must be
// set via `npx wrangler secret put <NAME>` (from the repo root, so it
// picks up wrangler.toml's project name) — NOT the dashboard's "Runtime
// Variables and Secrets" UI. On this project (a git-connected Workers
// Builds deployment with a wrangler.toml checked in), dashboard-set vars
// silently never reach `env`; only `wrangler secret put` actually binds.
// Verify what's bound with `wrangler secret list` (names only, no values).
// Nothing in this repo sets them — get the values from:
//   TURNSTILE_SECRET  — Cloudflare dashboard → Turnstile → your widget
//   APPS_SCRIPT_URL   — the Apps Script Web App's /exec URL (Phase 2)
//   SHARED_SECRET     — a long random string, matching Script Properties
//                        SHARED_SECRET in the Apps Script project

const POSTAL_RE = /^[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Authoritative service-area check. Must stay in sync with
// public/js/app.js CONFIG.serviceAreaFSAs — that copy is UX only.
const SERVICE_AREA = new Set([
  'L1S', 'L1T', 'L1Z', 'L1V', 'L1W', 'L1X', 'L1Y', 'L1M', 'L1N',
  'L1P', 'L1R', 'L1G', 'L1H', 'L1J', 'L1K', 'L1L', 'L1B', 'L1C', 'L1E',
]);

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost({ request, env }) {
  const ip = request.headers.get('CF-Connecting-IP') || '';

  const raw = await request.text();
  if (raw.length > 20000) return json({ ok: false, error: 'too-large' }, 413);

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'bad-json' }, 400);
  }

  // Honeypot: bots tick this hidden checkbox; pretend success so as not
  // to tip them off, and never store or notify.
  if (body.botcheck) return json({ ok: true });

  // Reject sub-3-second (bot) and stale (>30 min) submissions.
  const ts = Number(body.ts || 0);
  const age = Date.now() - ts;
  if (!ts || age < 3000 || age > 1800000) {
    return json({ ok: false, error: 'timing' }, 400);
  }

  const first  = (body.first_name || '').trim();
  const last   = (body.last_name || '').trim();
  const email  = (body.email || '').trim();
  const phone  = (body.phone || '').trim();
  const postal = (body.postal_code || '').trim().toUpperCase();
  const stype  = (body.service_type || '').trim();
  const req    = (body.work_request || '').trim();

  if (!first || !last || !req) {
    return json({ ok: false, error: 'missing-fields' }, 400);
  }
  if (!EMAIL_RE.test(email)) {
    return json({ ok: false, error: 'invalid-email' }, 400);
  }
  if (!POSTAL_RE.test(postal)) {
    return json({ ok: false, error: 'invalid-postal' }, 400);
  }

  const fsa = postal.replace(/\s+/g, '').slice(0, 3);
  const outOfArea = SERVICE_AREA.has(fsa) ? 'no' : 'yes';

  // Turnstile server-side verification — the widget's checkmark is UX
  // only, this call is the actual security boundary.
  const tsForm = new FormData();
  tsForm.append('secret', env.TURNSTILE_SECRET);
  tsForm.append('response', body['cf-turnstile-response'] || '');
  tsForm.append('remoteip', ip);
  const verify = await fetch(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    { method: 'POST', body: tsForm }
  );
  const outcome = await verify.json();
  if (!outcome.success) {
    return json({ ok: false, error: 'captcha', codes: outcome['error-codes'] }, 403);
  }

  // Forward to Apps Script. Its URL and the shared secret live only in
  // this function's env — never in client code or the repo.
  const forwardPayload = {
    secret: env.SHARED_SECRET,
    first_name: first,
    last_name: last,
    email,
    phone,
    postal_code: postal,
    service_type: stype,
    work_request: req,
    out_of_area: outOfArea,
    ip,
    ts,
  };

  try {
    const gs = await fetch(env.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(forwardPayload),
      // fetch() follows the 302 Apps Script issues automatically.
    });
    // Apps Script can 404/error-page instead of returning JSON (e.g. a
    // stale /exec URL) — parse defensively rather than letting that throw
    // an unhelpful "Unexpected token <" from JSON.parse.
    const gsText = await gs.text();
    let gsData;
    try {
      gsData = JSON.parse(gsText);
    } catch {
      throw new Error('apps-script-non-json-response');
    }
    if (!gsData.ok) throw new Error(gsData.error || 'apps-script-failed');
    return json({ ok: true, id: gsData.id });
  } catch (err) {
    // Logged (never includes lead data) so a future 502 is diagnosable
    // from the Cloudflare dashboard's Logs tab or `wrangler tail` without
    // re-adding debug statements.
    console.log('apps-script forward failed', { message: String(err) });
    // TODO (Phase 4): write to a KV fallback here so a down/misconfigured
    // Apps Script never silently loses a submitted lead.
    return json({ ok: false, error: 'backend-unavailable' }, 502);
  }
}
