/**
 * LLM 答题适配器
 *
 * 把「题库配置」（{@link AnswererWrapper}.llm）翻译成一次大模型接口调用：
 * 构造请求（四种接口格式 + 思考参数）→ 发送 → 解析响应 → 解析答案。
 *
 * 与题库搜索的区别：不再请求题库接口，而是直接向大模型提问，
 * 因此这里完全不使用 wrapper.url / wrapper.data / wrapper.handler。
 */
import { AnswererWrapper, LLMApiFormat, LLMAnswererConfig, SearchInformation } from './interface';
import { request } from '../utils/request';
import { AnswerWrapperHandlerConfig } from './answer.wrapper.handler';
import { buildLLMSystemPrompt, buildLLMUserPrompt } from './llm-answerer.prompt';
import { parseLLMAnswerText } from './llm-answerer.parser';
import { isJudgementOptions } from '../worker/resolvers';

export { parseLLMAnswerText };

/** 多模态图片（data URL） */
export interface LLMImagePart {
	dataUrl: string;
}

/** 适配器构造出的单次请求描述 */
export interface LLMRequestSpec {
	url: string;
	method: 'post';
	headers: Record<string, string>;
	body: Record<string, any>;
	/** 该请求是否带上了思考（reasoning）参数；systemone 等不支持思考的格式为 undefined */
	reasoning?: boolean;
}

/** LLM 每次请求携带的题面信息（与 defaultAnswerWrapperHandler 的 env 同构） */
export interface LLMAnswererEnv {
	title?: string;
	/**
	 * 选项文本：与 defaultAnswerWrapperHandler 一致为按行拼接的字符串
	 * （运行时也兼容直接传选项数组，见 normalizeOptionList）
	 */
	options?: string;
	type?: string;
	images?: string[];
	suggestion_title?: string;
	suggestion_options?: string;
	[x: string]: any;
}

/** 从原始响应中提取出的内容（systemone 额外返回置信度等信息） */
export interface LLMResponseExtract {
	/** 模型可见的答案文本（systemone 为字母或判断题选项原文） */
	text: string;
	/** 思考内容（无则 undefined） */
	reasoning?: string;
	/** 置信度（仅 systemone 等接口返回） */
	confidence?: number;
	/** 各选项概率（仅 systemone：多选为 label → noul，单选为接口原样返回） */
	probabilities?: Record<string, number>;
	/** token 用量（仅 systemone 等接口返回） */
	usage?: Record<string, any>;
}

/** 从模型答案文本中解析出题库答案（可自定义，见 wrapper.llm.answerResolver） */
export type AnswerResolver = (answerText: string, env: LLMAnswererEnv) => string;

/**
 * 网络传输层的最小抽象，可注入（测试用）
 *
 * `timeout` 单位为毫秒，会原样传给 {@link request} 的 timeout 选项。
 */
export interface LLMTransportRequest {
	url: string;
	method: 'post';
	headers: Record<string, string>;
	body: any;
	timeout: number;
}

/** 传输层返回值 */
export interface LLMTransportResponse {
	status: number;
	text: string;
}

/** 传输层实现 */
export interface LLMTransport {
	(r: LLMTransportRequest): Promise<LLMTransportResponse>;
}

/** 一次 LLM 答题的完整结果 */
export interface LLMAnswererResult {
	/** 解析出的答案（交给题库答案匹配器，如 "A" / "AB" / "选项原文" / 填空题答案） */
	answer: string;
	/** 模型可见的最终文本 */
	answerText: string;
	/** 思考内容（无则 undefined） */
	reasoning?: string;
	/** 是否因为在 400/422 后去掉思考参数重试而成功 */
	reasoningFallback?: boolean;
	/** 置信度（仅 systemone 等接口返回） */
	confidence?: number;
	/** 实际发出的最后一次请求 */
	request: LLMRequestSpec;
	/** 原始响应对象 */
	response: any;
	status: number;
}

