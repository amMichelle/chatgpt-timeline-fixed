const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');

class FakeCustomEvent {
  constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
}

class FakeEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener, options = {}) {
    const list = this.listeners.get(type) || [];
    list.push({ listener, once: !!options.once });
    this.listeners.set(type, list);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item.listener !== listener));
  }
  dispatchEvent(event) {
    const list = [...(this.listeners.get(event.type) || [])];
    list.forEach(item => item.listener.call(this, event));
    this.listeners.set(event.type, (this.listeners.get(event.type) || []).filter(item => !item.once));
    return true;
  }
  querySelectorAll() { return []; }
  querySelector() { return null; }
}

const response = payload => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  clone: () => ({ json: async () => structuredClone(payload) }),
  json: async () => structuredClone(payload)
});

const message = (id, role, text) => ({
  id,
  author: { role },
  recipient: 'all',
  content: { content_type: 'text', parts: [text] }
});

const mappingFixture = (conversationId, suffix = '') => {
  const nodes = [
    ['u1' + suffix, null, message('mu1' + suffix, 'user', 'first question')],
    ['a1' + suffix, 'u1' + suffix, message('ma1' + suffix, 'assistant', 'answer')],
    ['u2' + suffix, 'a1' + suffix, message('mu2' + suffix, 'user', 'second question')],
    ['a2' + suffix, 'u2' + suffix, message('ma2' + suffix, 'assistant', 'answer two')]
  ];
  const mapping = {};
  nodes.forEach(([id, parent, value], index) => {
    mapping[id] = { id, parent, children: nodes[index + 1] ? [nodes[index + 1][0]] : [], message: value };
  });
  return { conversation_id: conversationId, current_node: nodes.at(-1)[0], mapping };
};

async function testCaptureIndexAndIsolation() {
  const document = new FakeEventTarget();
  const conversationId = '12345678-1234-1234-1234-123456789012';
  const otherId = '87654321-4321-4321-4321-210987654321';
  const fixtures = new Map([
    [conversationId, mappingFixture(conversationId)],
    [otherId, mappingFixture(otherId, '-other')]
  ]);
  const fetch = async url => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/auth/session') return response({ accessToken: 'x'.repeat(40) });
    const id = parsed.pathname.split('/').at(-1);
    return response(fixtures.get(id));
  };
  const window = { fetch, location: null, AITGPTDiagnostics: null };
  const context = vm.createContext({
    window,
    document,
    location: { href: `https://chatgpt.com/c/${conversationId}`, origin: 'https://chatgpt.com', pathname: `/c/${conversationId}` },
    URL,
    CustomEvent: FakeCustomEvent,
    performance: { now: () => 0 },
    navigator: { onLine: true },
    setTimeout: (callback, delay = 0) => {
      // Run only immediate refresh work. Ignore the capture bridge's long-lived
      // health timers so this standalone regression test can exit promptly.
      if (delay === 0) Promise.resolve().then(callback);
      return 0;
    },
    clearTimeout: () => {},
    Map,
    Set,
    Object,
    Array,
    JSON,
    Promise,
    console
  });
  window.location = context.location;
  vm.runInContext(fs.readFileSync(path.join(root, 'js/apiCapture/chatgpt.js'), 'utf8'), context);

  await window.fetch(`https://chatgpt.com/backend-api/conversation/${conversationId}`);
  await new Promise(resolve => setImmediate(resolve));
  let pulled = null;
  document.addEventListener('ait-gpt-user-texts-result', event => { pulled = JSON.parse(event.detail); });
  document.dispatchEvent(new FakeCustomEvent('ait-gpt-user-texts-pull', { detail: conversationId }));
  assert.equal(pulled.conversationId, conversationId);
  assert.deepEqual(pulled.turns.map(turn => turn.id), ['u1', 'u2']);
  assert.deepEqual(pulled.turns.map(turn => turn.messageIndex), [1, 3]);
  assert.equal(pulled.totalMessages, 4);
  assert.equal(pulled.texts.u1, 'first question');
  assert.equal(pulled.texts.mu2, 'second question');

  await window.fetch(`https://chatgpt.com/backend-api/conversation/${otherId}`);
  await new Promise(resolve => setImmediate(resolve));
  document.dispatchEvent(new FakeCustomEvent('ait-gpt-user-texts-pull', { detail: otherId }));
  assert.deepEqual(pulled.turns.map(turn => turn.id), ['u1-other', 'u2-other']);
  assert.equal(pulled.texts.u1, undefined, 'conversation buckets must not leak across SPA routes');
}

