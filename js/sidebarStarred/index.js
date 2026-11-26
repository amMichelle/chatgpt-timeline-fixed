/**
 * Sidebar Starred - Entry Point
 *
 * 功能入口：检测当前平台是否支持侧边栏收藏列表，
 * 然后以重试机制等待侧边栏 DOM 就绪后初始化 SidebarStarredManager。
 *
 * 生命周期：
 *   1. 平台检测（feature gate）
 *   2. 等待侧边栏 DOM 出现（retry）
 *   3. 初始化 Manager
 *   4. SPA 路由变化时由 Manager 内部的 reinjectTimer 自动处理
 */

(async function () {
    const RETRY_DELAYS = [800, 1000, 1500, 2000, 2000, 3000];

    let manager = null;
    let platform = null;
    let adapter = null;
    let initInFlight = false;
    let bootstrapInFlight = false;
    let settingsListenerAttached = false;
    let stopWaiting = null;
    let enabled = false;
    let retryGeneration = 0;
    const retryTimers = new Set();

    function clearRetries() {
        retryGeneration++;
        retryTimers.forEach(timer => clearTimeout(timer));
        retryTimers.clear();
    }

    async function resolveSupport() {
        platform = await getCurrentPlatform();
        window.AITGPTDiagnostics?.log('features.sidebar-support', { platform: !!platform, supported: platform?.features?.sidebarStarred === true });
        if (!platform || platform.features?.sidebarStarred !== true) {
            platform = null;
            adapter = null;
            return false;
        }

        const registry = window.sidebarStarredAdapterRegistry;
        if (!registry) {
            adapter = null;
            return false;
        }

        adapter = await registry.getAdapter();
        return !!adapter;
    }

    // ==================== Init with retry ====================

    function canInject() {
        if (!enabled || !adapter) return false;
        const info = adapter.findInsertionPoint();
        window.AITGPTDiagnostics?.log('features.sidebar-anchor', { found: !!info, parent: !!info?.parent, offsetParent: !!info?.parent?.offsetParent, positiveHeight: (info?.parent?.offsetHeight || 0) > 0 });
        if (!info) return false;
        const { parent } = info;
        if (!parent) return false;
        const rolloutNav = platform?.id === 'chatgpt' && info.position === 'prepend';
        const rect = parent.getBoundingClientRect();
        const visible = parent.isConnected && rect.width > 0 && rect.height > 0
            && getComputedStyle(parent).display !== 'none';
        if (rolloutNav ? !visible : (!parent.offsetParent || parent.offsetHeight <= 0)) return false;
        return true;
    }

    async function initialize(retryIndex) {
        if (!enabled || manager || initInFlight) return;
        initInFlight = true;
        let candidate = null;
        try {
            await TimelineI18n.ready();
            if (!enabled) return;

            if (!adapter) {
                if (!await resolveSupport()) return;
            }

            candidate = new SidebarStarredManager(adapter);
            if (!enabled) return;
            manager = candidate;
            const ok = await candidate.init();
            window.AITGPTDiagnostics?.log('features.sidebar-init', { initialized: !!ok });

            if (manager !== candidate || !enabled) {
                candidate.destroy();
                if (manager === candidate) manager = null;
                return;
            }
            if (!ok) {
                candidate.destroy();
                manager = null;
                if (retryIndex !== undefined) {
                    initWithRetry(retryIndex + 1);
                }
            } else {
                stopWaiting?.();
            }
        } catch (error) {
            window.AITGPTDiagnostics?.error('features.sidebar-init', error);
            destroyManager();
        } finally {
            initInFlight = false;
        }
    }

    function destroyManager() {
        if (manager) {
            manager.destroy();
            manager = null;
        }
        adapter?.restoreNativeList?.();
    }

    function waitForSidebar() {
        if (!enabled || stopWaiting) return;
        const tryInitialize = () => {
            if (enabled && !manager && !initInFlight && canInject()) void initialize().catch(() => {});
        };
        const unsubscribe = window.DOMObserverManager?.getInstance().subscribeBody('sidebar-starred-mount', {
            callback: tryInitialize,
            filter: { hasAddedNodes: true },
            debounce: 200
        }) || (() => {});
        const timer = setInterval(tryInitialize, SidebarStarredManager.REINJECT_INTERVAL);
        stopWaiting = () => {
            unsubscribe();
            clearInterval(timer);
            stopWaiting = null;
        };
    }

    function initWithRetry(retryIndex = 0) {
        if (!enabled) return;
        if (retryIndex >= RETRY_DELAYS.length) {
            window.AITGPTDiagnostics?.log('features.sidebar-retry-exhausted');
            waitForSidebar();
            return;
        }

        const generation = retryGeneration;
        const timer = setTimeout(async () => {
            retryTimers.delete(timer);
            if (!enabled || generation !== retryGeneration) return;
            try {
                if (!await resolveSupport()) return;
                if (!enabled || generation !== retryGeneration) return;
                if (canInject()) {
                    await initialize(retryIndex);
                } else {
                    initWithRetry(retryIndex + 1);
                }
            } catch (error) {
            window.AITGPTDiagnostics?.error('features.sidebar-init', error);
            }
        }, RETRY_DELAYS[retryIndex]);
        retryTimers.add(timer);
    }

    function setEnabled(nextEnabled) {
        enabled = !!nextEnabled;
        clearRetries();
        if (!enabled) {
            stopWaiting?.();
            destroyManager();
            return;
        }
        if (manager) return;
        if (canInject()) void initialize(0);
        else {
            waitForSidebar();
            initWithRetry();
        }
    }

    // ==================== 监听开关变化 ====================

    function attachSettingsListener() {
        if (settingsListenerAttached) return;
        settingsListenerAttached = true;
        StorageAdapter.addChangeListener((changes, areaName) => {
            if (areaName !== 'local' || !changes.sidebarStarredPlatformSettings) return;
            if (!platform) return;
            const settings = changes.sidebarStarredPlatformSettings.newValue || {};
            setEnabled(settings[platform.id] !== false);
        });
    }

    // ==================== Bootstrap ====================

    async function bootstrap() {
        if (manager || bootstrapInFlight) return;
        bootstrapInFlight = true;
        try {
            if (!await resolveSupport()) return;
            attachSettingsListener();

            const settings = await StorageAdapter.get('sidebarStarredPlatformSettings');
            window.AITGPTDiagnostics?.log('features.sidebar-gate', { enabled: settings?.[platform.id] !== false });
            setEnabled(settings?.[platform.id] !== false);
        } catch (error) {
            window.AITGPTDiagnostics?.error('features.sidebar-init', error);
        } finally {
            bootstrapInFlight = false;
        }
    }

    bootstrap();
})();