/** requestLLMAnswerer 的可选项 */
export interface LLMAnswererOptions {
	env: LLMAnswererEnv;
	/** 注入网络传输（测试用），默认走 request() */
	transport?: LLMTransport;
	/** 超时秒数，默认 wrapper.timeout ?? AnswerWrapperHandlerConfig.timeout_seconds ?? 60 */
	timeout?: number;
	/** 默认最大输出 token，默认 AnswerWrapperHandlerConfig.max_tokens ?? 512 */
	defaultMaxTokens?: number;
}

/** LLM 请求异常（带 HTTP 状态码） */
export class LLMRequestError extends Error {
	status: number;
	response?: any;
	constructor(status: number, message: string, response?: any) {
		super(message);
		this.name = 'LLMRequestError';
		this.status = status;
		this.response = response;
		// 兼容部分环境（如 ES5 编译产物）下继承内置 Error 的原型链
		Object.setPrototypeOf(this, LLMRequestError.prototype);
	}
}

/** 接口未声明但允许用户透传的扩展字段 */
type LLMAnswererConfigExtras = LLMAnswererConfig & {
	/** 自定义请求头（会覆盖默认头） */
	headers?: Record<string, string>;
	/** 自定义答案解析器 */
	answerResolver?: AnswerResolver;
};

/** 各接口格式的默认路径 */
const DEFAULT_ENDPOINTS: Record<LLMApiFormat, string> = {
	completions: '/chat/completions',
	response: '/responses',
	anthropic: '/messages',
	systemone: '/systemone'
};

/** anthropic 必需版本头 */
const ANTHROPIC_VERSION = '2023-06-01';

/** anthropic 思考（interleaved thinking）beta 头 */
const ANTHROPIC_THINKING_BETA = 'interleaved-thinking-2025-05-14';

/** 默认思考预算 */
const DEFAULT_THINKING_BUDGET = 2048;

/** anthropic 思考时 max_tokens 至少要比预算多出的余量 */
const THINKING_TOKEN_MARGIN = 1024;

/** systemone 多选（noul）默认判定阈值 */
const DEFAULT_NOUL_THRESHOLD = 0.5;

/** 选项标签：索引 0 → A、1 → B…… */
function optionLabel(index: number): string {
	return String.fromCharCode(65 + index);
}

/** 字母标签 → 选项索引（'A' → 0），非法标签返回 -1 */
function labelIndex(label: string): number {
	const normalized = (label || '').trim().toUpperCase();
	if (!/^[A-Z]$/.test(normalized)) return -1;
	return normalized.charCodeAt(0) - 65;
}

/** 占位符解析：值非字符串时 JSON.stringify，缺失时替换为空串 */
export function resolveLLMPlaceholders(text: string, env: LLMAnswererEnv): string {
	if (typeof text !== 'string' || !text) return '';
	const e = env || {};
	return text.replace(/\$\{\s*([^}]+?)\s*\}/g, (origin: string, key: string) => {
		if (!Object.prototype.hasOwnProperty.call(e, key)) return '';
		const value = e[key];
		if (value === undefined || value === null) return '';
		return typeof value === 'string' ? value : JSON.stringify(value);
	});
}

/** data URL 归一化：已带 data: 前缀的原样返回，否则补 image/png */
function ensureDataUrl(image: string): string {
	return /^data:/i.test(image) ? image : 'data:image/png;base64,' + image;
}

/** 拆分 data URL */
function parseDataUrl(dataUrl: string): { mediaType: string; data: string } {
	const match = /^data:([^;,]*)(?:;[^,]*)?,([\s\S]*)$/i.exec(dataUrl);
	if (!match) return { mediaType: 'image/png', data: dataUrl };
	return { mediaType: (match[1] || '').trim() || 'image/png', data: match[2] || '' };
}

/** 过滤并归一化图片列表 */
function normalizeImageParts(images?: string[]): LLMImagePart[] {
	if (!Array.isArray(images)) return [];
	return images
		.filter((image) => typeof image === 'string' && image.trim().length > 0)
		.map((image) => ({ dataUrl: ensureDataUrl(image.trim()) }));
}

