import { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { Context } from "@deepseek-ai/cordis";
import { HostConnectionHandle } from "@deepseek-ai/dsh-client-connection";
import { AgentDefaultModelConfig } from "@deepseek-ai/dsh-agent-default-model";

//#region src/index.d.ts
declare const name = "dsh-inline-chat";
declare const inject: readonly ["connection", "llm", "agentDefaultModel"];
interface HostContext extends Context {
  connection: HostConnectionHandle;
  llm: LlmRuntime;
  agentDefaultModel: AgentDefaultModelConfig;
}
declare function apply(ctx: HostContext): void;
//#endregion
export { apply, inject, name };