(function() {
    'use strict';
    
    var startTime = 0;
    
    function send(type, data) {
        try {
            window.parent.postMessage({ type: type, data: data }, '*');
        } catch (e) {
            console.error('[Sandbox] Failed to send:', type, e);
        }
    }
    
    function fmt(v, seen) {
        // 初始化循环引用检测
        if (!seen) seen = new WeakSet();
        
        // 基本类型
        if (v === null) return 'null';
        if (v === undefined) return 'undefined';
        if (typeof v === 'string') return v;
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        if (typeof v === 'bigint') return v.toString() + 'n';
        if (typeof v === 'symbol') return v.toString();
        if (typeof v === 'function') return v.toString();
        
        // 对象类型 - 先检测循环引用
        if (typeof v === 'object') {
            if (seen.has(v)) return '[Circular]';
            seen.add(v);
        }
        
        // 特殊对象类型
        if (v instanceof Error) return v.stack || v.message;
        if (v instanceof Date) return v.toString();
        if (v instanceof RegExp) return v.toString();
        if (v instanceof Map) {
            var entries = [];
            v.forEach(function(val, key) {
                entries.push(fmt(key, seen) + ' => ' + fmt(val, seen));
            });
            return 'Map(' + v.size + ') {' + entries.join(', ') + '}';
        }
        if (v instanceof Set) {
            var items = [];
            v.forEach(function(val) {
                items.push(fmt(val, seen));
            });
            return 'Set(' + v.size + ') {' + items.join(', ') + '}';
        }
        if (v instanceof Promise) return 'Promise { <pending> }';
        if (v instanceof WeakMap) return 'WeakMap { <items unknown> }';
        if (v instanceof WeakSet) return 'WeakSet { <items unknown> }';
        
        // ArrayBuffer 和 TypedArray
        if (ArrayBuffer.isView(v)) {
            return v.constructor.name + '(' + v.length + ') [' + Array.from(v).join(', ') + ']';
        }
        if (v instanceof ArrayBuffer) {
            return 'ArrayBuffer(' + v.byteLength + ')';
        }
        
        // 数组
        if (Array.isArray(v)) {
            var items = v.map(function(item) { return fmt(item, seen); });
            return '[' + items.join(', ') + ']';
        }
        
        // 普通对象
        if (typeof v === 'object') {
            try {
                var keys = Object.keys(v);
                var pairs = keys.map(function(k) {
                    return k + ': ' + fmt(v[k], seen);
                });
                return '{' + pairs.join(', ') + '}';
            } catch (e) {
                return String(v);
            }
        }
        
        return String(v);
    }
    
    var _log = console.log;
    var _err = console.error;
    var _warn = console.warn;
    var _info = console.info;
    
    console.log = function() {
        var args = Array.prototype.slice.call(arguments);
        send('SANDBOX_OUTPUT', { level: 'log', data: args.map(fmt) });
        _log.apply(console, arguments);
    };
    console.error = function() {
        var args = Array.prototype.slice.call(arguments);
        send('SANDBOX_OUTPUT', { level: 'error', data: args.map(fmt) });
        _err.apply(console, arguments);
    };
    console.warn = function() {
        var args = Array.prototype.slice.call(arguments);
        send('SANDBOX_OUTPUT', { level: 'warn', data: args.map(fmt) });
        _warn.apply(console, arguments);
    };
    console.info = function() {
        var args = Array.prototype.slice.call(arguments);
        send('SANDBOX_OUTPUT', { level: 'info', data: args.map(fmt) });
        _info.apply(console, arguments);
    };
    
    window.onerror = function(msg, src, line, col, err) {
        send('SANDBOX_ERROR', { message: String(msg), line: line, stack: err ? err.stack : null });
        return true;
    };
    window.onunhandledrejection = function(e) {
        send('SANDBOX_ERROR', { message: 'Promise rejected: ' + e.reason });
    };
    
    function executeCode(code) {
        startTime = Date.now();
        
        try {
            var AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
            var fn = new AsyncFunction(code);
            
            fn().then(function() {
                setTimeout(function() {
                    send('SANDBOX_COMPLETE', { success: true, duration: Date.now() - startTime });
                }, 10);
            }).catch(function(e) {
                send('SANDBOX_ERROR', { message: e.message, stack: e.stack });
                send('SANDBOX_COMPLETE', { success: false, duration: Date.now() - startTime });
            });
        } catch (e) {
            send('SANDBOX_ERROR', { message: e.message, stack: e.stack });
            send('SANDBOX_COMPLETE', { success: false, duration: Date.now() - startTime });
        }
    }
    
    window.addEventListener('message', function(event) {
        if (!event.data || typeof event.data !== 'object') return;
        
        if (event.data.type === 'EXECUTE_CODE') {
            executeCode(event.data.code);
        }
    });
    
    send('SANDBOX_READY', { ready: true });
})();