/** 组装请求地址：endpoint 覆盖 > 绝对地址 > baseUrl + 默认路径，最后替换 ${apiKey} */
function buildLLMRequestUrl(config: LLMAnswererConfig): string {
	const endpoint = (config.endpoint || '').trim();
	const apiFormat = config.apiFormat || 'completions';
	let url: string;
	if (/^https?:\/\//i.test(endpoint)) {
		url = endpoint;
	} else {
		const baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
		const path = endpoint || DEFAULT_ENDPOINTS[apiFormat] || DEFAULT_ENDPOINTS.completions;
		url = baseUrl + (path.charAt(0) === '/' ? path : '/' + path);
	}
	const apiKey = config.apiKey || '';
	// 拼接出 ${apiKey} 占位符（不直接写模板串，避免误以为是模板字符串）
	const keyPlaceholder = '$' + '{apiKey}';
	if (url.indexOf(keyPlaceholder) >= 0) {
		url = url.split(keyPlaceholder).join(encodeURIComponent(apiKey));
	}
	return url;
}

/** 组装请求头：默认 JSON + 鉴权头，用户自定义头最后覆盖 */
function buildLLMRequestHeaders(config: LLMAnswererConfig): Record<string, string> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	const apiKey = config.apiKey || '';
	const reasoningEnabled = !!(config.reasoning && config.reasoning.enabled);
	if (apiKey) {
		if (config.apiFormat === 'anthropic') {
			headers['x-api-key'] = apiKey;
			headers['anthropic-version'] = ANTHROPIC_VERSION;
			if (reasoningEnabled) headers['anthropic-beta'] = ANTHROPIC_THINKING_BETA;
		} else {
			headers.Authorization = 'Bearer ' + apiKey;
		}
	}
	const extras = (config as LLMAnswererConfigExtras).headers;
	if (extras && typeof extras === 'object') Object.assign(headers, extras);
	return headers;
}

/** 组装用户消息内容：无图片时是字符串，有图片时是对应格式的多模态数组 */
function buildUserContent(apiFormat: LLMApiFormat, userPrompt: string, images: LLMImagePart[]): string | any[] {
	if (!images.length) return userPrompt;
	if (apiFormat === 'anthropic') {
		const parts: any[] = images.map((image) => {
			const parsed = parseDataUrl(image.dataUrl);
			return {
				type: 'image',
				source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data }
			};
		});
		parts.push({ type: 'text', text: userPrompt });
		return parts;
	}
	if (apiFormat === 'response') {
		const parts: any[] = images.map((image) => ({ type: 'input_image', image_url: image.dataUrl }));
		parts.push({ type: 'text', text: userPrompt });
		return parts;
	}
	return [
		{ type: 'text', text: userPrompt },
		...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } }))
	];
}

/** systemone 不支持填空类题型时给出的提示 */
const SYSTEMONE_COMPLETION_ERROR =
	'System One（Jev）类模型不支持填空：只能做选择/判断，无法生成填空答案，请改用 chat/completions 或 anthropic 等生成式格式。';

/** 选项标签前缀（"A. " / "A、" / "A)" 等） */
const OPTION_LABEL_PREFIX_RE = /^\s*([A-Za-z])\s*[.．、)）:：]\s*/;

/** 去掉与自身序号一致的选项标签前缀（"A. 甲" → "甲"），避免 criteria / 原文里重复出现标签 */
function stripOptionLabelPrefix(text: string, index: number): string {
	const matched = OPTION_LABEL_PREFIX_RE.exec(text);
	if (matched && matched[1].toUpperCase() === optionLabel(index)) {
		const stripped = text.slice(matched[0].length).trim();
		if (stripped) return stripped;
	}
	return text;
}

/**
 * 归一化选项列表：数组直接使用，字符串按行拆分
 * （题库 handler 的 env.options 通常已是按行拼接的字符串，此处兼容两种形态）
 *
 * 同时去掉与序号一致的标签前缀，System One 会按索引重新编号 A/B/C…，
 * 选项原文里再带一份旧标签只会干扰判断。
 */
function normalizeOptionList(raw: any): string[] {
	const list: string[] = [];
	if (Array.isArray(raw)) {
		raw.forEach((option) => {
			const text = option === undefined || option === null ? '' : String(option).trim();
			if (text) list.push(text);
		});
	} else if (typeof raw === 'string') {
		raw.split(/\r?\n/).forEach((line) => {
			const text = line.trim();
			if (text) list.push(text);
		});
	}
	return list.map((text, index) => stripOptionLabelPrefix(text, index));
}

