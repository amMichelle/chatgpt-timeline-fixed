/**
 * MermaidRunner - Mermaid 图表渲染器
 * 
 * 将 Mermaid DSL 代码渲染为 SVG 图表，作为 Runner 体系的一种"预览型"语言。
 * 行为类似 MarkdownRunner / HtmlRunner：不执行代码，只渲染预览。
 * 
 * 依赖：mermaid.min.js（全局 window.mermaid）
 */

class MermaidRunner extends BaseRunner {
    constructor() {
        super({
            language: 'mermaid',
            displayName: 'Mermaid',
            icon: '📊',
            fileExtension: '.mmd'
        });
        this._idCounter = 0;
    }

    /**
     * 生成唯一渲染 ID
     */
    _uniqueId() {
        return `mermaid-run-${Date.now().toString(36)}-${(this._idCounter++).toString(36)}`;
    }

    /**
     * 清理特殊空白字符
     */
    _sanitize(code) {
        return code
            .replace(/[\u00A0\u2002\u2003\u2009\u200A\u3000]/g, ' ')
            .replace(/[\u200B\u200C\u200D\u200E\u200F\uFEFF]/g, '');
    }

    /**
     * 配置 mermaid 实例
     * 固定使用浅色主题，因为 Runner 输出面板中的预览容器始终是白底
     */
    _configure() {
        if (typeof mermaid === 'undefined') return false;

        mermaid.initialize({
            startOnLoad: false,
            theme: 'default',
            securityLevel: 'loose',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
            logLevel: 'error'
        });
        return true;
    }

    /**
     * 执行（渲染）Mermaid 代码
     * @param {string} code - Mermaid 源码
     * @param {Object} options
     * @returns {Promise}
     */
    async execute(code, options = {}) {
        const startTime = Date.now();
        const { onOutput = () => {} } = options;

        try {
            if (typeof mermaid === 'undefined') {
                throw new Error('Mermaid library not loaded');
            }

            this._configure();

            const cleaned = this._sanitize(code);
            const id = this._uniqueId();

            // 兼容 v8 (回调/同步) 和 v10+ (Promise)
            const renderFn = mermaid.render || mermaid.mermaidAPI?.render;
            if (!renderFn) throw new Error('mermaid.render not available');

            let svg = null;
            const result = renderFn.call(mermaid, id, cleaned);

            if (result && typeof result.then === 'function') {
                // v10+
                const resolved = await result;
                svg = typeof resolved === 'string' ? resolved : resolved?.svg || null;
            } else if (typeof result === 'string' && result.includes('<svg')) {
                // v8/v9 同步返回
                svg = result;
            } else {
                // v8 回调 fallback
                svg = await new Promise((resolve) => {
                    try {
                        renderFn.call(mermaid, id, cleaned, (s) => resolve(s || null));
                    } catch { resolve(null); }
                });
            }

            if (!svg) throw new Error('Mermaid render returned empty result');

            onOutput({
                level: 'mermaid-preview',
                data: { svg: svg }
            });

            return {
                success: true,
                duration: Date.now() - startTime,
                language: this.language
            };
        } catch (error) {
            // 清理 mermaid 可能遗留的错误 DOM
            document.querySelectorAll('[id^="mermaid-run-"][id*="d"]').forEach(el => {
                if (!el.closest('.runner-container')) el.remove();
            });

            onOutput({
                level: 'error',
                data: [error.message || 'Mermaid render failed']
            });

            return {
                success: false,
                error: error.message,
                language: this.language
            };
        }
    }

    cleanup() {}

    getPlaceholder() {
        return 'graph TD\n    A[Start] --> B[End]';
    }

    getExampleCode() {
        return `graph TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Process A]
    B -->|No| D[Process B]
    C --> E[End]
    D --> E`;
    }
}

// 导出
if (typeof window !== 'undefined') {
    window.MermaidRunner = MermaidRunner;
}
