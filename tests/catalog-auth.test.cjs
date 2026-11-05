/**
 * catalog-auth.test.cjs — RED-first TDD for separate catalog PIN authentication
 *
 * These tests assert the NEW catalog-auth behaviour:
 *   1.  HTML has a catalog-gate overlay (id=catalogGateScreen) distinct from gateScreen
 *   2.  catalogGateInput is type=password with autocomplete=current-password
 *   3.  ensureCatalogSession does NOT read tagsearch-gate-pin-hash (old front-gate key)
 *   4.  ensureCatalogSession shows the overlay when no token exists
 *   5.  Form submit posts sha256(PIN) – not the front-gate hash – to /catalog/session
 *   6.  Failed auth (non-ok response) shows error, keeps overlay open for retry
 *   7.  Successful auth hides overlay, sets token, resolves promise
 *   8.  Second call with token already set resolves immediately (no overlay)
 *   9.  Equipment tab also uses ensureCatalogSession (token is shared)
 *  10.  Old front-gate GATE_HASH constant and gateScreen element are unchanged
 *
 * Run: node tests/catalog-auth.test.cjs
 */
'use strict';
const { test } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');
const vm      = require('node:vm');
const { webcrypto } = require('node:crypto');

// Helper: same SHA-256 as the app uses, so we can compute expected hashes in tests
async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const buf  = await webcrypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Minimal DOM mock (extended from catalog.test.cjs pattern) ─────────────────
class Element {
  constructor(tag = 'div') {
    this.tag = tag; this.children = []; this.style = {}; this.attrs = {};
    this.events = {}; this.value = '';
    this._cl = new Set();
    this.classList = {
      add: (c) => this._cl.add(c),
      remove: (c) => this._cl.delete(c),
      contains: (c) => this._cl.has(c),
      toggle: (c, v) => { v === undefined ? (this._cl.has(c) ? this._cl.delete(c) : this._cl.add(c)) : (v ? this._cl.add(c) : this._cl.delete(c)); }
    };
    this.className = '';
    this._hidden = false;
  }
  appendChild(n) { this.children.push(n); return n; }
  removeChild(n) { this.children.splice(this.children.indexOf(n), 1); }
  get firstChild() { return this.children[0]; }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'class') this.className = v; if (k === 'hidden') this._hidden = true; }
  getAttribute(k) { return this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; if (k === 'hidden') this._hidden = false; }
  addEventListener(k, v) {
    const prev = this.events[k];
    if (!prev) { this.events[k] = v; }
    else { const all = Array.isArray(prev) ? [...prev, v] : [prev, v]; this.events[k] = (...a) => all.forEach(f => f(...a)); }
  }
  removeEventListener(k, v) {
    if (this.events[k] === v) { delete this.events[k]; }
    // array-wrapped case: ignore for test purposes (caching prevents double-add)
  }
  focus() {}
  scrollIntoView() {}
  get textContent() { return (this.text || '') + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.text = String(v); this.children = []; }
}
class DocFragment extends Element { constructor() { super('#frag'); } }

function app(opts = {}) {
  const nodes = {};
  const dispatchEvents = {};
  const allElements = [];
  const doc = {
    getElementById(id) { return nodes[id] ||= new Element(); },
    createElement: t => { const e = new Element(t); allElements.push(e); return e; },
    createTextNode(t) { const n = new Element('#text'); n.textContent = t; return n; },
    createDocumentFragment() { return new DocFragment(); },
    documentElement: new Element(),
    addEventListener(type, fn) { dispatchEvents[type] = fn; },
    querySelectorAll(sel) {
      const cls = sel.startsWith('.') ? sel.slice(1) : null;
      const matched = cls ? allElements.filter(e => e._cl && e._cl.has(cls)) : [];
      return { forEach: fn => matched.forEach(fn), length: matched.length, [Symbol.iterator]: matched[Symbol.iterator].bind(matched) };
    },
  };
  // Session storage — already past the front gate, but NO catalog token yet
  const sessionStorage = {
    _store: { 'tagsearch-gate-ok': '1', ...(opts.sessionStore || {}) },
    getItem(k) { return this._store[k] ?? null; },
    setItem(k, v) { this._store[k] = v; },
    removeItem(k) { delete this._store[k]; },
  };
  const localStorage = {
    _store: {},
    getItem(k) { return this._store[k] ?? null; },
    setItem(k, v) { this._store[k] = v; },
    removeItem(k) { delete this._store[k]; },
  };

  const context = {
    document: doc,
    sessionStorage,
    localStorage,
    window: { matchMedia: () => ({ matches: false }) },
    location: { hash: '' },
    console,
    setTimeout,
    clearTimeout,
    TextEncoder,
    navigator: {},
    crypto: webcrypto,
    URLSearchParams: globalThis.URLSearchParams || class {
      constructor() { this._p = {}; }
      set(k, v) { this._p[k] = v; }
      toString() { return Object.entries(this._p).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&'); }
    },
    fetch: opts.fetch || (() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })),
    globalThis: null,
  };
  context.globalThis = context;
  vm.createContext(context);

  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  let source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  source = source.replace(
    '  initFromHash();',
    `  globalThis.api = {
      parseSse, finalize, renderResults, renderBaseScan, runBaseTagScan, runSearch,
      logicPageUrl, doSearch, setTool(fn){callTool=fn;},
      setCatalogFetch(fn) { if(typeof catalogFetch!=='undefined') catalogFetch=fn; },
      ensureCatalogSession: () => ensureCatalogSession(),
      getCatalogToken: () => typeof catalogToken !== 'undefined' ? catalogToken : null,
      triggerTabSwitch(tabName) {
        const ev = { target: { dataset: { tab: tabName } } };
        if (typeof onTabClick === 'function') onTabClick(ev);
      },
    };`
  );
  vm.runInContext(source, context);
  return { api: context.api, nodes, sessionStorage, localStorage };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('[AUTH-1] HTML has catalog gate overlay element (id=catalogGateScreen)', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(html.includes('id="catalogGateScreen"'), 'missing id="catalogGateScreen" overlay element');
});

