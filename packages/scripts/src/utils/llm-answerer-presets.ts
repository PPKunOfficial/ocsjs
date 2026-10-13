import type { AnswererWrapper, LLMApiFormat, LLMAnswererConfig } from '@ocsjs/core';

/**
 * LLM（大模型）答题预设与配置组装
 *
 * 本模块是**纯数据模块**：只负责「预设 + 用户输入 → AnswererWrapper（llm 字段）」的双向转换，
 * 不依赖 DOM / easy-us / 项目全局状态，因此可被 UI（llm-answerer-ui.ts）、common.ts 与单元测试直接复用。
 *
 * 请求路径拼接规则与 core 的 llm-answerer.adapter.ts 保持一致：
 *   completions → {baseUrl}/chat/completions
 *   response    → {baseUrl}/responses
 *   anthropic   → {baseUrl}/messages
 *   systemone   → {baseUrl}/systemone
 */

/**
 * 密钥占位符：少数服务商（或中转站）要求把密钥写在地址里，
 * 该占位符会**原样**写入 url，由适配器在真正请求时替换为 API Key。
 */
// eslint-disable-next-line no-template-curly-in-string
export const LLM_API_KEY_PLACEHOLDER = '${apiKey}';

/** LLM 接口预设 id（顺序即表单下拉顺序，custom 放最后） */
export type LLMPresetId =
	| 'openai'
	| 'openai-responses'
	| 'anthropic'
	| 'deepseek'
	| 'moonshot'
	| 'zhipu'
	| 'qwen'
	| 'gemini'
	/** System One（TypeSafe Jev）类模型：只做选择/判断 */
	| 'jev'
	| 'digitalocean'
	| 'custom';

/** LLM 接口预设 */
export interface LLMPreset {
	id: LLMPresetId;
	/** 展示名，例如 'OpenAI 兼容 (Chat Completions)' */
	name: string;
	/** 接口格式，决定请求路径与请求体结构 */
	apiFormat: LLMApiFormat;
	/** 默认接口基地址（不含 /chat/completions 等路径） */
	baseUrl: string;
	/** 默认模型 */
	model: string;
	/** 常用模型下拉候选（可编辑的 datalist 用） */
	models: string[];
	/** 额外提示，例如需要代理或特殊 header */
	note?: string;
}

/** 自定义预设（不在下拉中特殊处理，仅作为兜底返回） */
const CUSTOM_PRESET: LLMPreset = {
	id: 'custom',
	name: '自定义 (兼容 OpenAI / Anthropic 协议)',
	apiFormat: 'completions',
	baseUrl: '',
	model: '',
	models: [],
	note: '自定义接口：需要自己填写基地址（不含 /chat/completions 等路径）与模型名，接口需兼容所选格式。'
};

