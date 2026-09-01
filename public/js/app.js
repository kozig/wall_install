document.getElementById('year').textContent = new Date().getFullYear();

/* =============================================================
   CONFIG — the only part you edit.
   ============================================================= */
const CONFIG = {
  // Same-origin Cloudflare Pages Function — see functions/api/contact.js
  // (Phase 3 of ../../Deploy Static_Site.md). No CORS, no URL to edit.
  endpoint: '/api/contact',

  // Service area: the FSAs (first 3 characters of a postal code)
  // you cover. EDIT THIS. Below are EXAMPLE Durham Region FSAs —
  // verify each one and adjust to the areas you actually serve.
  serviceAreaFSAs: ['L3B','L5V','L5C','L5T','L5R','L5A','L5B','L4Z','L6R','L5K','L5L','L5M','L4A','L4W','L5G','L5H','L4Y','L5N','L5W','L9E','L5E','L4X','M7R','L5J','L9X','L6L','L6J','L6H'],

  // true  → refuse out-of-area submissions
  // false → allow them, but flag the lead as out_of_area (default)
  hardBlockOutOfArea: false
};
/* ============================================================= */

const form = document.getElementById('quote-form');
const statusEl = document.getElementById('form-status');
const submitBtn = form.querySelector('button[type="submit"]');
const postal = document.getElementById('postal');
const postalNote = document.getElementById('postal-note');
const outField = document.getElementById('out_of_area');

// Lets the server reject bot submissions that fire instantly, or stale
// retries of a long-abandoned page load.
document.getElementById('ts').value = Date.now();

// ---- service-area (FSA) check ----
function checkServiceArea() {
  const val = postal.value.trim();
  if (!/^[A-Za-z]\d[A-Za-z]/.test(val)) {   // not enough to judge yet
    postalNote.hidden = true; outField.value = 'no'; return true;
  }
  const fsa = val.toUpperCase().replace(/\s+/g, '').slice(0, 3);
  const inArea = CONFIG.serviceAreaFSAs.map(f => f.toUpperCase()).includes(fsa);
  outField.value = inArea ? 'no' : 'yes';
  if (inArea) {
    postalNote.hidden = true;
  } else {
    postalNote.className = 'field-note warn';
    postalNote.textContent = CONFIG.hardBlockOutOfArea
      ? 'Sorry — that postal code is outside our current service area.'
      : "Heads up — that's outside our usual area. You can still send your request and we'll confirm whether we can reach you.";
    postalNote.hidden = false;
  }
  return inArea;
}
postal.addEventListener('blur', checkServiceArea);
postal.addEventListener('input', () => { if (!postalNote.hidden) checkServiceArea(); });

// ---- status helpers ----
function showSuccess() {
  form.hidden = true;
  statusEl.className = 'form-status ok';
  statusEl.textContent = "Request sent. We'll be in touch shortly to confirm a time and price.";
  statusEl.hidden = false;
  statusEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function showError() {
  statusEl.className = 'form-status err';
  statusEl.innerHTML = 'Something went wrong sending that. Please try again, or call us at <a href="tel:+1XXXXXXXXXX">(XXX)&nbsp;XXX-XXXX</a>.';
  statusEl.hidden = false;
}

// ---- submit ----
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!form.reportValidity()) return;

  const inArea = checkServiceArea();
  if (CONFIG.hardBlockOutOfArea && !inArea) { postal.focus(); return; }

  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending…';
  statusEl.hidden = true;

  try {
    // Same-origin JSON POST to the Pages Function — no CORS involved.
    // Includes the honeypot (if a bot filled it), ts, and the
    // cf-turnstile-response token the widget injects into the form.
    const payload = Object.fromEntries(new FormData(form).entries());
    const res = await fetch(CONFIG.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (json.ok) showSuccess();
    else throw new Error(json.error || 'Submission failed');
  } catch (err) {
    showError();
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
    if (window.turnstile) window.turnstile.reset();
  }
});