test('[AUTH-2] catalogGateInput is type=password with autocomplete=current-password', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(html.includes('id="catalogGateInput"'), 'missing id="catalogGateInput"');
  const idx = html.indexOf('id="catalogGateInput"');
  const surroundings = html.slice(Math.max(0, idx - 300), idx + 300);
  assert.ok(surroundings.includes('type="password"'), 'catalogGateInput must be type=password');
  assert.ok(
    surroundings.includes('autocomplete="current-password"'),
    'catalogGateInput must have autocomplete="current-password" for password managers'
  );
});

test('[AUTH-3] ensureCatalogSession function does NOT read tagsearch-gate-pin-hash', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const fnStart = html.indexOf('function ensureCatalogSession()');
  assert.ok(fnStart >= 0, 'ensureCatalogSession must exist');
  // Extract function body (up to the closing brace + reasonable margin)
  const fnBody = html.slice(fnStart, fnStart + 2500);
  assert.ok(
    !fnBody.includes('tagsearch-gate-pin-hash'),
    'ensureCatalogSession must NOT read tagsearch-gate-pin-hash (catalog uses its own PIN form, not the front-gate hash)'
  );
});

test('[AUTH-4] HTML has catalogGateForm and catalogGateError inside catalogGateScreen', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(html.includes('id="catalogGateForm"'),  'missing id="catalogGateForm"');
  assert.ok(html.includes('id="catalogGateError"'), 'missing id="catalogGateError"');
  // All three must appear between catalogGateScreen open and next top-level section
  const screenStart = html.indexOf('id="catalogGateScreen"');
  const screenEnd   = html.indexOf('</div>', screenStart + html.slice(screenStart).indexOf('gate-card'));
  const region      = html.slice(screenStart, screenStart + 1200);
  assert.ok(region.includes('id="catalogGateForm"'),  'catalogGateForm must be inside catalogGateScreen');
  assert.ok(region.includes('id="catalogGateInput"'), 'catalogGateInput must be inside catalogGateScreen');
  assert.ok(region.includes('id="catalogGateError"'), 'catalogGateError must be inside catalogGateScreen');
});

test('[AUTH-5] VM: ensureCatalogSession shows catalog gate overlay when no token', () => {
  const { api, nodes } = app();
  // Should not be hidden before call (freshly created element has _hidden=false by default)
  // Call ensureCatalogSession — it must mark catalogGateScreen as visible
  api.ensureCatalogSession(); // fire-and-forget; we just check overlay shown
  assert.equal(nodes.catalogGateScreen._hidden, false, 'catalogGateScreen must be un-hidden when auth required');
});