/**
 * systemone 的 questions 字段
 *
 * - 多选：每个选项一个 noul 问题，逐个判定「是否为正确答案之一」
 * - 单选 / 判断：单个 choice 问题，选项作为 criteria
 * - 填空：接口无法生成自由文本，直接抛错提示改用生成式格式
 */
function buildSystemOneQuestions(env: LLMAnswererEnv): Record<string, any> {
	const type = (env && env.type) || '';
	const options = normalizeOptionList(env && env.options);
	if (type === 'completion') throw new Error(SYSTEMONE_COMPLETION_ERROR);
	if (options.length < 2) {
		throw new Error('System One（Jev）类模型需要至少 2 个选项（当前 ' + options.length + ' 个），无法作答。');
	}
	if (type === 'multiple') {
		const questions: Record<string, any> = {};
		options.forEach((optionText, index) => {
			const label = optionLabel(index);
			questions[label] = {
				type: 'noul',
				instructions: '本题为多选题，判断选项 ' + label + '「' + optionText + '」是否为正确答案之一。'
			};
		});
		return questions;
	}
	const criteria: Record<string, string> = {};
	options.forEach((optionText, index) => {
		criteria[optionLabel(index)] = optionText;
	});
	const instructions =
		type === 'judgement'
			? '本题为判断题，请从 criteria 中选出正确的选项。'
			: '本题为选择题，请从 criteria 中选出唯一正确答案。';
	return { answer: { type: 'choice', instructions, criteria } };
}

/**
 * 按 apiFormat 构造请求（纯函数，便于单测）
 *
 * @param config 题库 LLM 配置
 * @param env 题面环境
 * @param opts maxTokens 覆盖
 */
export function buildLLMAnswererRequest(
	config: LLMAnswererConfig,
	env: LLMAnswererEnv,
	opts?: { maxTokens?: number }
): LLMRequestSpec {
	const apiFormat: LLMApiFormat = config.apiFormat || 'completions';
	const reasoningEnabled = !!(config.reasoning && config.reasoning.enabled);
	const effort = (config.reasoning && config.reasoning.effort) || 'medium';
	const systemPrompt = buildLLMSystemPrompt(config, env);
	const userPrompt = buildLLMUserPrompt(config, env);
	const images = config.images ? normalizeImageParts((env || {}).images) : [];
	const content = buildUserContent(apiFormat, userPrompt, images);
	const maxTokens =
		config.maxTokens ?? (opts ? opts.maxTokens : undefined) ?? AnswerWrapperHandlerConfig.max_tokens ?? 512;
	const temperature = typeof config.temperature === 'number' ? config.temperature : 0.3;
	const body: Record<string, any> = {};

	if (apiFormat === 'anthropic') {
		let finalTemperature = temperature;
		let finalMaxTokens = maxTokens;
		let thinking: Record<string, any> | undefined;
		if (reasoningEnabled) {
			const budget = (config.reasoning && config.reasoning.budgetTokens) || DEFAULT_THINKING_BUDGET;
			thinking = { type: 'enabled', budget_tokens: budget };
			// 开启思考时 anthropic 要求 temperature 必须为 1，且 max_tokens 必须大于思考预算
			finalTemperature = 1;
			finalMaxTokens = Math.max(maxTokens, budget + THINKING_TOKEN_MARGIN);
		}
		body.model = config.model;
		body.system = systemPrompt;
		body.max_tokens = finalMaxTokens;
		body.temperature = finalTemperature;
		body.messages = [{ role: 'user', content }];
		if (thinking) body.thinking = thinking;
	} else if (apiFormat === 'response') {
		body.model = config.model;
		body.instructions = systemPrompt;
		body.input = content;
		body.max_output_tokens = maxTokens;
		body.temperature = temperature;
		if (reasoningEnabled && effort !== 'none') body.reasoning = { effort };
	} else if (apiFormat === 'systemone') {
		// System One / Jev：只做类型化判断，不发送 temperature / max_tokens / 思考 / 图片
		body.model = config.model;
		body.state = resolveLLMPlaceholders((env && env.title) || '', env);
		body.questions = buildSystemOneQuestions(env);
	} else {
		body.model = config.model;
		body.messages = [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content }
		];
		body.stream = false;
		if (reasoningEnabled) {
			// 思考模型普遍不接受 temperature，并且用 max_completion_tokens 代替 max_tokens
			if (effort !== 'none') body.reasoning_effort = effort;
			body.max_completion_tokens = maxTokens;
		} else {
			body.max_tokens = maxTokens;
			body.temperature = temperature;
		}
	}

	return {
		url: buildLLMRequestUrl(config),
		method: 'post',
		headers: buildLLMRequestHeaders(config),
		body,
		// systemone 不支持思考参数，保持 undefined 以跳过「去掉思考重试」逻辑
		reasoning: apiFormat === 'systemone' ? undefined : reasoningEnabled
	};
}

