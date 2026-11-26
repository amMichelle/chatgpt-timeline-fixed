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
        if (window.AITGPTDiagnostics?.verbose) {
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
        // Temporary Chat has no durable conversation id/API snapshot. Keep its
        // index entirely in this adapter instance and never ask the history
        // bridge to create a cache bucket for it.
        if (!convId) {
            if (this._textCacheConvId !== null) {
                this._textCacheConvId = null;
                this._turnTextCache.clear();
                this._capturedTextIds.clear();
                this._capturedMatchTexts.clear();
                this._capturedTurns = [];
                this._capturedComplete = false;
                this._capturedSource = 'temporary-dom';
                this._domOnlyTurns = [];
                this._scrollPositionByMessageId.clear();
                this._virtualIndexByMessageId.clear();
            }
            this._capturedSource = 'temporary-dom';
            return;
        }
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
            if (root.closest?.('form, nav, aside, [data-composer-input], .ProseMirror, .ait-chat-timeline-wrapper')) return;
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
        if (window.AITGPTDiagnostics?.verbose) {
            window.AITGPTDiagnostics.log('timeline.init-stage', {
                stage: 'adapter-prepared', modernTurns: this._getModernTurnRoots().length,
                modernUsers: modern.matchedUsers, apiUsers: this._capturedTurns.length,
                legacyVirtual: this._usesVirtualizedTurnSelector, headings: this._usesHeadingTurnSelector
            });
        }
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
        // the total node count for a durable conversation. Temporary Chat has
        // no history API, so append stable, actually observed user turns to an
        // in-memory-only index instead.
        if (!this._capturedComplete) {
            if (!this.isTransientConversation()) return [];
            const known = new Map();
            this._domOnlyTurns.forEach(turn => {
                [turn.id, ...(turn.aliases || [])].filter(Boolean)
                    .forEach(id => known.set(id, turn));
            });
            Array.from(userTurnElements || []).forEach(element => {
                if (!this._isRenderedMessageElement(element)) return;
                const aliases = this._getDomIdCandidates(element);
                const sourceId = aliases[0];
                if (!sourceId) return;
                const existing = aliases.map(id => known.get(id)).find(Boolean);
                const summary = this.extractText(element) || '[未加载的提问]';
                if (existing) {
                    existing.element = element;
                    if (!this.isPlaceholderSummary(summary)) existing.summary = summary;
                    existing.aliases = Array.from(new Set([...(existing.aliases || []), ...aliases]));
                    aliases.forEach(id => known.set(id, existing));
                    return;
                }
                const turn = {
                    id: sourceId,
                    aliases: Array.from(new Set(aliases)),
                    element,
                    summary,
                    userOrder: this._domOnlyTurns.length + 1
                };
                this._domOnlyTurns.push(turn);
                turn.aliases.forEach(id => known.set(id, turn));
            });
            const mountedById = new Map();
            Array.from(userTurnElements || []).forEach(element => {
                this._getDomIdCandidates(element).forEach(id => mountedById.set(id, element));
            });
            return this._domOnlyTurns.map((turn, index) => {
                const element = turn.aliases.map(id => mountedById.get(id)).find(Boolean) || null;
                return {
                    id: `chatgpt-${turn.id}`,
                    sourceId: turn.id,
                    aliasIds: turn.aliases,
                    element,
                    summary: turn.summary,
                    messageId: turn.id,
                    messageIndex: index + 1,
                    totalMessages: this._domOnlyTurns.length,
                    userOrder: index + 1,
                    virtual: !element,
                    transient: true
                };
            });
        }

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
        return !!this._findRenderedUserContent(element);
    }

    _findRenderedUserContent(element) {
        if (!element?.isConnected) return null;
        const hasRenderedBox = node => {
            if (!node) return false;
            if (typeof node.getBoundingClientRect !== 'function') return true;
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };
        const contentSelector = [
            '[data-message-author-role="user"]',
            '[data-testid="user-message"]', '[data-testid*="user-message"]',
            '[data-chatgpt-selection-message-id]', '[data-message-id]',
            '[class*="user-message-bubble"]',
            '.whitespace-pre-wrap', '.markdown'
        ].join(',');
        const contentNodes = [
            ...(element.matches?.(contentSelector) ? [element] : []),
            ...Array.from(element.querySelectorAll?.(contentSelector) || [])
        ];
        const attachmentSelector = [
            'img', 'video', 'audio', 'canvas',
            '[data-attachment-kind]', '[data-file-id]', '[data-asset-id]',
            '[data-testid*="attachment"]', '[data-testid*="file"]', '[data-testid*="image"]'
        ].join(',');
        for (const node of contentNodes) {
            if (!hasRenderedBox(node)
                || node.closest?.('form, nav, aside, [data-composer-input], .ProseMirror')
                || node.closest?.('[data-turn="assistant"], [data-message-author-role="assistant"]')) continue;
            const hasText = !!String(node.textContent || '').replace(/\s+/g, ' ').trim();
            const hasAttachment = [
                ...(node.matches?.(attachmentSelector) ? [node] : []),
                ...Array.from(node.querySelectorAll?.(attachmentSelector) || [])
            ].some(hasRenderedBox);
            if (hasText || hasAttachment) return node;
        }
        // Pure image/file questions may not have a text wrapper at all.
        const directAttachments = Array.from(element.querySelectorAll?.(attachmentSelector) || []);
        const renderedAttachment = directAttachments.find(node => hasRenderedBox(node)
            && !node.closest?.('form, nav, aside, [data-composer-input], .ProseMirror'));
        if (renderedAttachment) return renderedAttachment;
        return null;
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
        if (cached.maxScrollTop > 0) {
            const heightRatio = currentMax / cached.maxScrollTop;
            if (heightRatio < 0.75 || heightRatio > 1.25) return null;
        }
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
        this._domOnlyTurns.forEach((turn, index) => {
            [turn.id, ...(turn.aliases || [])].filter(Boolean)
                .forEach(id => orderByAlias.set(id, index + 1));
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

    _sampleMountedUserOrderState(scrollContainer) {
        if (!scrollContainer) return null;
        const beforeTop = Number(scrollContainer.scrollTop) || 0;
        const beforeHeight = Number(scrollContainer.scrollHeight) || 0;
        const range = this._getMountedUserOrderRange(scrollContainer);
        const scrollTop = Number(scrollContainer.scrollTop) || 0;
        const scrollHeight = Number(scrollContainer.scrollHeight) || 0;
        const maxScrollTop = Math.max(0, scrollHeight - (Number(scrollContainer.clientHeight) || 0));
        return {
            range,
            scrollTop,
            scrollHeight,
            maxScrollTop,
            stable: Math.abs(scrollTop - beforeTop) <= 2
                && Math.abs(scrollHeight - beforeHeight) <= 4
        };
    }

    _captureReadingAnchor(scrollContainer) {
        if (!scrollContainer) return null;
        const containerRect = scrollContainer.getBoundingClientRect?.() || { top: 0, bottom: 0 };
        const candidates = [];
        const seen = new Set();
        const roots = [
            ...this._getModernTurnRoots(),
            ...Array.from(document.querySelectorAll?.('[data-turn-id-container], [data-turn-id], [data-message-id]') || [])
        ];
        roots.forEach(element => {
            if (!element?.isConnected || seen.has(element) || !this._isRenderedMessageElement(element)) return;
            seen.add(element);
            const ids = element.matches?.(ChatGPTAdapter.MODERN_TURN_SELECTOR)
                ? this._getModernRoleIdCandidates(element)
                : this._getDomIdCandidates(element, { includeWeak: false });
            if (!ids.length) return;
            const rect = this.getTimelineMessageRect(element) || element.getBoundingClientRect?.();
            if (!rect || rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) return;
            candidates.push({
                ids: Array.from(new Set(ids)),
                offset: rect.top - containerRect.top,
                distance: Math.abs(rect.top - containerRect.top - 30)
            });
        });
        candidates.sort((left, right) => left.distance - right.distance);
        return candidates[0] || null;
    }

    async _restoreReadingAnchor(anchor, scrollContainer, isCurrent) {
        if (!anchor?.ids?.length || !scrollContainer || !isCurrent()) return false;
        const marker = { sourceId: anchor.ids[0], aliasIds: anchor.ids };
        let element = this._findIdentityAnchor(marker);
        if (!this._isRenderedMessageElement(element)) return false;
        const containerRect = scrollContainer.getBoundingClientRect?.() || { top: 0 };
        const rect = this.getTimelineMessageRect(element) || element.getBoundingClientRect?.();
        if (!rect) return false;
        const correction = rect.top - containerRect.top - anchor.offset;
        if (Math.abs(correction) > 2) scrollContainer.scrollTop += correction;
        await new Promise(resolve => {
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resolve);
            else setTimeout(resolve, 0);
        });
        if (!isCurrent()) return false;
        element = this._findIdentityAnchor(marker);
        if (!this._isRenderedMessageElement(element)) return false;
        const verifiedRect = this.getTimelineMessageRect(element) || element.getBoundingClientRect?.();
        const verifiedContainerRect = scrollContainer.getBoundingClientRect?.() || { top: 0 };
        return !!verifiedRect
            && Math.abs((verifiedRect.top - verifiedContainerRect.top) - anchor.offset) <= 8;
    }

    _createHistoryPaginationTracker() {
        const conversationId = this.extractConversationId(location.pathname);
        const active = new Set();
        let completionCount = 0;
        let consumedCompletions = 0;
        let lastResponseOk = false;
        const handler = event => {
            let detail = null;
            try { detail = JSON.parse(typeof event.detail === 'string' ? event.detail : '{}'); } catch {}
            if (!detail || detail.conversationId !== conversationId || !Number.isFinite(detail.requestId)) return;
            if (detail.stage === 'request') active.add(detail.requestId);
            else if (detail.stage === 'response') {
                active.delete(detail.requestId);
                completionCount++;
                lastResponseOk = detail.ok === true;
            }
        };
        document.addEventListener('ait-gpt-native-history-pagination', handler);
        return {
            hasRelevantEvent() {
                return active.size > 0 || completionCount > consumedCompletions;
            },
            async waitForRelevant(isCurrent, timeoutMs = 1600, startGraceMs = 0) {
                const deadline = Date.now() + timeoutMs;
                const startDeadline = Math.min(deadline, Date.now() + startGraceMs);
                while (!this.hasRelevantEvent() && isCurrent() && Date.now() < startDeadline) {
                    await new Promise(resolve => setTimeout(resolve, 25));
                }
                if (!this.hasRelevantEvent()) return { observed: false, completed: false, ok: false };
                while (active.size > 0 && isCurrent() && Date.now() < deadline) {
                    await new Promise(resolve => setTimeout(resolve, 25));
                }
                const completed = completionCount > consumedCompletions && active.size === 0;
                consumedCompletions = completionCount;
                return { observed: true, completed, ok: completed && lastResponseOk, pending: active.size > 0 };
            },
            dispose() {
                document.removeEventListener('ait-gpt-native-history-pagination', handler);
            }
        };
    }

    _nativeLoadedOrders(state) {
        const source = Array.isArray(state?.turnUserOrders)
            ? state.turnUserOrders
            : Array.isArray(state?.loadedUserOrders) ? state.loadedUserOrders : [];
        return Array.from(new Set(source.map(Number)
            .filter(order => Number.isFinite(order) && order > 0)))
            .sort((left, right) => left - right);
    }

    _hasEarlierNativeHistoryProgress(previous, current) {
        const before = this._nativeLoadedOrders(previous);
        const after = this._nativeLoadedOrders(current);
        if (!before.length || !after.length) return false;
        const beforeSet = new Set(before);
        return after[0] < before[0]
            || after.some(order => order < before[0] && !beforeSet.has(order));
    }

    async _waitForNativeKeyUpdate(marker, context, previous, deadline) {
        let latest = previous;
        while ((typeof context.isCurrent !== 'function' || context.isCurrent())
            && Date.now() < deadline) {
            const remaining = deadline - Date.now();
            latest = await this._queryNativeKeyState(marker, context,
                Math.max(250, Math.min(450, remaining)));
            if (latest?.targetKeyLoaded === true
                || this._hasEarlierNativeHistoryProgress(previous, latest)) {
                return latest;
            }
            await new Promise(resolve => setTimeout(resolve, 80));
        }
        return latest;
    }

    _tryLocalHistoryTop(boundaryMarker, context, tracker, canContinue) {
        const sc = context.scrollContainer;
        const top = Number(sc?.scrollTop);
        // Only a verified, already reached history edge may receive one local
        // nudge. Never jump from a distant reading position to raw top=0.
        if (!canContinue() || tracker.hasRelevantEvent() || !sc?.isConnected
            || !Number.isFinite(top) || top <= 4 || top > sc.clientHeight) return false;
        const element = this.resolveTimelineElement(boundaryMarker);
        if (!element?.isConnected || !sc.contains?.(element)) return false;
        const rect = this.getTimelineMessageRect(element) || element.getBoundingClientRect?.();
        const viewport = sc.getBoundingClientRect?.();
        if (!rect || !viewport || rect.bottom <= viewport.top || rect.top >= viewport.bottom
            || !canContinue() || tracker.hasRelevantEvent()) return false;
        const liveTop = Number(sc.scrollTop);
        if (!Number.isFinite(liveTop) || liveTop <= 4 || liveTop > sc.clientHeight) return false;
        // One bounded DOM operation; the host may still compensate it. The
        // caller waits for actual pagination/Key progress, never assumes success.
        sc.scrollTop = 0;
        return true;
    }

    async _jumpToUnloadedHistory(marker, context, initialState, restoreAnchor) {
        const isCurrent = typeof context.isCurrent === 'function' ? context.isCurrent : () => true;
        const scrollContainer = context.scrollContainer;
        const targetOrder = Number(marker?.userOrder);
        let navigationDeadline = Number(context.navigationDeadline) || Date.now() + 9000;
        // Network-bound history loading has its own bounded progress window.
        // Renew only after earlier native Keys (or the target) are verified.
        const historyHardDeadline = Date.now() + 60000;
        const maxHistoryPages = 32;
        const renewAfterProgress = () => {
            navigationDeadline = Math.max(navigationDeadline,
                Math.min(historyHardDeadline, Date.now() + 9000));
            context.extendHistoryNavigation?.(navigationDeadline);
        };
        const searchBudget = context.searchBudget || { remaining: 8 };
        const canContinue = () => isCurrent() && Date.now() < navigationDeadline;
        const commandTimeout = () => Math.min(1300, navigationDeadline - Date.now());
        const commandPending = result => result?.promisePendingAfterTarget === true
            || (result?.nativeCommandIssued === true
                && ['command-promise-pending', 'bridge-timeout', 'cancelled'].includes(result.reason));
        let state = initialState;
        let loadedOrders = this._nativeLoadedOrders(state);
        if (!scrollContainer || !canContinue() || !loadedOrders.length
            || !(targetOrder > 0) || targetOrder >= loadedOrders[0]) return null;

        const paginationTracker = this._createHistoryPaginationTracker();
        const visitedBoundaries = new Set();
        try {
            while (canContinue() && searchBudget.remaining > 0 && visitedBoundaries.size < maxHistoryPages) {
                const boundaryOrder = loadedOrders[0];
                if (visitedBoundaries.has(boundaryOrder)) break;
                visitedBoundaries.add(boundaryOrder);
                // Use the earliest verified native user Key, not a raw top=0 write.
                const turn = this._capturedTurns.find(item => Number(item.userOrder) === boundaryOrder);
                if (!turn?.id || typeof context.alignHistoryBoundary !== 'function') break;
                const boundaryMarker = {
                    id: `chatgpt-${turn.id}`, sourceId: turn.id, messageId: turn.messageId,
                    aliasIds: Array.from(new Set([turn.id, turn.nodeId, turn.messageId, ...(turn.ids || [])].filter(Boolean))),
                    userOrder: boundaryOrder
                };
                const boundaryPlan = this._buildVirtualIndexPlan(boundaryMarker);
                if (!boundaryPlan || commandTimeout() < 350) break;
                // Boundary hops load history; they are not pixel-search attempts.
                this._navigationDiagnostic('unloaded-history-native-boundary', marker, context, {
                    attempt: visitedBoundaries.size, loadedOrderMin: boundaryOrder
                });
                const boundaryResult = await this._requestVirtualizerJump(
                    { ...boundaryPlan, requireSettledNativeKey: true }, boundaryMarker, context, commandTimeout()
                );
                if (!canContinue() || commandPending(boundaryResult)) return null;
                const nativeBoundaryAccepted = boundaryResult?.ok
                    && boundaryResult.indexStrategy === 'native-turn-key';
                const boundaryMovedWithoutTarget = boundaryResult?.reason === 'target-key-moved-without-target'
                    && boundaryResult?.nativeCommandIssued === true;
                if (!nativeBoundaryAccepted && !boundaryMovedWithoutTarget) break;
                let boundaryRecoveryAttempted = false;
                const recoverBoundaryFromMountedRange = async () => {
                    if (boundaryRecoveryAttempted || !canContinue()
                        || paginationTracker.hasRelevantEvent() || searchBudget.remaining <= 0) return null;
                    boundaryRecoveryAttempted = true;
                    const direct = this.resolveTimelineElement(boundaryMarker);
                    if (direct) return direct;
                    const recovered = await this._fallbackScrollByUserOrder(boundaryMarker, {
                        ...context,
                        isCurrent: () => canContinue() && !paginationTracker.hasRelevantEvent()
                    }, null, {
                        navigationDeadline,
                        nativeKeyState: state,
                        searchBudget,
                        maxAttempts: Math.min(2, searchBudget.remaining),
                        restoreOnFailure: false,
                        requireMountedEvidence: true
                    });
                    return canContinue() ? recovered : null;
                };
                if (boundaryMovedWithoutTarget) {
                    const recovered = await recoverBoundaryFromMountedRange();
                    if (!canContinue()) return null;
                    if (!recovered && !paginationTracker.hasRelevantEvent()) break;
                    if (recovered) {
                        this._navigationDiagnostic('unloaded-history-boundary-recovered', marker, context, {
                            loadedOrderMin: boundaryOrder, attempt: visitedBoundaries.size
                        });
                    }
                }
                let boundaryAligned = false;
                if (!paginationTracker.hasRelevantEvent()) {
                    boundaryAligned = await context.alignHistoryBoundary(boundaryMarker, paginationTracker) === true;
                    if (!canContinue()) return null;
                    if (!boundaryAligned && !paginationTracker.hasRelevantEvent()) {
                        const recovered = await recoverBoundaryFromMountedRange();
                        if (!canContinue()) return null;
                        if (recovered) {
                            boundaryAligned = await context.alignHistoryBoundary(
                                boundaryMarker, paginationTracker
                            ) === true;
                        }
                    }
                    if (!boundaryAligned && !paginationTracker.hasRelevantEvent()) break;
                }
                let nextState = state;
                let paginationFailed = false;
                let sawPagination = false;
                let triedLocalTop = false;
                let localTopWritten = false;
                // A quiet edge may need one local nudge after verified alignment.
                // Otherwise wait for native pagination and sample Keys sparingly.
                do {
                    let localTopWrittenThisPass = false;
                    let pagination = await paginationTracker.waitForRelevant(
                        canContinue, Math.max(1, navigationDeadline - Date.now()), 850
                    );
                    sawPagination ||= pagination.observed === true;
                    if (!canContinue() || pagination.pending) break;
                    if (pagination.completed && !pagination.ok) {
                        paginationFailed = true;
                        break;
                    }
                    nextState = pagination.completed && pagination.ok
                        ? await this._waitForNativeKeyUpdate(marker, context, state, navigationDeadline)
                        : await this._queryNativeKeyState(marker, context,
                            Math.min(450, navigationDeadline - Date.now()));
                    if (!canContinue()) break;
                    // A request can start during the read-only Key check.
                    // Consume it before permitting any new boundary command.
                    if (paginationTracker.hasRelevantEvent()) {
                        pagination = await paginationTracker.waitForRelevant(
                            canContinue, Math.max(1, navigationDeadline - Date.now()));
                        sawPagination ||= pagination.observed === true;
                        if (!canContinue() || pagination.pending) break;
                        if (pagination.completed && !pagination.ok) {
                            paginationFailed = true;
                            break;
                        }
                        if (pagination.completed && pagination.ok) {
                            nextState = await this._waitForNativeKeyUpdate(marker, context, state, navigationDeadline);
                        }
                    }
                    if (!sawPagination && !triedLocalTop && boundaryAligned
                        && nextState?.targetKeyLoaded !== true
                        && this._nativeLoadedOrders(nextState)[0] === boundaryOrder
                        && !this._hasEarlierNativeHistoryProgress(state, nextState)
                        && canContinue() && !paginationTracker.hasRelevantEvent()) {
                        triedLocalTop = true;
                        const beforeTop = scrollContainer.scrollTop;
                        if (this._tryLocalHistoryTop(boundaryMarker, context, paginationTracker, canContinue)) {
                            localTopWrittenThisPass = true;
                            localTopWritten = true;
                            this._navigationDiagnostic('unloaded-history-local-top', marker, context, {
                                loadedOrderMin: boundaryOrder, attempt: visitedBoundaries.size,
                                scrollTopBefore: beforeTop, scrollTopAfter: scrollContainer.scrollTop
                            });
                        }
                    }
                    if (localTopWritten && !localTopWrittenThisPass && !sawPagination
                        && nextState?.targetKeyLoaded !== true
                        && !this._hasEarlierNativeHistoryProgress(state, nextState)
                        && !paginationTracker.hasRelevantEvent()) break;
                } while (canContinue() && (paginationTracker.hasRelevantEvent()
                    || (nextState?.targetKeyLoaded !== true
                        && !this._hasEarlierNativeHistoryProgress(state, nextState))));
                if (!canContinue()) {
                    if (isCurrent()) this._navigationDiagnostic('unloaded-history-progress-timeout', marker, context, {
                        loadedOrderMin: boundaryOrder, attempt: visitedBoundaries.size,
                        pending: paginationTracker.hasRelevantEvent()
                    });
                    return null;
                }
                if (paginationTracker.hasRelevantEvent()) return null;
                if (paginationFailed) break;
                if (nextState?.targetKeyLoaded === true) {
                    renewAfterProgress();
                    const plan = this._buildVirtualIndexPlan(marker);
                    if (!plan || searchBudget.remaining <= 0 || commandTimeout() < 350) break;
                    searchBudget.remaining--;
                    const result = await this._requestVirtualizerJump(
                        { ...plan, requireSettledNativeKey: true }, marker, context, commandTimeout()
                    );
                    if (!canContinue() || commandPending(result)) return null;
                    if (result?.ok && result.indexStrategy === 'native-turn-key') {
                        const waited = await this._waitForMarkerMount(marker, context,
                            Math.min(900, Math.max(1, navigationDeadline - Date.now())));
                        if (!canContinue()) return null;
                        if (waited.element) {
                            marker._aitNavigationStrategy = result.indexStrategy;
                            return waited.element;
                        }
                    }
                    if (searchBudget.remaining <= 0 || paginationTracker.hasRelevantEvent()) return null;
                    paginationTracker.dispose();
                    return this._fallbackScrollByUserOrder(marker, context, null, {
                        restoreAnchor, navigationDeadline, nativeKeyState: nextState, searchBudget
                    });
                }
                if (!this._hasEarlierNativeHistoryProgress(state, nextState)) break;
                renewAfterProgress();
                state = nextState;
                loadedOrders = this._nativeLoadedOrders(state);
                if (!loadedOrders.length) break;
            }
            if (canContinue() && !paginationTracker.hasRelevantEvent()) {
                await this._restoreReadingAnchor(restoreAnchor, scrollContainer, isCurrent);
            }
            return null;
        } finally {
            paginationTracker.dispose();
        }
    }

    async _tryKnownTimelinePosition(marker, context) {
        const isCurrent = typeof context.isCurrent === 'function' ? context.isCurrent : () => true;
        const scrollContainer = context.scrollContainer;
        if (!isCurrent() || !scrollContainer) return null;

        const identityAnchor = this._findIdentityAnchor(marker);
        const identityAnchorRendered = this._isRenderedMessageElement(identityAnchor);
        const modernVirtualShell = identityAnchor?.matches?.(ChatGPTAdapter.MODERN_TURN_SELECTOR)
            && !identityAnchorRendered;
        if (identityAnchor && !modernVirtualShell && !identityAnchorRendered
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

    async _fallbackScrollByUserOrder(marker, context, restoreTop = null, options = {}) {
        const isCurrent = typeof context.isCurrent === 'function' ? context.isCurrent : () => true;
        const scrollContainer = context.scrollContainer;
        const userOrder = Number(marker?.userOrder);
        const totalUsers = this._capturedTurns.length || this._domOnlyTurns.length;
        let maxScrollTop = scrollContainer
            ? Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight) : 0;
        if (!isCurrent() || !scrollContainer || !(maxScrollTop > 0)
            || !(userOrder > 0) || totalUsers < 2) return null;

        const restoreAnchor = options.restoreAnchor || this._captureReadingAnchor(scrollContainer);
        let lowerTop = 0;
        let upperTop = maxScrollTop;
        let nextTop = ((userOrder - 1) / (totalUsers - 1)) * maxScrollTop;
        const initialSample = this._sampleMountedUserOrderState(scrollContainer);
        if (options.requireMountedEvidence === true
            && (!initialSample?.stable || !initialSample.range
                || (initialSample.range.anchors || []).length < 2)) return null;
        let lastDirection = 0;
        if (initialSample?.stable && initialSample.range) {
            const currentTop = initialSample.scrollTop;
            if (userOrder < initialSample.range.min) {
                lastDirection = -1;
                upperTop = Math.min(upperTop, Math.max(0, currentTop - 1));
            } else if (userOrder > initialSample.range.max) {
                lastDirection = 1;
                lowerTop = Math.max(lowerTop, Math.min(maxScrollTop, currentTop + 1));
            }
            const anchors = initialSample.range.anchors || [];
            if (anchors.length >= 2) {
                const first = anchors[0];
                const last = anchors[anchors.length - 1];
                if (last.order !== first.order && last.top !== first.top) {
                    const localProjection = first.top
                        + ((userOrder - first.order) / (last.order - first.order))
                        * (last.top - first.top);
                    if (Number.isFinite(localProjection)) nextTop = localProjection;
                }
            }
            nextTop = Math.max(lowerTop, Math.min(upperTop, nextTop));
        }
        const visited = new Set();
        let attempts = 0;
        const searchBudget = options.searchBudget || context.searchBudget || null;
        const availableAttempts = searchBudget
            ? Math.max(0, Number(searchBudget.remaining) || 0) : 8;
        const maxAttempts = Math.min(availableAttempts,
            Math.max(1, Math.min(8, Number(options.maxAttempts) || 8)));
        const navigationDeadline = Number(options.navigationDeadline)
            || Number(context.navigationDeadline) || Date.now() + 9000;
        let nativeKeyState = options.nativeKeyState || null;
        const paginationTracker = this._createHistoryPaginationTracker();
        for (let attempt = 0; attempt < maxAttempts && isCurrent()
            && Date.now() < navigationDeadline; attempt++) {
            const liveMax = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
            if (!(liveMax > 0)) break;
            if (Math.abs(liveMax - maxScrollTop) > 4) {
                // A virtual-height refill is not a uniform scale transform.
                // Discard pixel brackets from the old coordinate system and
                // rebuild direction from the current real scroll position.
                maxScrollTop = liveMax;
                lowerTop = 0;
                upperTop = liveMax;
                const currentTop = Math.max(0, Math.min(liveMax, scrollContainer.scrollTop || 0));
                if (lastDirection < 0) upperTop = Math.max(0, currentTop - 1);
                else if (lastDirection > 0) lowerTop = Math.min(liveMax, currentTop + 1);
                nextTop = ((userOrder - 1) / (totalUsers - 1)) * liveMax;
            }
            upperTop = Math.min(upperTop, liveMax);
            attempts = attempt + 1;
            if (searchBudget) searchBudget.remaining = Math.max(0, searchBudget.remaining - 1);
            const boundedTop = Math.max(lowerTop, Math.min(upperTop, nextTop));
            const key = `${Math.round(liveMax / 16)}:${Math.round(boundedTop / 4)}`;
            if (visited.has(key)) break;
            visited.add(key);
            const writeScrollHeight = scrollContainer.scrollHeight;
            scrollContainer.scrollTop = boundedTop;
            this._navigationDiagnostic('scroll-state-changed', marker, context, {
                strategy: options.requireMountedEvidence === true
                    ? 'boundary-local-correction'
                    : attempt === 0 ? 'bounded-scroll-ratio' : 'directional-local-correction',
                attempt: attempt + 1, candidateTop: Math.round(boundedTop)
            });
            const waited = await this._waitForMarkerMount(marker, context, attempt === 0 ? 800 : 550);
            if (!isCurrent()) { paginationTracker.dispose(); return null; }
            if (waited.element) { paginationTracker.dispose(); return waited.element; }

            const pagination = await paginationTracker.waitForRelevant(
                isCurrent,
                Math.max(1, navigationDeadline - Date.now())
            );
            if (!isCurrent()) { paginationTracker.dispose(); return null; }
            if (pagination.observed) {
                this._navigationDiagnostic('native-history-pagination-settled', marker, context, {
                    completed: pagination.completed,
                    ok: pagination.ok,
                    pending: pagination.pending === true,
                    attempt: attempt + 1
                });
            }
            if (pagination.pending) {
                // The bounded navigation budget expired while a real native
                // page is still in flight. Stop without writing an obsolete
                // reading coordinate or stacking another search operation.
                paginationTracker.dispose();
                return null;
            }
            if (pagination.completed && pagination.ok) {
                // HTTP completion precedes React state application. Poll only
                // the existing Key reader until the target or an earlier stable
                // user-order match appears; the query never invokes scrolling.
                const refreshedState = await this._waitForNativeKeyUpdate(
                    marker, context, nativeKeyState, navigationDeadline
                );
                if (!isCurrent()) { paginationTracker.dispose(); return null; }
                const keyProgressed = this._hasEarlierNativeHistoryProgress(
                    nativeKeyState, refreshedState
                );
                nativeKeyState = refreshedState || nativeKeyState;
                if (refreshedState?.targetKeyLoaded === true) {
                    const refreshedPlan = this._buildVirtualIndexPlan(marker);
                    const refreshedResult = refreshedPlan
                        ? await this._requestVirtualizerJump(refreshedPlan, marker, context,
                            Math.max(250, Math.min(900, navigationDeadline - Date.now())))
                        : null;
                    if (!isCurrent()) { paginationTracker.dispose(); return null; }
                    const nativePending = refreshedResult?.nativeCommandIssued === true
                        && (refreshedResult?.reason === 'command-promise-pending'
                            || refreshedResult?.reason === 'bridge-timeout');
                    if (nativePending) { paginationTracker.dispose(); return null; }
                    const afterNativeWait = await this._waitForMarkerMount(marker, context,
                        refreshedResult?.targetKeyLoaded === true ? 800 : 250);
                    if (!isCurrent()) { paginationTracker.dispose(); return null; }
                    if (afterNativeWait.element) {
                        marker._aitNavigationStrategy = refreshedResult?.indexStrategy || refreshedPlan?.strategy;
                        paginationTracker.dispose();
                        return afterNativeWait.element;
                    }
                } else if (!keyProgressed) {
                    paginationTracker.dispose();
                    await this._restoreReadingAnchor(restoreAnchor, scrollContainer, isCurrent);
                    return null;
                }
            }

            const sample = this._sampleMountedUserOrderState(scrollContainer);
            if (!sample) break;
            const coordinateSystemChanged = Math.abs(sample.scrollHeight - writeScrollHeight) > 8
                || Math.abs(sample.maxScrollTop - maxScrollTop) > 8;
            this._navigationDiagnostic('bounded-search-sample', marker, context, {
                attempt: attempt + 1,
                candidateTop: Math.round(boundedTop),
                actualTop: Math.round(sample.scrollTop),
                scrollHeight: Math.round(sample.scrollHeight),
                stable: sample.stable,
                coordinateSystemChanged,
                mountedMin: sample.range?.min || 0,
                mountedMax: sample.range?.max || 0
            });
            if (!sample.stable) {
                // React is still compensating scroll position/height. Do not
                // narrow a bracket with a range from that transient frame.
                maxScrollTop = sample.maxScrollTop;
                lowerTop = 0;
                upperTop = maxScrollTop;
                if (lastDirection < 0) {
                    upperTop = Math.max(0, sample.scrollTop - 1);
                    nextTop = upperTop / 2;
                } else if (lastDirection > 0) {
                    lowerTop = Math.min(maxScrollTop, sample.scrollTop + 1);
                    nextTop = lowerTop + (maxScrollTop - lowerTop) / 2;
                } else {
                    nextTop = ((userOrder - 1) / (totalUsers - 1)) * maxScrollTop;
                }
                continue;
            }
            const range = sample.range;
            if (!range) break;
            if (coordinateSystemChanged) {
                maxScrollTop = sample.maxScrollTop;
                lowerTop = 0;
                upperTop = maxScrollTop;
            }
            const actualTop = Math.max(0, Math.min(sample.maxScrollTop, sample.scrollTop));
            if (userOrder < range.min) {
                lastDirection = -1;
                upperTop = Math.min(upperTop, Math.max(0, actualTop - 1));
            } else if (userOrder > range.max) {
                lastDirection = 1;
                lowerTop = Math.max(lowerTop, Math.min(sample.maxScrollTop, actualTop + 1));
            } else {
                lastDirection = 0;
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
        let positionRestored = false;
        if (isCurrent() && options.restoreOnFailure !== false) {
            positionRestored = await this._restoreReadingAnchor(restoreAnchor, scrollContainer, isCurrent);
        }
        paginationTracker.dispose();
        this._navigationDiagnostic('target-identity-failed', marker, context, {
            strategy: 'bounded-evidence-search', reason: 'bounded-search-exhausted', attempts,
            positionRestored
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
        this._domOnlyTurns.forEach((turn, index) => {
            const indexedTurn = { ...turn, userOrder: index + 1 };
            [turn.id, ...(turn.aliases || [])].filter(Boolean)
                .forEach(id => turnByAlias.set(id, indexedTurn));
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

    _getKnownUserTurnRecords() {
        const turns = this._capturedTurns.length ? this._capturedTurns : this._domOnlyTurns;
        return turns.slice(0, 500).map((turn, index) => ({
            userOrder: Number(turn.userOrder) || index + 1,
            ids: Array.from(new Set([
                turn.id, turn.nodeId, turn.messageId,
                ...(turn.ids || []), ...(turn.aliases || [])
            ].filter(Boolean))).slice(0, 8)
        }));
    }

    _queryNativeKeyState(marker, context = {}, timeoutMs = 450) {
        const plan = this._buildVirtualIndexPlan(marker);
        if (!plan) return Promise.resolve(null);
        return this._requestVirtualizerJump({ ...plan, queryOnly: true }, marker, context, timeoutMs);
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
        const commandState = {
            commandIssued: false,
            nativeCommandIssued: false,
            method: '',
            indexStrategy: '',
            targetKeyLoaded: false,
            nativeKeyCount: 0
        };
        const queryOnly = plan.queryOnly === true;
        this._navigationDiagnostic('virtualizer-discovery-start', marker, context, {
            strategy: plan.strategy, queryOnly
        });
        if (!queryOnly) {
            this._navigationDiagnostic('bridge-command-issued', marker, context, { strategy: plan.strategy });
        }
        const resultPromise = new Promise(resolve => {
            const timeout = setTimeout(() => {
                document.removeEventListener('ait-gpt-virtualizer-jump-result', handler);
                document.removeEventListener('ait-gpt-virtualizer-jump-progress', progressHandler);
                document.dispatchEvent(new CustomEvent('ait-gpt-virtualizer-jump-cancel', {
                    detail: JSON.stringify({ requestId })
                }));
                if (this._activeVirtualizerRequestId === requestId) this._activeVirtualizerRequestId = null;
                const result = {
                    ok: false, reason: 'bridge-timeout', failureStage: 'bridge',
                    bridgeMs: Date.now() - issuedAt,
                    ...commandState
                };
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
                document.removeEventListener('ait-gpt-virtualizer-jump-progress', progressHandler);
                if (this._activeVirtualizerRequestId === requestId) this._activeVirtualizerRequestId = null;
                result.commandIssued = result.commandIssued === true || commandState.commandIssued;
                result.nativeCommandIssued = result.nativeCommandIssued === true || commandState.nativeCommandIssued;
                result.indexStrategy = result.indexStrategy || commandState.indexStrategy;
                result.targetKeyLoaded = result.targetKeyLoaded === true || commandState.targetKeyLoaded;
                result.nativeKeyCount = Math.max(Number(result.nativeKeyCount) || 0, commandState.nativeKeyCount);
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
                    stateChanged: !!result?.stateChanged,
                    nativeKeyCount: Number(result?.nativeKeyCount) || 0,
                    targetKeyLoaded: result?.targetKeyLoaded === true
                });
                resolve(result);
            };
            const progressHandler = event => {
                let progress = null;
                try { progress = JSON.parse(typeof event.detail === 'string' ? event.detail : '{}'); } catch {}
                if (progress?.requestId !== requestId || progress?.phase !== 'command-issued') return;
                commandState.commandIssued = true;
                commandState.nativeCommandIssued = commandState.nativeCommandIssued
                    || progress.nativeCommandIssued === true;
                commandState.method = progress.method || commandState.method;
                commandState.indexStrategy = progress.indexStrategy || commandState.indexStrategy;
                commandState.targetKeyLoaded = commandState.targetKeyLoaded
                    || progress.targetKeyLoaded === true;
                commandState.nativeKeyCount = Math.max(
                    commandState.nativeKeyCount,
                    Number(progress.nativeKeyCount) || 0
                );
                this._navigationDiagnostic('bridge-command-invoked', marker, context, {
                    method: commandState.method,
                    nativeCommandIssued: commandState.nativeCommandIssued,
                    strategy: commandState.indexStrategy
                });
            };
            document.addEventListener('ait-gpt-virtualizer-jump-result', handler);
            document.addEventListener('ait-gpt-virtualizer-jump-progress', progressHandler);
        });
        document.dispatchEvent(new CustomEvent('ait-gpt-virtualizer-jump', {
            detail: JSON.stringify({
                requestId,
                index: Number.isFinite(plan.index) ? plan.index : null,
                strategy: plan.strategy,
                mappingVerified: plan.mappingVerified === true,
                observedIndices: Array.from(new Set(plan.observedIndices || [])).slice(0, 20),
                targetIds: Array.from(new Set(plan.targetIds || [])).slice(0, 8),
                knownUserTurns: this._getKnownUserTurnRecords(),
                queryOnly,
                requireSettledNativeKey: plan.requireSettledNativeKey === true,
                targetUserOrder: marker?.userOrder || 0,
                totalUserTurns: this._capturedTurns.length || this._domOnlyTurns.length,
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
        const navigationStartAnchor = this._captureReadingAnchor(context.scrollContainer);
        this._navigationDiagnostic('marker-resolved', marker, context, {
            identityAvailable: this._getMarkerAliasIds(marker).length > 0
        });
        const direct = this.resolveTimelineElement(marker);
        this._navigationDiagnostic(direct ? 'direct-dom-hit' : 'direct-dom-miss', marker, context);
        if (direct) return direct;

        // 保留已验证版本的顺序：先使用身份占位或可靠缓存位置，再把
        // React 原生 Key 当作加速手段，最后才进入真实 Q 范围有界搜索。
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
        const nativeKeyAttempted = result?.nativeCommandIssued === true
            || result?.indexStrategy === 'native-turn-key'
            || result?.targetKeyLoaded === true;
        if (!result?.ok) {
            if (result?.reason === 'target-key-not-loaded') {
                this._navigationDiagnostic('native-list-capability', marker, context, {
                    available: false, reason: 'target-key-not-loaded',
                    nativeKeyCount: Number(result?.nativeKeyCount) || 0
                });
            }
            const feedbackStage = result?.reason === 'cancelled' ? 'navigation-cancelled'
                : result?.stateChanged ? 'scroll-state-changed' : 'scroll-state-unchanged';
            this._navigationDiagnostic(feedbackStage, marker, context, {
                strategy: result?.indexStrategy || plan.strategy,
                reason: result?.reason || 'bridge-no-response', failureStage: result?.failureStage || 'bridge'
            });
            if (result?.reason === 'cancelled') return null;
            if (result?.reason === 'target-key-not-loaded') {
                let nativeState = result;
                if (!this._nativeLoadedOrders(nativeState).length) {
                    nativeState = await this._queryNativeKeyState(marker, context, 500) || nativeState;
                }
                if (!isCurrent()) return null;
                const loadedOrders = this._nativeLoadedOrders(nativeState);
                const targetOrder = Number(marker?.userOrder);
                if (loadedOrders.length && targetOrder > 0 && targetOrder < loadedOrders[0]) {
                    return this._jumpToUnloadedHistory(
                        marker, context, nativeState, navigationStartAnchor
                    );
                }
                // The target is absent from the native list, but its relation to
                // the loaded stable-ID range is not proven. A full-history ratio
                // is invalid for this partial scroll space, so stop without it.
                return null;
            }
            // 原生方法已经实际调用且 Promise 仍可能迟到时不叠加滚动。
            // 其余已结束/未调用的失败仍可回到原有真实挂载范围校正。
            const nativeStillPending = result?.nativeCommandIssued === true
                && (result?.reason === 'command-promise-pending'
                    || result?.reason === 'bridge-timeout');
            if (nativeStillPending) {
                this._navigationDiagnostic('native-key-passive-settle', marker, context, {
                    ok: false, reason: result?.reason || 'target-not-observed'
                });
                return null;
            }
            const fallbackElement = await this._fallbackScrollByUserOrder(
                marker, context, navigationStartTop, {
                    restoreAnchor: navigationStartAnchor,
                    nativeKeyState: result
                }
            );
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
        const firstWait = await this._waitForMarkerMount(
            marker,
            context,
            nativeKeyAttempted ? 1200 : (result.stateChanged ? 900 : 650)
        );
        if (!isCurrent()) return null;
        this._navigationDiagnostic(firstWait.element ? 'target-mount-detected' : 'target-mount-timeout', marker, context, {
            strategy: result.indexStrategy || plan.strategy, mountMs: firstWait.mountMs, mutations: firstWait.mutations
        });
        if (firstWait.element) {
            marker._aitNavigationStrategy = result.indexStrategy || plan.strategy;
            this._navigationDiagnostic('target-identity-verified', marker, context, { mountMs: firstWait.mountMs });
            return firstWait.element;
        }

        const nativeStillPending = result?.nativeCommandIssued === true
            && result?.reason === 'command-promise-pending';
        if (nativeStillPending) {
            this._navigationDiagnostic('native-key-passive-settle', marker, context, {
                ok: false, reason: 'content-not-rendered-before-deadline'
            });
            return null;
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
        return this._fallbackScrollByUserOrder(
            marker, context, navigationStartTop, {
                restoreAnchor: navigationStartAnchor,
                nativeKeyState: result
            }
        );
    }

    async recoverDisplacedTimelineMarker(marker, context = {}) {
        const direct = this.resolveTimelineElement(marker);
        if (direct) return direct;
        if (Number(context.navigationDeadline) > 0
            && Date.now() >= Number(context.navigationDeadline)) return null;
        // Reuse the original evidence-bounded correction with the navigation's
        // remaining writes/time. The first candidate is projected from the
        // latest mounted Q anchors when available; it is not a one-shot ratio.
        return this._fallbackScrollByUserOrder(marker, context, null, {
            navigationDeadline: context.navigationDeadline,
            searchBudget: context.searchBudget,
            restoreOnFailure: false
        });
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
        if (!element) return null;
        if (element.hasAttribute('data-ait-heading-turn')) {
            const headingRect = window.AITChatGPTRolloutDOM?.rect(element) || null;
            if (headingRect && (headingRect.height > 0 || headingRect.bottom > headingRect.top)) return headingRect;
        }
        // 新版 turn 外壳可能覆盖整行或承担虚拟占位；激活和精准对齐必须
        // 使用用户正文的真实矩形，不能把外层 turn 顶部当作提问顶部。
        const content = this._findRenderedUserContent(element);
        const contentRect = content?.getBoundingClientRect?.();
        if (contentRect && contentRect.width > 0
            && (contentRect.height > 0 || contentRect.bottom > contentRect.top)) return contentRect;
        return null;
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
        
        // Temporary Chat remains on a non-durable ChatGPT route (normally `/`).
        // Only treat it as a conversation after a real turn anchor exists, so
        // the empty home page is never initialized as a timeline.
        const transientPath = segs.length === 0
            || (segs.length === 2 && segs[0] === 'g');
        return transientPath && !!this.getInitializationAnchor();
    }

    isTransientConversation() {
        return !this.extractConversationId(location.pathname)
            && !!this.getInitializationAnchor();
    }

    clearTransientTimelineData() {
        if (this._capturedSource !== 'temporary-dom') return;
        this._domOnlyTurns = [];
        this._turnTextCache.clear();
        this._scrollPositionByMessageId.clear();
        this._virtualIndexByMessageId.clear();
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
        const transcript = firstMessage?.closest?.(
            '[data-thread-find-target="conversation"], [data-chatgpt-conversation-selection-target]'
        );
        if (transcript) return transcript;
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
        if (typeof ContainerFinder === 'undefined') return null;
        const inferred = ContainerFinder.findConversationContainer(firstMessage, {
            messageSelector: context.messageSelector || this.getUserMessageSelector(),
            messages: context.userTurnElements
        });
        // Never use the whole <main> as an injection scope. It also owns the
        // app header/composer in the new two-sidebar layout.
        return inferred?.matches?.('main, body, html') ? null : inferred;
    }

    shouldManageScrollPadding() {
        // ChatGPT owns a dynamic virtual spacer. Adding another child changes
        // its estimated scrollHeight and can displace a verified navigation.
        return false;
    }

    resolveTimelineScrollContainer(anchor, conversationContainer) {
        const nativeThreadScroll = anchor?.closest?.('.thread-scroll-container')
            || conversationContainer?.closest?.('.thread-scroll-container')
            || Array.from(document.querySelectorAll?.('.thread-scroll-container') || [])
                .find(element => element.isConnected
                    && (!conversationContainer || element.contains?.(conversationContainer)));
        if (nativeThreadScroll) return nativeThreadScroll;

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
