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
  serviceAreaFSAs: ['L1S','L1T','L1Z','L1V','L1W','L1X','L1Y','L1M','L1N','L1P','L1R','L1G','L1H','L1J','L1K','L1L','L1B','L1C','L1E'],

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
    // Same-origin POST to the Pages Function — no CORS involved.
    // TODO (Phase 3): switch to a JSON body once the Turnstile widget
    // and functions/api/contact.js are wired up (see Deploy Static_Site.md).
    const res = await fetch(CONFIG.endpoint, {
      method: 'POST',
      body: new FormData(form)
    });
    const json = await res.json();
    if (json.ok) showSuccess();
    else throw new Error(json.error || 'Submission failed');
  } catch (err) {
    showError();
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
});