/** 取第一个非空字符串 */
function firstNonEmptyString(...values: any[]): string | undefined {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) return value;
	}
	return undefined;
}

/** 把字符串 / 内容块数组拼成文本 */
function joinParts(value: any): string {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) {
		return value
			.map((part) => {
				if (typeof part === 'string') return part;
				if (!part || typeof part !== 'object') return '';
				return firstNonEmptyString(part.text, part.output_text, part.content) || '';
			})
			.join('');
	}
	if (value && typeof value === 'object')
		return firstNonEmptyString(value.text, value.output_text, value.content) || '';
	return '';
}

/** completions 格式解析 */
function extractCompletionsText(root: any): { text: string; reasoning?: string } {
	const choice = root && Array.isArray(root.choices) ? root.choices[0] : undefined;
	const message = choice ? choice.message || choice.delta : undefined;
	let text = message ? joinParts(message.content) : '';
	if (!text && choice) text = joinParts(choice.text);
	if (!text && typeof root.output_text === 'string') text = root.output_text;
	const reasoning = message
		? firstNonEmptyString(message.reasoning_content, message.reasoning, message.reasoning_text)
		: undefined;
	return { text: text || '', reasoning };
}

/** response（OpenAI Responses API）格式解析 */
function extractResponsesText(root: any): { text: string; reasoning?: string } {
	let text = typeof root.output_text === 'string' ? root.output_text : '';
	const output: any[] = root && Array.isArray(root.output) ? root.output : [];
	if (!text) {
		for (const item of output) {
			const type = String((item && item.type) || '');
			if (type === 'message') {
				text += joinParts(item.content);
			} else if (type === 'output_text') {
				text += firstNonEmptyString(item.text, item.output_text) || '';
			} else if (!type) {
				text += joinParts(item.content) || (typeof item.text === 'string' ? item.text : '');
			}
		}
	}
	const reasoningParts: string[] = [];
	for (const item of output) {
		const type = String((item && item.type) || '');
		if (type.indexOf('reasoning') === 0 || type === 'reasoning_text') {
			const piece =
				firstNonEmptyString(item.text, typeof item.content === 'string' ? item.content : undefined) ||
				joinParts(item.content) ||
				joinParts(item.summary);
			if (piece) reasoningParts.push(piece);
		}
	}
	return { text: text || '', reasoning: reasoningParts.length ? reasoningParts.join('\n') : undefined };
}

/** anthropic Messages 格式解析 */
function extractAnthropicText(root: any): { text: string; reasoning?: string } {
	const content = root ? root.content : undefined;
	let text = '';
	const reasoningParts: string[] = [];
	if (typeof content === 'string') {
		text = content;
	} else if (Array.isArray(content)) {
		for (const block of content) {
			const type = String((block && block.type) || '');
			if (type === 'text') {
				text += firstNonEmptyString(block.text, block.content) || '';
			} else if (type === 'thinking') {
				const piece = firstNonEmptyString(block.thinking, block.text);
				if (piece) reasoningParts.push(piece);
			} else if (type === 'redacted_thinking') {
				// 加密思考块完全跳过：既不进 text 也不进 reasoning，也不落占位符
			} else if (!type) {
				text += joinParts(block);
			}
		}
	} else if (content && typeof content === 'object') {
		text = joinParts(content);
	}
	return { text, reasoning: reasoningParts.length ? reasoningParts.join('\n') : undefined };
}

