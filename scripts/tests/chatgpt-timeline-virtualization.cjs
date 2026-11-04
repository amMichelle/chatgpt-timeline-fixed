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

const attachmentMessage = (id, parts) => ({
  id,
  author: { role: 'user' },
  recipient: 'all',
  content: { content_type: 'multimodal_text', parts }
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

const attachmentFixture = conversationId => {
  const values = [
    attachmentMessage('image-only-1', [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://image-1' }]),
    message('answer-1', 'assistant', 'image answer'),
    attachmentMessage('file-only-1', [{ content_type: 'file_asset_pointer', asset_pointer: 'file-service://file-1' }]),
    message('answer-2', 'assistant', 'file answer'),
    attachmentMessage('image-only-2', [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://image-2' }]),
    message('answer-3', 'assistant', 'second image answer'),
    attachmentMessage('mixed-1', ['same text', { content_type: 'image_asset_pointer', asset_pointer: 'file-service://image-3' }]),
    message('answer-4', 'assistant', 'mixed answer'),
    message('duplicate-1', 'user', 'same text'),
    message('answer-5', 'assistant', 'duplicate answer'),
    message('duplicate-2', 'user', 'same text')
  ];
  const mapping = {};
  values.forEach((value, index) => {
    const nodeId = `node-${value.id}`;
    const previous = values[index - 1];
    const next = values[index + 1];
    mapping[nodeId] = {
      id: nodeId,
      parent: previous ? `node-${previous.id}` : null,
      children: next ? [`node-${next.id}`] : [],
      message: value
    };
  });
  return { conversation_id: conversationId, current_node: `node-${values.at(-1).id}`, mapping };
};

async function testCaptureIndexAndIsolation() {
  const document = new FakeEventTarget();
  const conversationId = '12345678-1234-1234-1234-123456789012';
  const otherId = '87654321-4321-4321-4321-210987654321';
  const attachmentId = '11111111-2222-3333-4444-555555555555';
  const fixtures = new Map([
    [conversationId, mappingFixture(conversationId)],
    [otherId, mappingFixture(otherId, '-other')],
    [attachmentId, attachmentFixture(attachmentId)]
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

  await window.fetch(`https://chatgpt.com/backend-api/conversation/${attachmentId}`);
  await new Promise(resolve => setImmediate(resolve));
  document.dispatchEvent(new FakeCustomEvent('ait-gpt-user-texts-pull', { detail: attachmentId }));
  assert.deepEqual(pulled.turns.map(turn => turn.messageId),
    ['image-only-1', 'file-only-1', 'image-only-2', 'mixed-1', 'duplicate-1', 'duplicate-2']);
  assert.equal(pulled.turns[0].text, '[图片或文件]');
  assert.equal(pulled.turns[1].text, '[图片或文件]');
  assert.notEqual(pulled.turns[0].id, pulled.turns[2].id, 'consecutive image-only turns retain distinct stable identities');
  assert.notEqual(pulled.turns[4].id, pulled.turns[5].id, 'duplicate text never becomes the identity key');
  assert.equal(pulled.turns[3].text, 'same text', 'mixed text/attachment keeps text while retaining the message identity');
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
  const runBridge = async (virtualizer, request, options = {}) => {
    class FakeElement {}
    const element = new FakeElement();
    element.__reactFiber$test = { memoizedState: { virtualizer } };
    element.parentElement = null;
    const document = new FakeEventTarget();
    document.querySelectorAll = () => [element];
    document.documentElement = element;
    document.body = element;
    const window = {};
    const context = vm.createContext({
      window, document, Element: FakeElement, CustomEvent: FakeCustomEvent,
      Date, Math, JSON, Set, WeakSet, WeakMap, Object, Array, Promise,
      performance: { now: options.performanceNow || (() => Date.now()) }, setTimeout, clearTimeout
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/apiCapture/chatgpt-virtualizer.js'), 'utf8'), context);
    return new Promise(resolve => {
      document.addEventListener('ait-gpt-virtualizer-jump-result', event => resolve(JSON.parse(event.detail)), { once: true });
      document.dispatchEvent(new FakeCustomEvent('ait-gpt-virtualizer-jump', {
        detail: JSON.stringify({ requestId: 'bridge-case', deadlineMs: 900, ...request })
      }));
      if (Number.isFinite(options.cancelAfterMs)) {
        setTimeout(() => document.dispatchEvent(new FakeCustomEvent('ait-gpt-virtualizer-jump-cancel', {
          detail: JSON.stringify({ all: true, reason: 'newer-click' })
        })), options.cancelAfterMs);
      }
    });
  };

  let visible = [40, 41, 42];
  const numericAttempts = [];
  const numericController = {
    options: { count: 88 },
    getVirtualItems: () => visible.map(index => ({ index })),
    scrollToIndex(value) {
      numericAttempts.push(value);
      if (typeof value === 'number') visible = [value - 1, value, value + 1];
      // Object arguments are deliberately ignored without throwing.
    }
  };
  let result = await runBridge(numericController, {
    index: 55, mappingVerified: true, strategy: 'verified-test', observedIndices: [41]
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.stateChanged, true);
  assert.equal(result.signatureAttempt, 1, 'the common numeric signature is attempted first');
  assert.equal(numericAttempts[0], 55);

  visible = [1, 2, 3];
  const objectController = {
    options: { count: 12 },
    getVirtualItems: () => visible.map(index => ({ index })),
    scrollToIndex(value) { if (value && typeof value.index === 'number') visible = [value.index]; }
  };
  result = await runBridge(objectController, {
    index: 8, mappingVerified: true, strategy: 'verified-test', observedIndices: [2]
  });
  assert.equal(result.ok, true);
  assert.equal(result.signatureAttempt, 2, 'object-form controllers use one bounded fallback');
  assert.deepEqual(visible, [8]);

  const noOpController = {
    options: { count: 20 },
    getVirtualItems: () => [{ index: 18 }, { index: 19 }],
    scrollToIndex() {}
  };
  result = await runBridge(noOpController, {
    index: 4, mappingVerified: true, strategy: 'verified-test', observedIndices: [19]
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'scroll-state-unchanged', 'no observable movement must never be reported as success');

  const alreadyVisibleNoOp = {
    options: { count: 20 },
    getVirtualItems: () => [{ index: 3 }, { index: 4 }, { index: 5 }],
    scrollToIndex() {}
  };
  result = await runBridge(alreadyVisibleNoOp, {
    index: 4, mappingVerified: true, strategy: 'verified-test', observedIndices: [4]
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'scroll-state-unchanged',
    'an index that was already visible before a no-op command is not movement');

  visible = [84, 85, 86];
  let ratioIndex = null;
  const countMismatchController = {
    options: { count: 88 },
    getVirtualItems: () => visible.map(index => ({ index })),
    scrollToIndex(index) {
      if (typeof index === 'number') { ratioIndex = index; visible = [index]; }
    }
  };
  result = await runBridge(countMismatchController, {
    index: null, mappingVerified: false, targetUserOrder: 28, totalUserTurns: 44,
    observedIndices: [], targetIds: ['message-28']
  });
  assert.equal(result.ok, true);
  assert.equal(result.indexStrategy, 'bounded-ratio-estimate');
  assert.equal(ratioIndex, 55, '44 user questions may map onto a different 88-item virtual index space');

  visible = [84, 85, 86];
  let keyedIndex = null;
  const keyedController = {
    options: { count: 88, getItemKey: index => index === 54 ? 'message-28' : `other-${index}` },
    getVirtualItems: () => visible.map(index => ({ index, key: `other-${index}` })),
    scrollToIndex(index) {
      if (typeof index === 'number') { keyedIndex = index; visible = [index]; }
    }
  };
  result = await runBridge(keyedController, {
    index: null, mappingVerified: false, targetUserOrder: 28, totalUserTurns: 44,
    observedIndices: [], targetIds: ['message-28']
  });
  assert.equal(result.ok, true);
  assert.equal(result.indexStrategy, 'virtual-item-key');
  assert.equal(keyedIndex, 54, 'stable virtual item keys take precedence over ratio estimates');

  let lateCommandCalls = 0;
  let diagnosticClock = 0;
  const lateDiscoveryController = {
    options: { count: 88 },
    getVirtualItems: () => [{ index: 40 }],
    scrollToIndex() { lateCommandCalls++; }
  };
  result = await runBridge(lateDiscoveryController, {
    index: 20, mappingVerified: true, strategy: 'verified-test', observedIndices: [40], deadlineMs: 250
  }, { performanceNow: () => { diagnosticClock += 200; return diagnosticClock; } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'cancelled');
  assert.equal(lateCommandCalls, 0, 'a request whose discovery exceeded its deadline cannot issue a late scroll');
}

async function testAdapterBuildsCompleteMarkersFromPartialDom() {
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
    querySelector(selector) { return selector.includes('[data-turn="user"]') ? this : null; },
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
    get childElementCount() { return this.children.length; }
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
  scrollRoot.scrollHeight = 500;
  scrollRoot.clientHeight = 500;
  const userRoot = new ModernElement('div', { 'data-turn-key': 'opaque-user-turn' }, main);
  const contentRoot = new ModernElement('div', { 'data-content-search-turn-key': 'content-user' }, userRoot);
  const userContent = new ModernElement('div', { 'data-chatgpt-selection-message-id': 'm2' }, contentRoot);
  userContent.textContent = 'second question';
  new ModernElement('div', { 'data-chatgpt-search-message-ids': '["m2","related-id"]' }, contentRoot);
  new ModernElement('div', { 'data-dil-message-id': 'dil-block-1' }, contentRoot);
  new ModernElement('div', { 'data-dil-message-id': 'dil-block-2' }, contentRoot);
  const assistantRoot = new ModernElement('div', { 'data-turn-key': 'opaque-assistant-turn' }, main);
  new ModernElement('div', { 'data-chatgpt-selection-message-id': 'assistant-message' }, assistantRoot);
  new ModernElement('div', { 'data-chatgpt-search-message-ids': '["m2","assistant-message"]' }, assistantRoot);
  const contentOnlyRoot = new ModernElement('div', { 'data-content-search-turn-key': 'content-only-turn' }, main);
  const contentOnlyMessage = new ModernElement('div', { 'data-chatgpt-selection-message-id': 'm3' }, contentOnlyRoot);
  contentOnlyMessage.textContent = 'third question';
  const form = new ModernElement('form', {}, main);
  const composer = new ModernElement('div', { 'data-turn-key': 'composer-turn', 'data-composer-input': '' }, form);
  const allModern = [userRoot, contentRoot, assistantRoot, contentOnlyRoot, composer];
  document.querySelectorAll = selector => {
    if (selector === '[data-turn-key], [data-content-search-turn-key]') return allModern;
    return [main, ...allModern].filter(element => element.matches(selector));
  };
  document.querySelector = selector => document.querySelectorAll(selector)[0] || null;
  document.getElementById = () => null;
  context.window.getComputedStyle = element => ({ overflowY: element.hasAttribute?.('data-scroll-root') ? 'auto' : 'visible' });
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
  assert.equal(adapter.resolveTimelineScrollContainer(userRoot, main), scrollRoot,
    'ChatGPT scroll root is retained before it has a scrollable range');
  const nestedMain = new ModernElement('main');
  const nestedScrollRoot = new ModernElement('div', { 'data-scroll-root': '' }, nestedMain);
  const nestedTurn = new ModernElement('div', { 'data-turn-key': 'nested-turn' }, nestedScrollRoot);
  assert.equal(adapter.resolveTimelineScrollContainer(nestedTurn, nestedMain), nestedScrollRoot,
    'a main-owned inner scroll layer is accepted as the ChatGPT conversation scroller');
  const rangedMain = new ModernElement('main');
  const rangedScrollRoot = new ModernElement('div', {}, rangedMain);
  rangedScrollRoot.scrollHeight = 1600;
  rangedScrollRoot.clientHeight = 500;
  const rangedTurn = new ModernElement('div', { 'data-turn-key': 'ranged-turn' }, rangedScrollRoot);
  assert.equal(adapter.resolveTimelineScrollContainer(rangedTurn, rangedMain), rangedScrollRoot,
    'a real ChatGPT scroll range is used even when overflow-y metadata is missing');
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

  const firstAnchor = new ModernElement('div', { 'data-turn-key': 'first-anchor', 'data-index': '9' }, main);
  const firstAnchorContent = new ModernElement('div', { 'data-chatgpt-selection-message-id': 'm1' }, firstAnchor);
  firstAnchorContent.textContent = 'first question';
  contentOnlyRoot.setAttribute('data-index', '11');
  const originalModernRoots = adapter._getModernTurnRoots;
  adapter._getModernTurnRoots = () => [firstAnchor, contentOnlyRoot];
  adapter._virtualIndexByMessageId.clear();
  const virtualPlan = adapter._buildVirtualIndexPlan(modernEntries[1]);
  adapter._getModernTurnRoots = originalModernRoots;
  assert.equal(virtualPlan.index, 10, 'two real DOM anchors interpolate a local user-round index without API messageIndex');
  assert.equal(virtualPlan.strategy, 'verified-anchor-interpolation');

  const quotedAssistant = new ModernElement('div', { 'data-turn-key': 'assistant-with-quote' }, main);
  new ModernElement('div', { 'data-chatgpt-search-message-ids': '["m1"]' }, quotedAssistant);
  assert.equal(adapter._elementMatchesMarker(quotedAssistant, modernEntries[0]), false,
    'an assistant source/quote ID must never become the assistant turn identity');

  const shellOnly = new ModernElement('div', { 'data-turn-key': 'u1', 'data-index': '9' }, main);
  new ModernElement('div', {}, shellOnly);
  const originalShellRoots = adapter._getModernTurnRoots;
  adapter._getModernTurnRoots = () => [shellOnly];
  adapter._virtualIndexByMessageId.clear();
  assert.equal(adapter.resolveTimelineElement(modernEntries[0]), null, 'an identity-bearing virtual shell is not a rendered-message success');
  assert.equal(adapter._buildVirtualIndexPlan(modernEntries[0]).strategy, 'target-placeholder-index',
    'the same shell may still provide an exact virtual index anchor');
  adapter._getModernTurnRoots = originalShellRoots;

  const longAdapter = new window.__TestChatGPTAdapter();
  longAdapter._capturedComplete = true;
  longAdapter._capturedTurns = Array.from({ length: 44 }, (_, index) => ({
    id: `u${index + 1}`, nodeId: `u${index + 1}`, messageId: `m${index + 1}`,
    ids: [`u${index + 1}`, `m${index + 1}`], text: index === 27 ? '[图片或文件]' : 'same text',
    messageIndex: index * 2 + 1, userOrder: index + 1
  }));
  const makeTurn = (order, virtualIndex, attachmentOnly = false) => {
    const root = new ModernElement('div', { 'data-turn-key': `u${order}`, 'data-index': String(virtualIndex) }, main);
    if (attachmentOnly) new ModernElement('div', { 'data-attachment-kind': 'image' }, root);
    else {
      const content = new ModernElement('div', { 'data-chatgpt-selection-message-id': `m${order}` }, root);
      content.textContent = `question ${order}`;
    }
    return root;
  };
  let mountedWindow = [makeTurn(42, 82), makeTurn(43, 84), makeTurn(44, 86)];
  longAdapter._getModernTurnRoots = () => mountedWindow;
  document.querySelectorAll = selector => {
    if (selector === '[data-turn-key], [data-content-search-turn-key]') return mountedWindow;
    return mountedWindow.filter(element => element.matches(selector));
  };
  let commands = 0;
  longAdapter._requestVirtualizerJump = async (plan, marker) => {
    commands++;
    if (commands === 1) {
      assert.equal(longAdapter.resolveTimelineElement(marker), null, 'Q28 starts outside the mounted DOM window');
      assert.equal(longAdapter._findIdentityAnchor(marker), null, 'Q28 has no current DOM placeholder before the command');
      assert.equal(plan.mappingVerified, false, `far targets do not extrapolate the Q42-Q44 local mapping (${plan.strategy})`);
      mountedWindow = [makeTurn(27, 52), makeTurn(28, 54, true), makeTurn(29, 56)];
      assert.equal(longAdapter.resolveTimelineElement(marker), mountedWindow[1], 'attachment-only root is resolvable immediately after virtual mounting');
      return { ok: true, stateChanged: true, indexStrategy: 'bounded-ratio-estimate', attemptedIndex: 55 };
    }
    assert.equal(plan.strategy, 'target-placeholder-index');
    return { ok: true, stateChanged: false, targetIndexVisible: true, indexStrategy: plan.strategy, attemptedIndex: plan.index };
  };
  const q28 = { id: 'chatgpt-u28', sourceId: 'u28', messageId: 'm28', aliasIds: ['u28', 'm28'], userOrder: 28 };
  const q28Element = await longAdapter.jumpToTimelineMarker(q28, { isCurrent: () => true, conversationContainer: main, taskId: 1 });
  assert.equal(q28Element, mountedWindow[1], 'Q44 → Q28 mounts and verifies the exact attachment-only user turn');
  assert.ok(commands <= 2, 'Q44 → Q28 uses at most one progress-gated correction');

  mountedWindow = [makeTurn(1, 0), makeTurn(2, 2), makeTurn(3, 4)];
  longAdapter._virtualIndexByMessageId.clear();
  longAdapter._requestVirtualizerJump = async () => {
    mountedWindow = [makeTurn(42, 82), makeTurn(43, 84), makeTurn(44, 86)];
    return { ok: true, stateChanged: true, indexStrategy: 'bounded-ratio-estimate', attemptedIndex: 87 };
  };
  const q44 = { id: 'chatgpt-u44', sourceId: 'u44', messageId: 'm44', aliasIds: ['u44', 'm44'], userOrder: 44 };
  assert.equal(await longAdapter.jumpToTimelineMarker(q44, { isCurrent: () => true, conversationContainer: main, taskId: 2 }),
    mountedWindow[2], 'Q1 → Q44 mounts and verifies the final stable message ID');

  const shortAdapter = new window.__TestChatGPTAdapter();
  shortAdapter._capturedTurns = longAdapter._capturedTurns.slice(0, 3);
  const shortMounted = [makeTurn(1, 0), makeTurn(2, 2), makeTurn(3, 4)];
  shortAdapter._getModernTurnRoots = () => shortMounted;
  const q2 = { id: 'chatgpt-u2', sourceId: 'u2', messageId: 'm2', aliasIds: ['u2', 'm2'], userOrder: 2 };
  assert.equal(shortAdapter.resolveTimelineElement(q2), shortMounted[1], 'three-question conversations retain direct DOM jumps');
}

async function testManagerVirtualMarkerNavigation() {
  const source = fs.readFileSync(path.join(root, 'js/timeline/timeline-manager.js'), 'utf8') + '\nwindow.__TestTimelineManager = TimelineManager;';
  const window = {};
  const context = vm.createContext({ window, console, setTimeout, clearTimeout, requestAnimationFrame: callback => callback(0) });
  vm.runInContext(source, context);
  const manager = Object.create(window.__TestTimelineManager.prototype);
  let nativeTop = 900;
  const actualScrollRoot = { getBoundingClientRect: () => ({ top: 0, bottom: 500 }) };
  const fallbackHtml = { scrollTop: 0 };
  let nativeScrollCalls = 0;
  const nativeContent = {
    scrollIntoView() { nativeScrollCalls++; nativeTop = 20; }
  };
  const nativeTarget = {
    isConnected: true,
    scrollIntoView() { throw new Error('the zero-layout turn shell must not be scrolled'); }
  };
  const nativeManager = Object.create(window.__TestTimelineManager.prototype);
  nativeManager.adapter = {
    platformId: 'chatgpt',
    resolveTimelineScrollContainer: () => actualScrollRoot,
    getTimeLabelTarget: () => nativeContent,
    getScrollOffset: () => 30
  };
  nativeManager.conversationContainer = {};
  nativeManager.scrollContainer = fallbackHtml;
  nativeManager.isScrollContainerFallback = true;
  nativeManager._getMessageRect = () => ({ top: nativeTop, bottom: nativeTop + 80, height: 80 });
  assert.equal(await nativeManager.smoothScrollTo(nativeTarget, 0), true,
    'Q10 → Q12 uses a laid-out child and native ancestor scrolling when the stored container is fallback HTML');
  nativeTop = -700;
  assert.equal(await nativeManager.smoothScrollTo(nativeTarget, 0), true,
    'Q12 → Q10 uses the same native path in the opposite direction');
  assert.equal(nativeScrollCalls, 2, 'each navigation issues one native scroll command');
  assert.equal(fallbackHtml.scrollTop, 0, 'native ChatGPT navigation never writes scrollTop to fallback HTML');

  const mountedById = new Map(['chatgpt-u1', 'chatgpt-u50', 'chatgpt-u100'].map(id => [id, { isConnected: true, id }]));
  const bridgeCalls = [];
  const smoothed = [];
  manager._destroyed = false;
  manager.scrollContainer = {};
  manager.conversationContainer = {};
  manager.adapter = {
    platformId: 'chatgpt',
    resolveTimelineElement: marker => marker.element?.isConnected ? marker.element : null,
    jumpToTimelineMarker: async marker => { bridgeCalls.push(marker.id); return mountedById.get(marker.id); },
    invalidateTimelineNodes: () => {}
  };
  manager.smoothScrollTo = element => { smoothed.push(element.id); };
  manager._isElementVisibleInScrollContainer = element => !!element?.isConnected;
  manager.debouncedRecalculateAndRender = () => {};
  manager.markers = [];
  manager.updateActiveDotUI = () => {};
  manager._emitActiveChange = () => {};
  manager.syncTimelineTrackToMain = () => {};
  manager.updateVirtualRangeAndRender = () => {};
  manager.scheduleScrollSync = () => {};
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

  const reusedMarker = { id: 'chatgpt-reused', messageId: 'reused', element: null, virtual: true };
  const reusedElement = { isConnected: true, id: reusedMarker.id };
  manager.adapter.jumpToTimelineMarker = async () => reusedElement;
  manager.adapter.resolveTimelineElement = marker => marker.element === reusedElement ? null : marker.element;
  assert.equal(await manager.navigateToMarker(reusedMarker), false,
    'a connected DOM node that was reused for another message cannot satisfy final verification');
}

async function testQuestionListActivationWaitsForNavigation() {
  const source = fs.readFileSync(path.join(root, 'js/timeline/question-list/index.js'), 'utf8')
    + '\nwindow.__TestQuestionListPopup = QuestionListPopup;';
  const window = {};
  vm.runInContext(source, vm.createContext({ window, document: new FakeEventTarget(), Promise }));
  const popup = new window.__TestQuestionListPopup();
  const activations = [];
  popup._updateActiveItem = id => activations.push(id);
  const tm = { activeTurnId: 'chatgpt-u2', navigateToMarkerId: async () => false };
  assert.equal(await popup._navigateMarker(tm, 'chatgpt-u28', 27), false);
  assert.deepEqual(activations, ['chatgpt-u2'], 'failed list navigation keeps the actually active marker selected');
  tm.navigateToMarkerId = async id => id === 'chatgpt-u28';
  assert.equal(await popup._navigateMarker(tm, 'chatgpt-u28', 27), true);
  assert.deepEqual(activations, ['chatgpt-u2', 'chatgpt-u28'], 'list selection updates only after confirmed navigation');
}

async function testChatGPTJumpIsBoundedAndNeverScans() {
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
  adapter._capturedTurns = [{ id: 'old', messageId: 'old', ids: ['old'], userOrder: 2 }];
  adapter.resolveTimelineElement = () => null;
  adapter._requestVirtualizerJump = async () => ({ ok: false, reason: 'virtualizer_api_not_found' });
  const result = await adapter.jumpToTimelineMarker({ id: 'chatgpt-old', messageId: 'old', userOrder: 2 }, {
    scrollContainer, isCurrent: () => true
  });
  assert.equal(result, null);
  assert.deepEqual(positions, [], 'controller failure must not trigger any full-page scroll scan');

  let commands = 0;
  adapter._requestVirtualizerJump = async () => { commands++; return { ok: true }; };
  adapter._waitForMarkerMount = async () => ({ element: null, mountMs: 1, mutations: 0 });
  assert.equal(await adapter.jumpToTimelineMarker({ id: 'chatgpt-old', messageId: 'old', userOrder: 2 }, {
    scrollContainer, isCurrent: () => true
  }), null, 'an accepted command without an exact DOM identity match is failure');
  assert.equal(commands, 1, 'a failed strategy is not repeated within one navigation task');
  assert.deepEqual(positions, [], 'false success must not fall back to scroll probing');
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
  await testAdapterBuildsCompleteMarkersFromPartialDom();
  await testVirtualizerBridge();
  await testManagerVirtualMarkerNavigation();
  await testQuestionListActivationWaitsForNavigation();
  await testChatGPTJumpIsBoundedAndNeverScans();
  await testCapturedApiTriggersInitialization();
  console.log('PASS: 100+ turns, Q44→Q28/Q1→Q44 mounting, attachment IDs, both controller signatures, bounded no-op handling, list activation, isolation, and last-click-wins.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
