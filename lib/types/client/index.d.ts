import { type ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
export declare const name = "dsh-inline-chat-client";
export declare const inject: readonly ["connection"];
interface ClientContext {
    connection: ConnectionHandle;
    on?: (name: 'dispose', callback: () => void) => void;
}
export declare function apply(ctx: ClientContext): void;
export {};
//# sourceMappingURL=index.d.ts.map