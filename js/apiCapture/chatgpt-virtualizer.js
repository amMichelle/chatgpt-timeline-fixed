// ChatGPT virtualizer bridge (MAIN world / document_start).
// Locates the page-owned virtual-list controller through React's object graph and
// exposes only a narrow scroll-to-index command to the isolated timeline script.
(() => {
  'use strict';
  if (window.__aitGptVirtualizerBridge) return;
  window.__aitGptVirtualizerBridge = true;

  const REQUEST_EVENT = 'ait-gpt-virtualizer-jump';
  const RESULT_EVENT = 'ait-gpt-virtualizer-jump-result';
  const REACT_PREFIXES = ['__reactFiber$', '__reactProps$', '__reactContainer$', '__reactInternalInstance$'];
  const PRIORITY_KEYS = ['stateNode', 'memoizedProps', 'memoizedState', 'ref', 'updateQueue', 'return', 'child', 'sibling', 'alternate', 'dependencies'];
  const HINT_KEYS = ['scrollToIndex', 'scrollToItem', 'scrollToOffset', 'getVirtualItems', 'getTotalSize', 'measureElement', 'rangeChanged', 'firstItemIndex'];
  const START_SELECTOR = '#thread, main, [data-scroll-root], [data-virtualized-list], [data-test-render-count], section[data-turn], [data-turn-id-container], [data-turn-key], [data-content-search-turn-key], [data-content-search-unit-key], [data-chatgpt-selection-message-id]';
  const MAX_OBJECTS = 4200;
  const MAX_DEPTH = 8;
  let cached = null;
  let cachedAt = 0;

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
    const add = element => {
      if (!(element instanceof Element) || seen.has(element)) return;
      seen.add(element);
      ownKeys(element).filter(key => typeof key === 'string' && REACT_PREFIXES.some(prefix => key.startsWith(prefix)))
        .forEach(key => { const value = safeGet(element, key); if (objectLike(value)) result.push(value); });
    };
    document.querySelectorAll(START_SELECTOR).forEach(element => {
      add(element);
      let parent = element.parentElement;
      for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) add(parent);
    });
    add(document.documentElement);
    add(document.body);
    return result;
  };

  const findVirtualizer = () => {
    if (cached && Date.now() - cachedAt < 5000) return cached;
    const queue = starts().map(value => ({ value, depth: 0 }));
    const seen = new WeakSet();
    let best = null;
    let bestScore = 0;
    let scanned = 0;
    while (queue.length && scanned < MAX_OBJECTS) {
      const { value, depth } = queue.shift();
      if (!objectLike(value) || seen.has(value)) continue;
      seen.add(value);
      scanned++;
      const currentScore = score(value);
      if (currentScore > bestScore) {
        best = value;
        bestScore = currentScore;
        if (currentScore >= 305) break;
      }
      if (depth >= MAX_DEPTH) continue;
      PRIORITY_KEYS.forEach(key => {
        const child = safeGet(value, key);
        if (objectLike(child)) queue.push({ value: child, depth: depth + 1 });
        if (key === 'ref') {
          const current = safeGet(child, 'current');
          if (objectLike(current)) queue.push({ value: current, depth: depth + 1 });
        }
      });
      ownKeys(value).slice(0, 90).forEach(key => {
        if (skipKey(key)) return;
        const child = safeGet(value, key);
        if (objectLike(child) && (depth <= 2 || relevantKey(key) || score(child))) {
          queue.push({ value: child, depth: depth + 1 });
        }
      });
    }
    cached = best;
    cachedAt = best ? Date.now() : 0;
    return best;
  };

  const callMaybeAsync = async callback => {
    const result = callback();
    if (result && typeof result.then === 'function') await result;
  };

  const scrollToCandidate = async (api, index) => {
    if (hasFunction(api, 'scrollToIndex')) {
      const method = safeGet(api, 'scrollToIndex');
      const calls = [
        () => method.call(api, { index, align: 'center', behavior: 'auto' }),
        () => method.call(api, index, { align: 'center', behavior: 'auto' }),
        () => method.call(api, index)
      ];
      let lastError;
      for (const call of calls) {
        try { await callMaybeAsync(call); return 'scrollToIndex'; } catch (error) { lastError = error; }
      }
      throw lastError || new Error('scrollToIndex_failed');
    }
    if (hasFunction(api, 'scrollToItem')) {
      const method = safeGet(api, 'scrollToItem');
      await callMaybeAsync(() => method.call(api, index, 'center'));
      return 'scrollToItem';
    }
    throw new Error('virtualizer_api_not_found');
  };

  const reply = (requestId, result) => document.dispatchEvent(new CustomEvent(RESULT_EVENT, {
    detail: JSON.stringify({ requestId, ...result })
  }));

  document.addEventListener(REQUEST_EVENT, async event => {
    let request = null;
    try { request = JSON.parse(typeof event.detail === 'string' ? event.detail : '{}'); } catch {}
    const candidates = Array.isArray(request?.candidates)
      ? Array.from(new Set(request.candidates.map(Number).filter(value => Number.isFinite(value) && value >= 0).map(Math.trunc)))
      : [];
    if (!request?.requestId || !candidates.length) return;
    let api = findVirtualizer();
    if (!api) { reply(request.requestId, { ok: false, reason: 'virtualizer_api_not_found' }); return; }
    let reason = 'virtualizer_scroll_failed';
    for (const index of candidates) {
      try {
        const method = await scrollToCandidate(api, index);
        reply(request.requestId, { ok: true, method, attemptedIndex: index });
        return;
      } catch (error) {
        reason = typeof error?.message === 'string' ? error.message : 'call_failed';
        cached = null;
        api = findVirtualizer();
        if (!api) break;
      }
    }
    reply(request.requestId, { ok: false, reason });
  });
})();
