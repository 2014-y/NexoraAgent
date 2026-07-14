export async function init(config = {}) {
    const replyModel = config.replyModel || 'agnes-ai/agnes-2.0-flash';
    const taskModel = config.taskModel || 'agnes-ai/agnes-2.0-flash';
    const fallbackModel = config.fallbackModel || '';
    const defaultModel = config.defaultModel || 'agnes-ai/agnes-2.0-flash';

    console.log('[channel-router] All models → agnes-2.0-flash');

    function classifyMessage(text) {
        if (!text || typeof text !== 'string') return 'default';
        const lower = text.toLowerCase();
        const replyKeywords = config.replyKeywords || [];
        const taskKeywords = config.taskKeywords || [];
        for (const kw of replyKeywords) {
            if (lower.includes(kw.toLowerCase())) return 'reply';
        }
        for (const kw of taskKeywords) {
            if (lower.includes(kw.toLowerCase())) return 'task';
        }
        return 'default';
    }

    const handler = async (context) => {
        const message = context.message || {};
        const text = message.text || '';
        if (!text) return context;

        const type = classifyMessage(text);
        const model = defaultModel; // 全部用 agnes-2.0-flash

        context.selectedModel = model;
        context.metadata = {
            ...(context.metadata || {}),
            channelRouter: { type, model }
        };
        return context;
    };

    return { name: '@openclaw/channel-router', version: '1.0.0', handler, classifyMessage };
}
export { init };
