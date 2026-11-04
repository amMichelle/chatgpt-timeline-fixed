/**
 * ChatGPT Adapter
 * 
 * Supports: 
 *   - chatgpt.com/c/xxx (普通对话)
 *   - chatgpt.com/g/xxx/c/xxx (GPT 对话)
 *   - chatgpt.com/share/xxx 或 chatgpt.com/share/e/xxx (分享页面)
 *   - chat.openai.com (旧域名)
 */

class ChatGPTAdapter extends SiteAdapter {
    constructor() {
        super();
        // 内存文本缓存：nodeId → 提问文本（仅当前对话有效，切换对话 URL 时清空）
        // 新版虚拟化会把视口外轮次的 React 子树整体卸载（DOM/fiber 均无文本），
        // 只能在轮次渲染出来时缓存，空壳期回退缓存值
        this._turnTextCache = new Map();
        this._capturedMatchTexts = new Map();
        this._capturedTurns = [];
        this._capturedTotalMessages = 0;
        this._capturedOrderSignature = '';
        this._capturedComplete = false;
        this._capturedSource = 'none';
        this._capturedPageCount = 0;
        this._capturedRawMessages = 0;
        this._capturedDedupedMessages = 0;
        this._capturedVersion = 0;
        this._capturedPendingUserIds = new Set();
        this._domOnlyTurns = [];
        this._usesHeadingTurnSelector = false;
        this._capturedTextIds = new Set(); // 上一份 API 完整快照包含的消息 ID
        this._textCacheConvId = null; // 缓存所属的对话 id
        this._turnRolesDirty = true;
        this._usesVirtualizedTurnSelector = false;
        this._usesModernTurnSelector = false;
        // Exact DOM-observed virtual indices keyed by stable message aliases.
        // API message indexes and virtual item indexes are separate domains.
        this._virtualIndexByMessageId = new Map();
        // Stable message ID -> last DOM-observed scroll position. This lets a
        // manually visited turn remain reachable after React unmounts it.
        this._scrollPositionByMessageId = new Map();
        this._activeVirtualizerRequestId = null;
    }

    /**
     * 从 MAIN world 接口拦截模块（apiCapture/chatgpt.js）同步拉取
     * 当前对话的全量提问文本，同步进当前对话的内存缓存。
     *
     * 数据来源：模块在 document_start 补丁 fetch，捕获页面自己发起的
     * GET /backend-api/conversation/{id} 响应 mapping —— 这是唯一能让
     * 「从未渲染过的虚拟化轮次」在首次渲染时就有文案的数据源
     * （DOM/fiber 里物理不存在，调试探测已证实）。
     *
     * 同步事件往返，模块未就绪/未捕获到数据时静默返回，走既有降级链
     * （渲染期缓存 → 占位符）。切换对话时先拉取一次；如果接口稍后才完成，
     * 拦截模块会派发更新事件，由时间轴再次拉取，不做轮询。
     *
     * @returns {number} 本次发生变化的缓存条目数
     */
    _pullConvTexts(conversationId) {
        let received = null;
        const handler = (event) => {
            if (typeof event.detail !== 'string') return;
            try {
                const payload = JSON.parse(event.detail);
                if (payload?.conversationId === conversationId) received = payload;
            } catch {
                received = null;
            }
        };
        document.addEventListener('ait-gpt-user-texts-result', handler, { once: true });
        document.dispatchEvent(new CustomEvent('ait-gpt-user-texts-pull', {
            detail: conversationId
        }));
        document.removeEventListener('ait-gpt-user-texts-result', handler);

        const texts = received ? received.texts : null;
        const turns = Array.isArray(received?.turns) ? received.turns : [];
        window.AITGPTDiagnostics?.log('adapter.bridge-result', { responded: !!received, hasTexts: !!texts, textEntries: texts && typeof texts === 'object' ? Object.keys(texts).length : 0 });
        if (!texts) return 0;
        if (this._capturedComplete && received?.complete !== true) {
            window.AITGPTDiagnostics?.log('timeline.index-state', {
                conversationId, source: this._capturedSource, complete: true,
                users: this._capturedTurns.length, partialOverwritePrevented: true
            });
            return 0;
        }

        const nextTurns = turns.filter(turn => turn && typeof turn.id === 'string' && turn.id)
            .map((turn, index) => ({
                id: turn.id,
                nodeId: typeof turn.nodeId === 'string' ? turn.nodeId : '',
                messageId: typeof turn.messageId === 'string' ? turn.messageId : '',
                ids: Array.isArray(turn.ids) ? turn.ids.filter(id => typeof id === 'string' && id) : [],
                text: typeof turn.text === 'string' ? turn.text : '',
                messageIndex: Number.isFinite(turn.messageIndex) ? turn.messageIndex : index + 1,
                userOrder: Number.isFinite(turn.userOrder) ? turn.userOrder : index + 1,
                optimistic: turn.optimistic === true
            }));
        const nextSignature = nextTurns.map(turn => `${turn.id}:${turn.messageIndex}`).join('|');
        const completenessChanged = this._capturedComplete !== (received?.complete === true);

        const nextCapturedTextIds = new Set(Object.keys(texts));
        this._capturedMatchTexts = new Map(Object.entries(texts).filter(([, text]) => typeof text === 'string'));
        let changedCount = 0;
        // 只清理上一份 API 快照拥有、但最新快照已不存在的键。
        // DOM 机会性缓存的新增消息不在 _capturedTextIds 中，因此会被保留。
        this._capturedTextIds.forEach(id => {
            if (!nextCapturedTextIds.has(id) && this._turnTextCache.delete(id)) {
                changedCount++;
            }
        });
        Object.entries(texts).forEach(([id, txt]) => {
            const previous = this._turnTextCache.get(id);
            this._cacheTurnText(id, txt);
            if (this._turnTextCache.get(id) !== previous) changedCount++;
        });
        this._capturedTextIds = nextCapturedTextIds;
        if (nextSignature !== this._capturedOrderSignature) {
            changedCount++;
            this._domOnlyTurns = [];
            this._virtualIndexByMessageId.clear();
        }
        if (completenessChanged) changedCount++;
        this._capturedTurns = nextTurns;
        this._capturedTotalMessages = Number.isFinite(received?.totalMessages) ? received.totalMessages : 0;
        this._capturedOrderSignature = nextSignature;
        this._capturedComplete = received?.complete === true;
        this._capturedSource = typeof received?.source === 'string' ? received.source : 'captured-cache';
        this._capturedPageCount = Number.isFinite(received?.pageCount) ? received.pageCount : 0;
        this._capturedRawMessages = Number.isFinite(received?.rawMessages) ? received.rawMessages : 0;
        this._capturedDedupedMessages = Number.isFinite(received?.dedupedMessages) ? received.dedupedMessages : 0;
        this._capturedVersion = Number.isFinite(received?.version) ? received.version : this._capturedVersion + 1;
        this._capturedPendingUserIds = new Set(Array.isArray(received?.pendingUserIds) ? received.pendingUserIds : []);
        window.AITGPTDiagnostics?.log('timeline.index-state', {
            conversationId,
            source: this._capturedSource,
            complete: this._capturedComplete,
            pageCount: this._capturedPageCount,
            rawMessages: this._capturedRawMessages,
            dedupedMessages: this._capturedDedupedMessages,
            userTurns: nextTurns.length,
            firstUserId: received?.firstUserId || nextTurns[0]?.id || '',
            lastUserId: received?.lastUserId || nextTurns.at(-1)?.id || '',
            firstUserOrder: nextTurns[0]?.userOrder || 0,
            pendingUsers: this._capturedPendingUserIds.size,
            version: this._capturedVersion
        });
        if (window.AITGPTDiagnostics) {
            const elements = [
                ...this._getModernTurnRoots(),
                ...Array.from(document.querySelectorAll('[data-turn-id-container], [data-turn-id]'))
            ];
            const ids = new Set(elements.flatMap(el => this._getDomIdCandidates(el)).filter(Boolean));
            window.AITGPTDiagnostics.log('adapter.api-dom-id-match', { apiTextEntries: nextCapturedTextIds.size, domUniqueIds: ids.size, matchedIds: Array.from(ids).filter(id => nextCapturedTextIds.has(id)).length, changedCount });
        }
        return changedCount;
    }

    subscribeCapturedChatsDataUpdated(callback) {
        if (typeof callback !== 'function') return () => {};

        const handler = (event) => {
            const conversationId = typeof event.detail === 'string' ? event.detail : '';
            const changedCount = this.handleCapturedChatsDataUpdated(conversationId);
            if (changedCount > 0) callback({ conversationId, changedCount, rebuildMarkers: true });
        };
        document.addEventListener('ait-gpt-user-texts-updated', handler);
        return () => document.removeEventListener('ait-gpt-user-texts-updated', handler);
    }

    getConflictingTimelineSelectors() {
        return [
            '.chatgpt-timeline-bar',
            '*:has(> [data-toc-item-index])'
        ];
    }

    isPlaceholderSummary(text) {
        const normalized = String(text || '').trim();
        return super.isPlaceholderSummary(normalized)
            || normalized === '[未加载的提问]';
    }