/** systemone 响应解包：兼容 { data: ... } 包装 */
function unwrapSystemOneRoot(response: any): any {
	if (!response || typeof response !== 'object' || Array.isArray(response)) return undefined;
	if (response.answers && typeof response.answers === 'object') return response;
	if (response.data && typeof response.data === 'object' && !Array.isArray(response.data)) return response.data;
	return response;
}

/** 从 answers 中挑出 choice 型答案（answers.answer 优先，其次任意 choice 字段） */
function pickChoiceEntry(answers: any): any {
	if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return undefined;
	const direct = answers.answer;
	if (direct && typeof direct === 'object' && typeof direct.choice === 'string') return direct;
	for (const key of Object.keys(answers)) {
		const entry = answers[key];
		if (entry && typeof entry === 'object' && typeof entry.choice === 'string') return entry;
	}
	return undefined;
}

/** 收集 noul 型答案（多选逐项判定） */
function collectNoulEntries(answers: any): { label: string; value: number }[] {
	const entries: { label: string; value: number }[] = [];
	if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return entries;
	for (const label of Object.keys(answers)) {
		const entry = answers[label];
		const value = entry && typeof entry === 'object' ? entry.noul : undefined;
		if (typeof value === 'number' && isFinite(value)) entries.push({ label, value });
	}
	return entries;
}

/** 判断题（或选项本身就是对/错两项）时，把字母映射回选项原文 */
function shouldMapToOptionText(env: LLMAnswererEnv | undefined, options: string[]): boolean {
	if (!env || !options.length) return false;
	if (env.type === 'judgement') return true;
	return isJudgementOptions(options.map((option) => option.trim()));
}

/**
 * systemone（System One / Jev）格式解析
 *
 * choice → 字母（判断题映射回选项原文）；noul → 超过阈值的选项字母拼接。
 * 仅在「一个选项都没选中」时抛中文错误，其余异常形状返回空文本由调用方提示。
 */
function extractSystemOneText(
	response: any,
	env: LLMAnswererEnv | undefined,
	noulThreshold: number
): LLMResponseExtract {
	const root = unwrapSystemOneRoot(response);
	if (!root) return { text: '' };
	const usage = root.usage && typeof root.usage === 'object' ? root.usage : undefined;
	const answers = root.answers && typeof root.answers === 'object' ? root.answers : undefined;

	// 单选 / 判断题：choice
	const choiceEntry = pickChoiceEntry(answers) || (typeof root.choice === 'string' ? root : undefined);
	if (choiceEntry) {
		const options = normalizeOptionList(env && env.options);
		let text = String(choiceEntry.choice).trim().toUpperCase();
		if (shouldMapToOptionText(env, options)) {
			const index = labelIndex(text);
			const optionText = index >= 0 && index < options.length ? options[index] : undefined;
			if (optionText) text = optionText;
		}
		return {
			text,
			confidence: typeof choiceEntry.confidence === 'number' ? choiceEntry.confidence : undefined,
			probabilities:
				choiceEntry.probabilities && typeof choiceEntry.probabilities === 'object'
					? choiceEntry.probabilities
					: undefined,
			usage
		};
	}

	// 多选题：noul 逐项判定，超过阈值的选项按字母序拼接
	const entries = collectNoulEntries(answers);
	if (!entries.length) return { text: '' };
	entries.sort((a, b) => a.label.localeCompare(b.label));
	const selected = entries.filter((entry) => entry.value >= noulThreshold);
	if (!selected.length) {
		throw new Error(
			`System One 未选出任何选项：所有选项的判定值都低于阈值 ${noulThreshold}，无法确定正确答案，` +
				'可调低 wrapper.llm.noulThreshold 后重试。'
		);
	}
	const probabilities: Record<string, number> = {};
	entries.forEach((entry) => {
		probabilities[entry.label] = entry.value;
	});
	return {
		text: selected.map((entry) => entry.label).join(''),
		confidence: Math.min(...selected.map((entry) => entry.value)),
		probabilities,
		usage
	};
}