/** 全部 LLM 预设（顺序即表单下拉顺序） */
export const LLM_PRESETS: LLMPreset[] = [
	{
		id: 'openai',
		name: 'OpenAI 兼容 (Chat Completions)',
		apiFormat: 'completions',
		baseUrl: 'https://api.openai.com/v1',
		model: 'gpt-4o-mini',
		models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'o4-mini', 'o3-mini'],
		note: '官方 OpenAI 接口。o 系列（o3-mini / o4-mini）是思考模型，请开启下方「思考（推理）」。'
	},
	{
		id: 'openai-responses',
		name: 'OpenAI Responses API',
		apiFormat: 'response',
		baseUrl: 'https://api.openai.com/v1',
		model: 'gpt-4o-mini',
		models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'o4-mini', 'o3'],
		note: 'OpenAI 新版 Responses 接口，与 o 系列思考模型配合更好；同样是 https://api.openai.com/v1。'
	},
	{
		id: 'anthropic',
		name: 'Anthropic Claude (Messages)',
		apiFormat: 'anthropic',
		baseUrl: 'https://api.anthropic.com/v1',
		model: 'claude-sonnet-4-5',
		models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-latest'],
		note: 'Claude 使用 x-api-key 鉴权（适配器自动处理）。开启思考时用「思考预算 token」控制，且不能自定义温度。'
	},
	{
		id: 'deepseek',
		name: 'DeepSeek 深度求索',
		apiFormat: 'completions',
		baseUrl: 'https://api.deepseek.com/v1',
		model: 'deepseek-chat',
		models: ['deepseek-chat', 'deepseek-reasoner'],
		note: 'deepseek-reasoner 是思考模型：回答更准但更慢更贵，请开启「思考（推理）」；deepseek-chat 不需要。'
	},
	{
		id: 'moonshot',
		name: 'Moonshot Kimi',
		apiFormat: 'completions',
		baseUrl: 'https://api.moonshot.cn/v1',
		model: 'moonshot-v1-8k',
		models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-k2-0711-preview'],
		note: 'Kimi 开放平台接口，kimi-k2 系列上下文更长，题目较长时优先选它。'
	},
	{
		id: 'zhipu',
		name: '智谱 GLM',
		apiFormat: 'completions',
		baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
		model: 'glm-4-flash',
		models: ['glm-4-flash', 'glm-4-plus', 'glm-z1-air'],
		note: 'glm-4-flash 免费额度较多；glm-z1-air 是思考模型。'
	},
	{
		id: 'qwen',
		name: '阿里云通义千问 (百炼)',
		apiFormat: 'completions',
		baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
		model: 'qwen-plus',
		models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwq-32b'],
		note: '使用百炼的 OpenAI 兼容模式；qwq-32b 是思考模型，需要在控制台开通该模型。'
	},
	{
		id: 'gemini',
		name: 'Google Gemini (OpenAI 兼容)',
		apiFormat: 'completions',
		baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
		model: 'gemini-2.0-flash',
		models: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
		note: '使用 Gemini 的 OpenAI 兼容模式，Key 以 Bearer 头发送，不需要在地址里写 ?key=。'
	},
	{
		id: 'jev',
		name: 'TypeSafe Jev（System One）',
		apiFormat: 'systemone',
		baseUrl: 'https://api.typesafe.ai/v1',
		model: 'jev-latest',
		models: ['jev-latest', 'jev-1.13.0', 'jev-preview'],
		note: 'System One（Jev）只做选择/判断，不支持填空题与图片输入；多选题按「多选判定阈值」逐个选项判定。'
	},
	{
		id: 'digitalocean',
		name: 'DigitalOcean Jev',
		apiFormat: 'systemone',
		baseUrl: 'https://inference.do-ai.run/v1',
		model: 'typesafe-jev-1.13.0',
		models: ['typesafe-jev-1.13.0'],
		note: 'DigitalOcean 托管的 System One，需要在 DigitalOcean 后台创建 Model Access Key 并填到 API Key。'
	},
	CUSTOM_PRESET
];

/** 按 id 取预设（未知 id 时返回自定义预设，避免运行时报错） */
export function getLLMPreset(id: LLMPresetId): LLMPreset {
	return LLM_PRESETS.find((preset) => preset.id === id) ?? CUSTOM_PRESET;
}

/**
 * LLM 答题表单值（同时是 buildLLMWrapper 的完整入参形态）
 *
 * 字段与 UI 表单一一对应，parseLLMWrapper 的输出可直接作为表单初始值。
 */
export interface LLMAnswererFormValue {
	/** 预设 id（'custom' 表示完全自己填写） */
	presetId: LLMPresetId;
	/** 接口格式，决定请求路径与请求体结构 */
	apiFormat: LLMApiFormat;
	/** 接口基地址（不含 /chat/completions 等格式路径，可含 ${apiKey} 占位符） */
	baseUrl: string;
	/** 模型名称，例如 gpt-4o-mini / deepseek-chat */
	model: string;
	/** API 密钥 */
	apiKey: string;
	/** 系统提示词（支持 ${title} / ${options} / ${type} 占位符），留空 = 使用适配器默认提示词 */
	systemPrompt: string;
	/** 用户提示词模板（支持 ${title} / ${options} / ${type} 占位符），留空 = 由适配器按题面自动拼装 */
	userPrompt: string;
	/** 最大输出 token（默认 512） */
	maxTokens: number;
	/** 采样温度，undefined = 不下发该参数（思考模式建议留空） */
	temperature: number | undefined;
	/** 是否开启思考（推理） */
	reasoning: boolean;
	/** 思考强度（默认 medium） */
	reasoningEffort: 'minimal' | 'low' | 'medium' | 'high';
	/** 思考预算 token（默认 2048，仅 anthropic 思考模式生效） */
	budgetTokens: number;
	/** 服务端不支持思考参数（400/422）时自动去掉重试一次（默认 true） */
	fallback: boolean;
	/** 是否发送题目图片（需多模态模型） */
	images: boolean;
	/** 单题库超时秒数（默认 120，思考模型较慢） */
	timeoutSeconds: number;
	/** 请求方式：GM_xmlhttpRequest（跨域，默认）或 fetch（需接口允许 CORS） */
	requestType: 'GM_xmlhttpRequest' | 'fetch';
	/** System One（Jev）多选判定阈值（0~1，默认 0.5），仅 apiFormat === 'systemone' 生效 */
	noulThreshold?: number;
	/** System One（Jev）最低置信度（0~1，0 = 不校验），仅 apiFormat === 'systemone' 生效 */
	minConfidence?: number;
}