    static TEXT_CACHE_MAX_TEXT_LENGTH = 200;
    static TEXT_CACHE_MAX_ENTRIES = 3000;
    static MODERN_TURN_SELECTOR = '[data-turn-key], [data-content-search-turn-key]';
    static MODERN_STRONG_ID_ATTRIBUTES = [
        'data-turn-key',
        'data-content-search-turn-key',
        'data-chatgpt-selection-message-id'
    ];
    static MODERN_WEAK_ID_ATTRIBUTES = [
        'data-dil-source-message-id',
        'data-dil-message-id'
    ];

    async matches(url) {
        return matchesPlatform(url, 'chatgpt');
    }

    /**
     * 【2026-07 ChatGPT 虚拟化改版】给轮次容器标记角色属性 data-ait-turn
     *
     * 新版结构：每轮对话包在 [data-turn-id-container][data-is-intersecting] 容器里
     * （已渲染轮次为外层 DIV 套内层 SECTION 双层同 id 容器，内部保留旧的 [data-turn] 元素；
     * 视口外轮次被虚拟化成空壳 DIV，内部无任何内容，无法直接得知是提问还是回复）。
     *
     * 标记算法（纯 DOM，幂等，可反复执行）：
     * 1. 取所有双属性容器，按 id 去重（文档序先外后内，保留外层）；
     * 2. 倒序遍历。最后一轮被 ChatGPT 强制渲染（fiber props 的 isFinalTurn/forceRender），
     *    链条必有真实锚点：已渲染轮次用后代 [data-turn] 的真实值（并重新校准链条），
     *    空壳取后一轮角色的反值（提问/回复严格交替）；
     * 3. 第一轮必须是提问：推断为回复时不打属性（ChatGPT 开头可能有隐藏占位轮，
     *    只跳过、绝不平移链条）。
     *
     * TimelineManager 仅在轮次结构变化时调用 prepareTimelineNodes() 重跑标记，
     * 避免 AI 流式回复期间对所有容器反复执行全量扫描。结构属性延迟挂载、
     * 新消息、重渲染和虚拟化窗口移动由结构 MutationObserver 统一置脏。
     *
     * @returns {boolean} - 页面是否存在新版容器结构
     */
    /**
     * 时间轴重建 markers 前准备当前对话的文本数据。
     * 仅在切换对话时失效缓存并从网络拦截桥拉取一次全量文本，避免
     * getUserMessageSelector 在初始化预检查阶段提前消费唯一一次拉取机会。
     *
     * 前提：时间轴渲染时拦截模块已完成拦截，故每个对话拉取一次即可，不做轮询/节流。
     * 未拉到时静默降级（渲染期缓存 → 占位符）。
     */
    syncCapturedChatsData() {
        const convId = this.extractConversationId(location.pathname);
        if (convId !== this._textCacheConvId) {
            // 切换对话：失效缓存归属
            this._textCacheConvId = convId;
            this._turnTextCache.clear();
            this._capturedTextIds.clear();
            this._capturedMatchTexts.clear();
            this._capturedTurns = [];
            this._capturedTotalMessages = 0;
            this._capturedOrderSignature = '';
            this._capturedComplete = false;
            this._capturedSource = 'none';
            this._capturedPageCount = 0;
            this._capturedRawMessages = 0;
            this._capturedDedupedMessages = 0;
            this._scrollPositionByMessageId.clear();
            this._capturedVersion = 0;
            this._capturedPendingUserIds.clear();
            this._domOnlyTurns = [];
            this._virtualIndexByMessageId.clear();
        } else if (this._capturedComplete && this._capturedTextIds.size > 0) {
            return; // 只有已确认完整的同一对话索引才能停止重拉
        }
        // 首次拉取，或上次拉取时接口尚未返回（SPA 切换时 pull 常早于响应，
        // 且「更新事件」可能落在时间轴销毁/重建的空窗被漏掉）→ 每次重建时廉价重试
        this._pullConvTexts(convId);
    }

    /**
     * 接口拦截完成后的事件入口。仅处理当前 URL 对应的对话；
     * 其他对话可能是 ChatGPT 预加载的数据，只保留在 MAIN world 分桶缓存中。
     *
     * @param {string} conversationId - 已完成缓存的对话 ID
     * @returns {number} 本次发生变化的缓存条目数
     */
    handleCapturedChatsDataUpdated(conversationId) {
        const currentConvId = this.extractConversationId(location.pathname);
        if (!conversationId || conversationId !== currentConvId) return 0;

        // 更新事件可能早于 TimelineManager 初始化，此时先建立正确的缓存归属。
        if (this._textCacheConvId !== conversationId) {
            this._textCacheConvId = conversationId;
            this._turnTextCache.clear();
            this._scrollPositionByMessageId.clear();
            this._capturedTextIds.clear();
            this._capturedMatchTexts.clear();
            this._capturedTurns = [];
            this._capturedTotalMessages = 0;
            this._capturedOrderSignature = '';
            this._capturedComplete = false;
            this._capturedSource = 'none';
            this._capturedPageCount = 0;
            this._capturedRawMessages = 0;
            this._capturedDedupedMessages = 0;
            this._capturedVersion = 0;
            this._capturedPendingUserIds.clear();
            this._domOnlyTurns = [];
        }

        return this._pullConvTexts(conversationId);
    }