/**
 * 从原始响应中提取 答案文本 / 思考内容（纯函数，四种格式）
 *
 * 除 systemone「未选出任何选项」外绝不抛出（形状异常时返回空文本，由调用方给出提示）。
 *
 * @param apiFormat 接口格式
 * @param response 已解析的响应对象
 * @param env 题面环境（systemone 判断题需要据此映射回选项原文）
 * @param opts 提取选项（systemone 多选阈值，默认 0.5）
 */
export function extractLLMResponseText(
	apiFormat: LLMApiFormat,
	response: any,
	env?: LLMAnswererEnv,
	opts?: { noulThreshold?: number }
): LLMResponseExtract {
	if (apiFormat === 'systemone') {
		let threshold = DEFAULT_NOUL_THRESHOLD;
		if (opts && typeof opts.noulThreshold === 'number') threshold = opts.noulThreshold;
		else if (env && typeof env.noulThreshold === 'number') threshold = env.noulThreshold;
		return extractSystemOneText(response, env, threshold);
	}
	try {
		const extract = (root: any) => {
			if (apiFormat === 'anthropic') return extractAnthropicText(root);
			if (apiFormat === 'response') return extractResponsesText(root);
			return extractCompletionsText(root);
		};
		let result = extract(response);
		// 兼容 { data: ... } 包装
		if (!result.text && !result.reasoning && response && typeof response === 'object' && !Array.isArray(response)) {
			if (response.data && typeof response.data === 'object') {
				const wrapped = extract(response.data);
				if (wrapped.text || wrapped.reasoning) result = wrapped;
			}
		}
		return { text: result.text || '', reasoning: result.reasoning || undefined };
	} catch {
		return { text: '' };
	}
}

/** 默认传输层：走 {@link request}（GM_xmlhttpRequest 跨域，node 环境自动降级 fetch） */
function createDefaultTransport(config: LLMAnswererConfig): LLMTransport {
	return async (r: LLMTransportRequest) => {
		const text = await request(r.url, {
			type: config.type || 'GM_xmlhttpRequest',
			method: 'post',
			responseType: 'text',
			headers: r.headers,
			data: r.body,
			timeout: r.timeout
		});
		return { status: 200, text: typeof text === 'string' ? text : JSON.stringify(text) };
	};
}

/**
 * 完整执行一次 LLM 答题；失败抛 {@link LLMRequestError} / Error
 *
 * @param wrapper 题库配置器（必须带 llm 配置）
 * @param opts 环境 / 超时 / 传输层
 */