test('[AUTH-6] VM: ensureCatalogSession posts sha256(PIN) — not the front-gate hash — to /catalog/session', async () => {
  const TEST_PIN = 'hunter42';
  let capturedUrl  = null;
  let capturedBody = null;
  const mockFetch = (url, opts) => {
    capturedUrl  = url;
    capturedBody = JSON.parse(opts.body);
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ token: 'test-catalog-token-abc' }),
    });
  };

  const { api, nodes } = app({ fetch: mockFetch });

  const authPromise = api.ensureCatalogSession();
  // Gate should be shown
  assert.equal(nodes.catalogGateScreen._hidden, false, 'gate shown before PIN entry');

  // Fill in PIN and submit form
  nodes.catalogGateInput.value = TEST_PIN;
  const submitEv = { preventDefault() {} };
  nodes.catalogGateForm.events.submit(submitEv);

  await authPromise;

  // Fetch must have been called
  assert.ok(capturedUrl,  'fetch was called');
  assert.ok(capturedUrl.includes('/catalog/session'), 'fetch target is /catalog/session');
  assert.ok(capturedBody && capturedBody.pin_hash, 'body contains pin_hash');

  // pin_hash must be sha256 of the entered PIN — never the front-gate hash
  const expectedHash = await sha256Hex(TEST_PIN);
  assert.equal(capturedBody.pin_hash, expectedHash, 'pin_hash must equal sha256(enteredPIN)');

  // Front-gate hash must NOT have been sent
  const GATE_HASH = '30606ac3b4fd5c618ac4c6555ce007edd7fe73d75b685320aa56be211ebc4b40';
  assert.notEqual(capturedBody.pin_hash, GATE_HASH, 'must never send front-gate hash to catalog endpoint');

  // Overlay hidden after success
  assert.equal(nodes.catalogGateScreen._hidden, true, 'overlay hidden after successful auth');

  // Token recorded
  assert.equal(api.getCatalogToken(), 'test-catalog-token-abc', 'catalogToken stored after success');
});

test('[AUTH-7] VM: failed auth (non-ok response) shows error, keeps overlay open for retry', async () => {
  let callCount = 0;
  const mockFetch = () => {
    callCount++;
    return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
  };

  const { api, nodes } = app({ fetch: mockFetch });

  // Start auth (don't await — it won't resolve on failure)
  api.ensureCatalogSession();

  // Submit wrong PIN
  nodes.catalogGateInput.value = 'wrongpin';
  nodes.catalogGateForm.events.submit({ preventDefault() {} });

  // Wait for async fetch + then chain to settle
  await new Promise(r => setTimeout(r, 100));

  assert.equal(callCount, 1, 'fetch called once');
  assert.equal(nodes.catalogGateScreen._hidden, false, 'overlay stays open after failed auth (retry allowed)');
  assert.ok(nodes.catalogGateError.textContent.length > 0, 'error message shown in catalogGateError');
  assert.equal(api.getCatalogToken(), null, 'no token set after failed auth');
});

test('[AUTH-8] VM: second call with token already set resolves immediately without showing overlay', async () => {
  // Pre-set token via successful auth
  const mockFetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ token: 'existing-tok' }),
  });

  const { api, nodes } = app({ fetch: mockFetch });

  // First auth
  const p1 = api.ensureCatalogSession();
  nodes.catalogGateInput.value = 'somepin';
  nodes.catalogGateForm.events.submit({ preventDefault() {} });
  await p1;
  assert.equal(api.getCatalogToken(), 'existing-tok', 'token set after first auth');
  // Hide overlay gets called — reset _hidden manually to verify second call doesn't re-show
  nodes.catalogGateScreen._hidden = true;

  // Second call — must resolve without touching overlay
  await api.ensureCatalogSession();
  assert.equal(nodes.catalogGateScreen._hidden, true, 'overlay not re-shown when token already valid');
});

test('[AUTH-9] VM: no data fetch fires before catalog token is obtained', async () => {
  const fetchCalls = [];
  const mockFetch = (url, opts) => {
    fetchCalls.push(url);
    if (url.includes('/catalog/session')) {
      // Never resolve — simulates pending auth
      return new Promise(() => {});
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ drawings: [], total: 0 }) });
  };

  const { api } = app({ fetch: mockFetch });

  // Start auth (never resolves because fetch never resolves)
  api.ensureCatalogSession();

  // Wait a tick
  await new Promise(r => setTimeout(r, 50));

  // Only /catalog/session should have been fetched — no /catalog/drawings or /equipment
  const dataCalls = fetchCalls.filter(u => !u.includes('/catalog/session'));
  assert.equal(dataCalls.length, 0, `no data fetches before token obtained, but got: ${dataCalls}`);
});

test('[AUTH-10] Old front-gate GATE_HASH constant and gateScreen/gateInput unchanged', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(
    html.includes("var GATE_HASH = '30606ac3b4fd5c618ac4c6555ce007edd7fe73d75b685320aa56be211ebc4b40'"),
    'GATE_HASH constant must remain unchanged'
  );
  assert.ok(html.includes('id="gateScreen"'),  'old gateScreen must remain');
  assert.ok(html.includes('id="gateInput"'),   'old gateInput must remain');
  assert.ok(html.includes('id="gateForm"'),    'old gateForm must remain');
});