/**
 * 宽松的构建入参：只有 baseUrl / model / apiKey 必填，其余缺省时使用默认值，
 * 便于测试与外部调用（也兼容旧的 LLMPresetInput 用法）。
 */
export type LLMPresetInput = Pick<LLMAnswererFormValue, 'baseUrl' | 'model' | 'apiKey'> &
	Partial<Omit<LLMAnswererFormValue, 'baseUrl' | 'model' | 'apiKey'>>;

/** 各接口格式对应的请求路径 */
export function llmEndpointPath(apiFormat: LLMApiFormat): string {
	switch (apiFormat) {
		case 'completions':
			return '/chat/completions';
		case 'response':
			return '/responses';
		case 'anthropic':
			return '/messages';
		case 'systemone':
			return '/systemone';
		default:
			return '/chat/completions';
	}
}

/**
 * 解析 http/https 基地址：解析前先把 ${apiKey} 占位符替换掉（URL 解析不接受它），
 * 只在解析成功且协议为 http/https 时返回 URL，相对地址 / 非法地址返回 undefined（保持宽松行为）
 */
function parseHttpUrl(baseUrl: string): URL | undefined {
	const checked = baseUrl.split(LLM_API_KEY_PLACEHOLDER).join('LLM_API_KEY');
	try {
		const parsed = new URL(checked);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

/**
 * 基地址是否需要补 /v1 版本段：Anthropic 文档给的基地址是 https://api.anthropic.com，
 * System One（Jev）文档给的基地址是 https://api.typesafe.ai（都不含版本段），
 * 而两者的接口都恒定挂在 /v1 下；能解析为 http/https 且路径中没有 /v<数字> 版本段时才需要补
 */
function needsVersionSegment(baseUrl: string): boolean {
	const parsed = parseHttpUrl(baseUrl);
	return !!parsed && !/\/v\d+/i.test(parsed.pathname);
}

/**
 * 归一化接口基地址：去掉首尾空格与末尾斜杠，并去掉用户误粘贴的格式路径
 * （保证与适配器「基地址 + 路径」规则一致，避免拼出 /v1/chat/completions/chat/completions）
 *
 * 另外对 Anthropic 与 System One（Jev）追加一条版本段规则：
 * https://api.anthropic.com → https://api.anthropic.com/v1、https://api.typesafe.ai → https://api.typesafe.ai/v1。
 * 追加在原始字符串上进行（不经过 URL 重建），因此 ${apiKey} 占位符等原始字符会被完整保留。
 */
export function normalizeLLMBaseUrl(baseUrl: string, apiFormat: LLMApiFormat): string {
	const trimmed = (baseUrl || '').trim().replace(/\/+$/, '');
	const path = llmEndpointPath(apiFormat);
	let normalized = trimmed;
	if (path && trimmed.toLowerCase().endsWith(path.toLowerCase())) {
		normalized = trimmed.slice(0, -path.length).replace(/\/+$/, '');
	}
	if ((apiFormat === 'anthropic' || apiFormat === 'systemone') && needsVersionSegment(normalized)) {
		normalized = normalized.replace(/\/+$/, '') + '/v1';
	}
	return normalized;
}

/**
 * 拼出真正的请求地址（与适配器一致）：归一化基地址 + 接口路径
 * @param baseUrl 接口基地址（可含 ${apiKey} 占位符，原样保留）
 * @param apiFormat 接口格式
 * @param endpoint 请求路径覆盖（默认按 apiFormat 推导）
 */
export function buildLLMRequestUrl(baseUrl: string, apiFormat: LLMApiFormat, endpoint?: string): string {
	const base = normalizeLLMBaseUrl(baseUrl, apiFormat);
	const path = endpoint ? (endpoint.startsWith('/') ? endpoint : '/' + endpoint) : llmEndpointPath(apiFormat);
	return base + path;
}

/** 思考强度候选 */
const REASONING_EFFORTS: LLMAnswererFormValue['reasoningEffort'][] = ['minimal', 'low', 'medium', 'high'];

/** 归一化思考强度（未知值回退 medium） */
function normalizeReasoningEffort(effort?: string): LLMAnswererFormValue['reasoningEffort'] {
	return REASONING_EFFORTS.find((item) => item === effort) ?? 'medium';
}

/** 正整数兜底：非法值（空/非数字/<=0）返回默认值 */
function resolvePositiveInt(value: number | undefined, fallback: number): number {
	if (value === undefined || value === null || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.floor(value);
}

/** 正数兜底：非法值返回默认值 */
function resolvePositiveNumber(value: number | undefined, fallback: number): number {
	if (value === undefined || value === null || !Number.isFinite(value) || value <= 0) return fallback;
	return value;
}

/** 温度兜底：非法值返回 undefined（不下发），超出 0~2 时截断到范围内 */
function resolveTemperature(value: number | undefined): number | undefined {
	if (value === undefined || value === null || !Number.isFinite(value)) return undefined;
	return Math.min(2, Math.max(0, value));
}

/** 0~1 比例兜底（阈值 / 置信度）：非法值返回默认值，超出范围截断到 0~1 */
function resolveUnitNumber(value: number | undefined, fallback: number): number {
	if (value === undefined || value === null || !Number.isFinite(value)) return fallback;
	return Math.min(1, Math.max(0, value));
}

/** 在错误信息里遮蔽用户直接写在地址中的密钥，避免把 Key 显示到页面上 */
function maskApiKey(text: string, apiKey: string): string {
	if (!apiKey || !text.includes(apiKey)) return text;
	return text.split(apiKey).join('***');
}

/** 校验必填项（接口地址 / 模型 / 密钥），不合法时抛带中文说明的 Error */
function assertLLMConfig(baseUrl: string, model: string, apiKey: string): void {
	if (!baseUrl) {
		throw new Error('接口地址不能为空，请填写服务商提供的基地址，例如 https://api.openai.com/v1');
	}
	// ${apiKey} 是允许的占位符，校验语法时先替换掉，避免误报格式错误
	const checked = baseUrl.split(LLM_API_KEY_PLACEHOLDER).join('LLM_API_KEY');
	let parsed: URL;
	try {
		parsed = new URL(checked);
	} catch {
		throw new Error(
			maskApiKey('接口地址格式不正确：' + baseUrl + '，请填写完整地址，例如 https://api.openai.com/v1', apiKey)
		);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error('接口地址必须以 http:// 或 https:// 开头，当前为：' + parsed.protocol.replace(':', ''));
	}
	if (!model) {
		throw new Error('模型名称不能为空，请填写服务商提供的模型名，例如 deepseek-chat');
	}
	if (!apiKey) {
		throw new Error('API Key 不能为空，请到服务商后台创建后填写');
	}
}

/** 用 baseUrl + apiFormat 反查预设 id（找不到则为 custom） */
function matchLLMPreset(baseUrl: string, apiFormat: LLMApiFormat): LLMPresetId {
	const target = normalizeLLMBaseUrl(baseUrl, apiFormat);
	if (target) {
		const found = LLM_PRESETS.find(
			(preset) =>
				preset.id !== 'custom' &&
				preset.apiFormat === apiFormat &&
				normalizeLLMBaseUrl(preset.baseUrl, preset.apiFormat) === target
		);
		if (found) return found.id;
	}
	return 'custom';
}

/** 预设展示名去掉括号部分（作为模型名为空时的题库名兜底） */
function presetLabel(preset: LLMPreset): string {
	return preset.name.replace(/[（(].*$/, '').trim() || 'LLM';
}

/**
 * 组装 AnswererWrapper（llm 字段 + 兼容旧字段 url / method / type / headers / data / handler）
 *
 * - baseUrl / model / apiKey 一律以入参为准（即使与 presetId 的默认值不一致也不报错）
 * - url 是适配器真正请求的地址，供「连接检测」与 @connect 白名单校验使用（仅保留 ${apiKey} 占位符）
 * - handler 不会被 LLM 题库执行（响应由适配器直接解析），但解析器字段要求非空字符串
 *
 * @throws Error 接口地址为空/格式错误、模型为空、API Key 为空时抛出中文错误（由 UI 展示）
 */
export function buildLLMWrapper(input: LLMPresetInput): AnswererWrapper {
	const apiFormat: LLMApiFormat = input.apiFormat ?? getLLMPreset(input.presetId ?? 'custom').apiFormat;
	const preset = getLLMPreset(input.presetId ?? matchLLMPreset(input.baseUrl ?? '', apiFormat));
	const baseUrl = normalizeLLMBaseUrl(input.baseUrl ?? '', apiFormat);
	const model = (input.model ?? '').trim();
	const apiKey = (input.apiKey ?? '').trim();
	assertLLMConfig(baseUrl, model, apiKey);

	// System One（Jev）类模型没有思考参数：强制关闭思考（effort / budgetTokens 也不会写入）
	const reasoningEnabled = input.reasoning === true && apiFormat !== 'systemone';
	const requestType: 'GM_xmlhttpRequest' | 'fetch' = input.requestType === 'fetch' ? 'fetch' : 'GM_xmlhttpRequest';

	const llm: LLMAnswererConfig = {
		apiFormat,
		baseUrl,
		model,
		apiKey,
		systemPrompt: (input.systemPrompt ?? '').trim() || undefined,
		userPrompt: (input.userPrompt ?? '').trim() || undefined,
		// System One（Jev）不支持图片输入：与 UI 中禁用的「发送图片」一致，一律不下发图片
		images: input.images === true && apiFormat !== 'systemone',
		maxTokens: resolvePositiveInt(input.maxTokens, 512),
		temperature: resolveTemperature(input.temperature),
		reasoning: {
			enabled: reasoningEnabled,
			effort: reasoningEnabled ? normalizeReasoningEffort(input.reasoningEffort) : undefined,
			budgetTokens: reasoningEnabled ? resolvePositiveInt(input.budgetTokens, 2048) : undefined,
			fallback: input.fallback !== false
		},
		type: requestType
	};

	// System One（Jev）专属参数：只在该格式写入，保证既有格式的配置形态与既有断言完全不变
	if (apiFormat === 'systemone') {
		llm.noulThreshold = resolveUnitNumber(input.noulThreshold, 0.5);
		llm.minConfidence = resolveUnitNumber(input.minConfidence, 0);
	}

	return {
		name: `AI 答题（${model || presetLabel(preset)}）`,
		url: buildLLMRequestUrl(baseUrl, apiFormat),
		homepage: 'https://docs.ocsjs.com/docs/work',
		method: 'post',
		type: requestType,
		contentType: 'json',
		responseType: 'json',
		headers: { 'Content-Type': 'application/json' },
		data: {},
		handler: 'return (res)=> []',
		llm,
		timeout: resolvePositiveNumber(input.timeoutSeconds, 120)
	};
}

/** 是否为 LLM 题库配置 */
export function isLLMWrapper(wrapper: AnswererWrapper): boolean {
	return !!(wrapper && wrapper.llm);
}

/**
 * 从已保存的 LLM 题库配置反解出表单初值（编辑场景）
 * @returns 未配置 llm 字段时返回 undefined
 */
export function parseLLMWrapper(wrapper: AnswererWrapper): LLMAnswererFormValue | undefined {
	const llm = wrapper && wrapper.llm;
	if (!llm) return undefined;
	const apiFormat: LLMApiFormat = llm.apiFormat ?? 'completions';
	const baseUrl = llm.baseUrl ?? '';
	const parsed: LLMAnswererFormValue = {
		presetId: matchLLMPreset(baseUrl, apiFormat),
		apiFormat,
		baseUrl: normalizeLLMBaseUrl(baseUrl, apiFormat),
		model: llm.model ?? '',
		apiKey: llm.apiKey ?? '',
		systemPrompt: llm.systemPrompt ?? '',
		userPrompt: llm.userPrompt ?? '',
		maxTokens: resolvePositiveInt(llm.maxTokens, 512),
		temperature: resolveTemperature(llm.temperature),
		reasoning: llm.reasoning?.enabled === true,
		reasoningEffort: normalizeReasoningEffort(llm.reasoning?.effort),
		budgetTokens: resolvePositiveInt(llm.reasoning?.budgetTokens, 2048),
		fallback: llm.reasoning?.fallback !== false,
		images: llm.images === true,
		timeoutSeconds: resolvePositiveNumber(wrapper.timeout, 120),
		requestType: llm.type === 'fetch' ? 'fetch' : 'GM_xmlhttpRequest'
	};
	// System One（Jev）专属参数：仅该格式（或配置里确实写了这两个字段）才反解，
	// 避免给既有格式的表单值凭空补字段、影响既有断言
	if (apiFormat === 'systemone' || llm.noulThreshold !== undefined || llm.minConfidence !== undefined) {
		parsed.noulThreshold = resolveUnitNumber(llm.noulThreshold, 0.5);
		parsed.minConfidence = resolveUnitNumber(llm.minConfidence, 0);
	}
	return parsed;
}