    _parseDomIdValue(value) {
        const result = [];
        const add = candidate => {
            const text = typeof candidate === 'string' ? candidate.trim() : '';
            if (text && !result.includes(text)) result.push(text);
        };
        const visit = candidate => {
            if (typeof candidate === 'string') { add(candidate); return; }
            if (Array.isArray(candidate)) { candidate.forEach(visit); return; }
            if (candidate && typeof candidate === 'object') Object.values(candidate).forEach(visit);
        };
        const text = typeof value === 'string' ? value.trim() : '';
        if (!text) return result;
        add(text);
        let parsedStructuredValue = false;
        if (/^[\[{]/.test(text)) {
            try { visit(JSON.parse(text)); parsedStructuredValue = true; } catch {}
        }
        if (!parsedStructuredValue) text.split(/[\s,;|:/]+/).forEach(add);
        for (const match of text.matchAll(/[0-9a-f]{8}-[0-9a-f-]{10,}/ig)) add(match[0]);
        return result;
    }

    _getAttributeIdCandidates(element, attributes) {
        if (!element) return [];
        const result = [];
        const add = value => this._parseDomIdValue(value).forEach(id => {
            if (!result.includes(id)) result.push(id);
        });
        const nodes = [element, ...Array.from(element.querySelectorAll?.(attributes.map(name => `[${name}]`).join(',')) || [])];
        nodes.forEach(node => attributes.forEach(name => add(node.getAttribute?.(name))));
        return result;
    }

    _getDomIdCandidates(element, { includeWeak = true } = {}) {
        const attributes = [
            'data-message-id',
            'data-turn-id',
            'data-turn-id-container',
            ...ChatGPTAdapter.MODERN_STRONG_ID_ATTRIBUTES,
            ...(includeWeak ? ChatGPTAdapter.MODERN_WEAK_ID_ATTRIBUTES : [])
        ];
        return this._getAttributeIdCandidates(element, attributes);
    }

    _getModernTurnRoots(scope = document) {
        const raw = Array.from(scope.querySelectorAll?.(ChatGPTAdapter.MODERN_TURN_SELECTOR) || []);
        const roots = [];
        const seen = new Set();
        raw.forEach(candidate => {
            const root = candidate.closest?.('[data-turn-key]') || candidate;
            if (!root?.isConnected || seen.has(root)) return;
            if (root.closest('form, nav, aside, [data-composer-input], .ProseMirror, .ait-chat-timeline-wrapper')) return;
            const parentTurn = root.parentElement?.closest?.(ChatGPTAdapter.MODERN_TURN_SELECTOR);
            if (parentTurn && parentTurn !== root) return;
            seen.add(root);
            roots.push(root);
        });
        return roots;
    }

    _getModernRoleIdCandidates(root) {
        if (!root) return [];
        const ids = [];
        const add = value => this._parseDomIdValue(value).forEach(id => {
            if (!ids.includes(id)) ids.push(id);
        });
        ['data-turn-key', 'data-content-search-turn-key', 'data-chatgpt-selection-message-id']
            .forEach(name => add(root.getAttribute?.(name)));
        Array.from(root.querySelectorAll?.('[data-chatgpt-selection-message-id]') || []).forEach(node => {
            const owner = this._getOwningModernTurnRoot(node);
            if (owner === root) add(node.getAttribute?.('data-chatgpt-selection-message-id'));
        });
        // Search-message IDs describe sources/quotes and commonly put a user
        // message ID inside an assistant response. They are never identities.
        return ids;
    }

    _getOwningModernTurnRoot(node) {
        let owner = node?.closest?.(ChatGPTAdapter.MODERN_TURN_SELECTOR) || null;
        while (owner) {
            const parentOwner = owner.parentElement?.closest?.(ChatGPTAdapter.MODERN_TURN_SELECTOR);
            if (!parentOwner) break;
            owner = parentOwner;
        }
        return owner;
    }

    _markModernTurnRoles() {
        const roots = this._getModernTurnRoots();
        if (!roots.length) return { found: false, matchedUsers: 0 };
        const capturedUserIds = new Set(this._capturedTurns.flatMap(turn =>
            [turn.id, turn.nodeId, turn.messageId, ...(turn.ids || [])].filter(Boolean)
        ));
        let matchedUsers = 0;
        roots.forEach(root => {
            const strongIds = this._getModernRoleIdCandidates(root);
            const isUser = strongIds.some(id => capturedUserIds.has(id));
            if (isUser) {
                root.setAttribute('data-ait-turn', 'user');
                matchedUsers++;
            } else if (root.getAttribute('data-ait-turn') === 'user') {
                root.removeAttribute('data-ait-turn');
            }
        });
        return { found: true, matchedUsers };
    }

    _markTurnRoles() {
        const all = document.querySelectorAll('[data-turn-id-container]');
        if (!all.length) return false;

        // 按 id 去重，保留外层容器
        const seen = new Set();
        const containers = [];
        all.forEach(el => {
            const id = el.getAttribute('data-turn-id-container');
            if (!id || seen.has(id)) return;
            seen.add(id);
            containers.push(el);
        });

        // 倒序推导每个容器的角色
        const roles = new Array(containers.length).fill(null);
        const capturedUserIds = new Set(this._capturedTurns.flatMap(turn => [turn.id, turn.nodeId, turn.messageId, ...(turn.ids || [])].filter(Boolean)));
        let nextRole = null; // 后一个（更靠下）容器的角色
        for (let i = containers.length - 1; i >= 0; i--) {
            const real = containers[i].querySelector('[data-turn]')?.getAttribute('data-turn');
            const containerId = containers[i].getAttribute('data-turn-id-container');
            let role = capturedUserIds.has(containerId)
                ? 'user'
                : (real === 'user' || real === 'assistant') ? real : null;
            if (!role && nextRole) {
                role = (nextRole === 'user') ? 'assistant' : 'user';
            }
            roles[i] = role;
            if (role) nextRole = role;
        }

        // 第一轮推断为回复时不标记
        if (roles[0] === 'assistant') roles[0] = null;

        containers.forEach((el, i) => {
            const role = roles[i];
            // 机会性填充文本缓存：轮次只要渲染出来过，就在标记周期里把提问文本存住。
            // 不能依赖 extractText（只在 markers 重建时被调用）：滚动渲染不触发重建，
            // 等到重建时轮次可能已被虚拟化回空壳，文本就永远缓存不上了（调试日志实证）。
            if (role === 'user') {
                const id = el.getAttribute('data-turn-id-container');
                if (id && !this._turnTextCache.has(id)) {
                    const raw = el.querySelector('.whitespace-pre-wrap')?.textContent;
                    const text = (raw || '').replace(/\s+/g, ' ').trim();
                    if (text) this._cacheTurnText(id, text);
                }
            }
            if (role) {
                if (el.getAttribute('data-ait-turn') !== role) {
                    el.setAttribute('data-ait-turn', role);
                }
            } else if (el.hasAttribute('data-ait-turn')) {
                el.removeAttribute('data-ait-turn');
            }
        });
        return true;
    }

    prepareTimelineNodes(context = {}) {
        if (!context.force && !this._turnRolesDirty) return false;

        const modern = this._markModernTurnRoles();
        this._usesModernTurnSelector = modern.found;
        const hasVirtualizedTurns = this._markTurnRoles();
        this._usesVirtualizedTurnSelector = !this._usesModernTurnSelector && hasVirtualizedTurns
            && document.querySelector('[data-turn-id-container][data-ait-turn="user"]') !== null;
        this._usesHeadingTurnSelector = !this._usesModernTurnSelector && !this._usesVirtualizedTurnSelector
            && !document.querySelector('[data-turn="user"][data-turn-id]') && !!window.AITChatGPTRolloutDOM?.markTurns();
        this._turnRolesDirty = false;
        window.AITGPTDiagnostics?.log('timeline.init-stage', {
            stage: 'adapter-prepared', modernTurns: this._getModernTurnRoots().length,
            modernUsers: modern.matchedUsers, apiUsers: this._capturedTurns.length,
            legacyVirtual: this._usesVirtualizedTurnSelector, headings: this._usesHeadingTurnSelector
        });
        return true;
    }

    invalidateTimelineNodes() {
        this._turnRolesDirty = true;
    }

    getTimelineStructureSelectors() {
        return [
            '[data-turn-key]',
            '[data-content-search-turn-key]',
            '[data-chatgpt-selection-message-id]',
            '[data-turn-id-container]',
            '[data-turn]',
            ...(window.AITChatGPTRolloutDOM ? ['h4.sr-only', '*:has(> h4.sr-only)'] : [])
        ];
    }

    getTimelineStructureAttributeFilter() {
        return [
            'data-turn-key',
            'data-content-search-turn-key',
            'data-chatgpt-selection-message-id',
            'data-chatgpt-search-message-ids',
            'data-turn-id-container',
            'data-is-intersecting',
            'data-turn'
        ];
    }

    getUserMessageSelector() {
        if (this._usesModernTurnSelector) return '[data-turn-key][data-ait-turn="user"], [data-content-search-turn-key][data-ait-turn="user"]';
        if (this._usesHeadingTurnSelector) return '[data-ait-heading-turn="user"]';
        // prepareTimelineNodes() 负责维护模式；getter 保持无副作用。
        if (this._usesVirtualizedTurnSelector) {
            return '[data-turn-id-container][data-ait-turn="user"]';
        }
        return '[data-turn="user"][data-turn-id]';
    }

    getAssistantMessageSelector() {
        if (this._usesHeadingTurnSelector) return '[data-ait-heading-turn="assistant"]';
        if (document.querySelector('[data-turn-id-container][data-ait-turn="assistant"]')) {
            return '[data-turn-id-container][data-ait-turn="assistant"]';
        }
        return '[data-turn="assistant"][data-turn-id]';
    }

    hasTimelineData() {
        return this._capturedComplete && this._capturedTurns.length > 0;
    }

    getTimelineIndexDiagnostics() {
        return {
            conversationId: this._textCacheConvId || this.extractConversationId(location.pathname) || '',
            source: this._capturedSource,
            complete: this._capturedComplete,
            pageCount: this._capturedPageCount,
            rawMessages: this._capturedRawMessages,
            dedupedMessages: this._capturedDedupedMessages,
            userTurns: this._capturedTurns.length,
            firstUserId: this._capturedTurns[0]?.id || '',
            lastUserId: this._capturedTurns.at(-1)?.id || '',
            firstUserOrder: this._capturedTurns[0]?.userOrder || 0,
            pendingUsers: this._capturedPendingUserIds.size,
            version: this._capturedVersion
        };
    }

    getTimelineInitializationState() {
        const selector = this.getUserMessageSelector();
        const userDom = !!(selector && document.querySelector(selector));
        const apiIndex = this.hasTimelineData();
        const anchor = this.getInitializationAnchor();
        return {
            selector,
            userDom,
            apiIndex,
            anchor,
            ready: userDom || apiIndex || !!anchor,
            reason: userDom ? 'user-dom' : apiIndex ? 'api-index' : anchor ? 'turn-anchor' : 'none'
        };
    }

    getInitializationAnchor() {
        return document.querySelector(this.getUserMessageSelector())
            || this._getModernTurnRoots()[0]
            || document.querySelector('[data-turn-id-container], [data-turn-id], [data-message-id], [data-testid^="conversation-turn-"]');
    }

    /**
     * Build the ChatGPT marker source from the captured active branch. DOM nodes
     * are attached opportunistically; an entry remains valid while its turn is
     * outside the virtualized render window.
     */
    getTimelineEntries(userTurnElements = []) {
        // ChatGPT DOM is only a virtual render window. Never let it define Q1 or
        // the total node count; wait for a confirmed complete API index.
        if (!this._capturedComplete) return [];

        const elements = Array.from(userTurnElements || []);
        const domById = new Map();
        elements.forEach(element => {
            this._getDomIdCandidates(element).forEach(id => {
                if (!domById.has(id)) domById.set(id, element);
            });
        });

        const entries = this._capturedTurns.map((turn, index) => {
            const aliases = Array.from(new Set([turn.id, turn.nodeId, turn.messageId, ...(turn.ids || [])].filter(Boolean)));
            const element = aliases.map(id => domById.get(id)).find(Boolean) || null;
            const summary = turn.text || aliases.map(id => this._turnTextCache.get(id)).find(Boolean) || '[未加载的提问]';
            return {
                id: `chatgpt-${turn.id}`,
                sourceId: turn.id,
                aliasIds: aliases,
                element,
                summary,
                messageId: turn.messageId || turn.id,
                messageIndex: turn.messageIndex,
                totalMessages: this._capturedTotalMessages,
                userOrder: turn.userOrder || index + 1,
                optimistic: turn.optimistic === true,
                virtual: !element
            };
        });

        return entries;
    }

    _getMarkerAliasIds(marker) {
        return Array.from(new Set([
            marker?.sourceId,
            marker?.messageId,
            ...(marker?.aliasIds || [])
        ].filter(Boolean)));
    }

    _elementMatchesMarker(element, marker) {
        if (!element?.isConnected) return false;
        const ids = this._getMarkerAliasIds(marker);
        if (!ids.length) return false;
        const elementIds = element.matches?.(ChatGPTAdapter.MODERN_TURN_SELECTOR)
            ? this._getModernRoleIdCandidates(element)
            : this._getDomIdCandidates(element);
        if (!elementIds.some(id => ids.includes(id))) return false;
        const assistantEvidence = element.matches?.('[data-turn="assistant"], [data-message-author-role="assistant"]')
            || element.querySelector?.('[data-turn="assistant"], [data-message-author-role="assistant"]');
        const userEvidence = element.matches?.('[data-turn="user"], [data-message-author-role="user"], [data-ait-turn="user"]')
            || element.querySelector?.('[data-turn="user"], [data-message-author-role="user"]');
        return !assistantEvidence || !!userEvidence;
    }

    _isRenderedMessageElement(element) {
        if (!element?.isConnected) return false;
        const hasRenderedBox = node => {
            if (!node) return false;
            if (typeof node.getBoundingClientRect !== 'function') return true;
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };
        const attachmentSelector = [
            'img', 'video', 'audio', 'canvas', 'button', 'a', '[role="button"]',
            '[data-attachment-kind]', '[data-file-id]', '[data-asset-id]',
            '[data-testid*="attachment"]', '[data-testid*="file"]', '[data-testid*="image"]'
        ].join(',');
        const attachments = [
            ...(element.matches?.(attachmentSelector) ? [element] : []),
            ...Array.from(element.querySelectorAll?.(attachmentSelector) || [])
        ];
        if (attachments.some(hasRenderedBox)) return true;

        // Identity attributes locate a turn, but do not prove that React has
        // rendered its content. Require laid-out content with real text so a
        // virtual spacer shell cannot become a successful jump target.
        const contentSelector = [
            '[data-chatgpt-selection-message-id]', '[data-message-id]',
            '[data-message-author-role="user"]', '[data-turn="user"]',
            '.markdown', '.whitespace-pre-wrap'
        ].join(',');
        const contentNodes = [
            ...(element.matches?.(contentSelector) ? [element] : []),
            ...Array.from(element.querySelectorAll?.(contentSelector) || [])
        ];
        return contentNodes.some(node => hasRenderedBox(node)
            && !!String(node.textContent || element.textContent || '').trim());
    }

    _readDomVirtualIndex(element) {
        if (!element) return null;
        const candidates = [];
        let current = element;
        for (let depth = 0; current && depth < 5; depth++, current = current.parentElement) candidates.push(current);
        const indexed = element.querySelector?.('[data-index], [aria-posinset]');
        if (indexed) candidates.push(indexed);
        for (const candidate of candidates) {
            const dataIndex = Number.parseInt(candidate.getAttribute?.('data-index'), 10);
            if (Number.isFinite(dataIndex) && dataIndex >= 0) return dataIndex;
            const ariaPosition = Number.parseInt(candidate.getAttribute?.('aria-posinset'), 10);
            if (Number.isFinite(ariaPosition) && ariaPosition > 0) return ariaPosition - 1;
            const testId = candidate.getAttribute?.('data-testid') || '';
            const match = testId.match(/conversation-turn-(\d+)/i);
            if (match) return Math.max(0, Number(match[1]) - 1);
        }
        return null;
    }

    _recordVirtualIndex(element, marker) {
        const domIndex = this._readDomVirtualIndex(element);
        if (!Number.isFinite(domIndex)) return null;
        this._getMarkerAliasIds(marker).forEach(id => this._virtualIndexByMessageId.set(id, domIndex));
        return domIndex;
    }

    resolveTimelineElement(marker, { allowPlaceholder = false } = {}) {
        if (this._elementMatchesMarker(marker?.element, marker)
            && (allowPlaceholder || this._isRenderedMessageElement(marker.element))) {
            this._recordVirtualIndex(marker.element, marker);
            return marker.element;
        }
        if (marker) marker.element = null;
        const ids = this._getMarkerAliasIds(marker);
        if (!ids.length) return null;
        const candidates = [
            ...this._getModernTurnRoots(),
            ...Array.from(document.querySelectorAll('[data-turn-id-container], [data-turn-id], [data-message-id]'))
        ];
        for (const candidate of candidates) {
            const candidateIds = candidate.matches?.(ChatGPTAdapter.MODERN_TURN_SELECTOR)
                ? this._getModernRoleIdCandidates(candidate)
                : this._getDomIdCandidates(candidate);
            if (candidateIds.some(id => id && ids.includes(id))) {
                const matched = candidate.closest('[data-turn-key][data-ait-turn="user"], [data-content-search-turn-key][data-ait-turn="user"], [data-turn-id-container][data-ait-turn="user"], [data-turn="user"][data-turn-id]') || candidate;
                if (this._elementMatchesMarker(matched, marker)
                    && (allowPlaceholder || this._isRenderedMessageElement(matched))) {
                    this._recordVirtualIndex(matched, marker);
                    return matched;
                }
            }
        }
        return null;
    }

    _findIdentityAnchor(marker) {
        if (this._elementMatchesMarker(marker?.element, marker)) return marker.element;
        const ids = this._getMarkerAliasIds(marker);
        if (!ids.length) return null;
        const candidates = [
            ...this._getModernTurnRoots(),
            ...Array.from(document.querySelectorAll?.('[data-turn-id-container], [data-turn-id], [data-message-id]') || [])
        ];
        return candidates.find(candidate => this._elementMatchesMarker(candidate, marker)) || null;
    }

    getActiveTimelineMarkerId(scrollContainer, markers, activateAhead = 120) {
        if (!scrollContainer || !Array.isArray(markers) || !markers.length) return null;
        const containerRect = scrollContainer.getBoundingClientRect();
        const threshold = containerRect.top + activateAhead;
        const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
        const currentScrollTop = scrollContainer.scrollTop || 0;
        const markerByAlias = new Map();
        markers.forEach(marker => {
            [marker.sourceId, marker.messageId, ...(marker.aliasIds || [])]
                .filter(Boolean)
                .forEach(id => markerByAlias.set(id, marker));
        });
        let firstMounted = null;
        let active = null;
        const mounted = Array.from(document.querySelectorAll(this.getUserMessageSelector()));
        mounted.forEach(element => {
            const ids = this._getDomIdCandidates(element);
            const marker = ids.map(id => markerByAlias.get(id)).find(Boolean);
            if (!marker || !element.isConnected) return;
            marker.element = element;
            marker.virtual = false;
            if (!firstMounted) firstMounted = marker.id;
            const rect = this.getTimelineMessageRect(element) || element.getBoundingClientRect();
            if (this._isRenderedMessageElement(element)
                && (rect.height > 0 || rect.bottom > rect.top)) {
                const top = Math.max(0, currentScrollTop + rect.top - containerRect.top);
                this._getMarkerAliasIds(marker).forEach(id => this._scrollPositionByMessageId.set(id, {
                    top, maxScrollTop, userOrder: marker.userOrder || 0
                }));
            }
            if (rect.top <= threshold) active = marker.id;
        });
        return active || firstMounted;
    }

    _getCachedScrollPosition(marker, scrollContainer) {
        const cached = this._getMarkerAliasIds(marker)
            .map(id => this._scrollPositionByMessageId.get(id)).find(Boolean);
        if (!cached || !Number.isFinite(cached.top)) return null;
        const currentMax = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
        if (!(currentMax > 0)) return null;
        const scaledTop = cached.maxScrollTop > 0
            ? cached.top * (currentMax / cached.maxScrollTop) : cached.top;
        return Math.max(0, Math.min(currentMax, scaledTop));
    }

    _getMountedUserOrderRange(scrollContainer = null) {
        const orderByAlias = new Map();
        this._capturedTurns.forEach(turn => {
            [turn.id, turn.nodeId, turn.messageId, ...(turn.ids || [])].filter(Boolean)
                .forEach(id => orderByAlias.set(id, turn.userOrder));
        });
        const anchors = [];
        const containerRect = scrollContainer?.getBoundingClientRect?.() || { top: 0 };
        const scrollTop = scrollContainer?.scrollTop || 0;
        const roots = [
            ...this._getModernTurnRoots(),
            ...Array.from(document.querySelectorAll?.('[data-turn-id-container], [data-turn-id], [data-message-id]') || [])
        ];
        roots.forEach(element => {
            if (!element?.isConnected || !this._isRenderedMessageElement(element)) return;
            const ids = element.matches?.(ChatGPTAdapter.MODERN_TURN_SELECTOR)
                ? this._getModernRoleIdCandidates(element) : this._getDomIdCandidates(element, { includeWeak: false });
            const order = ids.map(id => orderByAlias.get(id)).find(Number.isFinite);
            if (!Number.isFinite(order)) return;
            const rect = this.getTimelineMessageRect(element) || element.getBoundingClientRect?.();
            if (!rect) return;
            anchors.push({ order, top: Math.max(0, scrollTop + rect.top - containerRect.top) });
        });
        const unique = Array.from(new Map(anchors
            .sort((a, b) => a.order - b.order)
            .map(anchor => [anchor.order, anchor])).values());
        return unique.length ? {
            min: unique[0].order,
            max: unique[unique.length - 1].order,
            anchors: unique
        } : null;
    }

    async _tryKnownTimelinePosition(marker, context) {
        const isCurrent = typeof context.isCurrent === 'function' ? context.isCurrent : () => true;
        const scrollContainer = context.scrollContainer;
        if (!isCurrent() || !scrollContainer) return null;

        const identityAnchor = this._findIdentityAnchor(marker);
        if (identityAnchor && !this._isRenderedMessageElement(identityAnchor)
            && typeof identityAnchor.scrollIntoView === 'function') {
            try {
                identityAnchor.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
            } catch {
                identityAnchor.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
            }
            const waited = await this._waitForMarkerMount(marker, context, 750);
            if (!isCurrent()) return null;
            if (waited.element) return waited.element;
        }

        const cachedTop = this._getCachedScrollPosition(marker, scrollContainer);
        if (!Number.isFinite(cachedTop)) return null;
        scrollContainer.scrollTop = cachedTop;
        this._navigationDiagnostic('scroll-state-changed', marker, context, {
            strategy: 'cached-dom-scroll-position'
        });
        const waited = await this._waitForMarkerMount(marker, context, 850);
        return isCurrent() ? waited.element : null;
    }

    async _fallbackScrollByUserOrder(marker, context, restoreTop = null) {
        const isCurrent = typeof context.isCurrent === 'function' ? context.isCurrent : () => true;
        const scrollContainer = context.scrollContainer;
        const userOrder = Number(marker?.userOrder);
        const totalUsers = this._capturedTurns.length;
        const maxScrollTop = scrollContainer
            ? Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight) : 0;
        if (!isCurrent() || !scrollContainer || !(maxScrollTop > 0)
            || !(userOrder > 0) || totalUsers < 2) return null;

        const originalTop = Number.isFinite(restoreTop) ? restoreTop : (scrollContainer.scrollTop || 0);
        let lowerTop = 0;
        let upperTop = maxScrollTop;
        let nextTop = ((userOrder - 1) / (totalUsers - 1)) * maxScrollTop;
        const visited = new Set();
        let attempts = 0;
        for (let attempt = 0; attempt < 8 && isCurrent(); attempt++) {
            attempts = attempt + 1;
            const boundedTop = Math.max(lowerTop, Math.min(upperTop, nextTop));
            const key = Math.round(boundedTop / 4);
            if (visited.has(key)) break;
            visited.add(key);
            scrollContainer.scrollTop = boundedTop;
            this._navigationDiagnostic('scroll-state-changed', marker, context, {
                strategy: attempt === 0 ? 'bounded-scroll-ratio' : 'directional-local-correction',
                attempt: attempt + 1
            });
            const waited = await this._waitForMarkerMount(marker, context, attempt === 0 ? 800 : 550);
            if (!isCurrent()) return null;
            if (waited.element) return waited.element;

            const range = this._getMountedUserOrderRange(scrollContainer);
            if (!range) break;
            if (userOrder < range.min) {
                upperTop = Math.min(upperTop, boundedTop - 1);
            } else if (userOrder > range.max) {
                lowerTop = Math.max(lowerTop, boundedTop + 1);
            } else {
                const left = [...range.anchors].reverse().find(anchor => anchor.order < userOrder);
                const right = range.anchors.find(anchor => anchor.order > userOrder);
                if (!left || !right || right.order === left.order) break;
                lowerTop = Math.max(lowerTop, Math.min(left.top, right.top));
                upperTop = Math.min(upperTop, Math.max(left.top, right.top));
            }
            if (upperTop - lowerTop < 8) break;

            let projected = NaN;
            if (range.anchors.length >= 2) {
                const first = range.anchors[0];
                const last = range.anchors[range.anchors.length - 1];
                if (last.order !== first.order && last.top !== first.top) {
                    projected = first.top + ((userOrder - first.order) / (last.order - first.order))
                        * (last.top - first.top);
                }
            }
            const midpoint = lowerTop + (upperTop - lowerTop) / 2;
            nextTop = Number.isFinite(projected) && projected > lowerTop + 4 && projected < upperTop - 4
                ? projected : midpoint;
        }
        if (isCurrent()) scrollContainer.scrollTop = Math.max(0, Math.min(maxScrollTop, originalTop));
        this._navigationDiagnostic('target-identity-failed', marker, context, {
            strategy: 'bounded-evidence-search', reason: 'bounded-search-exhausted', attempts
        });
        return null;
    }

    _buildVirtualIndexPlan(marker) {
        const targetAliases = this._getMarkerAliasIds(marker);
        const exact = targetAliases.map(id => this._virtualIndexByMessageId.get(id)).find(Number.isFinite);
        if (Number.isFinite(exact)) {
            return { index: exact, strategy: 'cached-exact-dom-index', mappingVerified: true,
                observedIndices: [], targetIds: targetAliases };
        }

        const targetAnchor = this._findIdentityAnchor(marker);
        const targetAnchorIndex = this._readDomVirtualIndex(targetAnchor);
        if (Number.isFinite(targetAnchorIndex)) {
            targetAliases.forEach(id => this._virtualIndexByMessageId.set(id, targetAnchorIndex));
            return { index: targetAnchorIndex, strategy: 'target-placeholder-index', mappingVerified: true,
                observedIndices: [targetAnchorIndex], targetIds: targetAliases };
        }

        const turnByAlias = new Map();
        this._capturedTurns.forEach(turn => {
            [turn.id, turn.nodeId, turn.messageId, ...(turn.ids || [])].filter(Boolean)
                .forEach(id => turnByAlias.set(id, turn));
        });
        const anchors = [];
        const roots = [
            ...this._getModernTurnRoots(),
            ...Array.from(document.querySelectorAll?.('[data-turn-id-container], [data-turn-id], [data-message-id]') || [])
        ];
        const seen = new Set();
        roots.forEach(element => {
            if (!element?.isConnected || seen.has(element)) return;
            seen.add(element);
            const virtualIndex = this._readDomVirtualIndex(element);
            if (!Number.isFinite(virtualIndex)) return;
            const ids = element.matches?.(ChatGPTAdapter.MODERN_TURN_SELECTOR)
                ? this._getModernRoleIdCandidates(element) : this._getDomIdCandidates(element, { includeWeak: false });
            const turn = ids.map(id => turnByAlias.get(id)).find(Boolean);
            if (!turn || !Number.isFinite(turn.userOrder)) return;
            const aliases = [turn.id, turn.nodeId, turn.messageId, ...(turn.ids || [])].filter(Boolean);
            aliases.forEach(id => this._virtualIndexByMessageId.set(id, virtualIndex));
            anchors.push({ virtualIndex, userOrder: turn.userOrder });
        });

        const cachedAfterObservation = targetAliases.map(id => this._virtualIndexByMessageId.get(id)).find(Number.isFinite);
        if (Number.isFinite(cachedAfterObservation)) {
            return { index: cachedAfterObservation, strategy: 'exact-dom-index', mappingVerified: true,
                observedIndices: anchors.map(anchor => anchor.virtualIndex), targetIds: targetAliases };
        }
        const userOrder = Number(marker?.userOrder);
        const sortedAnchors = Array.from(new Map(anchors
            .sort((a, b) => a.userOrder - b.userOrder)
            .map(anchor => [anchor.userOrder, anchor])).values());
        if (Number.isFinite(userOrder) && userOrder > 0) {
            for (let index = 0; index < sortedAnchors.length - 1; index++) {
                const left = sortedAnchors[index];
                const right = sortedAnchors[index + 1];
                const orderSpan = right.userOrder - left.userOrder;
                const indexSpan = right.virtualIndex - left.virtualIndex;
                if (orderSpan <= 0 || indexSpan <= 0) continue;
                const slope = indexSpan / orderSpan;
                const inside = userOrder >= left.userOrder && userOrder <= right.userOrder;
                const distance = userOrder < left.userOrder ? left.userOrder - userOrder
                    : userOrder > right.userOrder ? userOrder - right.userOrder : 0;
                if (!inside && distance > 3) continue;
                const projected = left.virtualIndex + (userOrder - left.userOrder) * slope;
                if (Math.abs(projected - Math.round(projected)) > 0.001 || slope > 4) continue;
                return {
                    index: Math.round(projected),
                    strategy: inside ? 'verified-anchor-interpolation' : 'bounded-local-extrapolation',
                    mappingVerified: true,
                    observedIndices: sortedAnchors.map(anchor => anchor.virtualIndex),
                    targetIds: targetAliases
                };
            }
        }

        // No API-index assumption is made here. The page-world bridge first
        // tries virtual item keys; only then may it use its own item count for
        // one bounded ratio estimate followed by strict DOM-ID verification.
        return {
            index: null,
            strategy: 'virtual-item-key-or-bounded-ratio',
            mappingVerified: false,
            observedIndices: anchors.map(anchor => anchor.virtualIndex),
            targetIds: targetAliases
        };
    }

    _navigationDiagnostic(stage, marker, context = {}, data = {}) {
        window.AITGPTDiagnostics?.log('timeline.navigation', {
            stage,
            taskId: context.taskId || 0,
            userOrder: marker?.userOrder || 0,
            ...data
        });
    }

    cancelPendingTimelineJump(reason = 'superseded') {
        const requestId = this._activeVirtualizerRequestId;
        document.dispatchEvent(new CustomEvent('ait-gpt-virtualizer-jump-cancel', {
            detail: JSON.stringify(requestId ? { requestId, all: true, reason } : { all: true, reason })
        }));
        this._activeVirtualizerRequestId = null;
    }

    _requestVirtualizerJump(plan, marker, context = {}, timeoutMs = 1300) {
        const requestId = `ait-timeline-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        this._activeVirtualizerRequestId = requestId;
        const issuedAt = Date.now();
        this._navigationDiagnostic('virtualizer-discovery-start', marker, context, { strategy: plan.strategy });
        this._navigationDiagnostic('bridge-command-issued', marker, context, { strategy: plan.strategy });
        const resultPromise = new Promise(resolve => {
            const timeout = setTimeout(() => {
                document.removeEventListener('ait-gpt-virtualizer-jump-result', handler);
                document.dispatchEvent(new CustomEvent('ait-gpt-virtualizer-jump-cancel', {
                    detail: JSON.stringify({ requestId })
                }));
                if (this._activeVirtualizerRequestId === requestId) this._activeVirtualizerRequestId = null;
                const result = { ok: false, reason: 'bridge-timeout', failureStage: 'bridge', bridgeMs: Date.now() - issuedAt };
                this._navigationDiagnostic('virtualizer-discovery-end', marker, context, {
                    found: false, elapsedMs: result.bridgeMs, reason: result.reason
                });
                this._navigationDiagnostic('virtualizer-validation-result', marker, context, {
                    passed: false, reason: result.reason
                });
                this._navigationDiagnostic('bridge-command-result', marker, context, result);
                resolve(result);
            }, timeoutMs);
            const handler = event => {
                let result = null;
                try { result = JSON.parse(typeof event.detail === 'string' ? event.detail : '{}'); } catch {}
                if (result?.requestId !== requestId) return;
                clearTimeout(timeout);
                document.removeEventListener('ait-gpt-virtualizer-jump-result', handler);
                if (this._activeVirtualizerRequestId === requestId) this._activeVirtualizerRequestId = null;
                this._navigationDiagnostic('virtualizer-discovery-end', marker, context, {
                    found: result?.failureStage !== 'discovery',
                    elapsedMs: Math.round(result?.discoveryMs || 0),
                    scannedObjects: result?.scannedObjects || 0,
                    cached: !!result?.cachedController
                });
                this._navigationDiagnostic('virtualizer-validation-result', marker, context, {
                    passed: !!result?.controllerValidated,
                    strategy: result?.ownershipStrategy || '',
                    reason: result?.failureStage === 'validation' ? result?.reason || 'validation-failed' : ''
                });
                this._navigationDiagnostic('bridge-command-result', marker, context, {
                    ok: !!result?.ok,
                    reason: result?.reason || '',
                    failureStage: result?.failureStage || '',
                    strategy: result?.indexStrategy || plan.strategy,
                    discoveryMs: Math.round(result?.discoveryMs || 0),
                    bridgeMs: Math.round(result?.bridgeMs || (Date.now() - issuedAt)),
                    stateChanged: !!result?.stateChanged
                });
                resolve(result);
            };
            document.addEventListener('ait-gpt-virtualizer-jump-result', handler);
        });
        document.dispatchEvent(new CustomEvent('ait-gpt-virtualizer-jump', {
            detail: JSON.stringify({
                requestId,
                index: Number.isFinite(plan.index) ? plan.index : null,
                strategy: plan.strategy,
                mappingVerified: plan.mappingVerified === true,
                observedIndices: Array.from(new Set(plan.observedIndices || [])).slice(0, 20),
                targetIds: Array.from(new Set(plan.targetIds || [])).slice(0, 8),
                targetUserOrder: marker?.userOrder || 0,
                totalUserTurns: this._capturedTurns.length,
                taskId: context.taskId || 0,
                deadlineMs: Math.max(250, timeoutMs - 100)
            })
        }));
        return resultPromise;
    }

    _waitForMarkerMount(marker, context, timeoutMs = 750) {
        const isCurrent = typeof context.isCurrent === 'function' ? context.isCurrent : () => true;
        const startedAt = Date.now();
        const immediate = this.resolveTimelineElement(marker);
        if (immediate) return Promise.resolve({ element: immediate, mountMs: 0, mutations: 0 });
        return new Promise(resolve => {
            let settled = false;
            let mutations = 0;
            let observer = null;
            const finish = element => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { observer?.disconnect(); } catch {}
                resolve({ element: element || null, mountMs: Date.now() - startedAt, mutations });
            };
            const check = () => {
                if (!isCurrent()) { finish(null); return; }
                const element = this.resolveTimelineElement(marker);
                if (!element) return;
                const settle = () => finish(this.resolveTimelineElement(marker));
                if (typeof requestAnimationFrame === 'function') requestAnimationFrame(settle);
                else settle();
            };
            const timer = setTimeout(() => finish(isCurrent() ? this.resolveTimelineElement(marker) : null), timeoutMs);
            if (typeof MutationObserver === 'function') {
                observer = new MutationObserver(records => {
                    mutations += records?.length || 1;
                    check();
                });
                try {
                    observer.observe(context.conversationContainer || document.body || document.documentElement,
                        { childList: true, subtree: true, attributes: true,
                            attributeFilter: ['data-turn-key', 'data-content-search-turn-key', 'data-chatgpt-selection-message-id', 'data-turn-id-container', 'data-message-id'] });
                } catch { observer = null; }
            }
            check();
        });
    }

    async jumpToTimelineMarker(marker, context = {}) {
        const isCurrent = typeof context.isCurrent === 'function' ? context.isCurrent : () => true;
        if (!isCurrent()) return null;
        const navigationStartTop = context.scrollContainer?.scrollTop || 0;
        this._navigationDiagnostic('marker-resolved', marker, context, {
            identityAvailable: this._getMarkerAliasIds(marker).length > 0
        });
        const direct = this.resolveTimelineElement(marker);
        this._navigationDiagnostic(direct ? 'direct-dom-hit' : 'direct-dom-miss', marker, context);
        if (direct) return direct;
        const knownPositionElement = await this._tryKnownTimelinePosition(marker, context);
        if (!isCurrent()) return null;
        if (knownPositionElement) {
            this._navigationDiagnostic('target-identity-verified', marker, context, {
                strategy: 'known-dom-position'
            });
            return knownPositionElement;
        }
        const plan = this._buildVirtualIndexPlan(marker);
        if (!plan) {
            this._navigationDiagnostic('virtual-index-plan', marker, context, { ok: false, reason: 'identity-unavailable' });
            return null;
        }
        this._navigationDiagnostic('virtual-index-plan', marker, context, {
            ok: true, strategy: plan.strategy, mappingVerified: plan.mappingVerified === true,
            hasExactIndex: Number.isFinite(plan.index)
        });
        if (!isCurrent()) return null;
        const result = await this._requestVirtualizerJump(plan, marker, context);
        if (!isCurrent()) return null;
        if (!result?.ok) {
            this._navigationDiagnostic(result?.reason === 'cancelled' ? 'navigation-cancelled' : 'scroll-state-unchanged', marker, context, {
                strategy: result?.indexStrategy || plan.strategy,
                reason: result?.reason || 'bridge-no-response', failureStage: result?.failureStage || 'bridge'
            });
            if (result?.reason === 'cancelled') return null;
            const fallbackElement = await this._fallbackScrollByUserOrder(marker, context, navigationStartTop);
            if (fallbackElement) {
                this._navigationDiagnostic('target-identity-verified', marker, context, {
                    strategy: 'bounded-scroll-fallback'
                });
            }
            return fallbackElement;
        }
        this._navigationDiagnostic(result.stateChanged ? 'scroll-state-changed' : 'scroll-state-unchanged', marker, context, {
            strategy: result.indexStrategy || plan.strategy, reason: result.targetIndexVisible ? 'target-index-visible' : ''
        });
        const firstWait = await this._waitForMarkerMount(marker, context, result.stateChanged ? 900 : 650);
        if (!isCurrent()) return null;
        this._navigationDiagnostic(firstWait.element ? 'target-mount-detected' : 'target-mount-timeout', marker, context, {
            strategy: result.indexStrategy || plan.strategy, mountMs: firstWait.mountMs, mutations: firstWait.mutations
        });
        if (firstWait.element) {
            this._navigationDiagnostic('target-identity-verified', marker, context, { mountMs: firstWait.mountMs });
            return firstWait.element;
        }

        // One progress-gated local correction is allowed after a coarse jump.
        // It must be backed by newly observed DOM indices and use a different
        // exact index; no page scan or alternating probe is performed.
        if (result.stateChanged && !plan.mappingVerified) {
            const correction = this._buildVirtualIndexPlan(marker);
            if (correction?.mappingVerified && Number.isFinite(correction.index)
                && correction.index !== result.attemptedIndex && isCurrent()) {
                this._navigationDiagnostic('virtual-index-plan', marker, context, {
                    ok: true, strategy: correction.strategy, mappingVerified: true, correction: true
                });
                const correctedResult = await this._requestVirtualizerJump(correction, marker, context, 900);
                if (!isCurrent() || !correctedResult?.ok) return null;
                const correctedWait = await this._waitForMarkerMount(marker, context, 650);
                if (!isCurrent()) return null;
                this._navigationDiagnostic(correctedWait.element ? 'target-mount-detected' : 'target-mount-timeout', marker, context, {
                    strategy: correction.strategy, mountMs: correctedWait.mountMs, correction: true
                });
                if (correctedWait.element) {
                    this._navigationDiagnostic('target-identity-verified', marker, context, { correction: true });
                    return correctedWait.element;
                }
            }
        }
        this._navigationDiagnostic('target-mount-timeout', marker, context, {
            strategy: result.indexStrategy || plan.strategy, reason: 'bridge-target-not-mounted'
        });
        return this._fallbackScrollByUserOrder(marker, context, navigationStartTop);
    }

    /**
     * 从 DOM 元素中提取 nodeId
     * 新版结构读容器的 data-turn-id-container，旧版结构读 data-turn-id
     * （两者是同一批 turn UUID，收藏等历史数据可直接对上）
     * 
     * ✅ 降级方案：返回 null 时，generateTurnId 会降级使用 index（数字类型）
     * @param {Element} element - 用户消息元素
     * @returns {string|null} - nodeId（字符串），失败返回 null
     */
    _extractNodeIdFromDom(element) {
        if (!element) return null;

        const candidates = this._getDomIdCandidates(element);
        const capturedIds = new Set(this._capturedTurns.flatMap(turn =>
            [turn.id, turn.nodeId, turn.messageId, ...(turn.ids || [])].filter(Boolean)
        ));
        const matched = candidates.find(id => capturedIds.has(id));
        if (matched) return matched;
        if (candidates.length) return candidates[0];
        if (element.getAttribute('data-ait-heading-turn') === 'user') {
            return window.AITChatGPTRolloutDOM?.matchId(element, this._capturedMatchTexts) || null;
        }
        return null;
    }

    /**
     * 生成节点的唯一标识 turnId
     * 优先使用 turn UUID（data-turn-id-container / data-turn-id，稳定），回退到数组索引（兼容）
     */
    generateTurnId(element, index) {
        const nodeId = this._extractNodeIdFromDom(element);
        return nodeId ? `chatgpt-${nodeId}` : `chatgpt-${index}`;
    }
    
    /**
     * 从存储的 nodeId 生成 turnId（用于收藏跳转）
     * @param {string|number} identifier - nodeId（字符串）或 index（数字）
     * @returns {string}
     */
    generateTurnIdFromIndex(identifier) {
        return `chatgpt-${identifier}`;
    }
    
    /**
     * 从 turnId 中提取 nodeId/index
     * @param {string} turnId - 格式为 chatgpt-{nodeId} 或 chatgpt-{index}
     * @returns {string|number|null} - nodeId（字符串）或 index（数字）
     */
    extractIndexFromTurnId(turnId) {
        if (!turnId) return null;
        if (turnId.startsWith('chatgpt-')) {
            const part = turnId.substring(8); // 'chatgpt-'.length = 8
            // ✅ 尝试解析为数字（降级到 index 时的数据）
            const parsed = parseInt(part, 10);
            // 如果是纯数字字符串，返回数字；否则返回字符串
            return (String(parsed) === part) ? parsed : part;
        }
        return null;
    }
    
    /**
     * 根据存储的 nodeId/index 查找 marker
     * 支持新数据（nodeId 字符串）和旧数据（index 数字）
     * @param {string|number} storedKey - 存储的 nodeId 或 index
     * @param {Array} markers - marker 数组
     * @param {Map} markerMap - markerMap
     * @returns {Object|null} - 匹配的 marker
     */
    findMarkerByStoredIndex(storedKey, markers, markerMap) {
        if (storedKey === null || storedKey === undefined) return null;
        
        // 1. 先尝试用 nodeId/index 构建 turnId 查找
        const turnId = `chatgpt-${storedKey}`;
        const marker = markerMap.get(turnId);
        if (marker) return marker;
        
        // 2. Fallback：如果是数字，尝试用数组索引（兼容旧数据）
        if (typeof storedKey === 'number' && storedKey >= 0 && storedKey < markers.length) {
            return markers[storedKey];
        }
        
        return null;
    }

    /**
     * 写入内存文本缓存（带容量控制）
     * @param {string} nodeId - turn UUID
     * @param {string} text - 提问文本
     */
    _cacheTurnText(nodeId, text) {
        // 截断长文本：tooltip 最多显示 5 行，控制内存与存储体积
        const maxLen = ChatGPTAdapter.TEXT_CACHE_MAX_TEXT_LENGTH;
        const trimmed = text.length > maxLen ? text.slice(0, maxLen) : text;
        if (this._turnTextCache.get(nodeId) === trimmed) return;
        if (!this._turnTextCache.has(nodeId)
            && this._turnTextCache.size >= ChatGPTAdapter.TEXT_CACHE_MAX_ENTRIES) {
            // 简单容量控制：删最早的一条
            const oldest = this._turnTextCache.keys().next().value;
            this._turnTextCache.delete(oldest);
        }
        this._turnTextCache.set(nodeId, trimmed);
    }

    extractText(element) {
        const nodeId = this._extractNodeIdFromDom(element);
        const textElement = element.querySelector('.whitespace-pre-wrap');
        let text = element.hasAttribute('data-ait-heading-turn')
            ? window.AITChatGPTRolloutDOM?.text(element) || ''
            : (textElement?.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text && element.matches?.(ChatGPTAdapter.MODERN_TURN_SELECTOR)) {
            const copy = element.cloneNode(true);
            copy.querySelectorAll('button, nav, form, [data-composer-input], .ProseMirror, [data-ait-time], .ait-time-label')
                .forEach(node => node.remove());
            text = (copy.textContent || '').replace(/\s+/g, ' ').trim();
        }
        if (text) {
            // 渲染期缓存文本，供该轮被虚拟化成空壳后使用
            if (nodeId) this._cacheTurnText(nodeId, text);
            window.AITGPTDiagnostics?.log('adapter.text-source', { source: 'dom' });
            return text;
        }
        // 虚拟化空壳：React 子树已卸载，DOM/fiber 均无文本，回退会话级缓存
        if (nodeId && this._turnTextCache.has(nodeId)) {
            window.AITGPTDiagnostics?.log('adapter.text-source', { source: this._capturedTextIds.has(nodeId) ? 'api-cache' : 'dom-cache' });
            return this._turnTextCache.get(nodeId);
        }
        // 区分两种"无文本"：
        // - 空壳（childElementCount=0）：轮次从未渲染过，文本在客户端物理不存在
        // - 已渲染但无文本节点：真的是纯图片/文件消息
        window.AITGPTDiagnostics?.log('adapter.text-source', { source: 'placeholder', hasNodeId: !!nodeId, emptyElement: element.childElementCount === 0 });
        return element.childElementCount === 0 ? '[未加载的提问]' : '[图片或文件]';
    }

    /**
     * 获取时间标签的渲染目标元素
     * ChatGPT: 使用 [data-message-id] 子元素
     */
    // 只返回计数和几何值。ID/正文仅在当前页面内比较，不进入 Console 或导出报告。
    getDiagnosticCoverage() {
        const conversation = this.extractConversationId(location.pathname);
        if (this._coverageConversation !== conversation) {
            this._coverageConversation = conversation;
            this._coverageSeen = new Set();
            this._coverageMaxDom = 0;
        }
        const cacheCurrent = this._textCacheConvId === conversation;
        const texts = cacheCurrent ? this._capturedMatchTexts : new Map();
        const frequencies = new Map();
        for (const value of texts.values()) {
            const normalized = value.replace(/\s+/g, ' ').trim();
            frequencies.set(normalized, (frequencies.get(normalized) || 0) + 1);
        }
        const elements = Array.from(document.querySelectorAll(this.getUserMessageSelector()));
        const domTexts = elements.map(el => this._usesHeadingTurnSelector
            ? window.AITChatGPTRolloutDOM?.text(el) || '' : this.extractText(el));
        let uniqueTextMatches = 0, ambiguousTextMatches = 0, unmatchedText = 0, emptyText = 0;
        const matched = new Set();
        domTexts.forEach(text => {
            const normalized = text.replace(/\s+/g, ' ').trim();
            if (!normalized) { emptyText++; return; }
            const count = frequencies.get(normalized) || 0;
            if (!count) unmatchedText++;
            else if (count > 1 || domTexts.filter(t => t.replace(/\s+/g, ' ').trim() === normalized).length > 1) ambiguousTextMatches++;
            else {
                uniqueTextMatches++;
                for (const [id, value] of texts) {
                    if (value.replace(/\s+/g, ' ').trim() === normalized) { matched.add(id); this._coverageSeen.add(id); break; }
                }
            }
        });
        this._coverageMaxDom = Math.max(this._coverageMaxDom, elements.length);
        const manager = window.timelineManager;
        const scroll = manager?.scrollContainer;
        return { mode: this._usesHeadingTurnSelector ? 'headings' : this._usesVirtualizedTurnSelector ? 'virtual' : 'legacy',
            cacheCurrent, apiTextEntries: texts.size, domUsers: elements.length, maxDomUsersSeen: this._coverageMaxDom,
            uniqueTextMatches, ambiguousTextMatches, unmatchedText, emptyText,
            apiTextsWithoutUniqueDomMatch: Math.max(0, texts.size - matched.size),
            apiTextsSeenAcrossSnapshots: Array.from(texts.keys()).filter(id => this._coverageSeen.has(id)).length,
            markers: manager?.markers?.length || 0, scrollTop: Math.round(scroll?.scrollTop || 0),
            scrollHeight: scroll?.scrollHeight || 0, clientHeight: scroll?.clientHeight || 0,
            scrollConnected: !!scroll?.isConnected };
    }

    getTimelineMessageRect(element) {
        if (!element?.hasAttribute('data-ait-heading-turn')) return null;
        return window.AITChatGPTRolloutDOM?.rect(element) || null;
    }

    getTimeLabelTarget(element) {
        return element.querySelector('[data-message-id], [data-chatgpt-selection-message-id]') || element;
    }

    isConversationRoute(pathname) {
        const segs = pathname.split('/').filter(Boolean);
        
        // 检查普通对话路径: /c/{id}
        const cIndex = segs.indexOf('c');
        if (cIndex !== -1) {
            const slug = segs[cIndex + 1];
            if (typeof slug === 'string' && slug.length > 0 && /^[A-Za-z0-9_-]+$/.test(slug)) {
                return true;
            }
        }
        
        // 检查 GPT 对话路径: /g/{gpt_id}/c/{conversation_id}
        const gIndex = segs.indexOf('g');
        if (gIndex !== -1 && segs[gIndex + 2] === 'c') {
            const gptId = segs[gIndex + 1];
            const conversationId = segs[gIndex + 3];
            if (gptId && conversationId && 
                /^[A-Za-z0-9_-]+$/.test(gptId) && 
                /^[A-Za-z0-9_-]+$/.test(conversationId)) {
                return true;
            }
        }
        
        // 检查分享页面路径: /share/{id} 或 /share/e/{id}
        const shareIndex = segs.indexOf('share');
        if (shareIndex !== -1) {
            const shareId = segs[shareIndex + 1] === 'e'
                ? segs[shareIndex + 2]
                : segs[shareIndex + 1];
            if (typeof shareId === 'string' && shareId.length > 0 && /^[A-Za-z0-9_-]+$/.test(shareId)) {
                return true;
            }
        }
        
        return false;
    }

    extractConversationId(pathname) {
        try {
            const segs = pathname.split('/').filter(Boolean);
            
            // 尝试提取 GPT 对话 ID: /g/{gpt_id}/c/{conversation_id}
            const gIndex = segs.indexOf('g');
            if (gIndex !== -1 && segs[gIndex + 2] === 'c') {
                const conversationId = segs[gIndex + 3];
                if (conversationId && /^[A-Za-z0-9_-]+$/.test(conversationId)) return conversationId;
            }
            
            // 尝试提取普通对话 ID: /c/{id}
            const cIndex = segs.indexOf('c');
            if (cIndex !== -1) {
                const slug = segs[cIndex + 1];
                if (slug && /^[A-Za-z0-9_-]+$/.test(slug)) return slug;
            }
            
            // 尝试提取分享页面 ID: /share/{id} 或 /share/e/{id}
            const shareIndex = segs.indexOf('share');
            if (shareIndex !== -1) {
                const shareId = segs[shareIndex + 1] === 'e'
                    ? segs[shareIndex + 2]
                    : segs[shareIndex + 1];
                if (shareId && /^[A-Za-z0-9_-]+$/.test(shareId)) return shareId;
            }
            
            return null;
        } catch {
            return null;
        }
    }

    findConversationContainer(firstMessage, context = {}) {
        /**
         * 查找对话容器
         * 
         * 使用 LCA（最近共同祖先）算法查找所有对话记录的最近父容器。
         * 传递 messageSelector 参数，让 ContainerFinder 能够：
         * 1. 查询所有用户消息元素
         * 2. 找到它们的最近共同祖先
         * 3. 确保容器是直接包裹所有对话的最小容器
         * 
         * 优势：比传统的向上遍历更精确，避免找到过于外层的容器
         */
        const stableVirtualRoot = firstMessage?.closest?.('[data-virtualized-list], [data-test-render-count]')
            || document.querySelector('main [data-virtualized-list], main [data-test-render-count]');
        if (stableVirtualRoot) return stableVirtualRoot;
        const threadRoot = firstMessage?.closest?.('#thread') || document.getElementById('thread');
        if (threadRoot) return threadRoot;
        const main = firstMessage?.closest?.('main') || document.querySelector('main');
        if (main) return main;
        return ContainerFinder.findConversationContainer(firstMessage, {
            messageSelector: context.messageSelector || this.getUserMessageSelector(),
            messages: context.userTurnElements
        });
    }

    resolveTimelineScrollContainer(anchor, conversationContainer) {
        // Start above the turn itself so an attachment/code scroller inside a
        // message can never become the main conversation scroll root.
        let node = anchor && anchor !== conversationContainer
            ? anchor.parentElement : (anchor || conversationContainer);
        let rangedFallback = null;
        let largestRange = 0;
        while (node && node !== document.body && node !== document.documentElement) {
            try {
                const style = window.getComputedStyle(node);
                const scrollableOverflow = /auto|scroll|overlay/.test(style.overflowY || '');
                let ownsConversation = !conversationContainer || node === conversationContainer
                    || !!node.contains?.(conversationContainer)
                    || !!conversationContainer.contains?.(node);
                for (let owner = conversationContainer?.parentElement; !ownsConversation && owner; owner = owner.parentElement) {
                    ownsConversation = owner === node;
                }
                for (let owner = node?.parentElement; !ownsConversation && owner; owner = owner.parentElement) {
                    ownsConversation = owner === conversationContainer;
                }
                const scrollRange = Math.max(0, (node.scrollHeight || 0) - (node.clientHeight || 0));
                if (ownsConversation && scrollRange > largestRange) {
                    rangedFallback = node;
                    largestRange = scrollRange;
                }
                // ChatGPT often creates the real scroll root before enough
                // turns are mounted to give it a scrollable range. Keep that
                // root instead of falling back to the document HTML element.
                if (ownsConversation && (scrollableOverflow || node.hasAttribute?.('data-scroll-root'))) {
                    return node;
                }
            } catch {}
            node = node.parentElement;
        }
        // Some ChatGPT builds do not expose overflow-y:auto on the element
        // that actually owns the scroll range. Prefer that real ancestor over
        // falling back to a non-scrollable documentElement.
        return rangedFallback;
    }

    getTimelinePosition() {
        // ChatGPT 默认位置
        return {
            top: '120px',      // 避开顶部导航栏
            right: '22px',    // 右侧边距
            bottom: '120px',   // 避开底部输入框
        };
    }
    
    /**
     * 获取时间标签位置配置
     * ChatGPT: 底部显示
     */
    getTimeLabelPosition() {
        // 相对于消息元素定位
        return {
            top: '-16px',
            right: '10px'
        };
    }
    
    getStarChatButtonTarget() {
        return window.AITChatHeaderActions?.getInsertTarget?.()
            || document.querySelector('[data-testid="share-chat-button"]');
    }
    
    getDefaultChatTheme() {
        // ChatGPT 使用页面标题作为默认主题
        return document.title || '';
    }
    
    /**
     * 检测是否应该隐藏时间轴
     * ChatGPT: 当页面存在 .text-token-primary 元素时隐藏
     * @returns {boolean}
     */
    shouldHideTimeline() {
        return document.querySelector('[data-stage-thread-flyout="true"][data-testid="stage-thread-flyout"]') !== null;
    }

    getTimelineVisibilitySelectors() {
        return [
            '[data-stage-thread-flyout="true"][data-testid="stage-thread-flyout"]'
        ];
    }
    
    /**
     * 获取滚动偏移量
     * 用户消息节点本身上方留白较多，仅需小幅补偿即可避免被顶部 UI 遮挡
     * @returns {number} - 滚动偏移量（像素）
     */
    getScrollOffset() {
        return 20;
    }
    
    /**
     * 检测 AI 是否正在生成回答
     * ChatGPT: 当 #composer-submit-button 元素的 data-testid="stop-button" 时，表示正在生成
     * @returns {boolean}
     */
    isAIGenerating() {
        const submitButton = document.getElementById('composer-submit-button');
        // ✅ 必须返回 boolean，找不到按钮视为 false（未生成），而不是 null（未实现）
        return !!(submitButton && submitButton.getAttribute('data-testid') === 'stop-button');
    }
}
