/** dsh-inline-chat 的跨端协议。只包含可序列化的数据，不依赖浏览器或 Node。 */
export declare const INLINE_CHAT_CHANNEL = "/dsh-inline-chat";
export declare const INLINE_CHAT_STORAGE_KEY = "dsh-inline-chat:v1";
export declare const INLINE_CHAT_MODEL_STORAGE_KEY = "dsh-inline-chat:model:v1";
export interface InlineChatMessageInput {
    role: 'user' | 'assistant';
    text: string;
}
export interface InlineChatModelSelection {
    provider: string;
    model: string;
    reasoningEffort?: string;
}
export interface InlineChatStartRequest {
    messages: InlineChatMessageInput[];
    selection?: InlineChatModelSelection;
}
export interface InlineChatStartResponse {
    requestId: string;
}
export interface InlineChatModelResponse {
    selection: InlineChatModelSelection;
}
export interface InlineChatPollRequest {
    requestId: string;
}
export interface InlineChatPollResponse {
    events: InlineChatStreamEvent[];
    done: boolean;
}
export interface InlineChatCancelRequest {
    requestId: string;
}
export type InlineChatStreamEvent = {
    type: 'delta';
    text: string;
} | {
    type: 'reasoning';
    text: string;
} | {
    type: 'done';
    reason: string;
} | {
    type: 'error';
    message: string;
};
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function isInlineChatMessageInput(value: unknown): value is InlineChatMessageInput;
export declare function parseModelSelection(value: unknown): InlineChatModelSelection | undefined;
export declare function parseStartRequest(value: unknown): InlineChatStartRequest | undefined;
export declare function parseRequestId(value: unknown): string | undefined;
//# sourceMappingURL=core.d.ts.map