export async function requestLLMAnswerer(
	wrapper: AnswererWrapper,
	opts: LLMAnswererOptions
): Promise<LLMAnswererResult> {
	const config = wrapper ? wrapper.llm : undefined;
	if (!config) throw new Error('该题库未配置 LLM 参数');
	const env: LLMAnswererEnv = opts && opts.env ? opts.env : {};
	const options = opts || ({} as LLMAnswererOptions);
	const timeoutSeconds =
		typeof options.timeout === 'number'
			? options.timeout
			: wrapper.timeout ?? AnswerWrapperHandlerConfig.timeout_seconds ?? 60;
	const timeoutMs = Math.max(1, Math.round(timeoutSeconds * 1000));
	const transport = options.transport || createDefaultTransport(config);
	let spec = buildLLMAnswererRequest(config, env, { maxTokens: options.defaultMaxTokens });
	let reasoningFallback = false;

	for (let attempt = 0; attempt < 2; attempt++) {
		let status = 0;
		let bodyText = '';
		try {
			const response = await transport({
				url: spec.url,
				method: 'post',
				headers: spec.headers,
				body: spec.body,
				timeout: timeoutMs
			});
			status = response && typeof response.status === 'number' ? response.status : 200;
			bodyText = response && typeof response.text === 'string' ? response.text : '';
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const matched = /HTTP\s*(?:status\s*)?(\d{3})/i.exec(message);
			if (!matched) {
				const wrapped = new Error('LLM 请求失败：' + message);
				(wrapped as Error & { cause?: unknown }).cause = error;
				throw wrapped;
			}
			status = Number(matched[1]);
			bodyText = message.slice(matched.index + matched[0].length).replace(/^[\s:：-]+/, '');
		}

		if (status < 200 || status >= 300) {
			const fallbackEnabled = !(config.reasoning && config.reasoning.fallback === false);
			const canFallback =
				fallbackEnabled &&
				attempt === 0 &&
				spec.reasoning &&
				(status === 400 || status === 422) &&
				/reasoning|thinking|budget_tokens|max_completion_tokens|temperature/i.test(bodyText);
			if (canFallback) {
				// 接口不支持思考参数：去掉思考重试一次
				const retryConfig: LLMAnswererConfig = {
					...config,
					reasoning: { ...(config.reasoning || {}), enabled: false }
				};
				spec = buildLLMAnswererRequest(retryConfig, env, { maxTokens: options.defaultMaxTokens });
				reasoningFallback = true;
				continue;
			}
			throw new LLMRequestError(status, '大模型接口返回 ' + status + '：' + bodyText.slice(0, 300));
		}

		let responseData: any;
		try {
			responseData = JSON.parse(bodyText);
		} catch {
			throw new Error('大模型接口返回的不是合法 JSON：' + bodyText.slice(0, 200));
		}
		const extracted = extractLLMResponseText(config.apiFormat, responseData, env, {
			noulThreshold: config.noulThreshold
		});
		const answerText = (extracted.text || '').trim();
		if (!answerText) {
			throw new Error('大模型未返回任何答案内容（可能是思考 token 用尽或接口异常）');
		}
		// 置信度校验（仅 systemone 等返回 confidence 的格式生效）
		const minConfidence = typeof config.minConfidence === 'number' ? config.minConfidence : 0;
		if (minConfidence > 0 && typeof extracted.confidence === 'number' && extracted.confidence < minConfidence) {
			throw new Error('大模型置信度 ' + extracted.confidence + ' 低于设定阈值 ' + minConfidence + '，本题不自动作答。');
		}
		const customResolver = (config as LLMAnswererConfigExtras).answerResolver;
		const resolver: AnswerResolver = typeof customResolver === 'function' ? customResolver : parseLLMAnswerText;
		const resolved = resolver(answerText, env);
		const answer = resolved === undefined || resolved === null ? '' : String(resolved).trim();
		if (!answer) {
			throw new Error('大模型返回内容中未解析出答案：' + answerText.slice(0, 200));
		}
		return {
			answer,
			answerText,
			...(extracted.reasoning ? { reasoning: extracted.reasoning } : {}),
			...(reasoningFallback ? { reasoningFallback: true } : {}),
			...(typeof extracted.confidence === 'number' ? { confidence: extracted.confidence } : {}),
			request: spec,
			response: responseData,
			status
		};
	}
	throw new Error('LLM 请求失败：已达到最大重试次数');
}

/**
 * 组装 SearchInformation（与题库搜索的结果结构保持一致）
 *
 * @param wrapper 题库配置器
 * @param result LLM 答题结果
 * @param env 题面环境
 */
export function buildLLMSearchInformation(
	wrapper: AnswererWrapper,
	result: LLMAnswererResult,
	env: LLMAnswererEnv
): SearchInformation {
	const config = (wrapper && wrapper.llm) || ({} as LLMAnswererConfig);
	return {
		name: (wrapper && wrapper.name) || 'AI 答题',
		url: (wrapper && wrapper.url) || result.request.url,
		homepage: wrapper ? wrapper.homepage : undefined,
		results: [
			{
				question: env.title ?? '',
				answer: result.answer,
				extra_data: {
					reasoning_content: result.reasoning,
					// 置信度：systemone 等接口返回，顶层与 llm 元信息内各放一份，便于 UI 与统计直接读取
					...(typeof result.confidence === 'number' ? { confidence: result.confidence } : {}),
					llm: {
						apiFormat: config.apiFormat,
						model: config.model,
						reasoningFallback: !!result.reasoningFallback,
						status: result.status,
						...(typeof result.confidence === 'number' ? { confidence: result.confidence } : {})
					}
				}
			}
		],
		response: result.response,
		data: {
			model: config.model,
			apiFormat: config.apiFormat,
			url: result.request.url,
			reasoning: !!(config.reasoning && config.reasoning.enabled)
		}
	};
}
