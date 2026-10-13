/**
 * LLM 答题提示词组装
 *
 * 默认提示词要求模型输出机器可解析的答案（见 {@link DEFAULT_LLM_ANSWER_STYLE_HINT}），
 * 用户也可以在题库配置里通过 systemPrompt / userPrompt 完全覆盖。
 */
import type { LLMAnswererConfig } from './interface';
import type { LLMAnswererEnv } from './llm-answerer.adapter';
import { resolveLLMPlaceholders } from './llm-answerer.adapter';

/** 默认答题格式要求：便于程序自动判分 */
export const DEFAULT_LLM_ANSWER_STYLE_HINT = `请严格按以下格式作答，便于程序自动判分：
- 单选题：只输出一个选项字母（例如 A），或直接输出被选中的选项原文。
- 多选题：只输出选项字母，按顺序拼接且不要添加任何分隔符（例如 AB）。
- 判断题：只输出「正确」或「错误」。
- 填空题：每个空一行，按顺序输出对应答案。
- 其他未知题型：直接输出答案文本。
推理过程写在最终答案之前，最终答案之后不要再输出任何内容，不要反问。
最后一行必须以「答案：」开头并紧跟答案本身，例如：
答案：A
也可以使用如下代码块给出答案：
\`\`\`answer
A
\`\`\`
若无法确定，请给出你最好的判断，不要请求更多信息。`;

/** 默认系统提示词 */
export const DEFAULT_LLM_SYSTEM_PROMPT = `你是一名专业的在线课程答题助手，需要根据题目和选项给出准确的答案。
${DEFAULT_LLM_ANSWER_STYLE_HINT}`;

/**
 * 组装系统提示词：配置了 systemPrompt 时使用其占位符解析结果，否则使用默认提示词
 *
 * @param config 题库 LLM 配置
 * @param env 题面环境
 */
export function buildLLMSystemPrompt(config: LLMAnswererConfig, env: LLMAnswererEnv): string {
	const custom = (config && config.systemPrompt ? config.systemPrompt : '').trim();
	if (custom) {
		const resolved = resolveLLMPlaceholders(custom, env).trim();
		if (resolved) return resolved;
	}
	return DEFAULT_LLM_SYSTEM_PROMPT;
}

/**
 * 组装用户消息文本：配置了 userPrompt 时使用其占位符解析结果，
 * 否则按 题目 / 选项 / 题型 自动拼装
 *
 * @param config 题库 LLM 配置
 * @param env 题面环境
 */
export function buildLLMUserPrompt(config: LLMAnswererConfig, env: LLMAnswererEnv): string {
	const e = env || {};
	const custom = (config && config.userPrompt ? config.userPrompt : '').trim();
	if (custom) {
		const resolved = resolveLLMPlaceholders(custom, e).trim();
		if (resolved) return resolved;
	}
	const lines = [`题目：${e.title || e.suggestion_title || ''}`];
	const options = e.options || e.suggestion_options || '';
	if (options) lines.push(`选项：${options}`);
	lines.push(`题型：${e.type || 'unknown'}`);
	return lines.join('\n');
}
