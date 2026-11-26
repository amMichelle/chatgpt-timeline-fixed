const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { JSDOM } = require('jsdom');

let source = readFileSync(join(__dirname, '../../js/timeline/index.js'), 'utf8');
source = source.replace(/bootstrapTimeline\(\)\.catch\([^\n]+\);\s*$/, '');

const dom = new JSDOM('<main></main>', {
    url: 'https://chatgpt.com/c/start',
    runScripts: 'outside-only'
});
const { window } = dom;
const pending = [];
window.SiteAdapterRegistry = class {
    detectAdapter() {
        return new Promise(resolve => pending.push(resolve));
    }
};
window.TimelineUtils = {
    removeElementSafe(element) { element?.remove(); },
    removeEventListenerSafe(target, type, listener) { target.removeEventListener(type, listener); }
};
window.TIMELINE_CONFIG = { INIT_RETRY_DELAYS: [] };
window.eval(`${source}\nwindow.__timelineLifecycleTest = { handleUrlChange, getAdapter: () => currentAdapter, getVersion: () => initVersion };`);

(async () => {
    window.history.pushState({}, '', '/c/slow-route');
    const slow = window.__timelineLifecycleTest.handleUrlChange();
    window.history.pushState({}, '', '/');
    const latest = window.__timelineLifecycleTest.handleUrlChange();

    const latestAdapter = { isConversationRoute: () => false, name: 'latest' };
    const staleAdapter = { isConversationRoute: () => true, name: 'stale' };
    pending[1](latestAdapter);
    await latest;
    pending[0](staleAdapter);
    await slow;

    assert.equal(window.__timelineLifecycleTest.getAdapter(), latestAdapter,
        'a slower route detection must not overwrite the newer route adapter');
    assert.equal(window.__timelineLifecycleTest.getVersion(), 2);

    let healthTick = null;
    window.setInterval = callback => { healthTick = callback; return 7; };
    const managerSource = readFileSync(join(__dirname, '../../js/timeline/timeline-manager.js'), 'utf8');
    window.eval(`${managerSource}\nwindow.__HealthManager = TimelineManager;`);
    const healthManager = new window.__HealthManager({ extractConversationId: () => 'test' });
    healthManager.conversationContainer = { isConnected: true };
    healthManager.ui.wrapper = { isConnected: false };
    healthManager.ui.timelineBar = { isConnected: false };
    let reinitEvents = 0;
    window.addEventListener('ait-timeline-health-reinit', () => reinitEvents++);
    healthManager.startHealthCheck();
    healthTick();
    healthTick();
    assert.equal(reinitEvents, 1, 'a disconnected wrapper requests one bounded full reinitialization');

    dom.window.close();
    console.log('PASS: stale route work is isolated and a disconnected timeline UI requests one reinitialization.');
})().catch(error => { console.error(error); process.exitCode = 1; });
