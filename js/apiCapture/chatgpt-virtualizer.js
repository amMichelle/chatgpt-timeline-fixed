// ChatGPT virtualizer bridge (MAIN world / document_start).
// Discovers the page-owned conversation virtualizer, resolves stable item keys
// when available, and accepts a scroll command only after observable feedback.
(() => {
  'use strict';
  if (window.__aitGptVirtualizerBridge) return;
  window.__aitGptVirtualizerBridge = true;

  const REQUEST_EVENT = 'ait-gpt-virtualizer-jump';
  const RESULT_EVENT = 'ait-gpt-virtualizer-jump-result';
  const PROGRESS_EVENT = 'ait-gpt-virtualizer-jump-progress';
  const CANCEL_EVENT = 'ait-gpt-virtualizer-jump-cancel';
  const REACT_PREFIXES = ['__reactFiber$', '__reactProps$', '__reactContainer$', '__reactInternalInstance$'];
  const PRIORITY_KEYS = ['stateNode', 'memoizedProps', 'memoizedState', 'ref', 'current', 'updateQueue', 'queue', 'baseState', 'return', 'child', 'sibling', 'alternate', 'dependencies', 'containerInfo'];
  const HINT_KEYS = ['scrollToKey', 'turnKeys', 'retainedTurnKeys', 'getRowKey', 'scrollToIndex', 'scrollToItem', 'scrollToOffset', 'getVirtualItems', 'getTotalSize', 'measureElement', 'rangeChanged', 'firstItemIndex'];
  const START_SELECTOR = '#thread, main, .thread-scroll-container, [data-thread-find-target="conversation"], [data-chatgpt-conversation-selection-target], [data-scroll-root], [data-virtualized-list], [data-test-render-count], [data-ait-heading-turn], section[data-turn], [data-turn-id-container], [data-turn-key], [data-content-search-turn-key], [data-content-search-unit-key], [data-chatgpt-selection-message-id]';
  const MAX_OBJECTS = 5000;
  const MAX_DEPTH = 11;
  const MAX_FIBER_ANCESTORS = 80;
  const MAX_HOOK_NODES = 192;
  const MAX_PROP_OBJECTS = 240;
  const MAX_PROP_DEPTH = 4;
  const MAX_KEY_SCAN = 2000;
  const CACHE_TTL_MS = 5000;
  let cached = null;
  let cachedAt = 0;
  let generation = 0;
  const cancelledRequests = new Set();

  const now = () => typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  const objectLike = value => value !== null && (typeof value === 'object' || typeof value === 'function');
  const safeGet = (value, key) => { try { return value?.[key]; } catch { return undefined; } };
  const ownKeys = value => { try { return [...Object.getOwnPropertyNames(value), ...Object.getOwnPropertySymbols(value)]; } catch { return []; } };
  const reactTreeOrigin = value => {
    if (!objectLike(value)) return value;
    let current = value;
    let root = value;
    const visited = new WeakSet();
    for (let depth = 0; depth < 80 && objectLike(current) && !visited.has(current); depth++) {
      visited.add(current);
      root = current;
      const parent = safeGet(current, 'return');
      if (!objectLike(parent)) break;
      current = parent;
    }
    return root;
  };
  const hasFunction = (value, key) => typeof safeGet(value, key) === 'function';
  const preferredMethod = value => hasFunction(value, 'scrollToKey') ? 'scrollToKey'
    : hasFunction(value, 'scrollToIndex') ? 'scrollToIndex'
      : hasFunction(value, 'scrollToItem') ? 'scrollToItem'
      : hasFunction(value, 'scrollToOffset') ? 'scrollToOffset' : '';
  const score = value => {
    const method = preferredMethod(value);
    if (!method) return 0;
    const base = method === 'scrollToKey' ? 1000
      : method === 'scrollToIndex' ? 300 : method === 'scrollToItem' ? 200 : 100;
    return base + HINT_KEYS.filter(key => safeGet(value, key) !== undefined).length;
  };
  const relevantKey = key => /virtual|scroll|list|range|index|item|ref|state|props/i.test(String(typeof key === 'symbol' ? key.description || '' : key));
  const skipKey = key => /^(?:__proto__|constructor|prototype|ownerDocument|parentNode|children|childNodes|style|classList)$/.test(String(key));

  const starts = () => {
    const result = [];
    const seen = new Set();
    const add = (element, conversationEvidence) => {
      if (!(element instanceof Element) || seen.has(element)) return;
      seen.add(element);
      const scope = element.closest?.(
        '[data-thread-find-target="conversation"], [data-chatgpt-conversation-selection-target], #thread, main'
      ) || element;
      const rect = element.getBoundingClientRect?.();
      const scopeRect = scope === element ? rect : scope.getBoundingClientRect?.();
      const visibleConversationEvidence = !!conversationEvidence && element.isConnected !== false
        && (!rect || rect.width > 0 && rect.height > 0
          || !!scopeRect && scopeRect.width > 0 && scopeRect.height > 0);
      ownKeys(element).filter(key => typeof key === 'string' && REACT_PREFIXES.some(prefix => key.startsWith(prefix)))
        .forEach(key => {
          const value = safeGet(element, key);
          if (objectLike(value)) result.push({
            value, depth: 0, conversationEvidence: visibleConversationEvidence, scope,
            origin: reactTreeOrigin(value), sourceElement: element
          });
        });
    };
    document.querySelectorAll(START_SELECTOR).forEach(element => {
      add(element, true);
      let parent = element.parentElement;
      for (let depth = 0; parent && depth < 8; depth++, parent = parent.parentElement) add(parent, true);
    });
    add(document.documentElement, false);
    add(document.body, false);
    return result;
  };

  const sameConversationScope = (left, right) => !!(left && right
    && (left === right || left.contains?.(right) || right.contains?.(left)));
  const fiberSeeds = value => {
    const seeds = [value, safeGet(value, 'current'), safeGet(safeGet(value, '_internalRoot'), 'current')];
    return seeds.filter(candidate => objectLike(candidate)
      && (safeGet(candidate, 'memoizedProps') !== undefined
        || safeGet(candidate, 'pendingProps') !== undefined
        || safeGet(candidate, 'memoizedState') !== undefined
        || objectLike(safeGet(candidate, 'return'))));
  };
  const scanPropsForTurnListApis = fiber => {
    const results = [];
    const seen = new WeakSet();
    const queue = [safeGet(fiber, 'pendingProps'), safeGet(fiber, 'memoizedProps')]
      .filter(objectLike).map(value => ({ value, depth: 0 }));
    let scanned = 0;
    while (queue.length && scanned < MAX_PROP_OBJECTS) {
      const { value, depth } = queue.shift();
      if (!objectLike(value) || seen.has(value)) continue;
      seen.add(value);
      scanned++;
      const nested = safeGet(value, 'turnListApi');
      if (objectLike(nested) && hasFunction(nested, 'scrollToKey')) results.push(nested);
      if (hasFunction(value, 'scrollToKey')) results.push(value);
      if (depth >= MAX_PROP_DEPTH) continue;
      for (const key of ownKeys(value).slice(0, 64)) {
        if (skipKey(key)) continue;
        const child = safeGet(value, key);
        if (!objectLike(child)) continue;
        const name = String(typeof key === 'symbol' ? key.description || '' : key);
        if (depth < 1 || /turn|list|api|ref|state|props|value|current/i.test(name)) {
          queue.push({ value: child, depth: depth + 1 });
        }
      }
    }
    return Array.from(new Set(results));
  };
  const scanFiberHookKeys = fiber => {
    const results = [];
    const seen = new WeakSet();
    let hook = safeGet(fiber, 'memoizedState');
    for (let index = 0; index < MAX_HOOK_NODES && objectLike(hook) && !seen.has(hook); index++) {
      seen.add(hook);
      for (const owner of [hook, safeGet(hook, 'memoizedState'), safeGet(hook, 'baseState')]) {
        if (objectLike(owner) && hasNativeKeyCollection(owner)) results.push({ owner, hookIndex: index });
      }
      hook = safeGet(hook, 'next');
    }
    return results;
  };
  const discoverReactCapabilities = startRecords => {
    const apis = [];
    const keyOwners = [];
    const seenFibers = new WeakMap();
    for (const start of startRecords) {
      for (const seed of fiberSeeds(start.value)) {
        let fiber = seed;
        const ancestrySeen = new WeakSet();
        for (let level = 0; level < MAX_FIBER_ANCESTORS
          && objectLike(fiber) && !ancestrySeen.has(fiber); level++) {
          ancestrySeen.add(fiber);
          const variants = [fiber, safeGet(fiber, 'alternate')].filter(objectLike);
          for (const variant of variants) {
            let scopes = seenFibers.get(variant);
            if (!scopes) { scopes = new Set(); seenFibers.set(variant, scopes); }
            if (scopes.has(start.scope)) continue;
            scopes.add(start.scope);
            const origin = reactTreeOrigin(variant);
            for (const api of scanPropsForTurnListApis(variant)) {
              apis.push({ api, fiber: variant, conversationEvidence: start.conversationEvidence,
                scope: start.scope, origin, sourceElement: start.sourceElement });
            }
            for (const hookRecord of scanFiberHookKeys(variant)) {
              keyOwners.push({ ...hookRecord, fiber: variant,
                conversationEvidence: start.conversationEvidence,
                scope: start.scope, origin, sourceElement: start.sourceElement });
            }
          }
          fiber = safeGet(fiber, 'return');
        }
      }
    }
    return { apis, keyOwners };
  };

  const virtualItems = api => {
    if (!hasFunction(api, 'getVirtualItems')) return [];
    try {
      const items = safeGet(api, 'getVirtualItems').call(api);
      return Array.isArray(items) ? items : [];
    } catch { return []; }
  };
  const visibleIndices = api => virtualItems(api).map(item => Number(safeGet(item, 'index')))
    .filter(value => Number.isFinite(value) && value >= 0);
  const itemCount = api => {
    const candidates = [safeGet(safeGet(api, 'options'), 'count'), safeGet(api, 'count'), safeGet(api, 'itemCount')];
    if (hasFunction(api, 'getCount')) {
      try { candidates.push(safeGet(api, 'getCount').call(api)); } catch {}
    }
    return candidates.map(Number).find(value => Number.isFinite(value) && value > 0) ?? null;
  };
  const scrollElement = api => {
    const direct = safeGet(api, 'scrollElement') || safeGet(api, 'scrollContainer');
    if (direct instanceof Element) return direct;
    // Do not invoke the separately discovered scroll-state controller here.
    // Its signatures are not yet verified; the real DOM scroll root is enough
    // for observable feedback.
    return Array.from(document.querySelectorAll?.('.thread-scroll-container, [data-scroll-root]') || [])
      .find(element => {
        const rect = element.getBoundingClientRect?.();
        return element.isConnected && (!rect || rect.width > 0 && rect.height > 0);
      }) || null;
  };
  const snapshot = api => {
    const indices = visibleIndices(api);
    const element = scrollElement(api);
    return {
      indices,
      scrollTop: Number.isFinite(element?.scrollTop) ? element.scrollTop : null
    };
  };
  const snapshotChanged = (before, after) => {
    if (Number.isFinite(before?.scrollTop) && Number.isFinite(after?.scrollTop) && before.scrollTop !== after.scrollTop) return true;
    return JSON.stringify(before?.indices || []) !== JSON.stringify(after?.indices || []);
  };
  const keyTokens = value => {
    const result = [];
    const add = candidate => {
      const text = typeof candidate === 'string' || typeof candidate === 'number' ? String(candidate).trim() : '';
      if (text && !result.includes(text)) result.push(text);
    };
    const visit = candidate => {
      if (typeof candidate === 'string' || typeof candidate === 'number') { add(candidate); return; }
      if (Array.isArray(candidate)) { candidate.slice(0, 20).forEach(visit); return; }
      if (candidate && typeof candidate === 'object') ownKeys(candidate).slice(0, 20).forEach(key => visit(safeGet(candidate, key)));
    };
    visit(value);
    return result;
  };
  const collectionValues = value => {
    if (Array.isArray(value)) return value.slice(0, MAX_KEY_SCAN);
    if (value instanceof Set) return Array.from(value).slice(0, MAX_KEY_SCAN);
    if (value instanceof Map) return Array.from(value.keys()).slice(0, MAX_KEY_SCAN);
    return [];
  };
  const nativeTurnKeys = candidate => {
    const values = [];
    for (const owner of [candidate?.keyOwner, candidate?.api]) {
      if (!objectLike(owner)) continue;
      for (const name of ['turnKeys', 'retainedTurnKeys']) {
        collectionValues(safeGet(owner, name)).forEach(value => values.push(...keyTokens(value)));
      }
    }
    return Array.from(new Set(values)).slice(0, MAX_KEY_SCAN);
  };
  const nativeKeysByCollection = (candidate, collectionName) => {
    const values = [];
    for (const owner of [candidate?.keyOwner, candidate?.api]) {
      if (!objectLike(owner)) continue;
      collectionValues(safeGet(owner, collectionName))
        .forEach(value => values.push(...keyTokens(value)));
    }
    return Array.from(new Set(values)).slice(0, MAX_KEY_SCAN);
  };
  const hasNativeKeyCollection = value => ['turnKeys', 'retainedTurnKeys']
    .some(name => collectionValues(safeGet(value, name)).length > 0);
  const targetIds = request => new Set(Array.isArray(request?.targetIds)
    ? request.targetIds.filter(value => typeof value === 'string' && value) : []);
  const resolveTargetKey = (candidate, request) => {
    const ids = targetIds(request);
    if (!ids.size) return null;
    return nativeTurnKeys(candidate).find(key => ids.has(key)) || null;
  };
  const matchedUserOrders = (keysInput, request) => {
    const keys = new Set(keysInput.map(String));
    const records = Array.isArray(request?.knownUserTurns) ? request.knownUserTurns.slice(0, 500) : [];
    return records.filter(record => {
      const ids = Array.isArray(record?.ids) ? record.ids.slice(0, 8) : [];
      return ids.some(id => keys.has(String(id)));
    }).map(record => Number(record.userOrder))
      .filter(order => Number.isFinite(order) && order > 0)
      .filter((order, index, values) => values.indexOf(order) === index)
      .sort((left, right) => left - right);
  };
  const currentDomKeys = () => {
    const values = [];
    const selector = '[data-turn-key], [data-content-search-turn-key], [data-turn-id-container], [data-turn-id], [data-message-id], [data-chatgpt-selection-message-id], [data-chatgpt-search-message-ids]';
    for (const node of document.querySelectorAll?.(selector) || []) {
      if (!node.isConnected || node.closest?.('nav, aside, form, [data-composer-input], .ProseMirror')) continue;
      for (const attr of ['data-turn-key', 'data-content-search-turn-key', 'data-turn-id-container',
        'data-turn-id', 'data-message-id', 'data-chatgpt-selection-message-id', 'data-chatgpt-search-message-ids']) {
        const raw = node.getAttribute?.(attr);
        if (!raw) continue;
        values.push(raw);
        try { values.push(...keyTokens(JSON.parse(raw))); } catch {}
      }
    }
    return new Set(values.map(String));
  };
  const renderedTarget = request => {
    const ids = targetIds(request);
    if (!ids.size) return null;
    const selector = '[data-turn-key], [data-content-search-turn-key], [data-turn-id-container], [data-turn-id], [data-message-id], [data-chatgpt-selection-message-id], [data-chatgpt-search-message-ids]';
    for (const node of document.querySelectorAll?.(selector) || []) {
      const values = [];
      for (const attr of ['data-turn-key', 'data-content-search-turn-key', 'data-turn-id-container',
        'data-turn-id', 'data-message-id', 'data-chatgpt-selection-message-id', 'data-chatgpt-search-message-ids']) {
        const raw = node.getAttribute?.(attr);
        if (!raw) continue;
        values.push(raw);
        try { values.push(...keyTokens(JSON.parse(raw))); } catch {}
      }
      if (!values.some(value => ids.has(String(value)))) continue;
      const root = node.closest?.('[data-turn-key], [data-content-search-turn-key], [data-turn-id-container], [data-turn="user"]') || node;
      const rect = root.getBoundingClientRect?.();
      if (!rect || rect.width > 0 && rect.height > 0) return root;
    }
    return null;
  };
  const recordBelongsToCurrentTree = record => {
    const element = record?.sourceElement;
    const origin = record?.origin;
    if (!element || !origin) return true;
    if (element.isConnected === false) return false;
    return ownKeys(element)
      .filter(key => typeof key === 'string' && REACT_PREFIXES.some(prefix => key.startsWith(prefix)))
      .some(key => fiberSeeds(safeGet(element, key))
        .some(seed => reactTreeOrigin(seed) === origin));
  };
  const resolveTargetIndex = (api, request) => {
    const targetIds = new Set(Array.isArray(request?.targetIds) ? request.targetIds.filter(value => typeof value === 'string' && value) : []);
    if (!targetIds.size) return null;
    for (const item of virtualItems(api)) {
      if (keyTokens(safeGet(item, 'key')).some(key => targetIds.has(key))) {
        const index = Number(safeGet(item, 'index'));
        if (Number.isFinite(index) && index >= 0) return Math.trunc(index);
      }
    }
    const count = itemCount(api);
    const options = safeGet(api, 'options');
    const getItemKey = safeGet(options, 'getItemKey') || safeGet(api, 'getItemKey');
    if (!Number.isFinite(count) || typeof getItemKey !== 'function' || count > MAX_KEY_SCAN) return null;
    for (let index = 0; index < count; index++) {
      let key;
      try { key = getItemKey.call(options || api, index); } catch { break; }
      if (keyTokens(key).some(token => targetIds.has(token))) return index;
    }
    return null;
  };

  const validateController = (candidate, request) => {
    const api = candidate?.api;
    const method = preferredMethod(api);
    if (!api || !method) {
      return { ok: false, reason: 'controller-shape-unverified' };
    }
    const nativeKeys = nativeTurnKeys(candidate);
    if (method === 'scrollToKey') {
      const exactTargetKey = resolveTargetKey(candidate, request);
      const domKeys = currentDomKeys();
      const overlapsMountedConversation = nativeKeys.some(key => domKeys.has(String(key)));
      const routeLooksCurrent = /\/(?:c|share)\//.test(location.pathname);
      const keyListEvidence = routeLooksCurrent && candidate.conversationEvidence
        && candidate.keyOwnerConversationEvidence
        && nativeKeys.length > 0;
      const ownershipEvidence = candidate.sameConversationScope
        || !!exactTargetKey || overlapsMountedConversation;
      if (!keyListEvidence || !ownershipEvidence) {
        return { ok: false, reason: 'main-conversation-controller-unverified' };
      }
      return {
        ok: true,
        method,
        ownershipStrategy: exactTargetKey ? 'native-turn-key' : 'native-turn-key-list',
        ownershipRank: exactTargetKey ? 7 : overlapsMountedConversation ? 6 : 5,
        targetKey: exactTargetKey,
        nativeKeyCount: nativeKeys.length,
        loadedUserOrders: matchedUserOrders(nativeKeys, request),
        turnUserOrders: matchedUserOrders(nativeKeysByCollection(candidate, 'turnKeys'), request),
        retainedUserOrders: matchedUserOrders(nativeKeysByCollection(candidate, 'retainedTurnKeys'), request),
        mountedKeyOverlap: overlapsMountedConversation,
        exactKeyIndex: null,
        itemCount: null,
        visibleIndices: []
      };
    }
    const observed = Array.isArray(request?.observedIndices)
      ? request.observedIndices.map(Number).filter(value => Number.isFinite(value) && value >= 0) : [];
    const visible = visibleIndices(api);
    const overlap = observed.some(index => visible.includes(index));
    const exactKeyIndex = resolveTargetIndex(api, request);
    const element = scrollElement(api);
    const conversationNodes = Array.from(document.querySelectorAll?.(
      '#thread, [data-thread-find-target="conversation"], [data-chatgpt-conversation-selection-target], [data-ait-heading-turn], [data-turn-key], [data-content-search-turn-key], [data-turn-id-container], [data-turn="user"]'
    ) || []).filter(node => node.isConnected && node.getClientRects?.().length > 0);
    const elementControlsConversation = !!(element && conversationNodes.some(node =>
      element === node || element.contains?.(node)));
    const conversationRangeEvidence = candidate.conversationEvidence
      && visible.length > 0 && Number.isFinite(itemCount(api));
    const ownershipVerified = overlap || Number.isFinite(exactKeyIndex)
      || elementControlsConversation || conversationRangeEvidence;
    if (!ownershipVerified) return { ok: false, reason: 'main-conversation-controller-unverified' };
    const ownershipRank = Number.isFinite(exactKeyIndex) ? 4
      : elementControlsConversation ? 3 : overlap ? 2 : 1;
    return {
      ok: true,
      method,
      ownershipStrategy: Number.isFinite(exactKeyIndex) ? 'target-item-key'
        : elementControlsConversation ? 'conversation-scroll-element'
          : overlap ? 'visible-index-overlap' : 'conversation-virtual-range',
      ownershipRank,
      targetKey: null,
      nativeKeyCount: 0,
      exactKeyIndex,
      itemCount: itemCount(api),
      visibleIndices: visible
    };
  };

  const findVirtualizer = (request, excludedApi = null) => {
    const startedAt = now();
    if (cached && preferredMethod(cached.api) === 'scrollToKey') {
      // Hook state and props can be replaced after native history pagination.
      // Native capability discovery is bounded and cheap, so never trust a
      // cross-navigation snapshot of the Key collection.
      cached = null;
    }
    if (cached && Date.now() - cachedAt < CACHE_TTL_MS) {
      const validation = validateController(cached, request);
      if (validation.ok && (validation.method !== 'scrollToKey' || validation.targetKey)) {
        return { candidate: cached, validation, discoveryMs: now() - startedAt, scanned: 0, cached: true };
      }
      cached = null;
    }
    const queue = starts();
    const seen = new WeakMap();
    let best = null;
    let bestValidation = null;
    let bestScore = 0;
    let lastReason = 'virtualizer_api_not_found';
    let scanned = 0;
    const reactCapabilities = discoverReactCapabilities(queue);
    const keyApis = reactCapabilities.apis;
    const keyOwners = reactCapabilities.keyOwners;
    while (queue.length && scanned < MAX_OBJECTS) {
      const { value, depth, conversationEvidence, keyOwner, scope, origin, sourceElement } = queue.shift();
      if (!objectLike(value)) continue;
      const excluded = value === excludedApi;
      const previousEvidence = seen.get(value);
      if (previousEvidence === true || (previousEvidence === false && !conversationEvidence)) continue;
      seen.set(value, !!conversationEvidence);
      scanned++;
      const contextualKeyOwner = hasNativeKeyCollection(value) ? value : keyOwner;
      if (hasNativeKeyCollection(value)) {
        keyOwners.push({ owner: value, conversationEvidence: !!conversationEvidence,
          scope, origin, sourceElement });
      }
      const nestedTurnListApi = safeGet(value, 'turnListApi');
      const api = objectLike(nestedTurnListApi) && hasFunction(nestedTurnListApi, 'scrollToKey')
        ? nestedTurnListApi : value;
      const currentScore = excluded || api === excludedApi ? 0 : score(api);
      if (currentScore > 0) {
        if (preferredMethod(api) === 'scrollToKey') {
          keyApis.push({ api, conversationEvidence: !!conversationEvidence,
            scope, origin, sourceElement });
        }
        const candidate = {
          api, keyOwner: contextualKeyOwner || value,
          conversationEvidence: !!conversationEvidence,
          keyOwnerConversationEvidence: !!conversationEvidence,
          sameConversationScope: true,
          sameReactRoot: true,
          currentReactTree: recordBelongsToCurrentTree({ sourceElement, origin })
        };
        const validation = validateController(candidate, request);
        if (!validation.ok) lastReason = validation.reason;
        const rankedScore = validation.ok ? validation.ownershipRank * 10000 + currentScore : 0;
        if (validation.ok && rankedScore > bestScore) {
          best = candidate;
          bestValidation = validation;
          bestScore = rankedScore;
        }
      }
      if (depth >= MAX_DEPTH) continue;
      PRIORITY_KEYS.forEach(key => {
        const child = safeGet(value, key);
        if (objectLike(child)) queue.push({ value: child, depth: depth + 1, conversationEvidence,
          keyOwner: contextualKeyOwner, scope, origin, sourceElement });
        if (key === 'ref') {
          const current = safeGet(child, 'current');
          if (objectLike(current)) queue.push({ value: current, depth: depth + 1, conversationEvidence,
            keyOwner: contextualKeyOwner, scope, origin, sourceElement });
        }
      });
      ownKeys(value).slice(0, 80).forEach(key => {
        if (skipKey(key)) return;
        const child = safeGet(value, key);
        if (objectLike(child) && (depth <= 2 || relevantKey(key) || score(child))) {
          queue.push({ value: child, depth: depth + 1, conversationEvidence,
            keyOwner: contextualKeyOwner, scope, origin, sourceElement });
        }
      });
    }
    // turnListApi lives in component props while turnKeys may live in a
    // sibling Hook state. Pair independently discovered capabilities only
    // when both originate from the same visible conversation scope.
    for (const apiRecord of keyApis) {
      for (const ownerRecord of keyOwners) {
        if (!apiRecord.conversationEvidence || !ownerRecord.conversationEvidence) continue;
        const sameScope = sameConversationScope(apiRecord.scope, ownerRecord.scope);
        const ownerKeys = [];
        for (const name of ['turnKeys', 'retainedTurnKeys']) {
          collectionValues(safeGet(ownerRecord.owner, name))
            .forEach(value => ownerKeys.push(...keyTokens(value)));
        }
        const requestedIds = targetIds(request);
        const exactTargetMatch = ownerKeys.some(key => requestedIds.has(String(key)));
        const domKeys = currentDomKeys();
        const mountedOverlap = ownerKeys.some(key => domKeys.has(String(key)));
        if (!sameScope && !exactTargetMatch && !mountedOverlap) continue;
        const candidate = {
          api: apiRecord.api,
          keyOwner: ownerRecord.owner,
          conversationEvidence: apiRecord.conversationEvidence,
          keyOwnerConversationEvidence: ownerRecord.conversationEvidence,
          sameConversationScope: sameScope,
          sameReactRoot: !!(apiRecord.origin && apiRecord.origin === ownerRecord.origin),
          currentReactTree: recordBelongsToCurrentTree(apiRecord)
            && recordBelongsToCurrentTree(ownerRecord),
          apiFiber: apiRecord.fiber || null,
          keyFiber: ownerRecord.fiber || null,
          hookIndex: Number.isFinite(ownerRecord.hookIndex) ? ownerRecord.hookIndex : null
        };
        const validation = validateController(candidate, request);
        if (!validation.ok) { lastReason = validation.reason; continue; }
        const rankedScore = validation.ownershipRank * 10000 + score(apiRecord.api)
          + (sameScope ? 500 : 0)
          + (candidate.sameReactRoot ? 100 : 0);
        if (rankedScore > bestScore) {
          best = candidate;
          bestValidation = validation;
          bestScore = rankedScore;
        }
      }
    }
    cached = best;
    cachedAt = best ? Date.now() : 0;
    return {
      candidate: best,
      validation: bestValidation || { ok: false, reason: lastReason },
      discoveryMs: now() - startedAt,
      scanned,
      cached: false
    };
  };

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const requestActive = (requestId, requestGeneration, deadlineAt) =>
    generation === requestGeneration && !cancelledRequests.has(requestId) && now() < deadlineAt;
  const awaitInvocation = async (value, requestId, requestGeneration, deadlineAt, observeTarget = null) => {
    if (!value || typeof value.then !== 'function') return { settled: true, value };
    let settled = false;
    let resolvedValue;
    let rejection;
    Promise.resolve(value).then(result => {
      settled = true;
      resolvedValue = result;
    }, error => {
      settled = true;
      rejection = error;
    });
    while (!settled && requestActive(requestId, requestGeneration, deadlineAt)) {
      if (observeTarget?.()) return { settled: false, targetObserved: true };
      await delay(20);
    }
    if (!settled) return {
      settled: false,
      cancelled: generation !== requestGeneration || cancelledRequests.has(requestId)
    };
    if (rejection) throw rejection;
    return { settled: true, value: resolvedValue };
  };
  const observeCommand = async (api, before, targetIndex, requestId, requestGeneration, deadlineAt, checks = 9) => {
    for (let attempt = 0; attempt < checks; attempt++) {
      if (!requestActive(requestId, requestGeneration, deadlineAt)) return { cancelled: true, changed: false, after: snapshot(api) };
      await delay(35);
      const after = snapshot(api);
      const changed = snapshotChanged(before, after);
      if (changed) return {
        changed: true,
        targetVisible: Number.isFinite(targetIndex) && after.indices.includes(targetIndex),
        after
      };
    }
    const after = snapshot(api);
    return {
      changed: false,
      targetVisible: Number.isFinite(targetIndex) && after.indices.includes(targetIndex),
      after
    };
  };

  const callWithFeedback = async (api, methodName, target, requestId, requestGeneration,
    deadlineAt, request, onCommandIssued) => {
    const method = safeGet(api, methodName);
    const options = { align: 'center', behavior: 'auto' };
    const attempts = [];
    if (methodName === 'scrollToKey') {
      attempts.push(() => method.call(api, target));
    } else if (methodName === 'scrollToIndex') {
      const numeric = () => method.call(api, target, options);
      const object = () => method.call(api, { index: target, ...options });
      // Modern ChatGPT currently uses the numeric signature most often. Try it
      // first; object form remains a single bounded compatibility fallback.
      attempts.push(numeric, object);
    } else if (methodName === 'scrollToItem') {
      attempts.push(() => method.call(api, target, 'center'), () => method.call(api, target));
    } else if (methodName === 'scrollToOffset') {
      attempts.push(() => method.call(api, target, options), () => method.call(api, { offset: target, ...options }));
    }
    let lastError = null;
    let commandIssued = false;
    let anyStateChanged = false;
    let lastBefore = { indices: [], scrollTop: null };
    let lastAfter = lastBefore;
    for (let signatureAttempt = 0; signatureAttempt < Math.min(2, attempts.length); signatureAttempt++) {
      if (!requestActive(requestId, requestGeneration, deadlineAt)) {
        return { ok: false, reason: 'cancelled', commandIssued,
          nativeCommandIssued: commandIssued && methodName === 'scrollToKey' };
      }
      const before = snapshot(methodName === 'scrollToKey' ? null : api);
      lastBefore = before;
      let invocation;
      try {
        invocation = attempts[signatureAttempt]();
        commandIssued = true;
        onCommandIssued?.({ method: methodName, signatureAttempt: signatureAttempt + 1 });
      } catch (error) {
        commandIssued = true;
        onCommandIssued?.({ method: methodName, signatureAttempt: signatureAttempt + 1 });
        lastError = error;
        continue;
      }
      let completion;
      try {
        completion = await awaitInvocation(
          invocation, requestId, requestGeneration, deadlineAt,
          methodName === 'scrollToKey' && request.requireSettledNativeKey !== true
            ? () => renderedTarget(request) : null
        );
      } catch (error) {
        lastError = error;
        continue;
      }
      if (completion.targetObserved) {
        return {
          ok: true, method: methodName, signatureAttempt: signatureAttempt + 1,
          stateChanged: true, targetIndexVisible: true,
          beforeVisible: before.indices, afterVisible: [],
          commandIssued: true, nativeCommandIssued: true,
          promisePendingAfterTarget: true
        };
      }
      if (!completion.settled) {
        const pendingAfter = snapshot(methodName === 'scrollToKey' ? null : api);
        anyStateChanged = anyStateChanged || snapshotChanged(before, pendingAfter);
        lastAfter = pendingAfter;
        return {
          ok: false,
          reason: completion.cancelled ? 'cancelled' : 'command-promise-pending',
          commandIssued: true,
          nativeCommandIssued: methodName === 'scrollToKey',
          stateChanged: anyStateChanged,
          beforeVisible: before.indices,
          afterVisible: pendingAfter.indices
        };
      }
      let observed;
      if (methodName === 'scrollToKey') {
        observed = { changed: false, targetVisible: false, after: snapshot(null) };
        while (requestActive(requestId, requestGeneration, deadlineAt)) {
          const targetElement = renderedTarget(request);
          const after = snapshot(null);
          if (targetElement) {
            observed = { changed: true, targetVisible: true, after };
            break;
          }
          if (snapshotChanged(before, after)) observed = { ...observed, changed: true, after };
          await delay(25);
        }
        if (generation !== requestGeneration || cancelledRequests.has(requestId)) {
          observed.cancelled = true;
        }
      } else {
        observed = await observeCommand(api, before, methodName === 'scrollToOffset' ? null : target,
          requestId, requestGeneration, deadlineAt, 9);
      }
      anyStateChanged = anyStateChanged || observed.changed;
      lastAfter = observed.after || lastAfter;
      if (observed.cancelled) return { ok: false, reason: 'cancelled', commandIssued: true,
        nativeCommandIssued: methodName === 'scrollToKey', stateChanged: anyStateChanged };
      // A target that was already listed as visible before the call is not
      // evidence that this command did anything. Only an observable range or
      // scroll-position change accepts the signature.
      if (methodName === 'scrollToKey' ? observed.targetVisible : observed.changed) {
        return {
          ok: true,
          method: methodName,
          signatureAttempt: signatureAttempt + 1,
          stateChanged: observed.changed,
          targetIndexVisible: observed.targetVisible,
          beforeVisible: before.indices,
          afterVisible: observed.after.indices,
          commandIssued: true,
          nativeCommandIssued: methodName === 'scrollToKey'
        };
      }
    }
    return { ok: false, reason: lastError?.message
      || (methodName === 'scrollToKey'
        ? (anyStateChanged ? 'target-key-moved-without-target' : 'target-key-no-observable-effect')
        : 'scroll-state-unchanged'),
      commandIssued,
      nativeCommandIssued: commandIssued && methodName === 'scrollToKey',
      stateChanged: anyStateChanged,
      beforeVisible: lastBefore.indices,
      afterVisible: lastAfter.indices };
  };

  const reply = (requestId, result) => document.dispatchEvent(new CustomEvent(RESULT_EVENT, {
    detail: JSON.stringify({ requestId, ...result })
  }));
  const progress = (requestId, result) => document.dispatchEvent(new CustomEvent(PROGRESS_EVENT, {
    detail: JSON.stringify({ requestId, ...result })
  }));

  document.addEventListener(CANCEL_EVENT, event => {
    let detail = null;
    try { detail = JSON.parse(typeof event.detail === 'string' ? event.detail : '{}'); } catch {}
    if (detail?.requestId) cancelledRequests.add(detail.requestId);
    if (detail?.all === true) generation++;
  });

  document.addEventListener(REQUEST_EVENT, async event => {
    let request = null;
    try { request = JSON.parse(typeof event.detail === 'string' ? event.detail : '{}'); } catch {}
    if (!request?.requestId) return;
    const requestGeneration = generation;
    const startedAt = now();
    const deadlineAt = startedAt + Math.max(250, Math.min(2000, Number(request.deadlineMs) || 1100));
    const found = findVirtualizer(request);
    if (!requestActive(request.requestId, requestGeneration, deadlineAt)) {
      reply(request.requestId, { ok: false, reason: 'cancelled', discoveryMs: found.discoveryMs });
      return;
    }
    if (!found.candidate) {
      reply(request.requestId, {
        ok: false,
        reason: found.validation?.reason || 'virtualizer_api_not_found',
        failureStage: found.validation?.reason === 'virtualizer_api_not_found' ? 'discovery' : 'validation',
        discoveryMs: found.discoveryMs,
        scannedObjects: found.scanned
      });
      return;
    }
    const api = found.candidate.api;
    const validation = found.validation;
    if (request.queryOnly === true) {
      reply(request.requestId, {
        ok: true,
        queryOnly: true,
        controllerValidated: true,
        ownershipStrategy: validation.ownershipStrategy,
        nativeKeyCount: validation.nativeKeyCount || 0,
        targetKeyLoaded: !!validation.targetKey,
        loadedUserOrders: validation.loadedUserOrders || [],
        turnUserOrders: validation.turnUserOrders || [],
        retainedUserOrders: validation.retainedUserOrders || [],
        discoveryMs: found.discoveryMs,
        bridgeMs: now() - startedAt,
        cachedController: found.cached
      });
      return;
    }
    let targetIndex = Number.isFinite(validation.exactKeyIndex) ? validation.exactKeyIndex : null;
    let indexStrategy = Number.isFinite(targetIndex) ? 'virtual-item-key' : '';
    const requestedIndex = Number(request.index);
    if (!Number.isFinite(targetIndex) && request.mappingVerified === true && Number.isFinite(requestedIndex) && requestedIndex >= 0) {
      targetIndex = Math.trunc(requestedIndex);
      indexStrategy = request.strategy || 'verified-dom-index';
    }
    const count = validation.itemCount;
    const userOrder = Number(request.targetUserOrder);
    const totalUsers = Number(request.totalUserTurns);
    if (!Number.isFinite(targetIndex) && Number.isFinite(count) && count > 0
      && Number.isFinite(userOrder) && userOrder > 0 && Number.isFinite(totalUsers) && totalUsers > 1) {
      targetIndex = Math.round(((userOrder - 1) / (totalUsers - 1)) * (count - 1));
      indexStrategy = 'bounded-ratio-estimate';
    }

    const methodName = validation.method;
    if (request.requireSettledNativeKey === true && methodName !== 'scrollToKey') {
      reply(request.requestId, { ok: false, reason: 'native-key-required', failureStage: 'validation',
        controllerValidated: true, discoveryMs: found.discoveryMs });
      return;
    }
    let commandTarget = methodName === 'scrollToKey' ? validation.targetKey : targetIndex;
    if (methodName === 'scrollToKey') {
      indexStrategy = 'native-turn-key';
      if (!commandTarget) {
        reply(request.requestId, {
          ok: false, reason: 'target-key-not-loaded', failureStage: 'native-list-capability',
          controllerValidated: true, ownershipStrategy: validation.ownershipStrategy,
          nativeKeyCount: validation.nativeKeyCount || 0,
          loadedUserOrders: validation.loadedUserOrders || [],
          turnUserOrders: validation.turnUserOrders || [],
          retainedUserOrders: validation.retainedUserOrders || [],
          discoveryMs: found.discoveryMs, bridgeMs: now() - startedAt
        });
        return;
      }
    } else if (methodName === 'scrollToOffset') {
      let totalSize = NaN;
      try { if (hasFunction(api, 'getTotalSize')) totalSize = Number(safeGet(api, 'getTotalSize').call(api)); } catch {}
      if (Number.isFinite(totalSize) && Number.isFinite(userOrder) && Number.isFinite(totalUsers) && totalUsers > 1) {
        commandTarget = Math.max(0, ((userOrder - 1) / (totalUsers - 1)) * totalSize);
        indexStrategy = 'bounded-offset-ratio';
      }
    }
    if (methodName !== 'scrollToKey' && (!Number.isFinite(commandTarget) || commandTarget < 0)) {
      reply(request.requestId, {
        ok: false, reason: 'virtual-index-unresolved', failureStage: 'mapping',
        controllerValidated: true, ownershipStrategy: validation.ownershipStrategy,
        discoveryMs: found.discoveryMs, bridgeMs: now() - startedAt
      });
      return;
    }

    const reportCommandIssued = detail => progress(request.requestId, {
      phase: 'command-issued', commandIssued: true,
      nativeCommandIssued: detail.method === 'scrollToKey',
      method: detail.method,
      signatureAttempt: detail.signatureAttempt,
      indexStrategy,
      targetKeyLoaded: methodName === 'scrollToKey' && !!validation.targetKey,
      nativeKeyCount: validation.nativeKeyCount || 0
    });
    let command = await callWithFeedback(api, methodName, commandTarget,
      request.requestId, requestGeneration, deadlineAt, request, reportCommandIssued);
    let rediscovered = false;
    let activeValidation = validation;
    if (!command.ok && command.reason === 'scroll-state-unchanged' && found.cached
      && requestActive(request.requestId, requestGeneration, deadlineAt)) {
      cached = null;
      const replacement = findVirtualizer(request, api);
      if (replacement.candidate && replacement.candidate.api !== api
        && requestActive(request.requestId, requestGeneration, deadlineAt)) {
        rediscovered = true;
        activeValidation = replacement.validation;
        const replacementIndex = Number.isFinite(activeValidation.exactKeyIndex)
          ? activeValidation.exactKeyIndex : targetIndex;
        const replacementMethod = activeValidation.method;
        let replacementTarget = replacementIndex;
        if (replacementMethod === 'scrollToOffset') {
          let totalSize = NaN;
          try {
            if (hasFunction(replacement.candidate.api, 'getTotalSize')) {
              totalSize = Number(safeGet(replacement.candidate.api, 'getTotalSize').call(replacement.candidate.api));
            }
          } catch {}
          if (Number.isFinite(totalSize) && Number.isFinite(userOrder) && Number.isFinite(totalUsers) && totalUsers > 1) {
            replacementTarget = ((userOrder - 1) / (totalUsers - 1)) * totalSize;
          }
        }
        if (Number.isFinite(replacementTarget)) {
          command = await callWithFeedback(replacement.candidate.api, replacementMethod, replacementTarget,
            request.requestId, requestGeneration, deadlineAt, request, reportCommandIssued);
        }
      }
    }
    const result = {
      ...command,
      attemptedIndex: Number.isFinite(targetIndex) ? targetIndex : null,
      indexStrategy,
      controllerValidated: true,
      ownershipStrategy: activeValidation.ownershipStrategy,
      itemCount: activeValidation.itemCount,
      nativeKeyCount: activeValidation.nativeKeyCount || 0,
      loadedUserOrders: activeValidation.loadedUserOrders || [],
      turnUserOrders: activeValidation.turnUserOrders || [],
      retainedUserOrders: activeValidation.retainedUserOrders || [],
      targetKeyLoaded: methodName === 'scrollToKey' && !!validation.targetKey,
      commandIssued: command.commandIssued === true,
      nativeCommandIssued: command.nativeCommandIssued === true,
      discoveryMs: found.discoveryMs,
      bridgeMs: now() - startedAt,
      cachedController: found.cached,
      rediscovered
    };
    if (!command.ok) result.failureStage = command.reason === 'cancelled' ? 'cancelled' : 'command';
    reply(request.requestId, result);
    cancelledRequests.delete(request.requestId);
  });
})();
