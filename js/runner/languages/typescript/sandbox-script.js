/**
 * TypeScript Sandbox Script
 * 
 * 在 iframe 沙箱中编译并执行 TypeScript 代码
 */

(function() {
    'use strict';

    /**
     * 发送消息到父窗口
     */
    function postMessage(type, data) {
        if (window.parent && window.parent !== window) {
            window.parent.postMessage({ type, data }, '*');
        }
    }

    /**
     * 发送输出
     */
    function postOutput(level, ...args) {
        postMessage('TS_OUTPUT', {
            level: level,
            data: args
        });
    }

    /**
     * 发送加载进度
     */
    function postLoading(message) {
        postMessage('TS_LOADING', { message });
    }

    /**
     * 编译 TypeScript 代码
     */
    function compileTypeScript(code) {
        if (typeof ts === 'undefined') {
            throw new Error('TypeScript 编译器未加载');
        }

        const result = ts.transpileModule(code, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2020,
                module: ts.ModuleKind.None,
                strict: false,
                esModuleInterop: true,
                skipLibCheck: true,
                forceConsistentCasingInFileNames: true,
                noEmit: false
            }
        });

        // 检查编译错误
        if (result.diagnostics && result.diagnostics.length > 0) {
            const errors = result.diagnostics.map(d => {
                const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
                if (d.file && d.start !== undefined) {
                    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
                    return `行 ${line + 1}, 列 ${character + 1}: ${message}`;
                }
                return message;
            });
            throw new Error('编译错误:\n' + errors.join('\n'));
        }

        return result.outputText;
    }

    /**
     * 执行编译后的 JavaScript 代码
     */
    function executeJavaScript(jsCode) {
        // 重写 console 方法以捕获输出
        const originalConsole = {
            log: console.log,
            error: console.error,
            warn: console.warn,
            info: console.info
        };

        console.log = (...args) => {
            postOutput('log', ...args.map(formatValue));
        };
        console.error = (...args) => {
            postOutput('error', ...args.map(formatValue));
        };
        console.warn = (...args) => {
            postOutput('warn', ...args.map(formatValue));
        };
        console.info = (...args) => {
            postOutput('info', ...args.map(formatValue));
        };

        try {
            // 使用 Function 构造器执行代码（比 eval 更安全）
            const fn = new Function(jsCode);
            const result = fn();
            
            // 如果有返回值，输出它
            if (result !== undefined) {
                postOutput('result', formatValue(result));
            }
        } finally {
            // 恢复原始 console
            Object.assign(console, originalConsole);
        }
    }

    /**
     * 格式化输出值
     */
    function formatValue(value) {
        if (value === null) return 'null';
        if (value === undefined) return 'undefined';
        if (typeof value === 'object') {
            try {
                return JSON.stringify(value, null, 2);
            } catch (e) {
                return String(value);
            }
        }
        return String(value);
    }

    /**
     * 执行 TypeScript 代码
     */
    function executeTypeScript(code) {
        const startTime = Date.now();

        try {
            postLoading('正在编译 TypeScript...');
            
            // 编译 TS -> JS
            const jsCode = compileTypeScript(code);
            
            postLoading('编译完成，正在执行...');
            
            // 执行 JS
            executeJavaScript(jsCode);

            const duration = Date.now() - startTime;
            postMessage('TS_COMPLETE', { success: true, duration });

        } catch (error) {
            const duration = Date.now() - startTime;
            
            let errorMessage = error.message || String(error);
            
            postMessage('TS_ERROR', { message: errorMessage });
            postMessage('TS_COMPLETE', { success: false, duration, error: errorMessage });
        }
    }

    /**
     * 监听来自父窗口的消息
     */
    window.addEventListener('message', (event) => {
        if (!event.data || typeof event.data !== 'object') return;
        
        const { type, code } = event.data;
        
        if (type === 'EXECUTE_TS' && code) {
            executeTypeScript(code);
        }
    });

    // 通知父窗口沙箱已准备就绪
    postMessage('TS_SANDBOX_READY', {});

})();