async function testPaginationAndCompleteSnapshotProtection() {
  const document = new FakeEventTarget();
  const conversationId = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
  const messages = [];
  for (let index = 1; index <= 100; index++) {
    messages.push(message(`m-user-${index}`, 'user', `question ${index}`));
    messages.push(message(`m-assistant-${index}`, 'assistant', `answer ${index}`));
  }
  const older = messages.slice(0, 100);
  const newer = messages.slice(100);
  const delayedTimers = [];
  let legacyPayload = null;
  const failedResponse = { ok: false, status: 404, headers: { get: () => 'application/json' }, clone() { return this; }, json: async () => ({}) };
  const fetch = async (rawUrl, init = {}) => {
    const url = new URL(String(rawUrl));
    if (url.pathname === '/api/auth/session') return response({ accessToken: 'x'.repeat(40) });
    if (url.pathname === '/backend-api/f/conversation' && String(init.method || 'GET').toUpperCase() === 'POST') {
      const payload = typeof init.body === 'string' ? JSON.parse(init.body) : {};
      newer.push(...(payload.messages || []));
      return response({ ok: true });
    }
    if (url.pathname === `/backend-api/conversation/${conversationId}`) return legacyPayload ? response(legacyPayload) : failedResponse;
    if (url.pathname === `/backend-api/conversations/${conversationId}/messages`) {
      return response({ messages: [...older, newer[0]], page_info: { has_previous_page: false, start_cursor: '' } });
    }
    if (url.pathname === `/backend-api/conversations/${conversationId}`) {
      return response({ messages: newer, page_info: { has_previous_page: true, start_cursor: 'older-page' } });
    }
    return failedResponse;
  };
  const window = { fetch, location: null, AITGPTDiagnostics: null };
  const context = vm.createContext({
    window,
    document,
    location: { href: `https://chatgpt.com/c/${conversationId}`, origin: 'https://chatgpt.com', pathname: `/c/${conversationId}` },
    URL,
    CustomEvent: FakeCustomEvent,
    performance: { now: () => 0 },
    navigator: { onLine: true },
    setTimeout: (callback, delay = 0) => {
      if (delay === 0) Promise.resolve().then(callback);
      else delayedTimers.push({ callback, delay });
      return 0;
    },
    clearTimeout: () => {},
    Map, Set, Object, Array, JSON, Promise, Date, console
  });
  window.location = context.location;
  vm.runInContext(fs.readFileSync(path.join(root, 'js/apiCapture/chatgpt-rollout.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'js/apiCapture/chatgpt.js'), 'utf8'), context);
  let pulled = null;
  document.addEventListener('ait-gpt-user-texts-result', event => { pulled = JSON.parse(event.detail); });
  const pull = () => document.dispatchEvent(new FakeCustomEvent('ait-gpt-user-texts-pull', { detail: conversationId }));
  pull();
  for (let index = 0; index < 6; index++) await new Promise(resolve => setImmediate(resolve));
  pull();
  assert.equal(pulled.complete, true);
  assert.equal(pulled.source, 'paginated-api');
  assert.equal(pulled.pageCount, 2);
  assert.equal(pulled.rawMessages, 201);
  assert.equal(pulled.dedupedMessages, 200);
  assert.equal(pulled.turns.length, 100);
  assert.equal(pulled.turns[0].id, 'm-user-1');
  assert.equal(pulled.turns[49].id, 'm-user-50');
  assert.equal(pulled.turns[99].id, 'm-user-100');

  await window.fetch(`https://chatgpt.com/backend-api/conversations/${conversationId}`);
  await new Promise(resolve => setImmediate(resolve));
  pull();
  assert.equal(pulled.complete, true);
  assert.equal(pulled.turns.length, 100, 'a recent partial page must not overwrite a confirmed complete index');
  assert.equal(pulled.turns[0].id, 'm-user-1');

  const recentMessages = messages.slice(-10);
  const truncatedMapping = {};
  recentMessages.forEach((value, index) => {
    truncatedMapping[value.id] = {
      id: value.id,
      parent: index > 0 ? recentMessages[index - 1].id : null,
      children: recentMessages[index + 1] ? [recentMessages[index + 1].id] : [],
      message: value
    };
  });
  legacyPayload = { current_node: recentMessages.at(-1).id, mapping: truncatedMapping };
  await window.fetch(`https://chatgpt.com/backend-api/conversation/${conversationId}`);
  await new Promise(resolve => setImmediate(resolve));
  pull();
  assert.equal(pulled.turns.length, 100, 'a smaller subset claiming to be complete must not replace the 100-question index');

  // Send three questions without a page reload.
  legacyPayload = null;
  delayedTimers.length = 0; // discard capture health timers
  for (let index = 101; index <= 103; index++) {
    const user = message(`m-user-${index}`, 'user', `question ${index}`);
    await window.fetch('https://chatgpt.com/backend-api/f/conversation', {
      method: 'POST',
      body: JSON.stringify({ conversation_id: conversationId, messages: [user] })
    });
    await new Promise(resolve => setImmediate(resolve));
    pull();
    assert.equal(pulled.turns.length, index, `question ${index} must appear before a page refresh`);
    assert.equal(pulled.turns.at(-1).id, `m-user-${index}`);
    assert.equal(pulled.pendingUserIds.length, index - 100, 'new questions remain optimistic while the assistant/API catches up');
  }
  assert.deepEqual(pulled.turns.slice(0, 100).map(turn => turn.id),
    Array.from({ length: 100 }, (_, index) => `m-user-${index + 1}`),
    'Q1-Q100 identities must not change while Q101-Q103 are appended');

  // Run the newest bounded refresh. The official IDs equal the optimistic IDs,
  // so all temporary nodes merge instead of being duplicated.
  while (delayedTimers.length) {
    const timer = delayedTimers.shift();
    if (timer.delay > 7000) continue;
    timer.callback();
    for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve));
    pull();
    if (pulled.pendingUserIds.length === 0) break;
  }
  assert.equal(pulled.complete, true);
  assert.equal(pulled.turns.length, 103, 'authoritative refresh must merge optimistic turns without duplicates');
  assert.equal(pulled.pendingUserIds.length, 0);
  assert.equal(pulled.turns[100].id, 'm-user-101');

  legacyPayload = mappingFixture(conversationId, '-branch');
  await window.fetch(`https://chatgpt.com/backend-api/conversation/${conversationId}`);
  for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve));
  pull();
  assert.equal(pulled.complete, true);
  assert.deepEqual(pulled.turns.map(turn => turn.id), ['u1-branch', 'u2-branch'], 'a confirmed branch snapshot replaces the previous branch');
}

