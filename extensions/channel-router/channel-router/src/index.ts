/**
 * channel-router - 消息路由插件
 * 
 * 功能:
 * 1. 拦截所有 incoming 消息
 * 2. 判断是"回复消息"还是"任务"
 * 3. 回复消息 → 轻量模型 (agnes-1.5-flash)
 * 4. 任务消息 → 重模型 (agnes-2.0-flash) + Computer Use
 * 5. 未知消息 → 默认模型
 */

import type { HookContext, HookHandler } from 'openclaw-plugin-types';

export async function init(config: Record<string, unknown>) {
    const replyModel = (config.replyModel as string) || 'agnes-ai/agnes-1.5-flash';
    const taskModel = (config.taskModel as string) || 'agnes-ai/agnes-2.0-flash';
    const fallbackModel = (config.fallbackModel as string) || 'ollama/gemma4:latest';
    const replyKeywords = (config.replyKeywords as string[]) || [];
    const taskKeywords = (config.taskKeywords as string[]) || [];
    const defaultModel = (config.defaultModel as string) || 'agnes-ai/agnes-2.0-flash';

    console.log('[channel-router] Initialized');
    console.log('[channel-router] Reply model:', replyModel);
    console.log('[channel-router] Task model:', taskModel);

    // 判断消息类型
    function classifyMessage(text: string): 'reply' | 'task' | 'default' {
        if (!text || typeof text !== 'string') return 'default';
        
        const lower = text.toLowerCase();
        
        // 检查回复关键词
        for (const kw of replyKeywords) {
            if (lower.includes(kw.toLowerCase())) {
                return 'reply';
            }
        }
        
        // 检查任务关键词
        for (const kw of taskKeywords) {
            if (lower.includes(kw.toLowerCase())) {
                return 'task';
            }
        }
        
        // 默认走任务模型（因为大部分有用消息都是任务）
        return 'default';
    }

    // Hook handler - 拦截消息
    const handler: HookHandler = async (context: HookContext) => {
        const { message, user, channel, metadata } = context;
        const text = message?.text || '';
        
        if (!text) {
            return context; // 非文本消息走默认路由
        }

        const type = classifyMessage(text);
        let model: string;

        switch (type) {
            case 'reply':
                model = replyModel;
                console.log(`[channel-router] Message classified as 'reply', using ${model}`);
                break;
            case 'task':
                model = taskModel;
                console.log(`[channel-router] Message classified as 'task', using ${model}`);
                break;
            default:
                model = defaultModel;
                console.log(`[channel-router] Message classified as 'default', using ${model}`);
        }

        // 注入模型选择
        context.selectedModel = model;
        context.metadata = {
            ...metadata,
            channelRouter: {
                type,
                model,
                originalMessage: text.substring(0, 100)
            }
        };

        return context;
    };

    return {
        name: '@openclaw/channel-router',
        version: '1.0.0',
        handler,
        classifyMessage
    };
}
