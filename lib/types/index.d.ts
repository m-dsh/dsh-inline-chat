import type { Context } from '@deepseek-ai/cordis';
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection';
import { type LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model';
export declare const name = "dsh-inline-chat";
export declare const inject: readonly ["connection", "llm", "agentDefaultModel"];
interface HostContext extends Context {
    connection: HostConnectionHandle;
    llm: LlmRuntime;
    agentDefaultModel: AgentDefaultModelConfig;
}
export declare function apply(ctx: HostContext): void;
export {};
//# sourceMappingURL=index.d.ts.map