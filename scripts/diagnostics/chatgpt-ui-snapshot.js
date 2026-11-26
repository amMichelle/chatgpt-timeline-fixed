// Paste this whole file into the ChatGPT DevTools Console.
// Read-only and sanitized: no message text, URL/IDs, account data, cookies,
// tokens, request data, storage values, or React property values are read.
(async () => {
    const startedAt = Date.now();
    const round = value => Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
    const visible = element => {
        if (!element?.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const classShape = element => Array.from(element?.classList || [])
        .filter(name => /(?:thread|scroll|sidebar|composer|header|timeline|ait-|overflow|max-w|flex)/i.test(name)).slice(0, 20);
    const cssVars = style => Array.from(style).filter(name => name.startsWith('--')
        && /(?:sidebar|thread|composer|header|nav|width|content|main)/i.test(name)).slice(0, 30)
        .reduce((out, name) => { out[name] = String(style.getPropertyValue(name)).trim().slice(0, 100); return out; }, {});
    const describe = element => {
        if (!element) return null;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
            tag: element.tagName.toLowerCase(), visible: visible(element),
            rect: { x: round(rect.x), y: round(rect.y), left: round(rect.left), top: round(rect.top),
                right: round(rect.right), bottom: round(rect.bottom), width: round(rect.width), height: round(rect.height) },
            style: { display: style.display, position: style.position, overflowX: style.overflowX,
                overflowY: style.overflowY, width: style.width, maxWidth: style.maxWidth,
                margin: style.margin, padding: style.padding, transform: style.transform },
            scroll: { top: round(element.scrollTop || 0), height: element.scrollHeight || 0, client: element.clientHeight || 0 },
            classes: classShape(element), cssVars: cssVars(style),
            attributes: Array.from(element.attributes || [], ({ name }) => name)
                .filter(name => /^(?:role|aria-|data-(?:app-action-sidebar-section|scroll-root|virtualized-list|test-render-count|thread-find-target|chatgpt-conversation-selection-target|ait-))/.test(name)).sort()
        };
    };
    const firstVisible = selector => Array.from(document.querySelectorAll(selector)).find(visible) || null;
    const main = firstVisible('main');
    const header = firstVisible('main header, header');
    const prompt = firstVisible('form[data-type="unified-composer"], [data-testid="composer"], #prompt-textarea');
    const composer = prompt?.closest('form, [data-testid="composer"], main > div') || null;
    const primaryNav = firstVisible('body > div nav, nav[aria-label]');
    const secondarySidebar = firstVisible('nav [data-app-action-sidebar-section]')?.closest('nav, aside, [class*="sidebar"]')
        || Array.from(document.querySelectorAll('nav, aside')).filter(visible)
            .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[1] || null;
    const scrollCandidates = Array.from(document.querySelectorAll(
        'main, main *, [data-scroll-root], [data-virtualized-list], .thread-scroll-container'
    )).filter(element => {
        const style = getComputedStyle(element);
        return /auto|scroll|overlay/.test(style.overflowY) || element.scrollHeight > element.clientHeight + 10;
    }).sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight)).slice(0, 12);
    const actualScroll = window.timelineManager?.scrollContainer || scrollCandidates[0] || null;
    const message = firstVisible('[data-ait-heading-turn="user"], [data-turn="user"], [data-message-author-role="user"]');
    const ancestors = [];
    for (let node = message, depth = 0; node && depth < 12; node = node.parentElement, depth++) {
        ancestors.push({ depth, tag: node.tagName.toLowerCase(), classes: classShape(node),
            attributes: Array.from(node.attributes || [], ({ name }) => name)
                .filter(name => /^(?:role|data-|aria-)/.test(name)).sort().slice(0, 30),
            rect: describe(node)?.rect });
    }
    const reactPrefixes = ['__reactFiber$', '__reactProps$', '__reactContainer$', '__reactInternalInstance$'];
    const methodPattern = /^(?:scrollToKey|scrollToIndex|scrollToItem|scrollToOffset|getVirtualItems|getTotalSize|measureElement|getScrollElement|getCount)$/;
    const candidateRoots = [message, actualScroll, main];
    for (let node = message, depth = 0; node && depth < 10; node = node.parentElement, depth++) candidateRoots.push(node);
    const queue = [];
    candidateRoots.filter(Boolean).forEach(root =>
        Object.getOwnPropertyNames(root).filter(key => reactPrefixes.some(prefix => key.startsWith(prefix)))
            .forEach(key => { try { queue.push({ value: root[key], depth: 0 }); } catch {} }));
    const seen = new WeakSet();
    const reactCandidates = [];
    for (let scanned = 0; queue.length && scanned < 2500; scanned++) {
        const item = queue.shift();
        const value = item?.value;
        if (!value || !['object', 'function'].includes(typeof value) || seen.has(value)) continue;
        seen.add(value);
        let keys = [];
        try { keys = Object.getOwnPropertyNames(value).slice(0, 100); } catch {}
        const methods = keys.filter(key => methodPattern.test(key) && typeof value[key] === 'function');
        if (methods.length) reactCandidates.push({ depth: item.depth, type: typeof value, methods: methods.sort(),
            shape: keys.filter(key => /virtual|scroll|range|index|item|count|options|turn|retained|rowkey/i.test(key)).slice(0, 30).sort() });
        if (item.depth >= 10 || reactCandidates.length >= 20) continue;
        keys.filter(key => /virtual|scroll|list|range|index|item|ref|state|props|current|child|return|alternate|queue/i.test(key))
            .slice(0, 50).forEach(key => {
                try { const child = value[key]; if (child && ['object', 'function'].includes(typeof child)) queue.push({ value: child, depth: item.depth + 1 }); } catch {}
            });
    }
    const timelineElements = Array.from(document.querySelectorAll('[class*="ait-"], [data-ait-heading-turn]')).slice(0, 100);
    const snapshotScroll = label => ({ label, timeOffsetMs: Date.now() - startedAt,
        container: describe(actualScroll),
        mountedUsers: document.querySelectorAll('[data-ait-heading-turn="user"], [data-turn="user"], [data-message-author-role="user"]').length,
        targetRect: describe(message)?.rect || null });
    const before = snapshotScroll('before');
    await new Promise(resolve => setTimeout(resolve, 1600)); // You may scroll during this sampling window.
    const after = snapshotScroll('after');
    const report = {
        revision: 9, route: /\/c\/[^/]+/.test(location.pathname) ? 'conversation'
            : location.pathname.includes('/share/') ? 'share' : 'other',
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        layout: { primaryNav: describe(primaryNav), secondarySidebar: describe(secondarySidebar),
            main: describe(main), header: describe(header), composer: describe(composer), actualScroll: describe(actualScroll) },
        scrollCandidates: scrollCandidates.map(describe),
        extension: {
            timelineWrapper: describe(document.querySelector('.ait-chat-timeline-wrapper')),
            starred: describe(document.querySelector('.ait-sidebar-starred')),
            conversationContainer: describe(window.timelineManager?.conversationContainer),
            overrides: timelineElements.map(element => ({ tag: element.tagName.toLowerCase(),
                classes: classShape(element), inlineStyleNames: Array.from(element.style || [], name => name).sort() })).slice(0, 60)
        },
        messageStructure: { mountedUsers: before.mountedUsers, ancestors },
        virtualizer: { scannedLimit: 2500, candidates: reactCandidates },
        stability: { before, after, delta: {
            scrollHeight: (after.container?.scroll?.height || 0) - (before.container?.scroll?.height || 0),
            scrollTop: round((after.container?.scroll?.top || 0) - (before.container?.scroll?.top || 0)),
            mountedUsers: after.mountedUsers - before.mountedUsers,
            targetTop: round((after.targetRect?.top || 0) - (before.targetRect?.top || 0))
        } }
    };
    const output = '[AIT-GPT-UI-SNAPSHOT]\n' + JSON.stringify(report, null, 2);
    if (typeof copy === 'function') copy(output); else console.info(output);
    return report;
})();
