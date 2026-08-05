/**
 * key-rotator v2 - Channel-aware API key load balancer
 * 
 * 按渠道分流:
 *   消息类 (微信/浏览器) → 固定 key-1 (低延迟)
 *   任务类 (训练/记忆/语音/桌面) → 加权轮询 key-2~7 (高吞吐)
 */

import { EventEmitter } from 'events';

export class KeyRotator {
    constructor(config) {
        this.strategy = config?.strategy || 'channel-aware';
        this.apiKeys = (Array.isArray(config?.apiKeys) ? config.apiKeys : String(process.env.AGNES_API_KEYS || '').split(','))
            .map((key) => String(key || '').trim())
            .filter(Boolean);
        
        // 渠道分类
        this.messageChannels = ['openclaw-weixin', 'browser'];
        this.taskChannels = ['dual-model-trainer', 'memory-core', 'voice-call', 'computer-use', 'default'];
        
        // 消息类固定用 key-1
        this.messageProvider = 'agnes-ai-1';
        
        // 任务类加权轮询 key-2 ~ key-7
        this.taskWeights = {
            'agnes-ai-2': 1,
            'agnes-ai-3': 1,
            'agnes-ai-4': 1,
            'agnes-ai-5': 1,
            'agnes-ai-6': 1,
            'agnes-ai-7': 1
        };
        this.taskProviders = Object.keys(this.taskWeights);
        this.taskIndex = 0;
        
        // 健康状态
        this.health = {};
        this.failureCount = {};
        this.successCount = {};
        for (const p of [...this.taskProviders, this.messageProvider]) {
            this.health[p] = 'healthy';
            this.failureCount[p] = 0;
            this.successCount[p] = 0;
        }
        
        this.emitter = new EventEmitter();
        this.emitter.setMaxListeners(100);
        
        console.log('[key-rotator v2] Channel-aware mode');
        console.log('[key-rotator v2] Message channels →', this.messageProvider);
        console.log('[key-rotator v2] Task channels →', this.taskProviders.join(', '));
    }
    
    /**
     * 判断渠道类型
     */
    classifyChannel(source) {
        // source 可能是渠道名、插件名、或请求来源
        if (!source) return 'default';
        
        const src = typeof source === 'string' ? source.toLowerCase() : String(source);
        
        // 检查是否是消息类渠道
        for (const ch of this.messageChannels) {
            if (src.includes(ch)) return 'message';
        }
        
        // 检查是否是任务类渠道
        for (const ch of this.taskChannels) {
            if (src.includes(ch)) return 'task';
        }
        
        return 'default';
    }
    
    /**
     * 选择 provider
     */
    selectProvider(source) {
        const channel = this.classifyChannel(source);
        
        if (channel === 'message') {
            // 消息类固定走 key-1，保证低延迟
            if (this.health[this.messageProvider] !== 'healthy') {
                console.warn(`[key-rotator] ${this.messageProvider} unhealthy, fallback to task pool`);
                return this._selectTaskProvider();
            }
            return this.messageProvider;
        }
        
        // 任务类走加权轮询
        return this._selectTaskProvider();
    }
    
    /**
     * 任务类加权轮询 (round-robin + 健康检查)
     */
    _selectTaskProvider() {
        const healthy = this.taskProviders.filter(p => this.health[p] === 'healthy');
        if (healthy.length === 0) {
            console.warn('[key-rotator] No healthy task providers, using message provider');
            return this.messageProvider;
        }
        
        // Round-robin (简单轮询，健康检查自动处理异常)
        const idx = this.taskIndex % healthy.length;
        this.taskIndex++;
        
        return healthy[idx];
    }
    
    /**
     * 记录请求结果
     */
    recordResult(provider, success) {
        const threshold = 3;
        if (success) {
            this.failureCount[provider] = 0;
            this.successCount[provider]++;
            if (this.health[provider] === 'degraded') {
                this.health[provider] = 'healthy';
                console.log(`[key-rotator] ${provider} recovered`);
            }
        } else {
            this.failureCount[provider]++;
            if (this.failureCount[provider] >= threshold) {
                this.health[provider] = 'degraded';
                console.warn(`[key-rotator] ${provider} degraded`);
                this.emitter.emit('provider:degraded', provider);
            }
        }
    }
    
    /**
     * 健康检查 (仅任务类，消息类固定用 key-1 不检查)
     */
    startHealthCheck() {
        let running = false;
        setInterval(async () => {
            if (running) return;
            running = true;
            try {
            for (const p of this.taskProviders) {
                if (this.health[p] !== 'healthy') continue;
                try {
                    const key = this._getKey(p);
                    if (!key) continue;
                    const ctrl = new AbortController();
                    const tid = setTimeout(() => ctrl.abort(), 5000);
                    const resp = await fetch('https://apihub.agnes-ai.com/v1/models', {
                        headers: { 'Authorization': `Bearer ${key}` },
                        signal: ctrl.signal
                    });
                    clearTimeout(tid);
                    if (!resp.ok) this.recordResult(p, false);
                } catch {
                    this.recordResult(p, false);
                }
            }
            } finally {
                running = false;
            }
        }, 30000);
    }
    
    _getKey(provider) {
        const match = String(provider || '').match(/-(\d+)$/);
        const index = match ? Number(match[1]) - 1 : -1;
        return index >= 0 ? (this.apiKeys[index] || '') : '';
    }
    
    getStats() {
        const stats = {};
        for (const p of [...this.taskProviders, this.messageProvider]) {
            stats[p] = {
                health: this.health[p],
                failures: this.failureCount[p],
                successes: this.successCount[p]
            };
        }
        return stats;
    }
}