async function testVirtualizerBridge() {
  class FakeElement {}
  let attempted = null;
  const virtualizer = {
    getVirtualItems() { return []; },
    getTotalSize() { return 1000; },
    scrollToIndex(options) { attempted = options.index; }
  };
  const element = new FakeElement();
  element.__reactFiber$test = { memoizedState: { virtualizer } };
  element.parentElement = null;
  const document = new FakeEventTarget();
  document.querySelectorAll = () => [element];
  document.documentElement = element;
  document.body = element;
  const window = {};
  const context = vm.createContext({ window, document, Element: FakeElement, CustomEvent: FakeCustomEvent, Date, Math, JSON, Set, WeakSet, Object, Array, Promise });
  vm.runInContext(fs.readFileSync(path.join(root, 'js/apiCapture/chatgpt-virtualizer.js'), 'utf8'), context);
  let result = null;
  document.addEventListener('ait-gpt-virtualizer-jump-result', event => { result = JSON.parse(event.detail); });
  document.dispatchEvent(new FakeCustomEvent('ait-gpt-virtualizer-jump', {
    detail: JSON.stringify({ requestId: 'test-jump', candidates: [37, 36] })
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempted, 37);
  assert.equal(result.ok, true);
  assert.equal(result.method, 'scrollToIndex');
}

function testAdapterBuildsCompleteMarkersFromPartialDom() {
  const source = fs.readFileSync(path.join(root, 'js/timeline/adapters/chatgpt.js'), 'utf8') + '\nwindow.__TestChatGPTAdapter = ChatGPTAdapter;';
  class SiteAdapter { isPlaceholderSummary(text) { return !text || text === '[图片或文件]'; } }
  const document = new FakeEventTarget();
  const window = { AITGPTDiagnostics: null };
  const context = vm.createContext({ window, document, SiteAdapter, Map, Set, Array, Object, JSON, Promise, CustomEvent: FakeCustomEvent, location: { pathname: '/c/test-conversation' }, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  const adapter = new window.__TestChatGPTAdapter();
  adapter._capturedTurns = [
    { id: 'u1', nodeId: 'u1', messageId: 'm1', ids: ['u1', 'm1'], text: 'one', messageIndex: 1, userOrder: 1 },
    { id: 'u2', nodeId: 'u2', messageId: 'm2', ids: ['u2', 'm2'], text: 'two', messageIndex: 3, userOrder: 2 },
    { id: 'u3', nodeId: 'u3', messageId: 'm3', ids: ['u3', 'm3'], text: 'three', messageIndex: 5, userOrder: 3 }
  ];
  adapter._capturedTotalMessages = 6;
  adapter._capturedComplete = true;
  const mounted = {
    isConnected: true,
    getAttribute(name) { return name === 'data-turn-id-container' ? 'u2' : null; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    hasAttribute() { return false; },
    childElementCount: 0
  };
  const entries = adapter.getTimelineEntries([mounted]);
  assert.deepEqual(entries.map(entry => entry.id), ['chatgpt-u1', 'chatgpt-u2', 'chatgpt-u3']);
  assert.deepEqual(entries.map(entry => entry.summary), ['one', 'two', 'three']);
  assert.equal(entries[0].element, null);
  assert.equal(entries[1].element, mounted);
  assert.equal(entries[2].element, null);
  assert.deepEqual(entries.map(entry => entry.messageIndex), [1, 3, 5]);
  const markerMap = new Map(entries.map(entry => [entry.id, entry]));
  assert.equal(adapter.findMarkerByStoredIndex('u2', entries, markerMap), entries[1], 'stored node IDs stay compatible');
  assert.equal(adapter.findMarkerByStoredIndex(0, entries, markerMap), entries[0], 'legacy numeric stars keep their index fallback');
  entries[1].element = { ...mounted, getAttribute(name) { return name === 'data-turn-id-container' ? 'reused-for-another-turn' : null; } };
  assert.equal(adapter.resolveTimelineElement(entries[1]), null, 'a connected React-reused element must be rejected when its message ID changed');
  entries[1].element = mounted;

  adapter._capturedComplete = false;
  assert.equal(adapter.getTimelineEntries([mounted]).length, 0, 'partial API/DOM windows must never define Q1');
  adapter._capturedComplete = true;

  const bulkAdapter = new window.__TestChatGPTAdapter();
  bulkAdapter._capturedComplete = true;
  bulkAdapter._capturedTotalMessages = 200;
  bulkAdapter._capturedTurns = Array.from({ length: 100 }, (_, index) => ({
    id: `u${index + 1}`, nodeId: `u${index + 1}`, messageId: `m${index + 1}`,
    ids: [`u${index + 1}`, `m${index + 1}`], text: `question ${index + 1}`,
    messageIndex: index * 2 + 1, userOrder: index + 1
  }));
  const lastFive = Array.from({ length: 5 }, (_, offset) => ({
    isConnected: true,
    getAttribute(name) { return name === 'data-turn-id-container' ? `u${96 + offset}` : null; },
    querySelectorAll() { return []; }, querySelector() { return null; }, hasAttribute() { return false; }
  }));
  const hundredEntries = bulkAdapter.getTimelineEntries(lastFive);
  assert.equal(hundredEntries.length, 100, '100 API questions must remain 100 markers with only five DOM turns');
  assert.equal(hundredEntries[0].id, 'chatgpt-u1');
  assert.equal(hundredEntries[49].id, 'chatgpt-u50');
  assert.equal(hundredEntries[99].id, 'chatgpt-u100');
  assert.equal(hundredEntries.filter(entry => entry.element).length, 5);
  assert.deepEqual(
    bulkAdapter.getTimelineEntries([]).map(entry => entry.id),
    hundredEntries.map(entry => entry.id),
    'virtual unmounts must not renumber Q1-Q100'
  );

  class ModernElement {
    constructor(tagName, attrs = {}, parent = null) {
      this.tagName = tagName.toUpperCase();
      this.attrs = new Map(Object.entries(attrs));
      this.parentElement = parent;
      this.children = [];
      this.isConnected = true;
      this.scrollHeight = 0;
      this.clientHeight = 0;
      if (parent) parent.children.push(this);
    }
    getAttribute(name) { return this.attrs.get(name) ?? null; }
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    removeAttribute(name) { this.attrs.delete(name); }
    hasAttribute(name) { return this.attrs.has(name); }
    matches(selector) {
      return selector.split(',').some(part => {
        const value = part.trim();
        if (!value) return false;
        if (value === 'form' || value === 'nav' || value === 'aside' || value === 'main') return this.tagName === value.toUpperCase();
        if (value === '.ProseMirror' || value === '.ait-chat-timeline-wrapper') return false;
        const attributes = [...value.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)];
        return attributes.length > 0 && attributes.every(([, name, expected]) =>
          this.hasAttribute(name) && (expected === undefined || this.getAttribute(name) === expected));
      });
    }
    closest(selector) {
      for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
      return null;
    }
    querySelectorAll(selector) {
      const result = [];
      const visit = node => node.children.forEach(child => {
        if (child.matches(selector)) result.push(child);
        visit(child);
      });
      visit(this);
      return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }

  const main = new ModernElement('main');
  const scrollRoot = new ModernElement('div', { 'data-scroll-root': '' });
  main.parentElement = scrollRoot;
  scrollRoot.children.push(main);
  scrollRoot.scrollHeight = 1200;
  scrollRoot.clientHeight = 500;
  const userRoot = new ModernElement('div', { 'data-turn-key': 'opaque-user-turn' }, main);
  const contentRoot = new ModernElement('div', { 'data-content-search-turn-key': 'content-user' }, userRoot);
  new ModernElement('div', { 'data-chatgpt-selection-message-id': 'm2' }, contentRoot);
  new ModernElement('div', { 'data-chatgpt-search-message-ids': '["m2","related-id"]' }, contentRoot);
  new ModernElement('div', { 'data-dil-message-id': 'dil-block-1' }, contentRoot);
  new ModernElement('div', { 'data-dil-message-id': 'dil-block-2' }, contentRoot);
  const assistantRoot = new ModernElement('div', { 'data-turn-key': 'opaque-assistant-turn' }, main);
  new ModernElement('div', { 'data-chatgpt-selection-message-id': 'assistant-message' }, assistantRoot);
  new ModernElement('div', { 'data-chatgpt-search-message-ids': '["m2","assistant-message"]' }, assistantRoot);
  const contentOnlyRoot = new ModernElement('div', { 'data-content-search-turn-key': 'content-only-turn' }, main);
  new ModernElement('div', { 'data-chatgpt-selection-message-id': 'm3' }, contentOnlyRoot);
  const form = new ModernElement('form', {}, main);
  const composer = new ModernElement('div', { 'data-turn-key': 'composer-turn', 'data-composer-input': '' }, form);
  const allModern = [userRoot, contentRoot, assistantRoot, contentOnlyRoot, composer];
  document.querySelectorAll = selector => {
    if (selector === '[data-turn-key], [data-content-search-turn-key]') return allModern;
    return [main, ...allModern].filter(element => element.matches(selector));
  };
  document.querySelector = selector => document.querySelectorAll(selector)[0] || null;
  document.getElementById = () => null;
  context.window.getComputedStyle = element => ({ overflowY: element === scrollRoot ? 'auto' : 'visible' });
  context.document.body = new ModernElement('body');
  context.document.documentElement = new ModernElement('html');

  const anchorOnlyAdapter = new window.__TestChatGPTAdapter();
  anchorOnlyAdapter.prepareTimelineNodes({ force: true, reason: 'modern-anchor-only-test' });
  assert.equal(anchorOnlyAdapter.getTimelineInitializationState().reason, 'turn-anchor', 'modern turn initializes before API data arrives');

  adapter._turnRolesDirty = true;
  adapter.prepareTimelineNodes({ force: true, reason: 'modern-dom-test' });
  assert.equal(adapter._usesModernTurnSelector, true);
  assert.equal(adapter._getModernTurnRoots().length, 3, 'nested content blocks and composer must not become turns');
  assert.equal(userRoot.getAttribute('data-ait-turn'), 'user', 'descendant selection message ID maps opaque turn key to API user');
  assert.equal(assistantRoot.getAttribute('data-ait-turn'), null, 'assistant roots must not be inferred as users');
  assert.equal(adapter.getInitializationAnchor(), userRoot, 'modern turn is a valid initialization anchor without #thread');
  assert.equal(adapter.findConversationContainer(userRoot), main, 'main is the stable no-#thread conversation container');
  assert.equal(adapter.resolveTimelineScrollContainer(userRoot, main), scrollRoot, 'scroll root is found from turn ancestors');
  assert.equal(adapter.getTimelineInitializationState().reason, 'user-dom');
  const getModernTurnRoots = adapter._getModernTurnRoots.bind(adapter);
  const querySelector = document.querySelector.bind(document);
  adapter._getModernTurnRoots = () => [];
  document.querySelector = () => null;
  assert.equal(adapter.getTimelineInitializationState().reason, 'api-index', 'API data initializes even when no turn is mounted');
  adapter._getModernTurnRoots = getModernTurnRoots;
  document.querySelector = querySelector;
  assert.deepEqual(Array.from(adapter._parseDomIdValue('m1, m2|m3')), ['m1, m2|m3', 'm1', 'm2', 'm3']);
  assert.deepEqual(Array.from(adapter._parseDomIdValue('["m2","m3"]')), ['["m2","m3"]', 'm2', 'm3']);
  assert.deepEqual(Array.from(adapter._parseDomIdValue('{"primary":"m2","related":["m3"]}')), ['{"primary":"m2","related":["m3"]}', 'm2', 'm3']);
  assert.deepEqual(Array.from(adapter._parseDomIdValue('m2')), ['m2']);
  assert.deepEqual(Array.from(adapter._parseDomIdValue('turn:m2')), ['turn:m2', 'turn', 'm2']);
  const modernEntries = adapter.getTimelineEntries([userRoot, contentOnlyRoot]);
  assert.equal(modernEntries[1].element, userRoot);
  assert.equal(modernEntries[2].element, contentOnlyRoot, 'content-search turn without data-turn-key maps by selection message ID');
  modernEntries[1].element = null;
  assert.equal(adapter.resolveTimelineElement(modernEntries[1]), userRoot);
}

async function testManagerVirtualMarkerNavigation() {
  const source = fs.readFileSync(path.join(root, 'js/timeline/timeline-manager.js'), 'utf8') + '\nwindow.__TestTimelineManager = TimelineManager;';
  const window = {};
  const context = vm.createContext({ window, console, setTimeout, clearTimeout, requestAnimationFrame: callback => callback(0) });
  vm.runInContext(source, context);
  const manager = Object.create(window.__TestTimelineManager.prototype);
  const mountedById = new Map(['chatgpt-u1', 'chatgpt-u50', 'chatgpt-u100'].map(id => [id, { isConnected: true, id }]));
  const bridgeCalls = [];
  const smoothed = [];
  manager._destroyed = false;
  manager.scrollContainer = {};
  manager.conversationContainer = {};
  manager.adapter = {
    resolveTimelineElement: () => null,
    jumpToTimelineMarker: async marker => { bridgeCalls.push(marker.id); return mountedById.get(marker.id); },
    invalidateTimelineNodes: () => {}
  };
  manager.smoothScrollTo = element => { smoothed.push(element.id); };
  manager._isElementVisibleInScrollContainer = () => true;
  manager.debouncedRecalculateAndRender = () => {};
  for (const id of ['chatgpt-u1', 'chatgpt-u50', 'chatgpt-u100']) {
    const marker = { id, element: null, virtual: true };
    assert.equal(await manager.navigateToMarker(marker), true);
    assert.equal(marker.element, mountedById.get(id));
    assert.equal(marker.virtual, false);
  }
  assert.deepEqual(bridgeCalls, ['chatgpt-u1', 'chatgpt-u50', 'chatgpt-u100']);
  assert.deepEqual(smoothed, ['chatgpt-u1', 'chatgpt-u50', 'chatgpt-u100']);

  let resolveFirstJump;
  manager.adapter.jumpToTimelineMarker = marker => marker.id === 'chatgpt-u1'
    ? new Promise(resolve => { resolveFirstJump = resolve; })
    : Promise.resolve(mountedById.get(marker.id));
  smoothed.length = 0;
  const firstNavigation = manager.navigateToMarker({ id: 'chatgpt-u1', messageId: 'u1', element: null, virtual: true });
  await new Promise(resolve => setImmediate(resolve));
  const lastNavigation = manager.navigateToMarker({ id: 'chatgpt-u100', messageId: 'u100', element: null, virtual: true });
  await lastNavigation;
  resolveFirstJump(mountedById.get('chatgpt-u1'));
  assert.equal(await firstNavigation, false, 'an older in-flight navigation must be cancelled');
  assert.deepEqual(smoothed, ['chatgpt-u100'], 'the last rapid click must own the final scroll');
}

async function testChatGPTFallbackSearchDoesNotOscillate() {
  const source = fs.readFileSync(path.join(root, 'js/timeline/adapters/chatgpt.js'), 'utf8') + '\nwindow.__TestChatGPTAdapter = ChatGPTAdapter;';
  class SiteAdapter {}
  const context = vm.createContext({
    window: {}, document: {}, SiteAdapter, Map, Set, Array, Object, JSON, Promise,
    setTimeout: callback => { Promise.resolve().then(callback); return 1; }
  });
  vm.runInContext(source, context);
  const adapter = new context.window.__TestChatGPTAdapter();
  const positions = [];
  const scrollContainer = { scrollHeight: 1800, clientHeight: 300,
    get scrollTop() { return positions.at(-1) || 0; },
    set scrollTop(value) { positions.push(value); }
  };
  const found = { isConnected: true };
  adapter.resolveTimelineElement = () => scrollContainer.scrollTop >= 540 ? found : null;
  adapter._requestVirtualizerJump = async () => ({ ok: false, reason: 'virtualizer_api_not_found' });
  const result = await adapter.jumpToTimelineMarker({ id: 'chatgpt-old', messageIndex: 3, visualN: 0.8 }, {
    scrollContainer, isCurrent: () => true
  });
  assert.equal(result, found);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'fallback search must move in one direction');
  assert.equal(positions.at(-1), 540, 'search stops as soon as the target message mounts');
}

async function testCapturedApiTriggersInitialization() {
  const document = new FakeEventTarget();
  document.body = {};
  document.querySelector = () => null;
  document.querySelectorAll = () => [];
  const window = new FakeEventTarget();
  window.AITGPTDiagnostics = { log() {}, error() {} };
  let apiReady = false;
  let managerInitCount = 0;
  const adapter = {
    platformId: 'chatgpt',
    isConversationRoute: () => true,
    getTimelineInitializationState: () => ({ selector: '[data-ait-turn="user"]', userDom: false, apiIndex: apiReady, anchor: null, ready: apiReady, reason: apiReady ? 'api-index' : 'none' }),
    syncCapturedChatsData() {},
    prepareTimelineNodes() {},
    handleCapturedChatsDataUpdated() { apiReady = true; return 1; }
  };
  class SiteAdapterRegistry {
    async loadCustomAdapters() {}
    async isSupportedSite() { return true; }
    async detectAdapter() { return adapter; }
  }
  class TimelineManager {
    constructor(value) { this.adapter = value; }
    async init() { managerInitCount++; window.timelineManager = this; return true; }
    destroy() {}
  }
  const context = vm.createContext({
    window,
    document,
    location: { href: 'https://chatgpt.com/c/conversation-id', pathname: '/c/conversation-id' },
    SiteAdapterRegistry,
    TimelineManager,
    TimelineI18n: { ready: async () => {} },
    TimelineUtils: { removeEventListenerSafe() {}, removeElementSafe() {} },
    TIMELINE_CONFIG: { INIT_RETRY_DELAYS: [0] },
    getCurrentPlatform: async () => ({ id: 'chatgpt', features: { timeline: true } }),
    chrome: { storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } } },
    CustomEvent: FakeCustomEvent,
    setTimeout,
    clearTimeout,
    Promise,
    console
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'js/timeline/index.js'), 'utf8'), context);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(managerInitCount, 0);
  document.dispatchEvent(new FakeCustomEvent('ait-gpt-user-texts-updated', { detail: 'conversation-id' }));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(managerInitCount, 1, 'captured API data must initialize timeline without a DOM mutation');
}

(async () => {
  await testCaptureIndexAndIsolation();
  await testPaginationAndCompleteSnapshotProtection();
  testAdapterBuildsCompleteMarkersFromPartialDom();
  await testVirtualizerBridge();
  await testManagerVirtualMarkerNavigation();
  await testChatGPTFallbackSearchDoesNotOscillate();
  await testCapturedApiTriggersInitialization();
  console.log('PASS: complete/paginated index, live Q101-Q103 optimistic merge, partial protection, stale DOM rejection, branch isolation, and last-click-wins navigation.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
