/** 题目答案 */
export interface Result {
	question: string;
	answer: string;
	extra_data?: object;
}

/** 题库查询信息 */
export interface SearchInformation {
	results: Result[];
	name: string;
	url?: string;
	/** 主页 */
	homepage?: string;
	/** 题目答案 */
	/** 请求响应内容 */
	response?: any;
	/** 请求发起内容 */
	data?: any;
	/** 错误数据 */
	error?: string;
}

/** LLM 接口格式 */
export type LLMApiFormat =
	/** OpenAI 兼容的 Chat Completions：POST {baseUrl}/chat/completions */
	| 'completions'
	/** OpenAI Responses API：POST {baseUrl}/responses */
	| 'response'
	/** Anthropic Messages API：POST {baseUrl}/messages */
	| 'anthropic'
	/**
	 * TypeSafe System One / Jev：POST {baseUrl}/systemone
	 *
	 * 非生成式接口：只对题目做类型化判断（选择题 / 判断题 / 多选逐项判定），
	 * 不生成自由文本，也不支持图片、流式与思考参数。
	 */
	| 'systemone';

/** LLM 思考（推理）参数 */
export interface LLMReasoningConfig {
	/** 是否开启思考（默认 false） */
	enabled?: boolean;
	/**
	 * 思考强度：low / medium / high / minimal / none
	 * - completions 映射 reasoning_effort
	 * - response 映射 reasoning.effort
	 * - anthropic 忽略（使用 budgetTokens）
	 */
	effort?: string;
	/** 思考预算 token 数（anthropic 必填，默认 2048） */
	budgetTokens?: number;
	/**
	 * 接口不支持思考参数时（HTTP 400）自动去掉思考参数重试一次（默认 true）
	 */
	fallback?: boolean;
}

/**
 * LLM 答题配置（挂在 AnswererWrapper.llm 上）
 *
 * 配置了该字段的题库不再走「题库搜索」逻辑，而是直接调用大模型接口答题，
 * 四种接口格式与思考/非思考模型均支持，实现见 llm-answerer.adapter.ts。
 */
export interface LLMAnswererConfig {
	/** 接口格式 */
	apiFormat: LLMApiFormat;
	/** 接口基地址，例如 https://api.openai.com/v1（可含 ${apiKey} 占位符） */
	baseUrl: string;
	/** 模型名称，例如 gpt-4o-mini / claude-sonnet-4-5 / deepseek-chat */
	model: string;
	/** API 密钥（以 Bearer 方式发送，anthropic 自动改为 x-api-key） */
	apiKey: string;
	/** 请求路径覆盖（默认按 apiFormat 推导） */
	endpoint?: string;
	/** 系统提示词（支持 ${title} / ${options} / ${type} 占位符） */
	systemPrompt?: string;
	/** 用户提示词模板（支持 ${title} / ${options} / ${type} 占位符，省略时由适配器按题面自动拼装） */
	userPrompt?: string;
	/** 是否把图片（env.images，data URL）作为多模态图片发送（默认 false） */
	images?: boolean;
	/** 最大输出 token 数（默认 1024） */
	maxTokens?: number;
	/** 采样温度（默认 0.3；anthropic 开启思考时必须为 1，由适配器处理） */
	temperature?: number;
	/** 思考模型配置 */
	reasoning?: LLMReasoningConfig;
	/** systemone 多选判定阈值：noul ≥ 该值的选项视为正确答案（默认 0.5） */
	noulThreshold?: number;
	/** 最低置信度（仅 systemone 等返回 confidence 的格式）：低于该值不自动作答（0 / 未设置 = 不校验） */
	minConfidence?: number;
	/**
	 * 请求方式：默认 GM_xmlhttpRequest（跨域），脚本管理器不可用时自动降级 fetch（需接口允许 CORS）
	 */
	type?: 'fetch' | 'GM_xmlhttpRequest';
}

/**
 * 题库配置器
 */
export interface AnswererWrapper {
	/** 答题器请求路径 */
	url: string;
	/** 题库名字 */
	name: string;
	/** 题库网址 */
	homepage?: string;
	/** 请求数据 */
	data?: Record<string, any>;
	/** 请求方法 */
	method: 'post' | 'get';
	/**
	 * 定义 handler 中的参数类型
	 * @deprecated 该字段已废弃，使用 responseType 替代
	 */
	contentType?: 'json' | 'text';
	/** 定义 handler 中的参数类型 */
	responseType?: 'json' | 'text';
	/** 请求模式 */
	type: 'fetch' | 'GM_xmlhttpRequest';
	/** 附带请求头 */
	headers: Record<string, string>;
	/**
	 * 此选项是个字符串， 使用 [Function(string)](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Function) 构造方法进行解析生成方法
	 *
	 * 方法传入一个参数 : 请求获取到的文本 ，可以使用 contentType 定义文本类型
	 *
	 * 对返回的数据进行自定义解析
	 *
	 * 并且返回一个数组 : `[题目, 答案]`
	 *
	 * 或者二维数据 : `[[题目1, 答案1],[题目2, 答案2], ...`
	 *
	 * 如果搜不到则返回 undefined
	 *
	 * @example
	 *
	 * ```js
	 * {
	 *      handler: `return (res)=> res.code === 0 ? undefined : [res.question, undefined]`
	 * }
	 * ```
	 *
	 */
	handler: string;
	/**
	 * LLM 答题配置：配置后该题库走大模型答题（忽略 url / data / handler 的请求逻辑）
	 */
	llm?: LLMAnswererConfig;
	/**
	 * 单题库超时时间（秒）：不传时使用 {@link AnswerWrapperHandlerConfig.timeout_seconds}
	 * 思考模型耗时较长，可单独调大
	 */
	timeout?: number;
}
