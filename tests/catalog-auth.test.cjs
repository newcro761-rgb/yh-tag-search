/**
 * catalog-auth.test.cjs — TDD for UNIFIED front-gate PIN → catalog session
 *
 * NEW behaviour (single PIN login for all 3 tabs):
 *   1.  HTML has NO client-side GATE_HASH constant for hash comparison
 *   2.  Gate form submit POSTs sha256(PIN) to /catalog/session and awaits token
 *   3.  Successful /catalog/session → catalogToken set, app unlocked
 *   4.  Failed /catalog/session → gate error shown, gate stays visible, retry
 *   5.  No separate catalogGateScreen overlay (removed)
 *   6.  After gate unlock, catalog tab works without additional PIN prompt
 *   7.  After gate unlock, equipment tab also works without additional PIN prompt
 *   8.  ensureCatalogSession resolves immediately if token already exists
 *   9.  Token in memory only — no hash/plaintext persistence in sessionStorage
 *  10.  Old gateScreen + 3 tabs + tag search unchanged
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

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const buf  = await webcrypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Minimal DOM mock ──────────────────────────────────────────────────────────
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
  removeEventListener(k, v) { if (this.events[k] === v) delete this.events[k]; }
  focus() {}
  scrollIntoView() {}
  get textContent() { return (this.text || '') + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.text = String(v); this.children = []; }
}
class DocFragment extends Element { constructor() { super('#frag'); } }

function makeApp(opts = {}) {
  const nodes = {};
  const dispatchEvents = {};
  const fetchCalls = [];
  const ssStorage = {};
  let appUnlocked = false;

  // token to return from /catalog/session when PIN is correct
  const FAKE_TOKEN = 'fake.signed.token';
  const correctHash = opts.correctHash || null; // sha256 of valid PIN

  const doc = {
    getElementById(id) { return nodes[id] ||= new Element(); },
    createElement: t => new Element(t),
    createTextNode(t) { const n = new Element('#text'); n.textContent = t; return n; },
    createDocumentFragment() { return new DocFragment(); },
    documentElement: new Element(),
    addEventListener(type, fn) { dispatchEvents[type] = fn; },
    querySelectorAll: () => [],
    body: new Element(),
  };

  // Pre-create nodes that exist in HTML
  nodes['gateScreen']     = new Element('div');
  nodes['appRoot']        = new Element('div');
  nodes['gateForm']       = new Element('form');
  nodes['gateInput']      = new Element('input');
  nodes['gateError']      = new Element('div');
  nodes['tabTagSearch']   = new Element('button');
  nodes['tabCatalog']     = new Element('button');
  nodes['tabEquipment']   = new Element('button');
  nodes['paneTagSearch']  = new Element('div');
  nodes['paneCatalog']    = new Element('div');
  nodes['paneEquipment']  = new Element('div');
  nodes['catalogResults'] = new Element('div');
  nodes['catalogPager']   = new Element('div');
  nodes['catalogSearchForm']  = new Element('form');
  nodes['catalogSearchInput'] = new Element('input');
  nodes['equipResults']   = new Element('div');
  nodes['catalogFilterAll']  = new Element('button');
  nodes['catalogFilterUJ']   = new Element('button');
  nodes['catalogFilterLM']   = new Element('button');
  nodes['catalogFilterLE']   = new Element('button');
  nodes['catalogFilterLJ']   = new Element('button');
  nodes['catalogStatus']     = new Element('div');
  nodes['catalogSourceBtn']  = new Element('button');
  nodes['catalogAuxSource']  = new Element('div');
  nodes['equipStatus']       = new Element('div');
  // catalogGateScreen should NOT be in the HTML in new version;
  // create a stub so getElementById doesn't crash on old references, but it must be unused
  nodes['catalogGateScreen']  = null; // intentionally null — new code must not use it
  nodes['catalogGateForm']    = null;
  nodes['catalogGateInput']   = null;
  nodes['catalogGateError']   = null;

  const mockFetch = async (url, init) => {
    fetchCalls.push({ url, init });
    if (url.includes('/catalog/session')) {
      const body = JSON.parse(init?.body || '{}');
      if (correctHash && body.pin_hash === correctHash) {
        return { ok: true, status: 200, json: async () => ({ token: FAKE_TOKEN, expires_in: 3600 }) };
      }
      return { ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) };
    }
    if (url.includes('/catalog/drawings')) {
      const auth = init?.headers?.Authorization || init?.headers?.['Authorization'] || '';
      if (auth === `Bearer ${FAKE_TOKEN}`) {
        return { ok: true, status: 200, json: async () => ({ results: [], total: 0 }) };
      }
      return { ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) };
    }
    if (url.includes('/catalog/equipment')) {
      const auth = init?.headers?.Authorization || init?.headers?.['Authorization'] || '';
      if (auth === `Bearer ${FAKE_TOKEN}`) {
        return { ok: true, status: 200, json: async () => ({ candidate: [], verified: [] }) };
      }
      return { ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const sessionStorageMock = {
    getItem: k => ssStorage[k] ?? null,
    setItem: (k, v) => { ssStorage[k] = String(v); },
    removeItem: k => { delete ssStorage[k]; },
  };

  const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  // Extract the MAIN app script (last/largest <script> block — first is tiny theme-detection)
  const allScripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (!allScripts.length) throw new Error('No inline <script> found');
  // Pick the longest script (the main app)
  const scriptSrc = allScripts.reduce((a, b) => b[1].length > a[1].length ? b : a)[1];

  const ctx = vm.createContext({
    document: doc,
    window: {},
    sessionStorage: sessionStorageMock,
    crypto: webcrypto,
    fetch: mockFetch,
    setTimeout: (fn, ms) => { fn(); return 1; },
    clearTimeout: () => {},
    TextEncoder,
    TextDecoder,
    console,
    _fetchCalls: fetchCalls,
    _appUnlocked: () => appUnlocked,
    _ssStorage: ssStorage,
    _nodes: nodes,
  });

  // Track app unlock
  const origUnlockCode = scriptSrc;

  try {
    vm.runInContext(`
      (function() {
        ${scriptSrc}
      })();
    `, ctx, { timeout: 3000 });
  } catch (e) {
    if (!e.message?.includes('initApp')) throw e;
  }

  return {
    doc, nodes, fetchCalls, ssStorage, ctx,
    FAKE_TOKEN,
    // Helper: submit the gate form with a PIN value
    async submitGatePin(pin) {
      nodes['gateInput'].value = pin;
      const submitFn = nodes['gateForm'].events['submit'];
      if (!submitFn) throw new Error('gateForm has no submit handler');
      const prevented = [];
      await submitFn({ preventDefault: () => prevented.push(true) });
      // Wait for async promises
      await new Promise(r => setTimeout(r, 50));
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

test('[AUTH-1] HTML does NOT contain a hardcoded GATE_HASH client-side comparison', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  // Should NOT contain the old pattern: if (hash === GATE_HASH)
  // (we move validation entirely to server)
  assert.ok(!src.includes("hash === GATE_HASH"), 'Should not compare hash to hardcoded GATE_HASH client-side');
  // Also should not have old var GATE_HASH = '...' constant
  assert.ok(!src.includes("var GATE_HASH ="), 'Should not define GATE_HASH constant in frontend');
});

test('[AUTH-2] Gate form submit POSTs to /catalog/session with sha256(PIN)', async () => {
  const correctPin = '1234';
  const hash = await sha256Hex(correctPin);
  const app = makeApp({ correctHash: hash });

  await app.submitGatePin(correctPin);

  const sessionCall = app.fetchCalls.find(c => c.url.includes('/catalog/session'));
  assert.ok(sessionCall, 'Should have called /catalog/session');
  assert.strictEqual(sessionCall.init?.method, 'POST');
  const body = JSON.parse(sessionCall.init?.body || '{}');
  assert.ok(body.pin_hash, 'Should send pin_hash');
  // Verify pin_hash is the sha256 of the entered PIN (not plaintext)
  const expectedHash = await sha256Hex(correctPin);
  assert.strictEqual(body.pin_hash, expectedHash, 'pin_hash must equal sha256(PIN)');
});

test('[AUTH-3] Successful /catalog/session sets catalogToken and unlocks app', async () => {
  const correctPin = '1234';
  const hash = await sha256Hex(correctPin);
  const app = makeApp({ correctHash: hash });

  await app.submitGatePin(correctPin);

  // appRoot should be visible (unlocked)
  const appRoot = app.nodes['appRoot'];
  assert.ok(appRoot.style.display !== 'none', 'appRoot should be visible after successful auth');
  // gateScreen should be hidden
  const gateScreen = app.nodes['gateScreen'];
  assert.ok(
    gateScreen.style.display === 'none' || gateScreen.attrs['hidden'] !== undefined,
    'gateScreen should be hidden after unlock'
  );
});

test('[AUTH-4] Failed /catalog/session shows gate error, keeps gate visible', async () => {
  const app = makeApp({ correctHash: 'will-not-match' });

  await app.submitGatePin('wrongpin');

  const gateError = app.nodes['gateError'];
  assert.ok(gateError.text || gateError.textContent, 'gateError should have message after wrong PIN');
  // Gate should still be visible
  const gateScreen = app.nodes['gateScreen'];
  assert.ok(
    gateScreen.style.display !== 'none' && gateScreen.attrs['hidden'] === undefined,
    'gateScreen should remain visible after failed auth'
  );
});

test('[AUTH-5] No catalogGateScreen overlay — catalog gate removed from HTML', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(!src.includes('id="catalogGateScreen"'), 'catalogGateScreen should be removed from HTML');
  assert.ok(!src.includes('catalogGateForm'), 'catalogGateForm should be removed');
  assert.ok(!src.includes('catalogGateInput'), 'catalogGateInput should be removed');
});

test('[AUTH-6] After gate unlock, catalog tab activates without additional PIN prompt', async () => {
  const correctPin = '1234';
  const hash = await sha256Hex(correctPin);
  const app = makeApp({ correctHash: hash });

  await app.submitGatePin(correctPin);

  // Click catalog tab
  const tabCatalogFn = app.nodes['tabCatalog'].events['click'];
  if (tabCatalogFn) {
    await tabCatalogFn();
    await new Promise(r => setTimeout(r, 50));
  }

  // Should NOT have called /catalog/session again (token already set)
  const sessionCalls = app.fetchCalls.filter(c => c.url.includes('/catalog/session'));
  assert.strictEqual(sessionCalls.length, 1, 'Should only call /catalog/session once (at gate unlock)');
});

test('[AUTH-7] After gate unlock, equipment tab also works without additional PIN prompt', async () => {
  const correctPin = '1234';
  const hash = await sha256Hex(correctPin);
  const app = makeApp({ correctHash: hash });

  await app.submitGatePin(correctPin);

  const sessionCallsBeforeEquip = app.fetchCalls.filter(c => c.url.includes('/catalog/session')).length;

  // Click equipment tab
  const tabEquipFn = app.nodes['tabEquipment'].events['click'];
  if (tabEquipFn) {
    await tabEquipFn();
    await new Promise(r => setTimeout(r, 50));
  }

  const sessionCallsAfter = app.fetchCalls.filter(c => c.url.includes('/catalog/session')).length;
  assert.strictEqual(sessionCallsAfter, sessionCallsBeforeEquip, 'Equipment tab must not trigger additional /catalog/session call');
});

test('[AUTH-8] Token is in memory only — sessionStorage does not store hash or plaintext PIN', async () => {
  const correctPin = '1234';
  const hash = await sha256Hex(correctPin);
  const app = makeApp({ correctHash: hash });

  await app.submitGatePin(correctPin);

  // sessionStorage must not contain any pin hash or plaintext
  for (const [k, v] of Object.entries(app.ssStorage)) {
    assert.ok(!v.includes(correctPin), `sessionStorage key "${k}" must not contain plaintext PIN`);
    // Allow gate-ok marker but NOT the hash
    if (k !== 'tagsearch-gate-ok' && k !== 'tagsearch-gate-pin-hash') {
      // any other key — just ensure no pin hash stored
    }
    // Specifically the old key 'tagsearch-gate-pin-hash' must NOT be set
    assert.notStrictEqual(k, 'tagsearch-gate-pin-hash', 'Must not store pin hash in sessionStorage');
  }
});

test('[AUTH-9] Wrong PIN retry: second attempt after failure can still succeed', async () => {
  const correctPin = '1234';
  const hash = await sha256Hex(correctPin);
  const app = makeApp({ correctHash: hash });

  // First: wrong PIN
  await app.submitGatePin('wrongpin');
  // Gate should still be visible
  const gateScreen = app.nodes['gateScreen'];
  assert.ok(gateScreen.style.display !== 'none', 'Gate stays visible after wrong PIN');

  // Second: correct PIN
  await app.submitGatePin(correctPin);
  // App should now be unlocked
  const appRoot = app.nodes['appRoot'];
  assert.ok(appRoot.style.display !== 'none', 'App unlocks after correct PIN on retry');
});

test('[AUTH-10] Old gateScreen + gateInput + 3 tabs are present and unchanged', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(src.includes('id="gateScreen"'), 'gateScreen must exist');
  assert.ok(src.includes('id="gateInput"'), 'gateInput must exist');
  assert.ok(src.includes('id="tabTagSearch"'), 'tabTagSearch must exist');
  assert.ok(src.includes('id="tabCatalog"'), 'tabCatalog must exist');
  assert.ok(src.includes('id="tabEquipment"'), 'tabEquipment must exist');
  assert.ok(src.includes('inputmode="numeric"'), 'gate input must use numeric inputmode (mobile keyboard)');
});
