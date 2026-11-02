// ChatGPT 对话接口拦截 —— MAIN world / document_start
//
// 目录：js/apiCapture/ —— 各平台 API 拦截模块统一放这里，每个平台一个 js 文件。
// 本文件：ChatGPT（chatgpt.com / chat.openai.com）
//
// ⚠️ MAIN WORLD ONLY，且必须 document_start 注入（要赶在页面发起首批请求前补丁 fetch）。
//
// 【解决什么问题】
// 新版 ChatGPT 虚拟化会把视口外轮次的 DOM 和 React 子树整体卸载，
// 未渲染轮次的内容在 DOM/fiber 中物理不存在。但页面自己一定从后端拿过完整对话 ——
// 本模块拦截页面发起的 GET /backend-api/conversation/{id} 响应，并在必要时对
// 当前对话补发一次 include_full_conversation 请求，解析当前分支的有序提问索引，
// 供「时间轴」为未渲染轮次创建节点、提供悬停文案和虚拟化跳转索引。
// （对话导出不依赖本模块：导出走滚动渲染 + DOM 采集，见 conversationExport 的 ChatGPT 适配器。）
//
// 【数据解析】
// 1. 沿 current_node 父链回溯 mapping，线性化出当前显示分支的节点序列；
// 2. 按角色分轮：user 消息独立成轮，连续的 assistant/tool/system 消息合并为一个助手轮
//    （与页面的 turn 结构一致）；
// 3. 文本过滤规则：content_type ∈ {text, multimodal_text}、recipient 为 all、
//    author.name 为空（排除思考链 / 工具调用 / 沙箱输出）；
// 4. 提问文本以【轮内每个消息 id】为键建索引 —— DOM 的 turn id（data-turn-id /
//    data-turn-id-container）等于轮内某条消息的 id，全键索引保证无论对应哪条都能命中。
//
// 【存储】按 convId 分桶保存消息 id → 文本及有序用户轮次。同一标签页内不限制跨对话总条目数，
// 刷新页面或关闭标签页后由页面生命周期统一释放。
//
// 【通信协议】（DOM 自定义事件同步往返，与项目内其他 MAIN world 桥一致）
//   ISOLATED 派发 'ait-gpt-user-texts-pull'，detail = 当前 conversationId
//   → 回派 'ait-gpt-user-texts-result'，detail = JSON 字符串
//     （{ conversationId, texts, turns, totalMessages, complete, source, pageCount, ... }）
//
// 【完整性】未确认完整的窗口响应只缓存为 pending，不得决定 Q1 或覆盖已确认完整索引；
// legacy mapping 不完整时自动遍历新版 conversations/messages 游标分页。
(() => {
  'use strict';
  if (window.__aitGptApiCapture) { window.AITGPTDiagnostics?.log('api.already-installed'); return; }
  window.__aitGptApiCapture = true;

  const conversationSnapshots = new Map(); // convId → ordered snapshot + completeness metadata
  const latestAppliedRequestByConversation = new Map(); // convId → 已成功应用的请求序号
  let nextRequestSequence = 0;
  let unmatchedJsonProbes = 0;
  let diagnosticRequestSequence = 0;
  const probedEndpointCounts = new Map();
  const endpointWords = new Set(['backend-api', 'conversation', 'conversations', 'thread', 'threads', 'message', 'messages', 'turn', 'turns', 'v1', 'v2', 'history', 'list', 'get', 'fetch', 'init', 'initialize', 'bootstrap', 'stream', 'resume', 'prepare', 'latest', 'recent', 'shared', 'sync', 'delta', 'batch', 'read', 'read-state', 'api', 'graphql', 'query']);
  const diag = window.AITGPTDiagnostics;
  const stats = { backendRequests: 0, matchedRequests: 0, unmatchedConversationRequests: 0, responses: 0, captured: 0, parseFailures: 0, pulls: 0 };
  diag?.log('api.capture-installed');

  const replaceSnapshot = (conversationId, snapshot, metadata = {}) => {
    if (!conversationId) return { applied: false, reason: 'missing-conversation' };
    const previous = conversationSnapshots.get(conversationId);
    const next = {
      texts: new Map(Object.entries(snapshot?.texts || {})),
      turns: Array.isArray(snapshot?.turns) ? snapshot.turns : [],
      totalMessages: Number.isFinite(snapshot?.totalMessages) ? snapshot.totalMessages : 0,
      complete: metadata.complete === true,
      source: metadata.source || 'captured-cache',
      pageCount: Number.isFinite(metadata.pageCount) ? metadata.pageCount : 1,
      rawMessages: Number.isFinite(metadata.rawMessages) ? metadata.rawMessages : (snapshot?.totalMessages || 0),
      dedupedMessages: Number.isFinite(metadata.dedupedMessages) ? metadata.dedupedMessages : (snapshot?.totalMessages || 0),
      currentNodeId: metadata.currentNodeId || '',
      pendingUserIds: [],
      version: (previous?.version || 0) + 1,
      capturedAt: Date.now()
    };
    const previousLastId = previous?.turns?.at(-1)?.id || '';
    const nextLastId = next.turns.at(-1)?.id || '';
    const branchChanged = !!(previousLastId && nextLastId && previousLastId !== nextLastId);
    const previousIds = new Set(previous?.turns?.map(turn => turn.id) || []);
    const incomingIsSubset = next.turns.length > 0 && next.turns.every(turn => previousIds.has(turn.id));
    const nextAliases = new Set(next.turns.flatMap(turn =>
      [turn.id, turn.nodeId, turn.messageId, ...(turn.ids || [])].filter(Boolean)
    ));
    const unresolvedPending = (previous?.pendingUserIds || []).filter(id => !nextAliases.has(id));
    if (next.complete && unresolvedPending.length) {
      diag?.log('api.partial-overwrite-prevented', {
        conversationId, previousUsers: previous.turns.length, incomingUsers: next.turns.length,
        previousSource: previous.source, incomingSource: next.source,
        pendingUsers: unresolvedPending.length, reason: 'pending-user-not-yet-indexed'
      });
      return { applied: false, reason: 'pending-user-protected', branchChanged };
    }
    if (previous?.complete && !next.complete) {
      diag?.log('api.partial-overwrite-prevented', {
        conversationId, previousUsers: previous.turns.length, incomingUsers: next.turns.length,
        previousSource: previous.source, incomingSource: next.source, branchChanged
      });
      return { applied: false, reason: 'complete-protected', branchChanged };
    }
    if (previous?.complete && next.complete
        && next.turns.length < previous.turns.length
        && !branchChanged && incomingIsSubset) {
      diag?.log('api.partial-overwrite-prevented', {
        conversationId, previousUsers: previous.turns.length, incomingUsers: next.turns.length,
        previousSource: previous.source, incomingSource: next.source,
        branchChanged: false, incomingClaimedComplete: true
      });
      return { applied: false, reason: 'smaller-complete-protected', branchChanged: false };
    }
    if (!previous?.complete && !next.complete && previous?.turns?.length > next.turns.length && !branchChanged) {
      diag?.log('api.partial-overwrite-prevented', {
        conversationId, previousUsers: previous.turns.length, incomingUsers: next.turns.length,
        previousSource: previous.source, incomingSource: next.source, branchChanged: false
      });
      return { applied: false, reason: 'larger-partial-protected', branchChanged: false };
    }
    conversationSnapshots.set(conversationId, next);
    return { applied: true, reason: 'applied', branchChanged };
  };

  const isCompleteMapping = json => {
    const mapping = json?.mapping;
    const current = json?.current_node || json?.current_node_id;
    if (!mapping || typeof mapping !== 'object' || !current || !mapping[current]) return false;
    const seen = new Set();
    let id = current;
    while (id) {
      if (seen.has(id) || !mapping[id]) return false;
      seen.add(id);
      id = mapping[id]?.parent || '';
    }
    return true;
  };

  const getPageInfo = json => json?.page_info || json?.pageInfo || {};
  const hasPreviousPage = json => {
    const info = getPageInfo(json);
    return info.has_previous_page === true || info.hasPreviousPage === true;
  };
  const getPreviousCursor = json => {
    const info = getPageInfo(json);
    const cursor = info.start_cursor || info.startCursor || '';
    return hasPreviousPage(json) && typeof cursor === 'string' ? cursor : '';
  };

  // ---- 消息过滤/提取规则 ----
  const isVisibleType = (m) => {
    const ct = m?.content?.content_type;
    return ct === 'text' || ct === 'multimodal_text';
  };
  const isForUser = (m) => !m?.recipient || m.recipient === 'all';
  const isModelAuthored = (m) => !m?.author?.name; // 工具沙箱消息带 name，正文无 name

  // 单个 part 的文本：
  // - 普通文本：part 为字符串
  // - 语音模式：part 为 { content_type: 'audio_transcription', text, direction, ... } 对象，
  //   提问文字在 text 字段（图片/文件等 asset pointer 对象没有 text，自然被忽略）
  const textFromPart = (p) => {
    if (typeof p === 'string') return p;
    if (p && typeof p === 'object' && typeof p.text === 'string') return p.text;
    return '';
  };

  const textFromMessage = (m) => {
    try {
      const content = m?.content;
      if (!content) return '';
      if (/thought|reason/i.test(content.content_type || '')) return '';
      const parts = content.parts;
      if (!Array.isArray(parts)) return '';
      return parts.map(textFromPart).filter(Boolean).join('\n').trim();
    } catch {
      return '';
    }
  };

  // ---- mapping 线性化：沿 current_node 父链回溯出当前显示分支 ----
  const linearize = (json, metrics) => {
    const mapping = json?.mapping || {};
    let cur = json?.current_node;
    metrics.currentNodePresent = !!cur;
    metrics.currentNodeResolves = !!(cur && mapping[cur]);
    if (!cur || !mapping[cur]) {
      metrics.usedLeafFallback = true;
      // 兜底：任取一个叶子节点（无 children）
      cur = Object.keys(mapping).find(id => !(mapping[id]?.children?.length));
    }
    const chain = [];
    let guard = 0;
    while (cur && mapping[cur] && guard++ < 10000) {
      chain.push(mapping[cur]);
      cur = mapping[cur].parent;
    }
    metrics.chainLength = chain.length;
    metrics.guardLimitReached = guard >= 10000;
    metrics.brokenParentLink = !!cur && !mapping[cur];
    return chain.reverse();
  };

  // ---- 解析：按轮分组后提取用户提问文本（消息id → 文本）----
  const parseConversationSnapshot = (json, rolloutNodes = null) => {
    const metrics = { usedLeafFallback: false, missingMessage: 0, missingNodeId: 0, roles: { user: 0, assistant: 0, system: 0, tool: 0, other: 0 }, contentTypes: { text: 0, multimodal_text: 0, other: 0 }, userNamedAuthor: 0, userNonPublicRecipient: 0, userUnsupportedContent: 0, userPartsNotArray: 0, userNoExtractableText: 0, userMissingMessageId: 0 };
    const chain = rolloutNodes || linearize(json, metrics);
    metrics.source = rolloutNodes ? 'messages' : 'mapping';
    metrics.chainLength = chain.length;
    const turns = [];
    let currentAssistant = null;
    chain.forEach((node, chainIndex) => {
      const msg = node?.message;
      if (!msg) metrics.missingMessage++;
      if (!node?.id) metrics.missingNodeId++;
      if (msg) {
        const role = ['user', 'assistant', 'system', 'tool'].includes(msg.author?.role) ? msg.author.role : 'other';
        metrics.roles[role]++;
        if (role === 'user') {
          const ct = ['text', 'multimodal_text'].includes(msg.content?.content_type) ? msg.content.content_type : 'other';
          metrics.contentTypes[ct]++;
          if (!isModelAuthored(msg)) metrics.userNamedAuthor++;
          if (!isForUser(msg)) metrics.userNonPublicRecipient++;
          if (!isVisibleType(msg)) metrics.userUnsupportedContent++;
          if (!Array.isArray(msg.content?.parts)) metrics.userPartsNotArray++;
          if (!textFromMessage(msg)) metrics.userNoExtractableText++;
          if (!msg.id) metrics.userMissingMessageId++;
        }
      }
      if (!msg || !node.id) return;
      if (msg.author?.role === 'user') {
        currentAssistant = null;
        turns.push({
          role: 'user',
          ids: Array.from(new Set([node.id, msg.id].filter(Boolean))),
          nodeId: node.id || '',
          messageId: msg.id || '',
          messageIndex: chainIndex + 1,
          messages: [msg]
        });
      } else {
        if (!currentAssistant) {
          currentAssistant = { role: 'assistant', ids: [], messages: [] };
          turns.push(currentAssistant);
        }
        currentAssistant.ids.push(node.id);
        currentAssistant.messages.push(msg);
      }
    });

    const texts = Object.create(null);
    const userTurns = [];
    turns.forEach(t => {
      if (t.role !== 'user') return;
      const text = t.messages
        .filter(m => m.author?.role === 'user' && isModelAuthored(m) && isForUser(m) && isVisibleType(m))
        .map(textFromMessage)
        .filter(Boolean)
        .join('\n\n');
      const compact = text ? text.replace(/\s+/g, ' ').trim() : '[图片或文件]';
      t.ids.forEach(id => { texts[id] = compact; });
      userTurns.push({
        id: t.nodeId || t.messageId || t.ids[0] || '',
        nodeId: t.nodeId,
        messageId: t.messageId,
        ids: t.ids,
        text: compact,
        messageIndex: t.messageIndex,
        userOrder: userTurns.length + 1
      });
    });
    diag?.log('api.parsed-branch', { ...metrics, turns: turns.length, userTurns: userTurns.length, textEntries: Object.keys(texts).length });
    return { texts, turns: userTurns, totalMessages: chain.length };
  };

  const capture = (conversationId, json, rollout = false, metadata = {}) => {
    try {
      if (diag?.verbose) diag.log('api.response-shape', diag.shape(json));
      const rolloutNodes = rollout ? window.AITChatGPTRolloutAPI?.nodes(json) : null;
      if (rollout ? !rolloutNodes : !json?.mapping) { diag?.log('api.capture-skipped', { reason: rollout ? 'messages-missing' : 'mapping-missing' }); return false; }
      if (diag?.verbose) {
        diag?.log('api.mapping-shape', { type: diag.type(json.mapping), nodeCount: Object.keys(json.mapping || {}).length });
        const schema = { inspected: 0, withNodeId: 0, withMessage: 0, withParent: 0, childrenArray: 0, messageHasAuthor: 0, messageHasContent: 0, userMessages: 0, otherRoles: 0 };
        for (const node of Object.values(json.mapping || {}).slice(0, 10000)) {
          schema.inspected++;
          if (node?.id) schema.withNodeId++;
          if (node?.message) schema.withMessage++;
          if (node?.parent) schema.withParent++;
          if (Array.isArray(node?.children)) schema.childrenArray++;
          if (node?.message?.author) schema.messageHasAuthor++;
          if (node?.message?.content) schema.messageHasContent++;
          if (node?.message?.author?.role === 'user') schema.userMessages++;
          else schema.otherRoles++;
        }
        diag?.log('api.mapping-node-schema', schema);
      }
      const snapshot = parseConversationSnapshot(json, rolloutNodes);
      // Only requests made by ensureFullConversation are authoritative. Page
      // traffic can look structurally complete while still representing a
      // virtual/paginated window with a synthetic root.
      const complete = metadata.complete === true;
      const source = metadata.source || (rollout ? 'captured-paginated-window' : 'captured-mapping');
      const replaceResult = replaceSnapshot(conversationId, snapshot, {
        complete,
        source,
        pageCount: metadata.pageCount || 1,
        rawMessages: metadata.rawMessages || rolloutNodes?.length || snapshot.totalMessages,
        dedupedMessages: metadata.dedupedMessages || rolloutNodes?.length || snapshot.totalMessages,
        currentNodeId: json?.current_node || json?.current_node_id || ''
      });
      if (!replaceResult.applied) {
        if (replaceResult.branchChanged) {
          setTimeout(() => { void ensureFullConversation(conversationId, { force: true }); }, 0);
        }
        return false;
      }
      stats.captured++;
      diag?.log('api.cache-written', {
        conversationId, source, complete, pageCount: metadata.pageCount || 1,
        rawMessages: metadata.rawMessages || rolloutNodes?.length || snapshot.totalMessages,
        dedupedMessages: metadata.dedupedMessages || rolloutNodes?.length || snapshot.totalMessages,
        userTurns: snapshot.turns.length,
        firstUserId: snapshot.turns[0]?.id || '', lastUserId: snapshot.turns.at(-1)?.id || '',
        version: conversationSnapshots.get(conversationId)?.version || 0
      });
      // 通知 ISOLATED world：该对话的接口文本已写入缓存。
      // 事件只携带对话 ID，消费方再通过既有 pull 协议读取，避免重复传输整份文本。
      document.dispatchEvent(new CustomEvent('ait-gpt-user-texts-updated', {
        // MAIN → ISOLATED 跨 world 只传字符串，避免对象 detail 的兼容性限制。
        detail: conversationId
      }));
      return true;
    } catch (error) {
      stats.parseFailures++;
      diag?.error('api.capture', error);
      return false;
    }
  };

  // ---- fetch 补丁 ----
  // 匹配 GET /backend-api/conversation/{uuid}（POST /backend-api/conversation 是发消息的 SSE 流，排除）
  const CONV_URL_RE = /^\/backend-api\/conversation\/([0-9a-f][0-9a-f-]{18,})$/i;
  const origFetch = window.fetch;
  const fullConversationRequests = new Map();
  const liveRefreshGeneration = new Map();
  let accessTokenPromise = null;

  const getAccessToken = () => {
    if (accessTokenPromise) return accessTokenPromise;
    accessTokenPromise = origFetch.call(window, new URL('/api/auth/session', location.origin).href, {
      method: 'GET', credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' }
    }).then(response => response.ok ? response.json() : null)
      .then(session => session?.accessToken || session?.access_token || '')
      .catch(() => '');
    return accessTokenPromise;
  };

  const mergeMessages = (older, newer) => {
    const merged = [];
    const seen = new Set();
    [...older, ...newer].forEach((message, index) => {
      if (!message || typeof message !== 'object') return;
      const key = typeof message.id === 'string' && message.id ? message.id : `missing-id-${index}`;
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(message);
    });
    return merged;
  };

  const fetchOwnJson = async (url, headers) => {
    const response = await origFetch.call(window, url, {
      method: 'GET', credentials: 'include', cache: 'no-store', headers
    });
    if (!response?.ok) throw new Error(`http-${response?.status || 0}`);
    return response.json();
  };

  const notifySnapshotUpdated = conversationId => {
    document.dispatchEvent(new CustomEvent('ait-gpt-user-texts-updated', { detail: conversationId }));
  };

  const snapshotAliasSet = snapshot => new Set((snapshot?.turns || []).flatMap(turn =>
    [turn?.id, turn?.nodeId, turn?.messageId, ...(turn?.ids || [])].filter(Boolean)
  ));

  const appendOptimisticUserMessages = (conversationId, messages) => {
    const snapshot = conversationSnapshots.get(conversationId);
    if (!snapshot?.complete || !Array.isArray(messages)) return [];
    const known = snapshotAliasSet(snapshot);
    const appended = [];
    const texts = new Map(snapshot.texts);
    const turns = [...snapshot.turns];
    const pendingUserIds = new Set(snapshot.pendingUserIds || []);
    const optimisticBaseTotalMessages = Number.isFinite(snapshot.optimisticBaseTotalMessages)
      ? snapshot.optimisticBaseTotalMessages : snapshot.totalMessages;
    let totalMessages = snapshot.totalMessages;
    messages.forEach(message => {
      if (message?.author?.role !== 'user' || typeof message.id !== 'string' || !message.id || known.has(message.id)) return;
      const text = textFromMessage(message).replace(/\s+/g, ' ').trim() || '[图片或文件]';
      const id = message.id;
      const messageIndex = totalMessages + 1;
      turns.push({
        id, nodeId: id, messageId: id, ids: [id], text,
        messageIndex, userOrder: turns.length + 1, optimistic: true
      });
      texts.set(id, text);
      known.add(id);
      pendingUserIds.add(id);
      appended.push(id);
      totalMessages = messageIndex;
    });
    if (!appended.length) return [];
    conversationSnapshots.set(conversationId, {
      ...snapshot,
      texts, turns, totalMessages,
      pendingUserIds: Array.from(pendingUserIds),
      optimisticBaseTotalMessages,
      source: snapshot.source.includes('optimistic') ? snapshot.source : `${snapshot.source}+optimistic`,
      version: (snapshot.version || 0) + 1,
      capturedAt: Date.now()
    });
    diag?.log('timeline.live-update', {
      conversationId, stage: 'optimistic-appended', addedUsers: appended.length,
      previousUsers: snapshot.turns.length, nextUsers: turns.length,
      pendingUsers: pendingUserIds.size, version: (snapshot.version || 0) + 1
    });
    notifySnapshotUpdated(conversationId);
    return appended;
  };

  const rollbackOptimisticUsers = (conversationId, ids) => {
    if (!ids?.length) return;
    const snapshot = conversationSnapshots.get(conversationId);
    if (!snapshot) return;
    const idSet = new Set(ids);
    const removed = snapshot.turns.filter(turn => turn.optimistic && idSet.has(turn.id));
    if (!removed.length) return;
    const turns = snapshot.turns.filter(turn => !(turn.optimistic && idSet.has(turn.id)))
      .map((turn, index) => ({ ...turn, userOrder: index + 1 }));
    const texts = new Map(snapshot.texts);
    removed.forEach(turn => (turn.ids || [turn.id]).forEach(id => texts.delete(id)));
    const pendingUserIds = (snapshot.pendingUserIds || []).filter(id => !idSet.has(id));
    const totalMessages = pendingUserIds.length
      ? (snapshot.optimisticBaseTotalMessages || 0) + pendingUserIds.length
      : (snapshot.optimisticBaseTotalMessages || snapshot.totalMessages);
    conversationSnapshots.set(conversationId, {
      ...snapshot, texts, turns, pendingUserIds, totalMessages,
      source: pendingUserIds.length ? snapshot.source : snapshot.source.replace(/\+optimistic$/, ''),
      optimisticBaseTotalMessages: pendingUserIds.length ? snapshot.optimisticBaseTotalMessages : undefined,
      version: (snapshot.version || 0) + 1,
      capturedAt: Date.now()
    });
    diag?.log('timeline.live-update', {
      conversationId, stage: 'optimistic-rolled-back', removedUsers: removed.length,
      nextUsers: turns.length, version: (snapshot.version || 0) + 1
    });
    notifySnapshotUpdated(conversationId);
  };

  const readRequestJson = async args => {
    try {
      const body = args?.[1]?.body;
      if (typeof body === 'string') return JSON.parse(body);
      const input = args?.[0];
      if (input && typeof input.clone === 'function' && typeof input.json === 'function') {
        return await input.clone().json();
      }
    } catch {}
    return null;
  };

  const refreshAfterUserSend = (conversationId, reason = 'user-send') => {
    if (!conversationId) return;
    const generation = (liveRefreshGeneration.get(conversationId) || 0) + 1;
    liveRefreshGeneration.set(conversationId, generation);
    void (async () => {
      const delays = [200, 700, 1600, 3200, 6500];
      for (let attempt = 0; attempt < delays.length; attempt++) {
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));
        if (liveRefreshGeneration.get(conversationId) !== generation) return;
        const path = location.pathname.split('/');
        if (path[path.indexOf('c') + 1] !== conversationId) return;
        const before = conversationSnapshots.get(conversationId);
        await ensureFullConversation(conversationId, { force: true });
        const after = conversationSnapshots.get(conversationId);
        diag?.log('timeline.live-update', {
          conversationId, stage: 'authoritative-refresh', reason, attempt: attempt + 1,
          previousUsers: before?.turns?.length || 0, nextUsers: after?.turns?.length || 0,
          pendingUsers: after?.pendingUserIds?.length || 0, version: after?.version || 0
        });
        if (!after?.pendingUserIds?.length && after?.complete) return;
      }
      const stale = conversationSnapshots.get(conversationId);
      const stalePending = stale?.pendingUserIds || [];
      if (liveRefreshGeneration.get(conversationId) === generation && stalePending.length) {
        // The send failed silently, was withdrawn, or the user changed branch
        // before the authoritative index adopted the optimistic IDs.
        rollbackOptimisticUsers(conversationId, stalePending);
        diag?.log('timeline.live-update', {
          conversationId, stage: 'optimistic-expired', removedUsers: stalePending.length,
          version: conversationSnapshots.get(conversationId)?.version || 0
        });
        await ensureFullConversation(conversationId, { force: true });
      }
    })();
  };

  // The page often requests only its current virtual window. Prefer the complete
  // legacy mapping; if unavailable/incomplete, exhaust the newer cursor API.
  const ensureFullConversation = (conversationId, options = {}) => {
    if (!/^[A-Za-z0-9_-]{12,}$/.test(conversationId || '')) return Promise.resolve(false);
    const existingSnapshot = conversationSnapshots.get(conversationId);
    if (existingSnapshot?.complete && !options.force) return Promise.resolve(true);
    const existingRequest = fullConversationRequests.get(conversationId);
    if (!options.force && existingRequest && Date.now() - existingRequest.startedAt < 30000) return existingRequest.promise;
    const promise = (async () => {
      let legacyPartial = null;
      try {
        const token = await getAccessToken();
        const headers = { Accept: 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        try {
          const legacyUrl = new URL(`/backend-api/conversation/${encodeURIComponent(conversationId)}`, location.origin);
          legacyUrl.searchParams.set('include_full_conversation', 'true');
          const legacy = await fetchOwnJson(legacyUrl.href, headers);
          if (isCompleteMapping(legacy)) {
            const requestSequence = ++nextRequestSequence;
            if (capture(conversationId, legacy, false, { complete: true, source: 'complete-api', pageCount: 1 })) {
              latestAppliedRequestByConversation.set(conversationId, requestSequence);
              return true;
            }
          } else if (legacy?.mapping) {
            legacyPartial = legacy;
          }
        } catch {
          // Continue with the paginated endpoint.
        }

        const firstUrl = new URL(`/backend-api/conversations/${encodeURIComponent(conversationId)}`, location.origin);
        firstUrl.searchParams.set('include_has_versions', 'true');
        firstUrl.searchParams.set('num_turns', '100');
        const firstPage = await fetchOwnJson(firstUrl.href, headers);
        if (!Array.isArray(firstPage?.messages)) throw new Error('paginated-messages-missing');
        let messages = mergeMessages([], firstPage.messages);
        let rawMessages = firstPage.messages.length;
        let cursor = getPreviousCursor(firstPage);
        if (hasPreviousPage(firstPage) && !cursor) throw new Error('pagination-cursor-missing');
        let pageCount = 1;
        const seenCursors = new Set();
        while (cursor) {
          if (seenCursors.has(cursor) || pageCount >= 500) throw new Error('pagination-stalled');
          seenCursors.add(cursor);
          const pageUrl = new URL(`/backend-api/conversations/${encodeURIComponent(conversationId)}/messages`, location.origin);
          pageUrl.searchParams.set('before', cursor);
          pageUrl.searchParams.set('include_has_versions', 'true');
          pageUrl.searchParams.set('num_turns', '100');
          const page = await fetchOwnJson(pageUrl.href, headers);
          if (!Array.isArray(page?.messages)) throw new Error('paginated-page-missing');
          rawMessages += page.messages.length;
          messages = mergeMessages(page.messages, messages);
          cursor = getPreviousCursor(page);
          if (hasPreviousPage(page) && !cursor) throw new Error('pagination-cursor-missing');
          pageCount++;
        }
        const requestSequence = ++nextRequestSequence;
        const combined = { ...firstPage, messages };
        if (capture(conversationId, combined, true, {
          complete: true,
          source: 'paginated-api',
          pageCount,
          rawMessages,
          dedupedMessages: messages.length
        })) {
          latestAppliedRequestByConversation.set(conversationId, requestSequence);
          return true;
        }
      } catch (error) {
        diag?.log('api.full-conversation-failed', {
          conversationId, reason: error?.name === 'AbortError' ? 'aborted' : 'unavailable',
          retainedComplete: conversationSnapshots.get(conversationId)?.complete === true
        });
        if (legacyPartial && !conversationSnapshots.get(conversationId)?.complete) {
          capture(conversationId, legacyPartial, false, { complete: false, source: 'partial-legacy-api', pageCount: 1 });
        }
      }
      return false;
    })();
    fullConversationRequests.set(conversationId, { promise, startedAt: Date.now() });
    return promise;
  };

  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    try {
      const rawUrl = typeof args[0] === 'string' ? args[0] : (args[0] instanceof URL ? args[0].href : (args[0]?.url || ''));
      const method = String(args[1]?.method || (typeof args[0] === 'object' ? args[0]?.method : '') || 'GET').toUpperCase();
      const requestUrl = new URL(rawUrl, location.href);
      const sameOrigin = requestUrl.origin === location.origin;
      const legacyMatch = sameOrigin && requestUrl.pathname.match(CONV_URL_RE);
      const rolloutMatch = sameOrigin && window.AITChatGPTRolloutAPI?.match(requestUrl.pathname);
      const match = legacyMatch || rolloutMatch;
      // Current ChatGPT sends through /backend-api/{namespace}/conversation;
      // /conversation/prepare is a separate preflight and has no user turn.
      const isConversationSend = sameOrigin && method === 'POST'
        && /^\/backend-api\/(?:[^/]+\/)?conversation\/?$/.test(requestUrl.pathname);
      if (sameOrigin && method === 'POST' && /\/backend-api\/.*conversation/i.test(requestUrl.pathname)) {
        diag?.log('timeline.send-detected', {
          matchedSendEndpoint: isConversationSend,
          conversationId: location.pathname.split('/').at(-1) || '',
          requestHasBody: !!(args[1]?.body || args[0]?.body)
        });
      }
      if (isConversationSend) {
        void (async () => {
          const payload = await readRequestJson(args);
          const routeParts = location.pathname.split('/');
          const routeIndex = routeParts.indexOf('c');
          const conversationId = typeof payload?.conversation_id === 'string' && payload.conversation_id
            ? payload.conversation_id
            : routeIndex >= 0 ? routeParts[routeIndex + 1] : '';
          const optimisticIds = appendOptimisticUserMessages(conversationId, payload?.messages);
          diag?.log('timeline.send-payload', {
            conversationId, parsed: !!payload,
            messageCount: Array.isArray(payload?.messages) ? payload.messages.length : 0,
            userCount: Array.isArray(payload?.messages) ? payload.messages.filter(message => message?.author?.role === 'user').length : 0,
            optimisticUsers: optimisticIds.length,
            cachedComplete: conversationSnapshots.get(conversationId)?.complete === true
          });
          try {
            const response = await p;
            if (!response?.ok) {
              rollbackOptimisticUsers(conversationId, optimisticIds);
              return;
            }
            diag?.log('timeline.live-update', {
              conversationId, stage: 'send-observed', optimisticUsers: optimisticIds.length,
              version: conversationSnapshots.get(conversationId)?.version || 0
            });
            refreshAfterUserSend(conversationId);
          } catch {
            rollbackOptimisticUsers(conversationId, optimisticIds);
          }
        })().catch(error => diag?.error('timeline.send-capture', error));
      }
      // Endpoint metadata only; never log raw URL/path, request body or headers.
      let backend = false, conversationLike = false, pathDepth = 0, endpointShape = 'unknown', currentConversationInPath = false;
      try {
        const url = new URL(rawUrl, location.href);
        backend = url.origin === location.origin && (/^\/(?:backend-api|api)\//.test(url.pathname) || url.pathname === '/graphql');
        const segments = url.pathname.split('/').filter(Boolean);
        conversationLike = backend && segments.some(s => /conversation|thread|message|turn/i.test(s));
        const currentParts = location.pathname.split('/');
        const currentIndex = currentParts.indexOf('c');
        const currentId = currentIndex >= 0 ? currentParts[currentIndex + 1] : null;
        currentConversationInPath = !!currentId && segments.includes(currentId);
        pathDepth = segments.length;
        endpointShape = '/' + segments.map(segment => endpointWords.has(segment) ? segment : ':redacted').join('/');
      } catch {}
      if (backend) stats.backendRequests++;
      const diagnosticRequest = backend || match ? ++diagnosticRequestSequence : 0;
      const safeMethod = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? method : 'other';
      if (backend) diag?.log('api.request-observed', { diagnosticRequest, endpointShape, method: safeMethod, conversationLike, currentConversationInPath });
      if (conversationLike && !(match && method === 'GET')) {
        stats.unmatchedConversationRequests++;
        diag?.log('api.unmatched-conversation-request', { diagnosticRequest, endpointShape, method: safeMethod, pathDepth, note: method === 'POST' ? 'may-be-normal-send-stream' : 'not-handled-by-existing-matcher' });
      }
      if (match && method === 'GET') {
        stats.matchedRequests++;
        const conversationId = match[1];
        const requestSequence = ++nextRequestSequence;
        const startedAt = performance.now();
        const signal = args[1]?.signal || args[0]?.signal;
        const requestMeta = { requestSequence, diagnosticRequest, endpointShape, currentConversationInPath };
        diag?.log('api.request-matched', requestMeta);
        p.then(async resp => {
          stats.responses++;
          const ct = resp?.headers?.get('content-type') || '';
          diag?.log('api.response', { requestSequence, status: resp?.status, ok: !!resp?.ok, contentType: ct.includes('json') ? 'json' : ct.includes('event-stream') ? 'event-stream' : ct.includes('html') ? 'html' : 'other' });
          if (resp && resp.ok) {
            let stage = 'clone', copy;
            const bodyState = () => ({ bodyUsed: !!resp.bodyUsed, bodyLocked: !!resp.body?.locked,
              copyBodyUsed: !!copy?.bodyUsed, copyBodyLocked: !!copy?.body?.locked, aborted: !!signal?.aborted,
              online: navigator.onLine, elapsedMs: Math.round(performance.now() - startedAt) });
            try {
              copy = resp.clone();
              stage = 'read-json';
              const json = await copy.json();
              diag?.log('api.read-complete', { ...requestMeta, ...bodyState(),
                hasMapping: !!json?.mapping, messagesCount: Array.isArray(json?.messages) ? json.messages.length : 0 });
              const latestApplied = latestAppliedRequestByConversation.get(conversationId) || 0;
              if (requestSequence < latestApplied) { diag?.log('api.stale-response-skipped', { requestSequence, latestApplied }); return; }
              if (capture(conversationId, json, !!rolloutMatch, {
                complete: false,
                source: rolloutMatch ? 'captured-page-window' : 'captured-page-mapping'
              })) latestAppliedRequestByConversation.set(conversationId, requestSequence);
            } catch (error) {
              stats.parseFailures++;
              // 只输出固定分类，不输出异常 message/stack（其中可能包含 URL 或正文）。
              const message = typeof error?.message === 'string' ? error.message : '';
              const reason = signal?.aborted || error?.name === 'AbortError' ? 'aborted'
                : /locked|already.*read|already.*used|unusable|disturbed/i.test(message) ? 'body-unavailable'
                : error?.name === 'SyntaxError' ? 'invalid-json'
                : /network|failed to fetch|terminated|load failed/i.test(message) ? 'network-read'
                : 'unknown';
              diag?.log('api.read-failed', { ...requestMeta, stage, reason, ...bodyState(), status: resp.status });
              diag?.error('api.response-json', error);
            }
          }
        }).catch(error => diag?.error('api.fetch', error));
      } else if (backend && diag?.verbose) {
        // Correlate every response with its request. Sample JSON from distinct endpoint
        // families, including POST JSON; never read request bodies or SSE streams.
        const probeKey = safeMethod + ':' + endpointShape;
        const shouldProbe = unmatchedJsonProbes < (conversationLike || currentConversationInPath ? 80 : 35) && (probedEndpointCounts.get(probeKey) || 0) < 3;
        if (shouldProbe) {
          unmatchedJsonProbes++;
          probedEndpointCounts.set(probeKey, (probedEndpointCounts.get(probeKey) || 0) + 1);
        }
        p.then(async resp => {
          const ct = resp?.headers?.get('content-type') || '';
          const meta = { diagnosticRequest, endpointShape, method: safeMethod, status: resp?.status,
            contentType: ct.includes('json') ? 'json' : ct.includes('event-stream') ? 'event-stream' : ct.includes('html') ? 'html' : 'other', conversationLike, currentConversationInPath };
          diag?.log('api.alternative-response', { ...meta, shapeProbeSelected: shouldProbe });
          if (shouldProbe && resp?.ok && ct.includes('json')) {
            const payload = await diag?.readResponseSample(resp, false);
            if (payload !== undefined) diag?.log('api.alternative-shape', { ...meta, ...diag.shape(payload) });
          } else if (shouldProbe && resp?.ok && ct.includes('event-stream')) {
            await diag?.readResponseSample(resp, true, meta);
          }
        }).catch(error => diag?.error('api.alternative-probe', error));
      }
    } catch (error) { diag?.error("api.fetch-hook", error); /* 补丁逻辑绝不影响页面请求本身 */ }
    return p;
  };

  const installedFetch = window.fetch;
  for (const delay of [5000, 15000, 30000, 60000]) {
    setTimeout(() => {
      try {
        const path = location.pathname.split('/');
        const index = path.indexOf('c');
        const snapshot = index >= 0 ? conversationSnapshots.get(path[index + 1]) : null;
        const ids = new Set(Array.from(document.querySelectorAll('[data-turn-id-container], [data-turn-id]'))
          .map(el => el.getAttribute('data-turn-id-container') || el.getAttribute('data-turn-id')).filter(Boolean));
        diag?.log('api.health', { ...stats, fetchHookStillInstalled: window.fetch === installedFetch,
          currentConversationCached: !!snapshot, currentTextEntries: snapshot?.texts?.size || 0,
          domUniqueIds: ids.size, matchingCachedIds: Array.from(ids).filter(id => snapshot?.texts?.has(id)).length });
      } catch (error) { diag?.error('api.health', error); }
    }, delay);
  }

  // ---- 事件视图：用户提问文本（时间轴）----
  document.addEventListener('ait-gpt-user-texts-pull', (event) => {
    try {
      const conversationId = typeof event.detail === 'string' ? event.detail : '';
      void ensureFullConversation(conversationId);
      const snapshot = conversationSnapshots.get(conversationId);
      stats.pulls++;
      diag?.log('api.bridge-pull', {
        validRequest: !!conversationId, cacheHit: !!snapshot, complete: snapshot?.complete === true,
        source: snapshot?.source || 'none', pageCount: snapshot?.pageCount || 0,
        textEntries: snapshot?.texts?.size || 0, userTurns: snapshot?.turns?.length || 0,
        pendingUsers: snapshot?.pendingUserIds?.length || 0, version: snapshot?.version || 0
      });
      document.dispatchEvent(new CustomEvent('ait-gpt-user-texts-result', {
        // Firefox 不允许页面脚本把非字符串 detail 直接暴露给扩展内容脚本。
        // MAIN → ISOLATED 统一使用 JSON 字符串，消费方负责解析。
        detail: JSON.stringify({
          conversationId,
          texts: snapshot ? Object.fromEntries(snapshot.texts) : {},
          turns: snapshot?.turns || [],
          totalMessages: snapshot?.totalMessages || 0,
          complete: snapshot?.complete === true,
          source: snapshot?.source || 'none',
          pageCount: snapshot?.pageCount || 0,
          rawMessages: snapshot?.rawMessages || 0,
          dedupedMessages: snapshot?.dedupedMessages || 0,
          pendingUserIds: snapshot?.pendingUserIds || [],
          version: snapshot?.version || 0,
          firstUserId: snapshot?.turns?.[0]?.id || '',
          lastUserId: snapshot?.turns?.at(-1)?.id || ''
        })
      }));
    } catch {
      document.dispatchEvent(new CustomEvent('ait-gpt-user-texts-result', {
        detail: JSON.stringify({ conversationId: '', texts: null })
      }));
    }
  });
})();
