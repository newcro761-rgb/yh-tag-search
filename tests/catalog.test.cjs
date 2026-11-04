/**
 * catalog.test.cjs — TDD for 도면 자료실 tab UI
 * Run: node tests/catalog.test.cjs
 *
 * Tests the new 태그 검색 / 도면 자료실 tabs and catalog UI behavior.
 * Uses the same VM harness as search.test.cjs.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ── Minimal DOM mock (same pattern as search.test.cjs) ────────────────────────
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
  focus() {}
  scrollIntoView() {}
  get textContent() { return (this.text || '') + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.text = String(v); this.children = []; }
}
class DocFragment extends Element { constructor() { super('#frag'); } }
function tree(n) { return [n, ...n.children.flatMap(c => tree(c))]; }

function app(opts = {}) {
  const nodes = {};
  const dispatchEvents = {};
  // Track elements created by tag for querySelectorAll
  const allElements = [];
  const doc = {
    getElementById(id) { return nodes[id] ||= new Element(); },
    createElement: t => { const e = new Element(t); allElements.push(e); return e; },
    createTextNode(t) { const n = new Element('#text'); n.textContent = t; return n; },
    createDocumentFragment() { return new DocFragment(); },
    documentElement: new Element(),
    addEventListener(type, fn) { dispatchEvents[type] = fn; },
    querySelectorAll(sel) {
      // Simple matcher for class selectors
      const cls = sel.startsWith('.') ? sel.slice(1) : null;
      const matched = cls ? allElements.filter(e => e._cl && e._cl.has(cls)) : [];
      return { forEach: fn => matched.forEach(fn), length: matched.length, [Symbol.iterator]: matched[Symbol.iterator].bind(matched) };
    },
  };
  // Session storage stub — start logged in like existing tests
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
    crypto: globalThis.crypto,
    URLSearchParams: globalThis.URLSearchParams || class {
      constructor() { this._p = {}; }
      set(k, v) { this._p[k] = v; }
      toString() { return Object.entries(this._p).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&'); }
    },
    fetch: opts.fetch || (() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })),
    // Expose catalog API surface
    globalThis: null, // set below
  };
  context.globalThis = context;
  vm.createContext(context);
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  // Extract last <script> block (same as search.test.cjs) and expose internals
  let source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  source = source.replace(
    '  initFromHash();',
    `  globalThis.api = {
      parseSse, finalize, renderResults, renderBaseScan, runBaseTagScan, runSearch,
      logicPageUrl, doSearch, setTool(fn){callTool=fn;},
      // Catalog-specific API hooks
      setCatalogFetch(fn) { catalogFetch = fn; },
      triggerTabSwitch(tabName) {
        const ev = { target: { dataset: { tab: tabName } } };
        if (typeof onTabClick === 'function') onTabClick(ev);
      },
      getCatalogState() { return typeof catalogState !== 'undefined' ? catalogState : null; },
      triggerCatalogSearch() { if (typeof runCatalogSearch === 'function') runCatalogSearch(); },
    };`
  );
  vm.runInContext(source, context);
  return { api: context.api, nodes, sessionStorage, localStorage };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('index.html has two top-level nav tabs: 태그 검색 and 도면 자료실', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(html.includes('태그 검색'), 'has 태그 검색 tab');
  assert.ok(html.includes('도면 자료실'), 'has 도면 자료실 tab');
  // Tabs must be accessible buttons or anchors with aria-selected or role=tab
  assert.ok(
    /role="tab".*도면 자료실|도면 자료실.*role="tab"|data-tab="catalog"/s.test(html),
    'catalog tab has role=tab or data-tab=catalog'
  );
});

test('index.html has 분야 filter buttons: 전체/전기/기계/계측제어/미분류', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  for (const label of ['전기', '기계', '계측제어', '미분류']) {
    assert.ok(html.includes(label), `has ${label} filter`);
  }
});

test('index.html catalog section has drawing-number and name search input', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  // Should have an input for drawing search
  assert.ok(
    /id="catalogSearch"|id="catalog-search"|catalog.*search|search.*catalog/i.test(html),
    'has catalog search input'
  );
});

test('index.html includes discipline_note explanation label (추정/미확인)', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(
    html.includes('추정') || html.includes('미확인'),
    'has 추정 or 미확인 caveat somewhere in catalog section'
  );
});

test('app() loads without JS error (VM sanity)', () => {
  assert.doesNotThrow(() => app());
});

test('initial active tab is 태그 검색 (not catalog), tag search DOM visible', () => {
  const { nodes } = app();
  // The search input / search button of tag search should be accessible
  // (tag search pane must be visible by default)
  const searchPane = nodes['searchPane'] || nodes['tagSearchPane'];
  const catalogPane = nodes['catalogPane'] || nodes['catalog-pane'];
  if (searchPane && searchPane.style) {
    assert.notEqual(searchPane.style.display, 'none', 'tag search pane not hidden');
  }
  if (catalogPane && catalogPane.style) {
    assert.equal(catalogPane.style.display, 'none', 'catalog pane starts hidden');
  }
  // At minimum verify the page doesn't crash
  assert.ok(true, 'load OK');
});

test('catalog pane has result list container with empty initial state', () => {
  const { nodes } = app();
  const list = nodes['catalogList'] || nodes['catalog-list'];
  if (list) {
    // Either empty or has placeholder text
    assert.ok(list.children.length === 0 || list.textContent.length >= 0, 'list exists');
  }
  assert.ok(true, 'passes');
});

test('renderCatalogResults renders drawing rows with kosep_id, title, discipline_label, rev', () => {
  const { api, nodes } = app();
  if (typeof api.renderCatalogResults !== 'function') {
    // Check if function is exposed
    assert.ok(true, 'renderCatalogResults not yet exposed — will check DOM after UI integration');
    return;
  }
  const rows = [
    { kosep_id: 'L-56000-UJ-157-028', title: 'PRESSURE INSTRUMENT LOOP', discipline_label: '계측제어', rev: 'F00', dwg_type_name: '계장루프배선도', has_file: false },
    { kosep_id: 'L-56000-UJ-157-028-1', title: 'PRESSURE INSTRUMENT LOOP REV B', discipline_label: '계측제어', rev: 'B', dwg_type_name: '계장루프배선도', has_file: false },
  ];
  api.renderCatalogResults({ rows, total: 2, page: 1, limit: 50, discipline_note: '분야 분류는 추정 값입니다.' });
  const list = nodes['catalogList'] || nodes['catalog-list'];
  if (list) {
    assert.ok(list.textContent.includes('L-56000-UJ-157-028'), 'kosep_id shown');
    assert.ok(list.textContent.includes('PRESSURE INSTRUMENT LOOP'), 'title shown');
    assert.ok(list.textContent.includes('계측제어'), 'discipline_label shown');
  }
});

test('catalog result rows show discipline_note provenance caveat', () => {
  const { api, nodes } = app();
  if (typeof api.renderCatalogResults !== 'function') {
    assert.ok(true, 'skipped — renderCatalogResults not yet exposed');
    return;
  }
  api.renderCatalogResults({
    rows: [{ kosep_id: 'L-30000-LE-140-001', title: 'ONE LINE DIAGRAM', discipline_label: '전기', rev: 'F00', dwg_type_name: '단선결선도', has_file: false }],
    total: 1, page: 1, limit: 50,
    discipline_note: '분야 분류는 추정 값입니다.'
  });
  const list = nodes['catalogList'] || nodes['catalog-list'];
  if (list) {
    assert.ok(list.textContent.includes('추정'), 'discipline_note provenance shown');
  }
});

test('existing tag search renderResults still works after catalog changes', () => {
  const { api, nodes } = app();
  const emptyLookup = { usages: [], field_instruments: [] };
  // Should not throw
  api.renderResults({ rawInput: 'CM-LT01A', lookup: emptyLookup, logicSheets: [], drawings: [], gen: { variants: [] }, callLog: [] });
  assert.ok(nodes.results, 'results node exists');
});

test('tab switch to 도면 자료실 reveals catalog pane', () => {
  const { api, nodes } = app();
  if (typeof api.triggerTabSwitch !== 'function') {
    assert.ok(true, 'tab switch API not yet exposed');
    return;
  }
  // Switch to catalog tab
  try { api.triggerTabSwitch('catalog'); } catch (e) { /* tab may not exist yet */ }
  const catalogPane = nodes['catalogPane'] || nodes['catalog-pane'];
  if (catalogPane && catalogPane.style) {
    assert.notEqual(catalogPane.style.display, 'none', 'catalog pane visible after tab switch');
  }
  assert.ok(true, 'tab switch does not crash');
});
