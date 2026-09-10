import { ReasoningEffortId, createAssistantMessage, createUserMessage } from "@deepseek-ai/dsh-llm";

//#region src/core.ts
/** dsh-inline-chat 的跨端协议。只包含可序列化的数据，不依赖浏览器或 Node。 */
const INLINE_CHAT_CHANNEL = "/dsh-inline-chat";
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
function isInlineChatMessageInput(value) {
	if (!isRecord(value)) return false;
	return (value.role === "user" || value.role === "assistant") && typeof value.text === "string" && value.text.trim().length > 0 && value.text.length <= 2e4;
}
function parseModelSelection(value) {
	if (!isRecord(value)) return void 0;
	if (typeof value.provider !== "string" || typeof value.model !== "string") return void 0;
	const provider = value.provider.trim();
	const model = value.model.trim();
	if (!provider || provider.length > 200 || !model || model.length > 500) return void 0;
	if (value.reasoningEffort !== void 0 && typeof value.reasoningEffort !== "string") return void 0;
	const reasoningEffort = typeof value.reasoningEffort === "string" ? value.reasoningEffort.trim() : void 0;
	if (reasoningEffort && reasoningEffort.length > 200) return void 0;
	return {
		provider,
		model,
		...reasoningEffort ? { reasoningEffort } : {}
	};
}
function parseStartRequest(value) {
	if (!isRecord(value) || !Array.isArray(value.messages)) return void 0;
	if (value.messages.length > 50) return void 0;
	const messages = value.messages.filter(isInlineChatMessageInput);
	if (messages.length !== value.messages.length) return void 0;
	const selection = value.selection === void 0 ? void 0 : parseModelSelection(value.selection);
	if (value.selection !== void 0 && !selection) return void 0;
	return {
		messages,
		...selection ? { selection } : {}
	};
}
function parseRequestId(value) {
	if (!isRecord(value) || typeof value.requestId !== "string") return void 0;
	const requestId = value.requestId.trim();
	return requestId.length > 0 && requestId.length <= 200 ? requestId : void 0;
}

//#endregion
//#region src/index.ts
const name = "dsh-inline-chat";
const inject = [
	"connection",
	"llm",
	"agentDefaultModel"
];
function apply(ctx) {
	const pending = /* @__PURE__ */ new Map();
	let sequence = 0;
	ctx.connection.rpc.handle(INLINE_CHAT_CHANNEL, async (endpoint, payload) => {
		if (endpoint === "default-model") return success({ selection: ctx.agentDefaultModel.currentSelection() });
		if (endpoint === "start") {
			const request = parseStartRequest(payload);
			if (!request || request.messages.length === 0 || request.messages.at(-1)?.role !== "user") return failure("辅助 Chat 请求内容无效");
			const requestId = `${Date.now().toString(36)}-${(++sequence).toString(36)}`;
			const job = {
				messages: request.messages,
				selection: request.selection,
				events: [],
				done: false,
				controller: new AbortController()
			};
			pending.set(requestId, job);
			runGeneration(ctx, job);
			return success({ requestId });
		}
		if (endpoint === "poll") {
			const requestId = parseRequestId(payload);
			const job = requestId ? pending.get(requestId) : void 0;
			if (!job) return failure("辅助 Chat 请求不存在或已失效");
			const value = {
				events: job.events.splice(0),
				done: job.done
			};
			if (job.done) pending.delete(requestId);
			return success(value);
		}
		if (endpoint === "cancel") {
			const requestId = parseRequestId(payload);
			const job = requestId ? pending.get(requestId) : void 0;
			if (job) job.controller.abort();
			if (requestId) pending.delete(requestId);
			return success({ cancelled: Boolean(job) });
		}
		return failure("未知的辅助 Chat 操作");
	});
}
async function runGeneration(ctx, job) {
	const emit = (event) => {
		if (!job.controller.signal.aborted) job.events.push(event);
	};
	try {
		const selection = job.selection ?? ctx.agentDefaultModel.currentSelection();
		const messages = toModelMessages(job.messages, selection);
		const options = {
			provider: selection.provider,
			model: selection.model,
			reasoningEffort: selection.reasoningEffort ? ReasoningEffortId(selection.reasoningEffort) : void 0,
			messages,
			signal: job.controller.signal
		};
		for await (const chunk of ctx.llm.stream(options)) {
			if (job.controller.signal.aborted) return;
			if (chunk.type === "text-delta" && chunk.text) emit({
				type: "delta",
				text: chunk.text
			});
			if (chunk.type === "reasoning-delta" && chunk.text) emit({
				type: "reasoning",
				text: chunk.text
			});
			if (chunk.type === "finish") if (chunk.reason.kind === "error" || chunk.reason.kind === "aborted") emit({
				type: "error",
				message: chunk.reason.failure.message
			});
			else emit({
				type: "done",
				reason: chunk.reason.kind
			});
		}
	} catch (error) {
		if (!job.controller.signal.aborted) emit({
			type: "error",
			message: publicErrorMessage(error)
		});
	} finally {
		if (!job.controller.signal.aborted && !job.events.some((event) => event.type === "done" || event.type === "error")) emit({
			type: "done",
			reason: "stop"
		});
		job.done = true;
	}
}
function toModelMessages(inputs, selection) {
	return inputs.map((item) => {
		const content = [{
			type: "text",
			text: item.text
		}];
		if (item.role === "user") return createUserMessage({
			content,
			source: { kind: "user" }
		});
		return createAssistantMessage({
			content,
			source: {
				provider: selection.provider,
				model: selection.model
			}
		});
	});
}
function success(value) {
	return {
		ok: true,
		value
	};
}
function failure(message) {
	return {
		ok: false,
		error: {
			code: "bad-request",
			message,
			details: { issues: [] }
		}
	};
}
function publicErrorMessage(error) {
	if (isRecord(error)) {
		const failure$1 = error.failure;
		if (isRecord(failure$1) && typeof failure$1.message === "string") return failure$1.message;
		if (typeof error.message === "string") return error.message;
	}
	return "辅助 Chat 生成失败，请稍后重试";
}

//#endregion
export { apply, inject, name };