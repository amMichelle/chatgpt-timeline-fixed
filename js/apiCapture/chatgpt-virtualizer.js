// ChatGPT virtualizer bridge (MAIN world / document_start).
// Discovers the page-owned conversation virtualizer, resolves stable item keys
// when available, and accepts a scroll command only after observable feedback.
(() => {
  'use strict';
  if (window.__aitGptVirtualizerBridge) return;
  window.__aitGptVirtualizerBridge = true;

  const REQUEST_EVENT = 'ait-gpt-virtualizer-jump';
  const RESULT_EVENT = 'ait-gpt-virtualizer-jump-result';
  const CANCEL_EVENT = 'ait-gpt-virtualizer-jump-cancel';
  const REACT_PREFIXES = ['__reactFiber$', '__reactProps$', '__reactContainer$', '__reactInternalInstance$'];
  const PRIORITY_KEYS = ['stateNode', 'memoizedProps', 'memoizedState', 'ref', 'updateQueue', 'return', 'child', 'sibling', 'alternate', 'dependencies'];
  const HINT_KEYS = ['scrollToIndex', 'scrollToItem', 'scrollToOffset', 'getVirtualItems', 'getTotalSize', 'measureElement', 'rangeChanged', 'firstItemIndex'];
  const START_SELECTOR = '#thread, main, [data-scroll-root], [data-virtualized-list], [data-test-render-count], section[data-turn], [data-turn-id-container], [data-turn-key], [data-content-search-turn-key], [data-content-search-unit-key], [data-chatgpt-selection-message-id]';
  const MAX_OBJECTS = 2600;
  const MAX_DEPTH = 8;
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
  const hasFunction = (value, key) => typeof safeGet(value, key) === 'function';
  const preferredMethod = value => hasFunction(value, 'scrollToIndex') ? 'scrollToIndex'
    : hasFunction(value, 'scrollToItem') ? 'scrollToItem'
      : hasFunction(value, 'scrollToOffset') ? 'scrollToOffset' : '';
  const score = value => {
    const method = preferredMethod(value);
    if (!method) return 0;
    const base = method === 'scrollToIndex' ? 300 : method === 'scrollToItem' ? 200 : 100;
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
      ownKeys(element).filter(key => typeof key === 'string' && REACT_PREFIXES.some(prefix => key.startsWith(prefix)))
        .forEach(key => {
          const value = safeGet(element, key);
          if (objectLike(value)) result.push({ value, depth: 0, conversationEvidence });
        });
    };
    document.querySelectorAll(START_SELECTOR).forEach(element => {
      add(element, true);
      let parent = element.parentElement;
      for (let depth = 0; parent && depth < 3; depth++, parent = parent.parentElement) add(parent, true);
    });
    add(document.documentElement, false);
    add(document.body, false);
    return result;
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
    for (const owner of [api, safeGet(api, 'options')]) {
      for (const key of ['getScrollElement', 'getScrollElementFn']) {
        if (!hasFunction(owner, key)) continue;
        try {
          const element = safeGet(owner, key).call(owner);
          if (element instanceof Element) return element;
        } catch {}
      }
    }
    return null;
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
    if (!api || !preferredMethod(api)) {
      return { ok: false, reason: 'controller-shape-unverified' };
    }
    const observed = Array.isArray(request?.observedIndices)
      ? request.observedIndices.map(Number).filter(value => Number.isFinite(value) && value >= 0) : [];
    const visible = visibleIndices(api);
    const overlap = observed.some(index => visible.includes(index));
    const exactKeyIndex = resolveTargetIndex(api, request);
    const element = scrollElement(api);
    const elementInConversation = !!element?.closest?.('main, #thread, [data-virtualized-list], [data-scroll-root]');
    const ownershipVerified = candidate.conversationEvidence || overlap || Number.isFinite(exactKeyIndex) || elementInConversation;
    if (!ownershipVerified) return { ok: false, reason: 'main-conversation-controller-unverified' };
    return {
      ok: true,
      method: preferredMethod(api),
      ownershipStrategy: Number.isFinite(exactKeyIndex) ? 'target-item-key'
        : overlap ? 'visible-index-overlap' : elementInConversation ? 'scroll-element' : 'conversation-react-root',
      exactKeyIndex,
      itemCount: itemCount(api),
      visibleIndices: visible
    };
  };

  const findVirtualizer = (request, excludedApi = null) => {
    const startedAt = now();
    if (cached && Date.now() - cachedAt < CACHE_TTL_MS) {
      const validation = validateController(cached, request);
      if (validation.ok) return { candidate: cached, validation, discoveryMs: now() - startedAt, scanned: 0, cached: true };
      cached = null;
    }
    const queue = starts();
    const seen = new WeakMap();
    let best = null;
    let bestValidation = null;
    let bestScore = 0;
    let lastReason = 'virtualizer_api_not_found';
    let scanned = 0;
    while (queue.length && scanned < MAX_OBJECTS) {
      const { value, depth, conversationEvidence } = queue.shift();
      if (!objectLike(value)) continue;
      const excluded = value === excludedApi;
      const previousEvidence = seen.get(value);
      if (previousEvidence === true || (previousEvidence === false && !conversationEvidence)) continue;
      seen.set(value, !!conversationEvidence);
      scanned++;
      const currentScore = excluded ? 0 : score(value);
      if (currentScore > 0) {
        const candidate = { api: value, conversationEvidence: !!conversationEvidence };
        const validation = validateController(candidate, request);
        if (!validation.ok) lastReason = validation.reason;
        if (validation.ok && currentScore > bestScore) {
          best = candidate;
          bestValidation = validation;
          bestScore = currentScore;
          // Conversation-root discovery is sufficient for this private plugin.
          // Stop early instead of walking thousands of React objects on every
          // long-conversation click.
          if (currentScore >= 301 && candidate.conversationEvidence) break;
        }
      }
      if (depth >= MAX_DEPTH) continue;
      PRIORITY_KEYS.forEach(key => {
        const child = safeGet(value, key);
        if (objectLike(child)) queue.push({ value: child, depth: depth + 1, conversationEvidence });
        if (key === 'ref') {
          const current = safeGet(child, 'current');
          if (objectLike(current)) queue.push({ value: current, depth: depth + 1, conversationEvidence });
        }
      });
      ownKeys(value).slice(0, 80).forEach(key => {
        if (skipKey(key)) return;
        const child = safeGet(value, key);
        if (objectLike(child) && (depth <= 2 || relevantKey(key) || score(child))) {
          queue.push({ value: child, depth: depth + 1, conversationEvidence });
        }
      });
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
  const callMaybeAsync = async callback => {
    const result = callback();
    if (result && typeof result.then === 'function') await result;
  };
  const requestActive = (requestId, requestGeneration, deadlineAt) =>
    generation === requestGeneration && !cancelledRequests.has(requestId) && now() < deadlineAt;
  const observeCommand = async (api, before, targetIndex, requestId, requestGeneration, deadlineAt, checks = 6) => {
    for (let attempt = 0; attempt < checks; attempt++) {
      if (!requestActive(requestId, requestGeneration, deadlineAt)) return { cancelled: true, changed: false, after: snapshot(api) };
      await delay(30);
      const after = snapshot(api);
      if (Number.isFinite(targetIndex) && after.indices.includes(targetIndex)) {
        return { changed: snapshotChanged(before, after), targetVisible: true, after };
      }
      if (snapshotChanged(before, after)) return { changed: true, after };
    }
    return { changed: false, targetVisible: false, after: snapshot(api) };
  };

  const callWithFeedback = async (api, methodName, target, requestId, requestGeneration, deadlineAt) => {
    const method = safeGet(api, methodName);
    const options = { align: 'center', behavior: 'auto' };
    const attempts = [];
    if (methodName === 'scrollToIndex') {
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
    for (let signatureAttempt = 0; signatureAttempt < Math.min(2, attempts.length); signatureAttempt++) {
      if (!requestActive(requestId, requestGeneration, deadlineAt)) return { ok: false, reason: 'cancelled' };
      const before = snapshot(api);
      try { await callMaybeAsync(attempts[signatureAttempt]); } catch (error) { lastError = error; continue; }
      const observed = await observeCommand(api, before, methodName === 'scrollToOffset' ? null : target,
        requestId, requestGeneration, deadlineAt, signatureAttempt === 0 ? 6 : 8);
      if (observed.cancelled) return { ok: false, reason: 'cancelled' };
      if (observed.changed || observed.targetVisible) {
        return {
          ok: true,
          method: methodName,
          signatureAttempt: signatureAttempt + 1,
          stateChanged: observed.changed,
          targetIndexVisible: observed.targetVisible,
          beforeVisible: before.indices,
          afterVisible: observed.after.indices
        };
      }
    }
    return { ok: false, reason: lastError?.message || 'scroll-state-unchanged' };
  };

  const reply = (requestId, result) => document.dispatchEvent(new CustomEvent(RESULT_EVENT, {
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
    let commandTarget = targetIndex;
    if (methodName === 'scrollToOffset') {
      let totalSize = NaN;
      try { if (hasFunction(api, 'getTotalSize')) totalSize = Number(safeGet(api, 'getTotalSize').call(api)); } catch {}
      if (Number.isFinite(totalSize) && Number.isFinite(userOrder) && Number.isFinite(totalUsers) && totalUsers > 1) {
        commandTarget = Math.max(0, ((userOrder - 1) / (totalUsers - 1)) * totalSize);
        indexStrategy = 'bounded-offset-ratio';
      }
    }
    if (!Number.isFinite(commandTarget) || commandTarget < 0) {
      reply(request.requestId, {
        ok: false, reason: 'virtual-index-unresolved', failureStage: 'mapping',
        controllerValidated: true, ownershipStrategy: validation.ownershipStrategy,
        discoveryMs: found.discoveryMs, bridgeMs: now() - startedAt
      });
      return;
    }

    let command = await callWithFeedback(api, methodName, commandTarget,
      request.requestId, requestGeneration, deadlineAt);
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
            request.requestId, requestGeneration, deadlineAt);
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
