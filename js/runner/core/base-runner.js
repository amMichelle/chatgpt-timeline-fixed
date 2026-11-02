/**
 * BaseRunner - 语言运行器基类
 * 
 * 所有语言运行器必须继承此类并实现相关方法
 */

class BaseRunner {
    constructor(config = {}) {
        this.language = config.language || '';
        this.displayName = config.displayName || '';
        this.icon = config.icon || '';
        this.fileExtension = config.fileExtension || '';
        this.isInitialized = false;
    }

    /**
     * 初始化运行器
     * 子类可以覆盖此方法进行异步初始化（如加载 WASM）
     * @returns {Promise<void>}
     */
    async initialize() {
        this.isInitialized = true;
    }

    /**
     * 执行代码
     * 子类必须实现此方法
     * @param {string} code - 要执行的代码
     * @param {Object} options - 执行选项
     * @param {Function} options.onOutput - 输出回调
     * @param {number} options.timeout - 超时时间（毫秒）
     * @returns {Promise<{success: boolean, duration?: number, error?: string}>}
     */
    async execute(code, options = {}) {
        throw new Error('execute() must be implemented by subclass');
    }

    /**
     * 验证代码语法
     * 子类可以覆盖此方法
     * @param {string} code - 要验证的代码
     * @returns {{valid: boolean, error?: string, line?: number}}
     */
    validateSyntax(code) {
        return { valid: true };
    }

    /**
     * 获取示例代码
     * 子类应该覆盖此方法
     * @returns {string}
     */
    getExampleCode() {
        return '';
    }

    /**
     * 获取占位符文本
     * @returns {string}
     */
    getPlaceholder() {
        return `// Enter ${this.displayName} code here`;
    }

    /**
     * 清理资源
     * 子类可以覆盖此方法
     */
    cleanup() {
        // 子类实现
    }

    /**
     * 检查是否已初始化
     * @returns {boolean}
     */
    isReady() {
        return this.isInitialized;
    }

    /**
     * 获取运行器信息
     * @returns {Object}
     */
    getInfo() {
        return {
            language: this.language,
            displayName: this.displayName,
            icon: this.icon,
            fileExtension: this.fileExtension,
            isReady: this.isReady()
        };
    }
}

// 导出
if (typeof window !== 'undefined') {
    window.BaseRunner = BaseRunner;
}

