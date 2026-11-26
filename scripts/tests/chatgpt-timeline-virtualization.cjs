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
    AbortController,
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
    AbortController,
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
  const nativePaginationEvents = [];
  document.addEventListener('ait-gpt-native-history-pagination', event => {
    nativePaginationEvents.push(JSON.parse(event.detail));
  });
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
  await window.fetch(`https://chatgpt.com/backend-api/conversations/${conversationId}/messages?before=native-cursor`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nativePaginationEvents.some(event => event.stage === 'request'), true);
  assert.equal(nativePaginationEvents.some(event => event.stage === 'response' && event.ok === true), true,
    'captured native history pagination exposes a paired, current-conversation lifecycle signal');

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
  const createBridge = (virtualizer, options = {}) => {
    class FakeElement {
      constructor(attrs = {}) { this.attrs = attrs; this.isConnected = true; this.parentElement = null; }
      getAttribute(name) { return this.attrs[name] || null; }
      getBoundingClientRect() { return { width: 600, height: 80, top: 120, bottom: 200 }; }
      getClientRects() { return [this.getBoundingClientRect()]; }
      closest() { return this; }
      contains(node) { return node === this; }
    }
    const reactValues = options.reactValues || [options.reactValue || { memoizedState: { virtualizer } }];
    const elements = reactValues.map((reactValue, index) => {
      const element = new FakeElement();
      element[`__reactFiber$test${index}`] = reactValue;
      element.parentElement = null;
      return element;
    });
    options.configureElements?.(elements);
    const document = new FakeEventTarget();
    document.querySelectorAll = selector => {
      if (selector.startsWith('[data-turn-key], [data-content-search-turn-key]')) {
        return options.targetNodes?.() || [];
      }
      return elements.filter(element => element.isConnected !== false);
    };
    document.documentElement = elements[0];
    document.body = elements[0];
    const window = {};
    const context = vm.createContext({
      window, document, Element: FakeElement, CustomEvent: FakeCustomEvent,
      Date, Math, JSON, Set, WeakSet, WeakMap, Object, Array, Promise,
      location: { pathname: '/c/test-conversation' },
      performance: { now: options.performanceNow || (() => Date.now()) }, setTimeout, clearTimeout
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/apiCapture/chatgpt-virtualizer.js'), 'utf8'), context);
    let requestSequence = 0;
    const send = request => new Promise(resolve => {
      const requestId = `bridge-case-${++requestSequence}`;
      const handler = event => {
        const result = JSON.parse(event.detail);
        if (result.requestId !== requestId) return;
        document.removeEventListener('ait-gpt-virtualizer-jump-result', handler);
        resolve(result);
      };
      document.addEventListener('ait-gpt-virtualizer-jump-result', handler);
      document.dispatchEvent(new FakeCustomEvent('ait-gpt-virtualizer-jump', {
        detail: JSON.stringify({ requestId, deadlineMs: 900, ...request })
      }));
      if (Number.isFinite(options.cancelAfterMs)) {
        setTimeout(() => document.dispatchEvent(new FakeCustomEvent('ait-gpt-virtualizer-jump-cancel', {
          detail: JSON.stringify({ all: true, reason: 'newer-click' })
        })), options.cancelAfterMs);
      }
    });
    return { send, document, elements, context };
  };
  const runBridge = async (virtualizer, request, options = {}) =>
    createBridge(virtualizer, options).send(request);

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

  let nativeMounted = false;
  const nativeCalls = [];
  const nativeOwner = {
    memoizedProps: { turnListApi: {
      async scrollToKey(key) {
        nativeCalls.push(key);
        if (key === 'q2') nativeMounted = true;
      }
    } },
    memoizedState: { turnKeys: ['q6', 'q7', 'q2'], retainedTurnKeys: ['q1'] }
  };
  const makeNativeTarget = key => new (class {
    constructor() { this.isConnected = true; }
    getAttribute(name) { return name === 'data-turn-key' ? key : null; }
    getBoundingClientRect() { return { width: 600, height: 80, top: 125, bottom: 205 }; }
    closest(selector) { return selector.includes('data-turn') ? this : null; }
  })();
  const nativeTarget = makeNativeTarget('q2');
  result = await runBridge(nativeOwner, {
    targetIds: ['q2'], targetUserOrder: 2, totalUserTurns: 10
  }, { targetNodes: () => nativeMounted ? [nativeTarget] : [] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.indexStrategy, 'native-turn-key');
  assert.equal(result.targetKeyLoaded, true);
  assert.deepEqual(nativeCalls, ['q2'], 'the verified native key is called exactly once');

  const makeHookChain = (nextDepth, keys, retainedKeys = []) => {
    const head = { memoizedState: {} };
    let hook = head;
    for (let index = 0; index < nextDepth; index++) {
      hook.next = { memoizedState: {} };
      hook = hook.next;
    }
    hook.memoizedState = { turnKeys: keys, retainedTurnKeys: retainedKeys };
    return head;
  };
  for (const depth of [8, 9, 10, 12, 32]) {
    let mounted = false;
    let calls = 0;
    const componentFiber = {
      pendingProps: { turnListApi: { async scrollToKey(key) { calls++; mounted = key === 'deep-q2'; } } },
      memoizedProps: {},
      memoizedState: makeHookChain(depth, ['deep-q2'])
    };
    const reactLeaf = { return: componentFiber, memoizedState: null, memoizedProps: {} };
    result = await runBridge(null, { targetIds: ['deep-q2'] }, {
      reactValue: reactLeaf,
      targetNodes: () => mounted ? [makeNativeTarget('deep-q2')] : []
    });
    assert.equal(result.ok, true, `Hook next depth ${depth}: ${JSON.stringify(result)}`);
    assert.equal(result.nativeKeyCount, 1, `Hook next depth ${depth} must expose the Key collection`);
    assert.equal(calls, 1, `Hook next depth ${depth} must call scrollToKey once`);
  }

  let splitMounted = false;
  let splitCalls = 0;
  const splitApiFiber = {
    pendingProps: { turnListApi: { scrollToKey(key) { splitCalls++; splitMounted = key === 'q2'; } } },
    memoizedState: null
  };
  const splitKeysFiber = {
    pendingProps: {}, memoizedState: makeHookChain(12, ['q2', 'q6', 'q7'])
  };
  result = await runBridge(null, { targetIds: ['q2'] }, {
    reactValues: [{ return: splitApiFiber }, { return: splitKeysFiber }],
    targetNodes: () => splitMounted ? [nativeTarget] : []
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(splitCalls, 1,
    'an exact target Key may validate a visible conversation API even when props and Hook entry roots differ');

  let wrongControllerCalls = 0;
  let currentControllerCalls = 0;
  let multipleMounted = false;
  const wrongFiber = {
    pendingProps: { turnListApi: { scrollToKey() { wrongControllerCalls++; } } },
    memoizedState: makeHookChain(12, ['q2'])
  };
  const currentFiber = {
    pendingProps: { turnListApi: { scrollToKey(key) { currentControllerCalls++; multipleMounted = key === 'q2'; } } },
    memoizedState: makeHookChain(12, ['q2'])
  };
  result = await runBridge(null, { targetIds: ['q2'] }, {
    reactValues: [{ return: wrongFiber }, { return: currentFiber }],
    configureElements: elements => {
      elements[0].getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, bottom: 0 });
    },
    targetNodes: () => multipleMounted ? [nativeTarget] : []
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(wrongControllerCalls, 0, 'a hidden stale conversation controller is not selected even with the same target Key');
  assert.equal(currentControllerCalls, 1, 'the current conversation controller owns the target Key');

  let pagedMounted = false;
  let pagedCalls = 0;
  const pagedFiber = {
    pendingProps: { turnListApi: { scrollToKey() { pagedCalls++; pagedMounted = true; } } },
    memoizedState: makeHookChain(12, ['q6', 'q7'], ['q1'])
  };
  const pagedBridge = createBridge(null, {
    reactValue: { return: pagedFiber },
    targetNodes: () => pagedMounted ? [nativeTarget] : []
  });
  result = await pagedBridge.send({
    targetIds: ['q2'], queryOnly: true,
    knownUserTurns: [
      { userOrder: 2, ids: ['q2'] },
      { userOrder: 1, ids: ['q1'] },
      { userOrder: 6, ids: ['q6'] },
      { userOrder: 7, ids: ['q7'] }
    ]
  });
  assert.equal(result.queryOnly, true);
  assert.equal(result.targetKeyLoaded, false);
  assert.deepEqual(result.loadedUserOrders, [1, 6, 7]);
  assert.deepEqual(result.turnUserOrders, [6, 7]);
  assert.deepEqual(result.retainedUserOrders, [1],
    'retained keys are reported separately and never define the loaded turn range');
  assert.equal(pagedCalls, 0, 'read-only Key queries never invoke scrollToKey');
  result = await pagedBridge.send({ targetIds: ['q2'] });
  assert.equal(result.reason, 'target-key-not-loaded');
  assert.equal(pagedCalls, 0);
  pagedFiber.memoizedState = makeHookChain(14, ['q2', 'q6', 'q7']);
  result = await pagedBridge.send({ targetIds: ['q2'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(pagedCalls, 1, 'history pagination replaces the Hook Key collection used by the next discovery');

  let oldTreeCalls = 0;
  let newTreeCalls = 0;
  let replacementMounted = false;
  const oldFiber = {
    pendingProps: { turnListApi: { scrollToKey() { oldTreeCalls++; replacementMounted = true; } } },
    memoizedState: makeHookChain(8, ['q2'])
  };
  const replacementBridge = createBridge(null, {
    reactValue: { return: oldFiber },
    targetNodes: () => replacementMounted ? [nativeTarget] : []
  });
  result = await replacementBridge.send({ targetIds: ['q2'] });
  assert.equal(result.ok, true);
  replacementMounted = false;
  const newFiber = {
    pendingProps: { turnListApi: { scrollToKey() { newTreeCalls++; replacementMounted = true; } } },
    memoizedState: makeHookChain(12, ['q2'])
  };
  const element = replacementBridge.elements[0];
  delete element.__reactFiber$test0;
  element.__reactFiber$replacement = { return: newFiber };
  result = await replacementBridge.send({ targetIds: ['q2'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(oldTreeCalls, 1, 'a replaced React tree must not reuse its old controller');
  assert.equal(newTreeCalls, 1, 'the replacement React tree is rediscovered');

  let delayedMounted = false;
  const delayedFiber = {
    pendingProps: { turnListApi: { scrollToKey: () => new Promise(resolve => {
      setTimeout(() => { delayedMounted = true; }, 40);
      setTimeout(resolve, 220);
    }) } },
    memoizedState: makeHookChain(12, ['q2'])
  };
  const delayedBridge = createBridge(null, {
    reactValue: { return: delayedFiber },
    targetNodes: () => delayedMounted ? [nativeTarget] : []
  });
  let issuedProgress = null;
  delayedBridge.document.addEventListener('ait-gpt-virtualizer-jump-progress', event => {
    issuedProgress = JSON.parse(event.detail);
  });
  const delayedResultPromise = delayedBridge.send({ targetIds: ['q2'], deadlineMs: 700 });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(issuedProgress?.nativeCommandIssued, true,
    'the bridge acknowledges native invocation before its Promise settles');
  result = await delayedResultPromise;
  assert.equal(result.ok, true);
  assert.equal(result.nativeCommandIssued, true);
  assert.equal(result.promisePendingAfterTarget, true,
    'verified target identity may complete navigation observation before a slow native Promise');

  let strictMounted = false;
  let strictSettled = false;
  const strictFiber = {
    pendingProps: { turnListApi: { scrollToKey: () => new Promise(resolve => {
      setTimeout(() => { strictMounted = true; }, 30);
      setTimeout(() => { strictSettled = true; resolve(); }, 160);
    }) } },
    memoizedState: makeHookChain(12, ['q2'])
  };
  result = await runBridge(null, { targetIds: ['q2'], deadlineMs: 700, requireSettledNativeKey: true }, {
    reactValue: { return: strictFiber }, targetNodes: () => strictMounted ? [nativeTarget] : []
  });
  assert.equal(result.ok, true);
  assert.equal(strictSettled, true, 'history edge navigation waits for the native Promise even after mounting');
  assert.notEqual(result.promisePendingAfterTarget, true);

  let cancelledNativeFinished = false;
  let cancelledNativeCalls = 0;
  const cancelledFiber = {
    pendingProps: { turnListApi: { scrollToKey: () => {
      cancelledNativeCalls++;
      return new Promise(resolve => setTimeout(() => {
        cancelledNativeFinished = true;
        resolve();
      }, 120));
    } } },
    memoizedState: makeHookChain(12, ['q2'])
  };
  result = await runBridge(null, { targetIds: ['q2'], deadlineMs: 700 }, {
    reactValue: { return: cancelledFiber }, cancelAfterMs: 20, targetNodes: () => []
  });
  assert.equal(result.reason, 'cancelled');
  assert.equal(result.nativeCommandIssued, true);
  assert.equal(cancelledNativeCalls, 1);
  await new Promise(resolve => setTimeout(resolve, 140));
  assert.equal(cancelledNativeFinished, true,
    'cancelling observation does not assume an already-invoked page Promise was cancelled');

  let missingKeyCalls = 0;
  const mountedQ6 = new (class {
    constructor() { this.isConnected = true; }
    getAttribute(name) { return name === 'data-turn-key' ? 'q6' : null; }
    getBoundingClientRect() { return { width: 600, height: 80, top: 125, bottom: 205 }; }
    closest(selector) { return selector.includes('data-turn') ? this : null; }
  })();
  result = await runBridge({
    memoizedProps: { turnListApi: { scrollToKey() { missingKeyCalls++; } } },
    memoizedState: { turnKeys: ['q6', 'q7'], retainedTurnKeys: [] }
  }, {
    targetIds: ['q2'], targetUserOrder: 2, totalUserTurns: 10
  }, { targetNodes: () => [mountedQ6] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'target-key-not-loaded');
  assert.equal(result.failureStage, 'native-list-capability');
  assert.equal(missingKeyCalls, 0, 'scrollToKey must not run for history absent from native turnKeys');

  let fulfilledNoEffectCalls = 0;
  result = await runBridge({
    memoizedProps: { turnListApi: { async scrollToKey() { fulfilledNoEffectCalls++; } } },
    memoizedState: { turnKeys: ['q2'], retainedTurnKeys: [] }
  }, {
    targetIds: ['q2'], deadlineMs: 300
  }, { targetNodes: () => [] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'target-key-no-observable-effect');
  assert.equal(fulfilledNoEffectCalls, 1, 'fulfilled Promise without a mounted identity is not success');

  let movedScrollRoot = null;
  result = await runBridge(null, {
    targetIds: ['q2'], deadlineMs: 300
  }, {
    reactValue: { memoizedProps: { turnListApi: {
      async scrollToKey() { movedScrollRoot.scrollTop = 420; }
    } }, memoizedState: { turnKeys: ['q2'], retainedTurnKeys: [] } },
    configureElements: elements => {
      movedScrollRoot = elements[0];
      movedScrollRoot.scrollTop = 0;
    },
    targetNodes: () => []
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'target-key-moved-without-target');
  assert.equal(result.stateChanged, true,
    'native movement is retained even when the stable target never mounts');

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

  const transientAdapter = new window.__TestChatGPTAdapter();
  transientAdapter.isTransientConversation = () => true;
  transientAdapter.extractText = element => `temporary ${element.getAttribute('data-turn-key')}`;
  const transientTurn = id => {
    const content = {
      textContent: `temporary ${id}`,
      getBoundingClientRect: () => ({ width: 300, height: 40, top: 20, bottom: 60 }),
      closest: () => null,
      matches: () => false,
      querySelectorAll: () => []
    };
    return {
      isConnected: true,
      getAttribute: name => name === 'data-turn-key' ? id : null,
      matches: selector => selector.includes('[data-turn-key]'),
      closest: () => null,
      querySelectorAll: selector => selector.includes('data-message-author-role') ? [content] : [],
      querySelector: () => null,
      hasAttribute: () => false,
      getBoundingClientRect: () => ({ width: 600, height: 80, top: 0, bottom: 80 })
    };
  };
  const temporaryQ1 = transientTurn('temporary-q1');
  const temporaryQ2 = transientTurn('temporary-q2');
  let transientEntries = transientAdapter.getTimelineEntries([temporaryQ1]);
  assert.equal(transientEntries.length, 1);
  transientEntries = transientAdapter.getTimelineEntries([temporaryQ1, temporaryQ2]);
  assert.equal(Array.from(transientEntries, entry => entry.sourceId).join(','),
    'temporary-q1,temporary-q2');
  assert.equal(transientEntries.every(entry => entry.transient === true), true,
    'Temporary Chat maintains a complete in-memory-only marker index as turns arrive');
  transientAdapter.getInitializationAnchor = () => temporaryQ1;
  assert.equal(transientAdapter.isConversationRoute('/'), true,
    'a non-durable ChatGPT route initializes only after a real turn anchor exists');

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
  assert.equal(adapter.findConversationContainer(userRoot), null,
    'new layout must never use the whole main as an extension injection container');
  assert.equal(adapter.shouldManageScrollPadding(), false,
    'ChatGPT virtual scroll height must not be changed by an injected padding child');
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
  let shellScrollCalls = 0;
  shellOnly.scrollIntoView = () => { shellScrollCalls++; };
  adapter._findIdentityAnchor = () => shellOnly;
  adapter._getCachedScrollPosition = () => null;
  assert.equal(await adapter._tryKnownTimelinePosition(modernEntries[0], {
    scrollContainer: {}, isCurrent: () => true
  }), null);
  assert.equal(shellScrollCalls, 0,
    'a modern identity shell without rendered user content is never scrolled as a real message');
  delete adapter._findIdentityAnchor;
  delete adapter._getCachedScrollPosition;
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
  let actualScrollTop = 500;
  let scrollTopWrites = 0;
  const actualScrollRoot = {
    get scrollTop() { return actualScrollTop; },
    set scrollTop(value) { scrollTopWrites++; nativeTop -= value - actualScrollTop; actualScrollTop = value; },
    getBoundingClientRect: () => ({ top: 0, bottom: 500 })
  };
  const fallbackHtml = { scrollTop: 0 };
  let nativeScrollCalls = 0;
  const nativeBubble = {
    getBoundingClientRect: () => ({ top: nativeTop, bottom: nativeTop + 80, height: 80 }),
    scrollIntoView() { nativeScrollCalls++; nativeTop = 0; }
  };
  const nativeTarget = {
    isConnected: true,
    getBoundingClientRect: () => ({ top: 0, bottom: 0, height: 0 }),
    querySelectorAll: () => [nativeBubble],
    scrollIntoView() { throw new Error('the zero-layout turn shell must not be scrolled'); }
  };
  const nativeManager = Object.create(window.__TestTimelineManager.prototype);
  nativeManager.adapter = {
    platformId: 'chatgpt',
    resolveTimelineScrollContainer: () => actualScrollRoot,
    getScrollOffset: () => 30
  };
  nativeManager.conversationContainer = {};
  nativeManager.scrollContainer = fallbackHtml;
  nativeManager.isScrollContainerFallback = true;
  assert.equal(await nativeManager.smoothScrollTo(nativeTarget, 0), true,
    'Q10 → Q12 uses the laid-out user question bubble when its turn shell has no box');
  assert.equal(nativeTop, 30, 'the user question is aligned 30px below the chat viewport top');
  nativeTop = -700;
  assert.equal(await nativeManager.smoothScrollTo(nativeTarget, 0), true,
    'Q12 → Q10 uses the same native path in the opposite direction');
  assert.equal(nativeTop, 30, 'upward navigation uses the same user-question alignment');
  assert.equal(nativeScrollCalls, 2, 'each navigation first reveals the real user-question body');
  assert.equal(scrollTopWrites, 2, 'each navigation then performs one 30px precision correction');
  assert.equal(fallbackHtml.scrollTop, 0, 'native ChatGPT navigation never writes scrollTop to fallback HTML');

  const mountedById = new Map(['chatgpt-u1', 'chatgpt-u50', 'chatgpt-u100'].map(id => [id, { isConnected: true, id }]));
  const bridgeCalls = [];
  const smoothed = [];
  const smoothOptions = [];
  manager._destroyed = false;
  manager.scrollContainer = {};
  manager.conversationContainer = {};
  manager.adapter = {
    platformId: 'chatgpt',
    resolveTimelineElement: marker => marker.element?.isConnected ? marker.element : null,
    jumpToTimelineMarker: async marker => { bridgeCalls.push(marker.id); return mountedById.get(marker.id); },
    invalidateTimelineNodes: () => {}
  };
  manager.smoothScrollTo = (element, duration, options) => {
    smoothed.push(element.id);
    smoothOptions.push(options || {});
    return true;
  };
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
  assert.deepEqual(smoothed, ['chatgpt-u1', 'chatgpt-u50', 'chatgpt-u100'],
    'every identity-verified ChatGPT target receives the proven final precision alignment');

  const nativeKeyMarker = { id: 'chatgpt-native-q2', messageId: 'q2', element: null, virtual: true };
  const nativeKeyElement = { isConnected: true, id: nativeKeyMarker.id };
  manager.adapter.jumpToTimelineMarker = async marker => {
    marker._aitNavigationStrategy = 'native-turn-key';
    return nativeKeyElement;
  };
  manager.adapter.resolveTimelineElement = marker => marker.element?.isConnected ? marker.element : null;
  smoothed.length = 0;
  assert.equal(await manager.navigateToMarker(nativeKeyMarker), true,
    'a native Key jump still finishes through stable-ID verification and precise alignment');
  assert.deepEqual(smoothed, ['chatgpt-native-q2']);
  assert.equal(smoothOptions.at(-1).skipReveal, true,
    'native Key positioning skips a second scrollIntoView and performs only final offset correction');

  const displacedMarker = { id: 'chatgpt-native-displaced', messageId: 'q10', element: null, virtual: true };
  const displacedElement = { isConnected: true, id: displacedMarker.id };
  const recoveredElement = { isConnected: true, id: displacedMarker.id };
  let displacedResolved = displacedElement;
  let displacementRecoveries = 0;
  manager.adapter.jumpToTimelineMarker = async marker => {
    marker._aitNavigationStrategy = 'native-turn-key';
    return displacedElement;
  };
  manager.adapter.resolveTimelineElement = () => displacedResolved;
  manager.adapter.recoverDisplacedTimelineMarker = async () => {
    displacementRecoveries++;
    displacedResolved = recoveredElement;
    return recoveredElement;
  };
  manager._isElementVisibleInScrollContainer = element => element === recoveredElement;
  manager.smoothScrollTo = async element => {
    if (element === displacedElement) displacedResolved = null;
    return true;
  };
  assert.equal(await manager.navigateToMarker(displacedMarker), true,
    'a stable-ID target displaced during final native settling uses the existing recovery path');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(displacementRecoveries, 1,
    'final verification and delayed settling share one displacement recovery allowance');

  manager.adapter.recoverDisplacedTimelineMarker = undefined;
  manager.adapter.resolveTimelineElement = marker => marker.element?.isConnected ? marker.element : null;
  manager._isElementVisibleInScrollContainer = element => !!element?.isConnected;
  manager.smoothScrollTo = (element, duration, options) => {
    smoothed.push(element.id);
    smoothOptions.push(options || {});
    return true;
  };

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
  assert.deepEqual(smoothed, ['chatgpt-u100'], 'only the last rapid click owns final alignment');

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
  const adapterDocument = new FakeEventTarget();
  adapterDocument.querySelectorAll = () => [];
  adapterDocument.body = adapterDocument;
  adapterDocument.documentElement = adapterDocument;
  const context = vm.createContext({
    window: {}, document: adapterDocument, SiteAdapter, Map, Set, Array, Object, JSON, Promise,
    CustomEvent: FakeCustomEvent, setTimeout, clearTimeout,
    location: { pathname: '/c/test-conversation' }
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

  const cachedAdapter = new context.window.__TestChatGPTAdapter();
  cachedAdapter._capturedTurns = Array.from({ length: 19 }, (_, index) => ({
    id: `u${index + 1}`, messageId: `m${index + 1}`, ids: [`u${index + 1}`, `m${index + 1}`],
    userOrder: index + 1
  }));
  cachedAdapter._findIdentityAnchor = () => null;
  cachedAdapter.resolveTimelineElement = () => null;
  cachedAdapter._getDomIdCandidates = () => ['m5'];
  cachedAdapter._isRenderedMessageElement = () => true;
  cachedAdapter.getUserMessageSelector = () => '[data-test-user]';
  let observedTop = 200;
  const observedQ5 = {
    isConnected: true, hasAttribute: () => false,
    getBoundingClientRect: () => ({ top: observedTop, bottom: observedTop + 80, height: 80 })
  };
  context.document.querySelectorAll = () => [observedQ5];
  cachedAdapter.getActiveTimelineMarkerId({
    scrollTop: 4000, scrollHeight: 19462, clientHeight: 462,
    getBoundingClientRect: () => ({ top: 0, bottom: 462 })
  }, [{ id: 'chatgpt-u5', sourceId: 'u5', messageId: 'm5', aliasIds: ['u5', 'm5'], userOrder: 5 }]);
  assert.equal(cachedAdapter._scrollPositionByMessageId.get('m5').top, 4200,
    'normal manual scrolling records Q5 by stable ID and real scroll position');
  observedTop = 125.5;
  assert.equal(cachedAdapter.getActiveTimelineMarkerId({
    scrollTop: 4000, scrollHeight: 19462, clientHeight: 462,
    getBoundingClientRect: () => ({ top: 0, bottom: 462 })
  }, [{ id: 'chatgpt-u5', sourceId: 'u5', messageId: 'm5', aliasIds: ['u5', 'm5'], userOrder: 5 }], 120), 'chatgpt-u5',
  'native scrollToKey landing near 125px must activate the matching dot');
  observedTop = 200;
  cachedAdapter.getActiveTimelineMarkerId({
    scrollTop: 4000, scrollHeight: 19462, clientHeight: 462,
    getBoundingClientRect: () => ({ top: 0, bottom: 462 })
  }, [{ id: 'chatgpt-u5', sourceId: 'u5', messageId: 'm5', aliasIds: ['u5', 'm5'], userOrder: 5 }]);
  let cachedMounted = false;
  const cachedScroll = { scrollHeight: 19462, clientHeight: 462,
    get scrollTop() { return this._top || 0; },
    set scrollTop(value) { this._top = value; cachedMounted = Math.abs(value - 4200) < 5; }
  };
  const cachedElement = { isConnected: true };
  cachedAdapter._waitForMarkerMount = async () => ({
    element: cachedMounted ? cachedElement : null, mountMs: 1, mutations: 1
  });
  let nativeCapabilityChecks = 0;
  cachedAdapter._requestVirtualizerJump = async () => {
    nativeCapabilityChecks++;
    return { ok: false, reason: 'target-key-not-loaded', nativeKeyCount: 10 };
  };
  assert.equal(await cachedAdapter.jumpToTimelineMarker({
    id: 'chatgpt-u5', sourceId: 'u5', messageId: 'm5', aliasIds: ['u5', 'm5'], userOrder: 5
  }, { scrollContainer: cachedScroll, isCurrent: () => true }), cachedElement,
  'a manually visited Q5 remounts from its stable-ID position before React discovery');
  assert.equal(nativeCapabilityChecks, 0, 'the proven cached-anchor path keeps its original priority');

  cachedMounted = false;
  cachedAdapter._requestVirtualizerJump = async () => ({
    ok: false, reason: 'virtualizer_api_not_found'
  });
  cachedAdapter._captureReadingAnchor = () => ({ ids: ['reading-q31'], offset: 30 });
  cachedAdapter._restoreReadingAnchor = async (anchor, container) => {
    assert.equal(anchor.ids[0], 'reading-q31');
    container.scrollTop = 900;
    return true;
  };
  let collapsedWrites = 0;
  const collapsedScroll = {
    scrollHeight: 2416, clientHeight: 462, scrollTop: 900,
    setScrollTop(value) { this.scrollTop = value; collapsedWrites++; }
  };
  Object.defineProperty(collapsedScroll, 'scrollTop', {
    get() { return this._top || 900; },
    set(value) { this._top = value; collapsedWrites++; }, configurable: true
  });
  assert.equal(await cachedAdapter.jumpToTimelineMarker({
    id: 'chatgpt-u5', sourceId: 'u5', messageId: 'm5', aliasIds: ['u5', 'm5'], userOrder: 5
  }, { scrollContainer: collapsedScroll, isCurrent: () => true }), null,
  'an invalid cached coordinate falls through to the original bounded search');
  assert.ok(collapsedWrites >= 2,
    'bounded search restores the reading position through its stable message identity');
  assert.equal(collapsedScroll.scrollTop, 900);

  const ratioAdapter = new context.window.__TestChatGPTAdapter();
  ratioAdapter._capturedTurns = cachedAdapter._capturedTurns;
  ratioAdapter._findIdentityAnchor = () => null;
  ratioAdapter.resolveTimelineElement = () => null;
  ratioAdapter._buildVirtualIndexPlan = () => ({
    index: null, strategy: 'virtual-item-key-or-bounded-ratio', mappingVerified: false,
    observedIndices: [], targetIds: ['u2', 'm2']
  });
  ratioAdapter._requestVirtualizerJump = async () => ({ ok: false, reason: 'virtualizer_api_not_found' });
  let ratioWrites = 0;
  let ratioMounted = false;
  const ratioScroll = { scrollHeight: 19462, clientHeight: 462,
    get scrollTop() { return this._top || 0; },
    set scrollTop(value) {
      this._top = value;
      ratioWrites++;
      ratioMounted = Math.abs(value - (19000 / 18)) < 5;
    }
  };
  const ratioElement = { isConnected: true };
  ratioAdapter._waitForMarkerMount = async () => ({
    element: ratioMounted ? ratioElement : null, mountMs: 1, mutations: 1
  });
  assert.equal(await ratioAdapter.jumpToTimelineMarker({
    id: 'chatgpt-u2', sourceId: 'u2', messageId: 'm2', aliasIds: ['u2', 'm2'], userOrder: 2
  }, { scrollContainer: ratioScroll, isCurrent: () => true }), ratioElement,
  'Q2 uses one bounded scroll-range estimate when the React virtualizer is unavailable');
  assert.equal(ratioWrites, 1, 'successful coarse positioning does not scan or oscillate');

  const bracketAdapter = new context.window.__TestChatGPTAdapter();
  bracketAdapter._capturedTurns = cachedAdapter._capturedTurns;
  bracketAdapter._findIdentityAnchor = () => null;
  bracketAdapter.resolveTimelineElement = () => null;
  bracketAdapter._buildVirtualIndexPlan = ratioAdapter._buildVirtualIndexPlan;
  bracketAdapter._requestVirtualizerJump = ratioAdapter._requestVirtualizerJump;
  let bracketMounted = false;
  const bracketWrites = [];
  const bracketScroll = { scrollHeight: 19462, clientHeight: 462, _top: 19000,
    get scrollTop() { return this._top; },
    set scrollTop(value) {
      this._top = value;
      bracketWrites.push(value);
      bracketMounted = value > 11800 && value < 12000;
    },
    getBoundingClientRect: () => ({ top: 0, bottom: 462 })
  };
  bracketAdapter._waitForMarkerMount = async () => ({
    element: bracketMounted ? ratioElement : null, mountMs: 1, mutations: 1
  });
  bracketAdapter._getMountedUserOrderRange = () => bracketScroll.scrollTop > 14000
    ? { min: 18, max: 19, anchors: [] }
    : { min: 10, max: 12, anchors: [] };
  assert.equal(await bracketAdapter.jumpToTimelineMarker({
    id: 'chatgpt-u16', sourceId: 'u16', messageId: 'm16', aliasIds: ['u16', 'm16'], userOrder: 16
  }, { scrollContainer: bracketScroll, isCurrent: () => true }), ratioElement,
  'Q16 narrows the proven scroll bracket after overshooting above and below the target');
  assert.equal(bracketWrites.length, 3, 'Q16 is found by one ratio estimate and two shrinking bracket corrections');
  assert.ok(bracketWrites[2] > bracketWrites[1] && bracketWrites[2] < bracketWrites[0],
    'the third position stays inside the evidence-backed bracket instead of making another large jump');

  const protocolAdapter = new context.window.__TestChatGPTAdapter();
  protocolAdapter._capturedTurns = cachedAdapter._capturedTurns;
  let protocolRequestCount = 0;
  const protocolRequestHandler = event => {
    const request = JSON.parse(event.detail);
    protocolRequestCount++;
    context.document.dispatchEvent(new FakeCustomEvent('ait-gpt-virtualizer-jump-progress', {
      detail: JSON.stringify({
        requestId: request.requestId, phase: 'command-issued', commandIssued: true,
        nativeCommandIssued: true, method: 'scrollToKey', indexStrategy: 'native-turn-key',
        targetKeyLoaded: true, nativeKeyCount: 10
      })
    }));
    const resultDelay = protocolRequestCount === 1 ? 80 : 5;
    setTimeout(() => context.document.dispatchEvent(new FakeCustomEvent('ait-gpt-virtualizer-jump-result', {
      detail: JSON.stringify({
        requestId: request.requestId, ok: true, controllerValidated: true,
        commandIssued: true, nativeCommandIssued: true,
        indexStrategy: 'native-turn-key', targetKeyLoaded: true, nativeKeyCount: 10
      })
    })), resultDelay);
  };
  context.document.addEventListener('ait-gpt-virtualizer-jump', protocolRequestHandler);
  const protocolPlan = { index: null, strategy: 'native-test', mappingVerified: false,
    observedIndices: [], targetIds: ['q2'] };
  const timeoutResult = await protocolAdapter._requestVirtualizerJump(
    protocolPlan, { userOrder: 2 }, { taskId: 90 }, 30
  );
  assert.equal(timeoutResult.reason, 'bridge-timeout');
  assert.equal(timeoutResult.commandIssued, true);
  assert.equal(timeoutResult.nativeCommandIssued, true,
    'bridge timeout retains the already-issued native command state');
  const nextResult = await protocolAdapter._requestVirtualizerJump(
    protocolPlan, { userOrder: 3 }, { taskId: 91 }, 100
  );
  assert.equal(nextResult.ok, true, 'a second click owns its own request despite the first late result');
  await new Promise(resolve => setTimeout(resolve, 90));
  context.document.removeEventListener('ait-gpt-virtualizer-jump', protocolRequestHandler);

  const timeoutNavigationAdapter = new context.window.__TestChatGPTAdapter();
  timeoutNavigationAdapter._capturedTurns = cachedAdapter._capturedTurns;
  timeoutNavigationAdapter.resolveTimelineElement = () => null;
  timeoutNavigationAdapter._buildVirtualIndexPlan = () => protocolPlan;
  timeoutNavigationAdapter._requestVirtualizerJump = async () => timeoutResult;
  let timeoutKnownChecks = 0;
  let timeoutFallbacks = 0;
  timeoutNavigationAdapter._tryKnownTimelinePosition = async () => { timeoutKnownChecks++; return null; };
  timeoutNavigationAdapter._fallbackScrollByUserOrder = async () => { timeoutFallbacks++; return null; };
  assert.equal(await timeoutNavigationAdapter.jumpToTimelineMarker({
    id: 'chatgpt-q2', sourceId: 'q2', aliasIds: ['q2'], userOrder: 2
  }, { scrollContainer: bracketScroll, isCurrent: () => true }), null);
  assert.equal(timeoutKnownChecks, 1, 'the original known-anchor check still runs before native discovery');
  assert.equal(timeoutFallbacks, 0,
    'an invoked native command never stacks cached-pixel or bounded-search fallback after timeout');

  const noEffectAdapter = new context.window.__TestChatGPTAdapter();
  noEffectAdapter._capturedTurns = cachedAdapter._capturedTurns;
  noEffectAdapter.resolveTimelineElement = () => null;
  noEffectAdapter._tryKnownTimelinePosition = async () => null;
  noEffectAdapter._buildVirtualIndexPlan = () => protocolPlan;
  noEffectAdapter._requestVirtualizerJump = async () => ({
    ok: false, reason: 'target-key-no-observable-effect',
    nativeCommandIssued: true, indexStrategy: 'native-turn-key',
    targetKeyLoaded: true, nativeKeyCount: 19
  });
  let noEffectFallbacks = 0;
  noEffectAdapter._fallbackScrollByUserOrder = async () => {
    noEffectFallbacks++;
    return ratioElement;
  };
  assert.equal(await noEffectAdapter.jumpToTimelineMarker({
    id: 'chatgpt-u19', sourceId: 'u19', aliasIds: ['u19'], userOrder: 19
  }, { scrollContainer: bracketScroll, isCurrent: () => true }), ratioElement);
  assert.equal(noEffectFallbacks, 1,
    'a settled scrollToKey with no observable effect resumes the original bounded search');

  const unloadedAdapter = new context.window.__TestChatGPTAdapter();
  unloadedAdapter._capturedTurns = cachedAdapter._capturedTurns;
  unloadedAdapter.resolveTimelineElement = () => null;
  unloadedAdapter._tryKnownTimelinePosition = async () => null;
  unloadedAdapter._buildVirtualIndexPlan = () => protocolPlan;
  unloadedAdapter._requestVirtualizerJump = async () => ({
    ok: false, reason: 'target-key-not-loaded', nativeKeyCount: 5,
    loadedUserOrders: [15, 16, 17, 18, 19]
  });
  let unloadedTopStrategy = 0;
  let unloadedRatioFallback = 0;
  unloadedAdapter._jumpToUnloadedHistory = async () => { unloadedTopStrategy++; return ratioElement; };
  unloadedAdapter._fallbackScrollByUserOrder = async () => { unloadedRatioFallback++; return null; };
  assert.equal(await unloadedAdapter.jumpToTimelineMarker({
    id: 'chatgpt-u11', sourceId: 'u11', aliasIds: ['u11'], userOrder: 11
  }, { scrollContainer: bracketScroll, isCurrent: () => true }), ratioElement);
  assert.equal(unloadedTopStrategy, 1);
  assert.equal(unloadedRatioFallback, 0,
    'a target before the loaded stable-ID range never enters full-history ratio positioning');

  // A real tracker must catch delayed pagination and advance only on actual
  // earlier Key progress. The intermediate edge must never become the result.
  const edgeAdapter = new context.window.__TestChatGPTAdapter();
  edgeAdapter._capturedTurns = Array.from({ length: 54 }, (_, i) => ({
    id: `u${i + 1}`, messageId: `m${i + 1}`, ids: [`u${i + 1}`, `m${i + 1}`], userOrder: i + 1
  }));
  const edgeTarget = { id: 'chatgpt-u10', sourceId: 'u10', userOrder: 10 };
  const edgeCommands = [], alignedEdges = [], edgeWrites = [];
  let edgeOrders = [39, 40, 54];
  let edgePagePending = false;
  const edgeScroll = { scrollHeight: 43140, clientHeight: 828,
    get scrollTop() { return 42312; }, set scrollTop(value) { edgeWrites.push(value); }
  };
  edgeAdapter._buildVirtualIndexPlan = marker => ({ strategy: 'virtual-item-key-or-bounded-ratio', targetIds: [marker.sourceId] });
  edgeAdapter._requestVirtualizerJump = async (plan, marker) => {
    assert.equal(plan.requireSettledNativeKey, true);
    assert.equal(edgePagePending, false, 'do not issue another scroll during native pagination');
    edgeCommands.push(marker.userOrder);
    assert.equal(plan.targetIds[0], `u${marker.userOrder}`);
    return { ok: true, indexStrategy: 'native-turn-key', nativeCommandIssued: true };
  };
  edgeAdapter._queryNativeKeyState = async () => ({ turnUserOrders: edgeOrders, targetKeyLoaded: edgeOrders.includes(10) });
  edgeAdapter._waitForMarkerMount = async marker => ({ element: marker.userOrder === 10 ? ratioElement : null });
  edgeAdapter._restoreReadingAnchor = async () => { throw new Error('unexpected restore'); };
  edgeAdapter._fallbackScrollByUserOrder = async () => { throw new Error('unexpected ratio fallback'); };
  const edgeBudget = { remaining: 8 };
  const edgeContext = {
    scrollContainer: edgeScroll, isCurrent: () => true,
    navigationDeadline: Date.now() + 9000, searchBudget: edgeBudget,
    alignHistoryBoundary: async marker => {
      alignedEdges.push(marker.userOrder);
      const requestId = marker.userOrder;
      setTimeout(() => {
        edgePagePending = true;
        adapterDocument.dispatchEvent(new FakeCustomEvent('ait-gpt-native-history-pagination', {
          detail: JSON.stringify({ requestId, conversationId: 'test-conversation', stage: 'request' })
        }));
        setTimeout(() => {
          edgePagePending = false;
          adapterDocument.dispatchEvent(new FakeCustomEvent('ait-gpt-native-history-pagination', {
            detail: JSON.stringify({ requestId, conversationId: 'test-conversation', stage: 'response', ok: true })
          }));
          // HTTP completion is not React Key progress yet.
          setTimeout(() => { edgeOrders = requestId === 39 ? [24, 39, 54] : [10, 24, 39, 54]; }, 40);
        }, 40);
      }, 35);
      return true;
    }
  };
  assert.equal(await edgeAdapter._jumpToUnloadedHistory(edgeTarget, edgeContext,
    { turnUserOrders: edgeOrders }, null), ratioElement);
  assert.deepEqual(edgeCommands, [39, 24, 10]);
  assert.deepEqual(alignedEdges, [39, 24]);
  assert.deepEqual(edgeWrites, [], 'never probe scrollTop=0 for unloaded history');
  assert.equal(edgeBudget.remaining, 7, 'only final positioning uses the pixel-search budget');
  assert.equal(edgeTarget._aitNavigationStrategy, 'native-turn-key');

  // A settled boundary scroll can move the list without mounting that edge.
  // Re-enter the existing mounted-Q bounded correction, then keep paging.
  edgeCommands.length = 0;
  edgeOrders = [39, 40, 54];
  const successfulBoundaryJump = edgeAdapter._requestVirtualizerJump;
  const rejectingFallback = edgeAdapter._fallbackScrollByUserOrder;
  let movedBoundaryRecoveries = 0;
  edgeAdapter._requestVirtualizerJump = async (plan, marker) => {
    edgeCommands.push(marker.userOrder);
    if (marker.userOrder === 39) {
      return { ok: false, reason: 'target-key-moved-without-target',
        nativeCommandIssued: true, stateChanged: true, indexStrategy: 'native-turn-key' };
    }
    return { ok: true, nativeCommandIssued: true, indexStrategy: 'native-turn-key' };
  };
  edgeAdapter._fallbackScrollByUserOrder = async (marker, recoveryContext, restoreTop, options) => {
    movedBoundaryRecoveries++;
    assert.equal(marker.userOrder, 39);
    assert.equal(options.requireMountedEvidence, true);
    assert.ok(options.maxAttempts <= 2);
    return { isConnected: true };
  };
  edgeAdapter._queryNativeKeyState = async () => ({
    turnUserOrders: edgeOrders, targetKeyLoaded: edgeOrders.includes(10)
  });
  assert.equal(await edgeAdapter._jumpToUnloadedHistory(edgeTarget, {
    ...edgeContext, searchBudget: { remaining: 8 }, navigationDeadline: Date.now() + 4000,
    alignHistoryBoundary: async marker => {
      assert.equal(marker.userOrder, 39);
      adapterDocument.dispatchEvent(new FakeCustomEvent('ait-gpt-native-history-pagination', {
        detail: JSON.stringify({ requestId: 390, conversationId: 'test-conversation', stage: 'request' })
      }));
      edgeOrders = [10, 39, 40, 54];
      adapterDocument.dispatchEvent(new FakeCustomEvent('ait-gpt-native-history-pagination', {
        detail: JSON.stringify({ requestId: 390, conversationId: 'test-conversation', stage: 'response', ok: true })
      }));
      return true;
    }
  }, { turnUserOrders: [39, 40, 54] }, null), ratioElement);
  assert.equal(movedBoundaryRecoveries, 1);
  assert.deepEqual(edgeCommands, [39, 10],
    'a moved-without-target boundary is locally recovered before pagination continues');
  edgeAdapter._requestVirtualizerJump = successfulBoundaryJump;
  edgeAdapter._fallbackScrollByUserOrder = rejectingFallback;

  // More than eight native boundary hops must not exhaust the pixel budget.
  edgeCommands.length = 0;
  edgeOrders = [54];
  const longEdgeBudget = { remaining: 8 };
  const renewals = [];
  assert.equal(await edgeAdapter._jumpToUnloadedHistory(edgeTarget, {
    ...edgeContext, searchBudget: longEdgeBudget,
    navigationDeadline: Date.now() + 9000,
    extendHistoryNavigation: deadline => renewals.push(deadline),
    alignHistoryBoundary: async marker => {
      const requestId = marker.userOrder;
      adapterDocument.dispatchEvent(new FakeCustomEvent('ait-gpt-native-history-pagination', {
        detail: JSON.stringify({ requestId, conversationId: 'test-conversation', stage: 'request' })
      }));
      edgeOrders = Array.from({length: 5}, (_, i) => requestId - 5 + i).concat(edgeOrders);
      adapterDocument.dispatchEvent(new FakeCustomEvent('ait-gpt-native-history-pagination', {
        detail: JSON.stringify({ requestId, conversationId: 'test-conversation', stage: 'response', ok: true })
      }));
      return true;
    }
  }, { turnUserOrders: edgeOrders }, null), ratioElement);
  assert.deepEqual(edgeCommands, [54, 49, 44, 39, 34, 29, 24, 19, 14, 10]);
  assert.equal(renewals.length, 9);
  assert.equal(longEdgeBudget.remaining, 7);

  // A native page may start after the original 850ms + 450ms window.
  // Preserve the existing deadline without issuing another boundary scroll.
  edgeCommands.length = 0;
  edgeOrders = [25, 54];
  assert.equal(await edgeAdapter._jumpToUnloadedHistory(edgeTarget, {
    ...edgeContext, searchBudget: { remaining: 8 },
    navigationDeadline: Date.now() + 4000,
    alignHistoryBoundary: async marker => {
      assert.equal(marker.userOrder, 25);
      setTimeout(() => {
        edgePagePending = true;
        adapterDocument.dispatchEvent(new FakeCustomEvent('ait-gpt-native-history-pagination', {
          detail: JSON.stringify({ requestId: 25, conversationId: 'test-conversation', stage: 'request' })
        }));
        setTimeout(() => {
          edgePagePending = false;
          adapterDocument.dispatchEvent(new FakeCustomEvent('ait-gpt-native-history-pagination', {
            detail: JSON.stringify({ requestId: 25, conversationId: 'test-conversation', stage: 'response', ok: true })
          }));
          setTimeout(() => { edgeOrders = [10, 25, 54]; }, 40);
        }, 40);
      }, 1800);
      return true;
    }
  }, { turnUserOrders: edgeOrders }, null), ratioElement);
  assert.deepEqual(edgeCommands, [25, 10], 'a delayed native page is awaited without another edge jump');

  edgeCommands.length = 0;
  edgeAdapter._requestVirtualizerJump = async (plan, marker) => {
    edgeCommands.push(marker.userOrder);
    return { ok: false, reason: 'command-promise-pending', nativeCommandIssued: true };
  };
  assert.equal(await edgeAdapter._jumpToUnloadedHistory(edgeTarget, {
    ...edgeContext, searchBudget: { remaining: 8 },
    alignHistoryBoundary: async () => { throw new Error('pending native command must not align'); }
  }, { turnUserOrders: [39, 54] }, null), null);
  assert.deepEqual(edgeCommands, [39]);

  edgeCommands.length = 0;
  edgeAdapter._requestVirtualizerJump = async (plan, marker) => {
    edgeCommands.push(marker.userOrder);
    return { ok: true, indexStrategy: 'native-turn-key' };
  };
  edgeAdapter._queryNativeKeyState = async () => ({ turnUserOrders: [39, 54], targetKeyLoaded: false });
  edgeAdapter._restoreReadingAnchor = async () => false;
  assert.equal(await edgeAdapter._jumpToUnloadedHistory(edgeTarget, {
    ...edgeContext, searchBudget: { remaining: 8 }, navigationDeadline: Date.now() + 1700,
    alignHistoryBoundary: async () => true
  }, { turnUserOrders: [39, 54] }, null), null);
  assert.deepEqual(edgeCommands, [39], 'no paging or Key progress means no repeated edge jump');

  // A verified visible edge can need a small local top nudge to trigger
  // another native page. This is never a raw jump from a distant position.
  edgeCommands.length = 0;
  edgeOrders = [25, 54];
  let localTop = 486, localWrites = 0, localQueries = 0;
  const localEdge = { isConnected: true };
  const localScroll = {
    isConnected: true, clientHeight: 828,
    contains: element => element === localEdge,
    getBoundingClientRect: () => ({ top: 0, bottom: 828 }),
    get scrollTop() { return localTop; },
    set scrollTop(value) {
      assert.equal(value, 0);
      localTop = value;
      localWrites++;
      adapterDocument.dispatchEvent(new FakeCustomEvent('ait-gpt-native-history-pagination', {
        detail: JSON.stringify({ requestId: 250, conversationId: 'test-conversation', stage: 'request' })
      }));
      edgePagePending = true;
      setTimeout(() => {
        edgePagePending = false;
        adapterDocument.dispatchEvent(new FakeCustomEvent('ait-gpt-native-history-pagination', {
          detail: JSON.stringify({ requestId: 250, conversationId: 'test-conversation', stage: 'response', ok: true })
        }));
        setTimeout(() => { edgeOrders = [10, 25, 54]; }, 40);
      }, 40);
    }
  };
  edgeAdapter.resolveTimelineElement = marker => marker.userOrder === 25 ? localEdge : null;
  edgeAdapter.getTimelineMessageRect = () => ({ top: 20, bottom: 80 });
  edgeAdapter._queryNativeKeyState = async () => {
    localQueries++;
    return { turnUserOrders: edgeOrders, targetKeyLoaded: edgeOrders.includes(10) };
  };
  assert.equal(await edgeAdapter._jumpToUnloadedHistory(edgeTarget, {
    ...edgeContext, scrollContainer: localScroll, searchBudget: { remaining: 8 },
    navigationDeadline: Date.now() + 4000, alignHistoryBoundary: async () => true
  }, { turnUserOrders: edgeOrders }, null), ratioElement);
  assert.deepEqual(edgeCommands, [25, 10]);
  assert.equal(localWrites, 1, 'a quiet visible edge gets only one local top nudge');
  assert.ok(localQueries <= 4, 'quiet edge avoids burst polling');
  localTop = 12000;
  const quietTracker = { hasRelevantEvent: () => false };
  assert.equal(edgeAdapter._tryLocalHistoryTop({ userOrder: 25 }, { scrollContainer: localScroll }, quietTracker, () => true), false);
  localTop = 486;
  assert.equal(edgeAdapter._tryLocalHistoryTop({ userOrder: 25 }, { scrollContainer: localScroll }, { hasRelevantEvent: () => true }, () => true), false);
  assert.equal(edgeAdapter._tryLocalHistoryTop({ userOrder: 25 }, { scrollContainer: localScroll }, quietTracker, () => false), false);
  assert.equal(localWrites, 1, 'distant, pending or cancelled navigation cannot nudge');

  const recoveryAdapter = new context.window.__TestChatGPTAdapter();
  recoveryAdapter.resolveTimelineElement = () => null;
  const recoveryBudget = { remaining: 5 };
  let recoveryOptions = null;
  recoveryAdapter._fallbackScrollByUserOrder = async (marker, recoveryContext, restoreTop, options) => {
    recoveryOptions = options;
    return ratioElement;
  };
  assert.equal(await recoveryAdapter.recoverDisplacedTimelineMarker({ userOrder: 10 }, {
    scrollContainer: bracketScroll, isCurrent: () => true,
    navigationDeadline: Date.now() + 5000, searchBudget: recoveryBudget
  }), ratioElement);
  assert.equal(recoveryOptions.maxAttempts, undefined,
    'displacement recovery reuses bounded correction instead of a one-shot ratio write');
  assert.equal(recoveryOptions.searchBudget, recoveryBudget,
    'displacement recovery shares the original navigation write budget');

  const paginationAdapter = new context.window.__TestChatGPTAdapter();
  paginationAdapter._capturedTurns = Array.from({ length: 33 }, (_, index) => ({
    id: `u${index + 1}`, messageId: `m${index + 1}`, ids: [`u${index + 1}`, `m${index + 1}`],
    userOrder: index + 1
  }));
  paginationAdapter._captureReadingAnchor = () => null;
  paginationAdapter._sampleMountedUserOrderState = container => ({
    range: { min: 21, max: 23, anchors: [] }, stable: true,
    scrollTop: container.scrollTop, scrollHeight: container.scrollHeight,
    maxScrollTop: container.scrollHeight - container.clientHeight
  });
  paginationAdapter._buildVirtualIndexPlan = () => protocolPlan;
  paginationAdapter._requestVirtualizerJump = async () => ({
    ok: true, targetKeyLoaded: true, nativeKeyCount: 33, indexStrategy: 'native-turn-key'
  });
  const paginationTarget = { isConnected: true };
  let paginationMountChecks = 0;
  paginationAdapter._waitForMarkerMount = async () => {
    paginationMountChecks++;
    if (paginationMountChecks === 1) {
      adapterDocument.dispatchEvent(new FakeCustomEvent('ait-gpt-native-history-pagination', {
        detail: JSON.stringify({ requestId: 1, conversationId: 'test-conversation', stage: 'request' })
      }));
      setTimeout(() => adapterDocument.dispatchEvent(new FakeCustomEvent('ait-gpt-native-history-pagination', {
        detail: JSON.stringify({ requestId: 1, conversationId: 'test-conversation', stage: 'response', ok: true })
      })), 1700);
    }
    return { element: paginationMountChecks >= 2 ? paginationTarget : null, mountMs: 1, mutations: 0 };
  };
  const paginationScroll = { scrollHeight: 20000, clientHeight: 500, scrollTop: 15000 };
  assert.equal(await paginationAdapter._fallbackScrollByUserOrder({
    id: 'chatgpt-u12', sourceId: 'u12', aliasIds: ['u12', 'm12'], userOrder: 12
  }, { scrollContainer: paginationScroll, isCurrent: () => true }, null,
  { maxAttempts: 1, restoreOnFailure: false }), paginationTarget,
  'an in-flight native history page beyond the old 1600ms cap is awaited and the refreshed Key list is retried');

  const failingAdapter = new context.window.__TestChatGPTAdapter();
  failingAdapter._capturedTurns = cachedAdapter._capturedTurns;
  failingAdapter._findIdentityAnchor = () => null;
  failingAdapter.resolveTimelineElement = () => null;
  failingAdapter._buildVirtualIndexPlan = ratioAdapter._buildVirtualIndexPlan;
  failingAdapter._requestVirtualizerJump = ratioAdapter._requestVirtualizerJump;
  failingAdapter._waitForMarkerMount = async () => ({ element: null, mountMs: 1, mutations: 0 });
  failingAdapter._getMountedUserOrderRange = () => null;
  const failedScroll = { scrollHeight: 19462, clientHeight: 462, _top: 19000,
    get scrollTop() { return this._top; }, set scrollTop(value) { this._top = value; }
  };
  assert.equal(await failingAdapter.jumpToTimelineMarker({
    id: 'chatgpt-u16', sourceId: 'u16', messageId: 'm16', aliasIds: ['u16', 'm16'], userOrder: 16
  }, { scrollContainer: failedScroll, isCurrent: () => true }), null,
  'a search without mounted stable-ID evidence reports failure');
  assert.notEqual(failedScroll.scrollTop, 19000,
    'without a stable reading identity, failure must not claim restoration by writing an old pixel');
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
    hasTimelineData: () => apiReady,
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
  console.log('PASS: stable-ID/cache priority, native Key assistance, bounded Q-range fallback, 30px final alignment, restoration, and last-click-wins.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
