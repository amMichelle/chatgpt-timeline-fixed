const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { JSDOM } = require('jsdom');

const root = join(__dirname, '../..');
const source = readFileSync(join(root, 'js/chat-width-manager/index.js'), 'utf8');
const dom = new JSDOM(`<!doctype html><html><head></head><body>
    <main style="margin-left:77px;transform:translateX(3px)">
        <div class="thread-scroll-container"><div class="max-w-(--thread-body-max-width)"></div></div>
        <div class="text-token-text-primary"><div><div id="legacy" style="max-width:640px"></div></div></div>
    </main>
</body></html>`, { url: 'https://chatgpt.com/c/layout-test', runScripts: 'outside-only' });
const { window } = dom;
window.eval(source + '\nwindow.TestChatWidthManager = ChatWidthManager;');
const manager = new window.TestChatWidthManager();
manager._config = {
    selectors: ['.text-token-text-primary > div > div'],
    responsiveRules: [{
        selector: '.thread-scroll-container [class~="max-w-(--thread-body-max-width)"]',
        base: 'var(--thread-body-max-width)'
    }]
};
manager._scale = 125;
manager._apply();
const css = window.document.getElementById('ait-chat-width-override').textContent;
assert.match(css, /var\(--thread-body-max-width\)/);
assert.doesNotMatch(css, /640px/, 'new responsive target must suppress the old fixed-pixel rule');
assert.equal(window.document.querySelector('main').style.marginLeft, '77px');
assert.equal(window.document.querySelector('main').style.transform, 'translateX(3px)');
manager.destroy();
assert.equal(window.document.getElementById('ait-chat-width-override'), null);
console.log('PASS: ChatGPT width override uses the native responsive variable and never shifts main.');
