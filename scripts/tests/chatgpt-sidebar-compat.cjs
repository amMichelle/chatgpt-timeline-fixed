const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { JSDOM } = require('jsdom');

const root = join(__dirname, '../..');
const baseSource = readFileSync(join(root, 'js/sidebarStarred/adapters/base.js'), 'utf8');
const adapterSource = readFileSync(join(root, 'js/sidebarStarred/adapters/chatgpt.js'), 'utf8');
const managerSource = readFileSync(join(root, 'js/sidebarStarred/sidebar-starred-manager.js'), 'utf8');

function createWindow(html) {
    return new JSDOM(html, {
        url: 'https://chatgpt.com/c/test-conversation',
        runScripts: 'outside-only'
    }).window;
}

{
    const window = createWindow(`
        <nav aria-hidden="true"><div class="overflow-y-auto" id="hidden-parent"><div><section data-app-action-sidebar-section></section></div></div></nav>
        <nav><div class="overflow-y-auto" id="visible-parent"><div><section data-app-action-sidebar-section></section></div></div></nav>
    `);
    for (const id of ['hidden-parent', 'visible-parent']) {
        window.document.getElementById(id).getBoundingClientRect = () => ({
            width: 280, height: 600, left: 0, right: 280, top: 0, bottom: 600
        });
    }
    window.eval(`${baseSource}\n${adapterSource}\nwindow.TestChatGPTSidebarAdapter = ChatGPTSidebarStarredAdapter;`);
    const point = new window.TestChatGPTSidebarAdapter().findInsertionPoint();
    assert.equal(point.parent.id, 'visible-parent', 'visible sidebar must win over a hidden retained copy');
    assert.equal(point.position, 'before');
}

{
    const window = createWindow('<nav><div id="parent"><section id="anchor"></section></div></nav>');
    let tick = null;
    window.setInterval = callback => { tick = callback; return 1; };
    window.clearInterval = () => {};
    window.FolderManager = class {};
    window.StarredTreeRenderer = class { destroy() {} _clearDropIndicator() {} };
    window.StorageAdapter = { removeChangeListener() {} };
    window.eval(`${managerSource}\nwindow.TestSidebarStarredManager = SidebarStarredManager;`);

    const parent = window.document.getElementById('parent');
    const anchor = window.document.getElementById('anchor');
    let point = { parent, reference: anchor, position: 'before' };
    const adapter = { findInsertionPoint: () => point, destroyNativeMenu() {}, refreshStarredIcons() {} };
    const manager = new window.TestSidebarStarredManager(adapter);
    manager.container = window.document.createElement('div');
    manager.container.className = 'ait-sidebar-starred';
    parent.insertBefore(manager.container, anchor);
    manager._startReinjectCheck();

    point = null;
    tick();
    assert.equal(manager.container.isConnected, true, 'transient anchor loss must not delete the owned folder tree');
    assert.equal(manager.container.parentNode, parent);
}

{
    const window = createWindow('<nav><a id="conversation" data-ait-hidden style="display:none"><i data-ait-starred-icon></i></a></nav><div data-ait-star-folder></div>');
    window.eval(`${baseSource}\nwindow.TestBaseSidebarAdapter = BaseSidebarStarredAdapter;`);
    const adapter = new window.TestBaseSidebarAdapter();
    adapter.restoreNativeList();
    const conversation = window.document.getElementById('conversation');
    assert.equal(conversation.hasAttribute('data-ait-hidden'), false);
    assert.equal(conversation.style.display, '');
    assert.equal(window.document.querySelector('[data-ait-starred-icon]'), null);
    assert.equal(window.document.querySelector('[data-ait-star-folder]'), null);
}

console.log('PASS: visible ChatGPT sidebar selection, transient-anchor preservation and full native-list cleanup.');
