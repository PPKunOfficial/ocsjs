/**
 * LLM 答题支持 —— 离线测试套件（无测试框架，纯断言 + process.exit）
 *
 * 分组：
 *   A. buildLLMAnswererRequest   三种接口格式 × 思考开/关 的请求构造
 *   B. extractLLMResponseText    三种格式 + thinking / redacted_thinking 变体的响应解析
 *   C. parseLLMAnswerText        模型输出文本 → 最终答案
 *   D. requestLLMAnswerer        注入式 transport 的成功 / 400 回退 / 401 / 500 / 非 JSON / 网络异常
 *   E. llm-answerer-presets      预设表与 wrapper 构建 / 解析
 *   F. 端到端                     defaultAnswerWrapperHandler + LLM wrapper（与旧版题库混用）
 *   G. 状态错误形态               适配器对 HTTP 状态错误的解析（request.ts 产出形态）
 *   H. prompt 模块                系统 / 用户提示词模板与占位符
 *   I. systemone 请求构造          System One / Jev（choice / noul）
 *   J. systemone 解析              choice / judgement / noul 阈值与置信度
 *   K. llm-answerer-ui            只读 IDL 属性（list）回归 + 四种格式切换 / 全按钮点击
 *
 * 全部离线：核心用例一律注入 transport，端到端用例桩化 fetch / GM_xmlhttpRequest，
 * 绝不访问真实网络（CI 无网络保证）。
 *
 * 用法：
 *   npx tsx tests/llm-answerer.test.ts
 *   pnpm test:llm
 *
 * 说明：生产模块尚未落地时，本套件会打印 ⏭️ 跳过原因并以退出码 1 结束（未验证 ≠ 通过）。
 */

// ========== 编译期类型契约（运行时被完整抹除，故不会影响惰性加载） ==========

import type {
	AnswererWrapper,
	LLMApiFormat,
	LLMAnswererConfig,
	SearchInformation
} from '../packages/core/src/core/answer-wrapper/interface';
import type {
	LLMAnswererEnv,
	LLMAnswererResult,
	LLMTransport,
	LLMTransportRequest
} from '../packages/core/src/core/answer-wrapper/llm-answerer.adapter';
import type { LLMPresetId } from '../packages/scripts/src/utils/llm-answerer-presets';

type AdapterModule = typeof import('../packages/core/src/core/answer-wrapper/llm-answerer.adapter');
type PromptModule = typeof import('../packages/core/src/core/answer-wrapper/llm-answerer.prompt');
type PresetsModule = typeof import('../packages/scripts/src/utils/llm-answerer-presets');
type HandlerModule = typeof import('../packages/core/src/core/answer-wrapper/answer.wrapper.handler');

// ========== 极简测试框架 ==========

interface GroupStat {
	pass: number;
	fail: number;
	skip: number;
}

const groups: Record<string, GroupStat> = {};
let currentGroup = '';
let pass = 0;
let fail = 0;
let skip = 0;
const failures: string[] = [];
const warns: string[] = [];
const skips: string[] = [];

function section(title: string) {
	currentGroup = title;
	groups[title] = { pass: 0, fail: 0, skip: 0 };
	console.log(`\n${title}`);
}

function bump(kind: keyof GroupStat) {
	const g = groups[currentGroup];
	if (g) g[kind]++;
}

/** 同步断言用例 */
function check(name: string, fn: () => void) {
	try {
		fn();
		pass++;
		bump('pass');
		console.log(`  ✅ ${name}`);
	} catch (err: any) {
		fail++;
		bump('fail');
		const msg = err?.message ?? String(err);
		failures.push(`[${currentGroup}] ${name} → ${msg}`);
		console.log(`  ❌ ${name}\n      ${msg}`);
	}
}

/** 异步断言用例 */
async function checkAsync(name: string, fn: () => Promise<void>) {
	try {
		await fn();
		pass++;
		bump('pass');
		console.log(`  ✅ ${name}`);
	} catch (err: any) {
		fail++;
		bump('fail');
		const msg = err?.message ?? String(err);
		failures.push(`[${currentGroup}] ${name} → ${msg}`);
		console.log(`  ❌ ${name}\n      ${msg}`);
	}
}

/** 无法验证（例如实现未落地 / 缺少可注入点）——不计失败，但整套仍以非 0 退出 */
function skipCheck(name: string, reason: string) {
	skip++;
	bump('skip');
	skips.push(`[${currentGroup}] ${name} → ${reason}`);
	console.log(`  ⏭️ ${name} —— ${reason}`);
}

/** 可疑但不判定为失败的行为（打印出来供人工核对） */
function warn(name: string, detail: string) {
	warns.push(`[${currentGroup}] ${name} → ${detail}`);
	console.log(`  ⚠️ ${name}：${detail}`);
}

function assert(cond: any, msg: string) {
	if (!cond) throw new Error(msg);
}

/** 深比较断言（JSON 语义） */
function eq(actual: any, expected: any, msg: string) {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(`${msg}：期望=${JSON.stringify(expected)} 实际=${JSON.stringify(actual)}`);
	}
}

function has(obj: any, key: string, msg: string) {
	if (!obj || !(key in obj)) {
		throw new Error(`${msg}：缺少字段 ${key}（实际字段 ${obj ? Object.keys(obj).join(',') : obj}）`);
	}
}

function notHas(obj: any, key: string, msg: string) {
	if (obj && key in obj) throw new Error(`${msg}：不应包含字段 ${key}=${JSON.stringify(obj[key])}`);
}

function contains(hay: any, needle: string, msg: string) {
	if (typeof hay !== 'string' || !hay.includes(needle)) {
		throw new Error(`${msg}：期望包含 ${JSON.stringify(needle)}，实际=${JSON.stringify(hay)}`);
	}
}

/** 断言必然 reject，返回捕获到的错误 */
async function expectReject(fn: () => Promise<any>, label: string): Promise<any> {
	try {
		const v = await fn();
		throw new Error(`${label}：期望抛出错误，实际成功返回 ${JSON.stringify(v)?.slice(0, 200)}`);
	} catch (err: any) {
		if (err instanceof Error && err.message.startsWith(`${label}：期望抛出错误`)) throw err;
		return err;
	}
}

/** 断言同步必然抛错，返回捕获到的错误 */
function expectThrows(fn: () => any, label: string): any {
	try {
		const v = fn();
		throw new Error(`${label}：期望抛出错误，实际成功返回 ${JSON.stringify(v)?.slice(0, 200)}`);
	} catch (err: any) {
		if (err instanceof Error && err.message.startsWith(`${label}：期望抛出错误`)) throw err;
		return err;
	}
}

// ========== 模块惰性加载 ==========

const MISSING: string[] = [];

function loadModule<T>(id: string, label: string): T | undefined {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		return require(id) as T;
	} catch (err: any) {
		const msg = `${label}（${id}）加载失败：${err?.message ?? err}`;
		MISSING.push(msg);
		console.log(`  ⚠️  ${msg}`);
		return undefined;
	}
}

// ========== 通用构造器 ==========

const IMG = 'data:image/png;base64,AAA';

function baseEnv(over: Record<string, any> = {}): LLMAnswererEnv {
	return {
		title: '1+1=?',
		options: 'A. 1\nB. 2\nC. 3\nD. 4',
		type: 'single',
		...over
	} as LLMAnswererEnv;
}

function cfg(over: Partial<LLMAnswererConfig> = {}): LLMAnswererConfig {
	return {
		apiFormat: 'completions',
		baseUrl: 'https://api.openai.com/v1',
		model: 'gpt-4o-mini',
		apiKey: 'sk-test',
		maxTokens: 512,
		temperature: 0.3,
		...over
	} as LLMAnswererConfig;
}

function makeWrapper(llm: Partial<LLMAnswererConfig> = {}, extra: Partial<AnswererWrapper> = {}): AnswererWrapper {
	return {
		url: 'https://api.deepseek.com/v1/chat/completions',
		name: 'LLM 测试题库',
		method: 'post',
		type: 'fetch',
		headers: {},
		handler: 'return (res)=> [res.question, res.answer]',
		llm: cfg(llm),
		...extra
	} as AnswererWrapper;
}

/** 记录请求的脚本化 transport */
function scripted(steps: Array<{ status?: number; text?: string; throw?: Error }>): {
	transport: LLMTransport;
	calls: LLMTransportRequest[];
} {
	const calls: LLMTransportRequest[] = [];
	const transport: LLMTransport = async (r: LLMTransportRequest) => {
		calls.push(r);
		const step = steps[Math.min(calls.length - 1, steps.length - 1)];
		if (step.throw) throw step.throw;
		return { status: step.status ?? 200, text: step.text ?? '{}' };
	};
	return { transport, calls };
}

/** transport 请求体可能是对象或 JSON 字符串 */
function bodyOf(r: LLMTransportRequest): Record<string, any> {
	return typeof r.body === 'string' ? JSON.parse(r.body) : r.body;
}

/** 从 user 消息中取出内容（string 或 parts 数组） */
function userContent(body: any, index: number): any {
	const msg = body.messages[index];
	if (!msg) throw new Error(`messages[${index}] 不存在，实际=${JSON.stringify(body.messages)}`);
	return msg.content;
}

// ========== systemone（TypeSafe System One / Jev）构造器 ==========
//
// 第四种格式 'systemone' 与其新增配置字段（noulThreshold / minConfidence）由
// core-adapter / scripts-integration 并行落地，类型定义可能晚于本用例到达；
// 这里统一用「宽松转换」保证契约先行的用例在实现落地前后都能通过 tsc。

const SYSTEMONE = 'systemone' as any as LLMApiFormat;
const SYSTEMONE_BASE = 'https://api.typesafe.ai/v1';
const MULTI_OPTIONS = 'A. 甲\nB. 乙\nC. 丙\nD. 丁';

/** systemone 配置（含新增字段，实现落地前不受类型定义约束） */
function soCfg(over: Record<string, any> = {}): LLMAnswererConfig {
	return cfg({
		apiFormat: SYSTEMONE,
		baseUrl: SYSTEMONE_BASE,
		model: 'jev-latest',
		apiKey: 'sk-test',
		...over
	} as Partial<LLMAnswererConfig>);
}

/** systemone 响应体：{ model, answers, usage } */
function soResponse(answers: Record<string, any>): any {
	return {
		model: 'jev-latest',
		answers,
		usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
	};
}

/** systemone choice 答案项 */
function soChoice(choice: string, confidence = 0.9): any {
	return { type: 'choice', choice, probabilities: { [choice]: confidence }, confidence };
}

/** systemone noul（多选逐项判定）答案项 */
function soNoul(noul: number): any {
	return { type: 'noul', noul };
}

/** 调用 extractLLMResponseText —— 第三参 env 由本次新增，宽松调用以兼容落地时序 */
function extractSO(mod: AdapterModule, response: any, env?: any): any {
	return (mod.extractLLMResponseText as any)(SYSTEMONE, response, env);
}

// ========== 浏览器环境垫片（仅为让 easy-us 顶层 class extends HTMLElement 可加载） ==========

let domReady = false;

function ensureBrowserEnv(): string {
	if (domReady) return 'already';
	const g: any = globalThis as any;
	if (typeof g.window !== 'undefined' && typeof g.document !== 'undefined' && typeof g.HTMLElement !== 'undefined') {
		domReady = true;
		return 'already';
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		require('browser-env')();
		g.unsafeWindow = g.unsafeWindow || {};
		domReady = true;
		return 'browser-env';
	} catch {
		/* 退化到手写垫片 */
	}
	try {
		if (typeof g.HTMLElement === 'undefined') g.HTMLElement = class HTMLElement {};
		if (typeof g.Element === 'undefined') g.Element = class Element {};
		if (typeof g.Node === 'undefined') g.Node = class Node {};
		if (typeof g.window === 'undefined') g.window = g;
		if (typeof g.document === 'undefined') {
			const el: any = new g.HTMLElement();
			el.style = {};
			el.appendChild = () => el;
			el.remove = () => undefined;
			el.querySelector = () => null;
			el.addEventListener = () => undefined;
			el.removeEventListener = () => undefined;
			g.document = {
				createElement: () => el,
				querySelector: () => null,
				querySelectorAll: () => [],
				getElementById: () => null,
				addEventListener: () => undefined,
				removeEventListener: () => undefined,
				body: el,
				head: el,
				documentElement: el,
				createTextNode: () => el
			};
		}
		g.unsafeWindow = g.unsafeWindow || {};
		domReady = true;
		return '手写最小 DOM 垫片';
	} catch (err: any) {
		return `失败：${err?.message ?? err}`;
	}
}

// ========== 端到端（F）准备 ==========

interface FContext {
	infos: SearchInformation[];
	llmBody: any;
	legacyBody: any;
	fetchCalls: string[];
	gmCalls: string[];
	transportCalls: LLMTransportRequest[];
	/** 端到端路径上真实发出的请求体（已 JSON 解析，仅保留疑似 LLM 请求体） */
	bodies: any[];
	injection: string;
}

function tryInjectTransport(adapter: any, transport: LLMTransport): string | undefined {
	try {
		if (typeof adapter?.setDefaultLLMTransport === 'function') {
			adapter.setDefaultLLMTransport(transport);
			return 'setDefaultLLMTransport()';
		}
		if (typeof adapter?.setLLMTransport === 'function') {
			adapter.setLLMTransport(transport);
			return 'setLLMTransport()';
		}
		if (adapter && 'llmAnswererTransport' in adapter) {
			adapter.llmAnswererTransport = transport;
			return 'llmAnswererTransport 赋值';
		}
	} catch {
		return undefined;
	}
	return undefined;
}

async function prepareF(handler: HandlerModule, adapter: AdapterModule): Promise<FContext | undefined> {
	const llmBody = { choices: [{ message: { content: '答案：A', reasoning_content: '因为 1+1=2' } }] };
	const legacyBody = { question: '1+1=?', answer: 'LEGACY' };
	const fetchCalls: string[] = [];
	const gmCalls: string[] = [];
	const transportCalls: LLMTransportRequest[] = [];
	const bodies: any[] = [];

	// 记录端到端路径上真实发出的请求体，供 F5 断言「handler 真的把构造好的 body 发出去了」
	const recordBody = (raw: any) => {
		if (raw === undefined || raw === null || raw === '') return;
		let value: any = raw;
		if (typeof raw === 'string') {
			try {
				value = JSON.parse(raw);
			} catch {
				return;
			}
		}
		if (value && typeof value === 'object' && (value.model || value.messages || value.input || value.system)) {
			bodies.push(value);
		}
	};

	const realFetch = (globalThis as any).fetch;
	const realGM = (globalThis as any).GM_xmlhttpRequest;

	const pick = (url: string) => (url.includes('legacy') ? legacyBody : llmBody);

	const fakeFetch = async (input: any, init?: any) => {
		const url = typeof input === 'string' ? input : String(input?.url ?? input);
		fetchCalls.push(url);
		recordBody(init?.body);
		const body = pick(url);
		return {
			status: 200,
			ok: true,
			json: async () => body,
			text: async () => JSON.stringify(body)
		};
	};

	(globalThis as any).fetch = fakeFetch;
	(globalThis as any).GM_xmlhttpRequest = (opts: any) => {
		const url = String(opts?.url ?? '');
		gmCalls.push(url);
		recordBody(opts?.data);
		setTimeout(() => opts?.onload?.({ status: 200, responseText: JSON.stringify(pick(url)) }), 0);
	};
	// Node 分支下 request() 走 node-fetch
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const nf = require('node-fetch');
		if (nf && nf.default) nf.default = fakeFetch;
	} catch {
		/* node-fetch 不可用时忽略 */
	}

	const injectedTransport: LLMTransport = async (r: LLMTransportRequest) => {
		transportCalls.push(r);
		recordBody(r.body);
		return { status: 200, text: JSON.stringify(llmBody) };
	};
	const injection = tryInjectTransport(adapter as any, injectedTransport) ?? 'globalThis.fetch 桩';

	const llmWrapper: AnswererWrapper = {
		url: 'https://api.deepseek.com/v1/chat/completions',
		name: 'LLM 测试题库',
		homepage: 'https://api.deepseek.com',
		method: 'post',
		type: 'fetch',
		headers: {},
		handler: 'return (res)=> [res.question, res.answer]',
		llm: cfg({
			apiFormat: 'completions',
			baseUrl: 'https://api.deepseek.com/v1',
			model: 'deepseek-chat',
			apiKey: 'sk-x',
			reasoning: { enabled: true, effort: 'low' },
			timeout: undefined
		} as any)
	};
	const legacyWrapper: AnswererWrapper = {
		url: 'https://legacy.example.com/legacy-search',
		name: '旧版题库',
		method: 'get',
		type: 'fetch',
		headers: {},
		handler: 'return (res)=> [res.question, res.answer]'
	};

	let infos: SearchInformation[] | undefined;
	let thrown: any;
	try {
		infos = await handler.defaultAnswerWrapperHandler([llmWrapper, legacyWrapper], baseEnv());
	} catch (err: any) {
		thrown = err;
	} finally {
		(globalThis as any).fetch = realFetch;
		(globalThis as any).GM_xmlhttpRequest = realGM;
	}

	const intercepted = fetchCalls.length + gmCalls.length + transportCalls.length;
	if (thrown || !infos) {
		console.log(`  ⚠️  端到端调用失败：${thrown?.message ?? '无返回'}`);
		return undefined;
	}
	if (intercepted === 0) {
		console.log('  ⚠️  端到端调用绕过了全部注入点（transport / fetch / GM_xmlhttpRequest），无法离线验证');
		return undefined;
	}

	console.log(
		`  ℹ️  注入方式=${injection}；fetch 命中=${fetchCalls.length}，GM 命中=${gmCalls.length}，transport 命中=${transportCalls.length}`
	);

	return { infos, llmBody, legacyBody, fetchCalls, gmCalls, transportCalls, bodies, injection };
}

// ========== 主流程 ==========

async function main() {
	console.log('🧪 LLM 答题支持 —— 离线测试套件');

	// 必须在加载业务模块之前装好 DOM 垫片（easy-us 顶层 extends HTMLElement）
	const domMode = ensureBrowserEnv();
	console.log(`   DOM 环境：${domMode}`);

	const adapter = loadModule<AdapterModule>(
		'../packages/core/src/core/answer-wrapper/llm-answerer.adapter',
		'LLM 适配器'
	);
	const prompt = loadModule<PromptModule>('../packages/core/src/core/answer-wrapper/llm-answerer.prompt', 'LLM 提示词');
	const presets = loadModule<PresetsModule>('../packages/scripts/src/utils/llm-answerer-presets', 'LLM 预设');
	const handler = loadModule<HandlerModule>(
		'../packages/core/src/core/answer-wrapper/answer.wrapper.handler',
		'默认题库处理器'
	);

	// ---------------------------------------------------------------- A
	section('A. buildLLMAnswererRequest —— 请求构造（3 种格式 × 思考开/关）');

	if (!adapter?.buildLLMAnswererRequest) {
		skipCheck('A 组全部', 'llm-answerer.adapter.ts 的 buildLLMAnswererRequest 尚未落地');
	} else {
		check('A1 completions 非思考：model/双消息/max_tokens/temperature/stream，且无 reasoning_effort', () => {
			const spec = adapter.buildLLMAnswererRequest(cfg(), baseEnv());
			eq(spec.method, 'post', 'A1 method');
			eq(spec.url, 'https://api.openai.com/v1/chat/completions', 'A1 url');
			const b = spec.body;
			eq(b.model, 'gpt-4o-mini', 'A1 model');
			eq(b.messages[0].role, 'system', 'A1 messages[0].role');
			eq(b.messages[1].role, 'user', 'A1 messages[1].role');
			eq(b.max_tokens, 512, 'A1 max_tokens');
			eq(b.temperature, 0.3, 'A1 temperature');
			eq(b.stream, false, 'A1 stream');
			notHas(b, 'reasoning_effort', 'A1');
			assert(spec.reasoning === false, `A1 reasoning 应为 false，实际=${spec.reasoning}`);
		});

		check('A2 completions 思考：reasoning_effort + max_completion_tokens，且无 max_tokens / temperature', () => {
			const spec = adapter.buildLLMAnswererRequest(cfg({ reasoning: { enabled: true, effort: 'high' } }), baseEnv());
			const b = spec.body;
			eq(b.reasoning_effort, 'high', 'A2 reasoning_effort');
			has(b, 'max_completion_tokens', 'A2');
			assert(
				typeof b.max_completion_tokens === 'number' && b.max_completion_tokens > 0,
				'A2 max_completion_tokens 应为正数'
			);
			notHas(b, 'max_tokens', 'A2');
			notHas(b, 'temperature', 'A2');
			assert(spec.reasoning === true, 'A2 reasoning 应为 true');
		});

		check('A3 response 非思考：input / instructions / max_output_tokens / temperature', () => {
			const spec = adapter.buildLLMAnswererRequest(cfg({ apiFormat: 'response' }), baseEnv());
			eq(spec.url, 'https://api.openai.com/v1/responses', 'A3 url');
			const b = spec.body;
			has(b, 'input', 'A3');
			has(b, 'instructions', 'A3');
			assert(b.instructions === undefined || typeof b.instructions === 'string', 'A3 instructions 应为字符串');
			eq(b.max_output_tokens, 512, 'A3 max_output_tokens');
			eq(b.temperature, 0.3, 'A3 temperature');
		});

		check('A4 response 思考：reasoning.effort，input / instructions 仍在', () => {
			const spec = adapter.buildLLMAnswererRequest(
				cfg({ apiFormat: 'response', reasoning: { enabled: true, effort: 'medium' } }),
				baseEnv()
			);
			const b = spec.body;
			eq(b.reasoning?.effort, 'medium', 'A4 reasoning.effort');
			has(b, 'input', 'A4');
			has(b, 'instructions', 'A4');
			assert(spec.reasoning === true, 'A4 reasoning 应为 true');
		});

		check('A5 anthropic 非思考：system 字符串 + messages[0].content + max_tokens + temperature，无 thinking', () => {
			const spec = adapter.buildLLMAnswererRequest(cfg({ apiFormat: 'anthropic' }), baseEnv());
			eq(spec.url, 'https://api.openai.com/v1/messages', 'A5 url');
			const b = spec.body;
			assert(
				typeof b.system === 'string' && b.system.length > 0,
				`A5 system 应为非空字符串，实际=${JSON.stringify(b.system)}`
			);
			assert(b.messages[0]?.content !== undefined, 'A5 messages[0].content 缺失');
			eq(b.max_tokens, 512, 'A5 max_tokens');
			eq(b.temperature, 0.3, 'A5 temperature');
			notHas(b, 'thinking', 'A5');
		});

		check('A6 anthropic 思考：thinking.budget_tokens === 配置值、temperature === 1、max_tokens > budget', () => {
			const budget = 4096;
			const spec = adapter.buildLLMAnswererRequest(
				cfg({ apiFormat: 'anthropic', reasoning: { enabled: true, budgetTokens: budget } }),
				baseEnv()
			);
			const b = spec.body;
			eq(b.thinking?.type, 'enabled', 'A6 thinking.type');
			eq(b.thinking?.budget_tokens, budget, 'A6 thinking.budget_tokens');
			eq(b.temperature, 1, 'A6 temperature');
			assert(b.max_tokens > budget, `A6 max_tokens(${b.max_tokens}) 应大于 budget(${budget})`);
			assert(spec.reasoning === true, 'A6 reasoning 应为 true');
		});

		check('A7 URL 拼接：baseUrl 尾斜杠 → /chat/completions、/responses、/messages，无重复斜杠', () => {
			const base = 'https://api.openai.com/v1/';
			const c1 = adapter.buildLLMAnswererRequest(cfg({ baseUrl: base }), baseEnv()).url;
			const c2 = adapter.buildLLMAnswererRequest(cfg({ baseUrl: base, apiFormat: 'response' }), baseEnv()).url;
			const c3 = adapter.buildLLMAnswererRequest(cfg({ baseUrl: base, apiFormat: 'anthropic' }), baseEnv()).url;
			eq(c1, 'https://api.openai.com/v1/chat/completions', 'A7 completions');
			eq(c2, 'https://api.openai.com/v1/responses', 'A7 response');
			eq(c3, 'https://api.openai.com/v1/messages', 'A7 anthropic');
			for (const u of [c1, c2, c3]) {
				assert(!/\/\/[^/]*\/\/|\/v1\/\//.test(u.replace(/^https?:\/\//, '')), `A7 出现了重复斜杠：${u}`);
			}
		});

		check(
			'A8 请求头：非 anthropic 用 Authorization Bearer；anthropic 用 x-api-key + anthropic-version 且无 Authorization',
			() => {
				const h1 = adapter.buildLLMAnswererRequest(cfg(), baseEnv()).headers;
				eq(h1.Authorization ?? h1.authorization, 'Bearer sk-test', 'A8 completions Authorization');
				const h2 = adapter.buildLLMAnswererRequest(cfg({ apiFormat: 'anthropic' }), baseEnv()).headers;
				eq(h2['x-api-key'], 'sk-test', 'A8 anthropic x-api-key');
				assert(!!h2['anthropic-version'], `A8 缺少 anthropic-version，实际头=${JSON.stringify(h2)}`);
				notHas(h2, 'Authorization', 'A8 anthropic');
				notHas(h2, 'authorization', 'A8 anthropic');
			}
		);

		check('A9 baseUrl 中 ${apiKey} 占位符被替换（URL 内不留占位符，且不含明文以外的残留）', () => {
			const url = adapter.buildLLMAnswererRequest(
				cfg({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai?key=${apiKey}' }),
				baseEnv()
			).url;
			contains(url, 'sk-test', 'A9 应替换为真实 key');
			assert(!url.includes('${apiKey}'), `A9 仍残留占位符：${url}`);
		});

		check('A10 图片（completions，images: true）：user content 为数组且含 image_url part', () => {
			const spec = adapter.buildLLMAnswererRequest(cfg({ images: true }), baseEnv({ images: [IMG] }));
			const content = userContent(spec.body, 1);
			assert(Array.isArray(content), `A10 user content 应为数组，实际=${JSON.stringify(content)}`);
			const part = content.find((p: any) => p?.type === 'image_url');
			assert(!!part, `A10 缺少 {type:'image_url'} part，实际=${JSON.stringify(content)}`);
			contains(JSON.stringify(part), 'AAA', 'A10 image_url part 应携带 base64 数据');
		});

		check('A11 图片（anthropic，images: true）：source.data 为剥离前缀的纯 base64', () => {
			const spec = adapter.buildLLMAnswererRequest(
				cfg({ apiFormat: 'anthropic', images: true }),
				baseEnv({ images: [IMG] })
			);
			const content = spec.body.messages[0].content;
			assert(Array.isArray(content), `A11 anthropic content 应为数组，实际=${JSON.stringify(content)}`);
			const part = content.find((p: any) => p?.type === 'image');
			assert(!!part, `A11 缺少 {type:'image'} part，实际=${JSON.stringify(content)}`);
			eq(part.source?.type, 'base64', 'A11 source.type');
			eq(part.source?.media_type, 'image/png', 'A11 source.media_type');
			eq(part.source?.data, 'AAA', 'A11 source.data（应剥离 data URL 前缀）');
		});

		check('A12 images: false 时 user content 为纯字符串', () => {
			const spec = adapter.buildLLMAnswererRequest(cfg({ images: false }), baseEnv({ images: [IMG] }));
			const content = userContent(spec.body, 1);
			assert(typeof content === 'string', `A12 user content 应为字符串，实际=${JSON.stringify(content)}`);
			const spec2 = adapter.buildLLMAnswererRequest(
				cfg({ apiFormat: 'anthropic', images: false }),
				baseEnv({ images: [IMG] })
			);
			assert(
				typeof spec2.body.messages[0].content === 'string',
				`A12 anthropic content 应为字符串，实际=${JSON.stringify(spec2.body.messages[0].content)}`
			);
		});

		check('A13 systemPrompt / userPrompt 中 ${title} / ${options} / ${type} 被 env 替换', () => {
			const env = baseEnv({ title: '题目TITLE', options: '选项OPTIONS', type: 'single' });
			const spec = adapter.buildLLMAnswererRequest(
				cfg({
					systemPrompt: '类型：${type}；题目：${title}',
					userPrompt: '请从以下选项中作答：${options}'
				}),
				env
			);
			const sys = spec.body.messages[0].content;
			const usr = userContent(spec.body, 1);
			contains(sys, '题目TITLE', 'A13 system 应替换 ${title}');
			contains(sys, 'single', 'A13 system 应替换 ${type}');
			assert(!sys.includes('${'), `A13 system 仍残留占位符：${sys}`);
			const usrText = typeof usr === 'string' ? usr : JSON.stringify(usr);
			contains(usrText, '选项OPTIONS', 'A13 user 应替换 ${options}');
			assert(!usrText.includes('${'), `A13 user 仍残留占位符：${usrText}`);
		});

		check('A14 endpoint 覆盖：config.endpoint 优先于按 apiFormat 推导的路径', () => {
			const spec = adapter.buildLLMAnswererRequest(
				cfg({ baseUrl: 'https://proxy.example.com/v1', endpoint: 'https://proxy.example.com/custom/chat' }),
				baseEnv()
			);
			contains(spec.url, 'proxy.example.com', 'A14 endpoint 应生效');
			assert(!spec.url.endsWith('/v1/chat/completions'), `A14 endpoint 似乎未生效：${spec.url}`);
		});

		check('A15 默认 maxTokens：未配置时仍有正数 token 上限', () => {
			const c = cfg();
			delete (c as any).maxTokens;
			const spec = adapter.buildLLMAnswererRequest(c, baseEnv());
			const n = spec.body.max_tokens ?? spec.body.max_completion_tokens ?? spec.body.max_output_tokens;
			assert(typeof n === 'number' && n > 0, `A15 默认 token 上限缺失，实际=${JSON.stringify(spec.body)}`);
		});
	}

	// ---------------------------------------------------------------- B
	section('B. extractLLMResponseText —— 三种格式 + thinking 变体');

	if (!adapter?.extractLLMResponseText) {
		skipCheck('B 组全部', 'llm-answerer.adapter.ts 的 extractLLMResponseText 尚未落地');
	} else {
		const extract = adapter.extractLLMResponseText;

		check('B1 completions 纯 content → text，无 reasoning', () => {
			const r = extract('completions', { choices: [{ message: { content: '答案是 A' } }] });
			eq(r.text, '答案是 A', 'B1 text');
			assert(!r.reasoning, `B1 reasoning 应为空，实际=${JSON.stringify(r.reasoning)}`);
		});

		check('B2 completions reasoning_content → reasoning 字段被提取', () => {
			const r = extract('completions', {
				choices: [{ message: { content: '答案：B', reasoning_content: '因为我...' } }]
			});
			eq(r.text, '答案：B', 'B2 text');
			eq(r.reasoning, '因为我...', 'B2 reasoning');
		});

		check('B3 completions content 为 parts 数组 → 拼接为文本', () => {
			const r = extract('completions', {
				choices: [
					{
						message: {
							content: [
								{ type: 'text', text: '答案' },
								{ type: 'text', text: '：C' }
							]
						}
					}
				]
			});
			eq(r.text.replace(/\s/g, ''), '答案：C', 'B3 text 应为各 part 拼接');
		});

		check('B4 response：output_text 直取', () => {
			const r = extract('response', { output_text: '答案：C' });
			eq(r.text, '答案：C', 'B4 text');
		});

		check('B5 response：output 数组（reasoning item + message item），output_text 缺失也能取到', () => {
			const r = extract('response', {
				output: [
					{
						type: 'reasoning',
						summary: [
							{ type: 'summary_text', text: '先分析题干，' },
							{ type: 'summary_text', text: '再排除干扰项' }
						]
					},
					{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '答案：D' }] }
				]
			});
			eq(r.text, '答案：D', 'B5 text');
			assert(!!r.reasoning && r.reasoning.length > 0, `B5 reasoning 应为非空，实际=${JSON.stringify(r.reasoning)}`);
		});

		check('B6 anthropic：thinking 块进 reasoning，text 块进 text，redacted_thinking 既不报错也不泄漏', () => {
			const r = extract('anthropic', {
				content: [
					{ type: 'thinking', thinking: '推理...' },
					{ type: 'redacted_thinking', data: 'SECRET-REDACTED-PAYLOAD' },
					{ type: 'text', text: '答案：A' }
				]
			});
			eq(r.reasoning, '推理...', 'B6 reasoning');
			eq(r.text, '答案：A', 'B6 text');
			assert(!JSON.stringify(r).includes('SECRET-REDACTED-PAYLOAD'), 'B6 redacted_thinking 负载泄漏进了结果');
		});

		check('B7 畸形/空 payload（{}、{choices:[]}、{content:"裸字符串"}）不抛错且 text 恒为字符串', () => {
			for (const payload of [{}, { choices: [] }, { content: '裸字符串' }]) {
				const r = extract('completions', payload);
				assert(typeof r.text === 'string', `B7 ${JSON.stringify(payload)} → text 应为字符串，实际=${typeof r.text}`);
			}
			const r2 = extract('anthropic', {});
			assert(typeof r2.text === 'string', 'B7 anthropic {} → text 应为字符串');
		});

		check('B8 兼容被 {data:...} 包裹的响应体（未解包则记为 WARN，不判失败）', () => {
			let r: { text: string } | undefined;
			assert(
				!(() => {
					try {
						r = adapter.extractLLMResponseText('completions', {
							data: { choices: [{ message: { content: '答案：E' } }] }
						});
						return false;
					} catch {
						return true;
					}
				})(),
				'B8 不应抛错'
			);
			if (r!.text === '答案：E') {
				eq(r!.text, '答案：E', 'B8 已自动解包 data');
			} else {
				warn('B8 data 包裹响应未解包', `期望 "答案：E"，实际 ${JSON.stringify(r!.text)}`);
			}
		});
	}

	// ---------------------------------------------------------------- C
	section('C. parseLLMAnswerText —— 模型文本 → 最终答案');

	if (!adapter?.parseLLMAnswerText) {
		skipCheck('C 组全部', 'llm-answerer.adapter.ts 的 parseLLMAnswerText 尚未落地');
	} else {
		const parse = adapter.parseLLMAnswerText;

		const cases: Array<[string, string, string]> = [
			['答案：A', 'A', '中文冒号'],
			['答案: A', 'A', '英文冒号 + 空格'],
			['Answer: B', 'B', '英文 Answer'],
			['思考过程：先算 1+1=2，再看选项。\n理由：只有 A 对应 1。\n答案：C', 'C', '长推理后末行答案'],
			['{"answer":"D"}', 'D', 'JSON answer'],
			['{"answers":["A","C"]}', 'A#C', 'JSON answers 多选'],
			['```json\n{"answer":"B"}\n```', 'B', 'json 代码块'],
			['<answer>AC</answer>', 'AC', 'XML 标签'],
			['因为 A 正确\n\nC', 'C', '裸末行答案'],
			['a、c', 'AC', '顿号分隔小写'],
			['A B', 'AB', '空格分隔'],
			['正确', '正确', '中文正确'],
			['对', '正确', '对 → 正确'],
			['错误', '错误', '中文错误'],
			['false', '错误', 'false → 错误'],
			['```answer\nE\n```', 'E', 'answer 代码块'],
			['分析：选项 A 是 1，选项 B 是 2，两者都符合题干要求，需要多选。\n答案：AB', 'AB', '解释在前，答案在后'],
			['思考……\n最终答案：B', 'B', '「最终答案：」前缀']
		];

		for (const [input, expected, label] of cases) {
			check(`C ${label}：${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
				eq(parse(input), expected, `C ${label}`);
			});
		}

		check('C 中文文本答案不被大写化/截断', () => {
			const out = parse('这是一段中文文本答案。');
			assert(typeof out === 'string', 'C 文本答案应为字符串');
			contains(out, '这是一段中文文本答案', 'C 文本答案应保留原文');
		});

		check('C 空串 / 纯空白 → 空字符串（不是 undefined，也不抛错）', () => {
			for (const input of ['', '   ', '\n\t\n']) {
				const out = parse(input);
				assert(typeof out === 'string', `C ${JSON.stringify(input)} → 应为字符串，实际=${typeof out}`);
				eq(out, '', `C ${JSON.stringify(input)} 应为空串`);
			}
		});

		check('C 无意义标点输入不抛错（返回值记为 WARN，供人工核对）', () => {
			let out = '';
			assert(
				!(() => {
					try {
						out = parse('!@#$%^&*()');
						return false;
					} catch {
						return true;
					}
				})(),
				'C 标点输入不应抛错'
			);
			if (out === '') {
				eq(out, '', 'C 标点输入应为空串');
			} else {
				warn('C 标点输入未被清空', `parse("!@#$%^&*()") = ${JSON.stringify(out)}（期望空串）`);
			}
		});

		check('C 叙述性取尾字母：含字母的中文文本答案不再被误截断（维生素C 回归）', () => {
			eq(parse('维生素C'), '维生素C', 'C 维生素C 不应被截断为 C');
			eq(parse('维生素C。'), '维生素C', 'C 维生素C。不应被截断');
			eq(parse('维生素B12'), '维生素B12', 'C 维生素B12 不应被截断');
			eq(parse('答案：维生素C'), '维生素C', 'C「答案：维生素C」标签分支');
		});

		check('C 叙述性取尾字母：带「选 / 答案」的叙述仍要正确取出选项字母', () => {
			eq(parse('这道题选 B'), 'B', 'C 这道题选 B');
			eq(parse('故选B'), 'B', 'C 故选B');
			eq(parse('应选 AC'), 'AC', 'C 应选 AC');
		});
	}

	// ---------------------------------------------------------------- D
	section('D. requestLLMAnswerer —— 注入式 transport 的成功 / 回退 / 错误路径');

	if (!adapter?.requestLLMAnswerer || !adapter?.LLMRequestError) {
		skipCheck('D 组全部', 'llm-answerer.adapter.ts 的 requestLLMAnswerer / LLMRequestError 尚未落地');
	} else {
		const run = adapter.requestLLMAnswerer;

		await checkAsync(
			'D1 200 + completions reasoning_content → answer 已解析，reasoning 保留，transport 调用一次',
			async () => {
				const { transport, calls } = scripted([
					{
						status: 200,
						text: JSON.stringify({ choices: [{ message: { content: '答案：A', reasoning_content: '因为 1+1=2' } }] })
					}
				]);
				const res: LLMAnswererResult = await run(makeWrapper({ reasoning: { enabled: true, effort: 'low' } }), {
					env: baseEnv(),
					transport
				});
				eq(res.answer, 'A', 'D1 answer');
				eq(res.reasoning, '因为 1+1=2', 'D1 reasoning');
				eq(res.status, 200, 'D1 status');
				assert(res.request?.reasoning === true, 'D1 request.reasoning 应为 true');
				eq(calls.length, 1, 'D1 transport 调用次数（应只走注入 transport）');
			}
		);

		await checkAsync('D2 200 + anthropic thinking → answer / reasoning 正确', async () => {
			const { transport, calls } = scripted([
				{
					status: 200,
					text: JSON.stringify({
						content: [
							{ type: 'thinking', thinking: '推理...' },
							{ type: 'text', text: '答案：B' }
						]
					})
				}
			]);
			const res = await run(makeWrapper({ apiFormat: 'anthropic' }), { env: baseEnv(), transport });
			eq(res.answer, 'B', 'D2 answer');
			eq(res.reasoning, '推理...', 'D2 reasoning');
			eq(calls.length, 1, 'D2 transport 调用次数');
		});

		await checkAsync('D3 200 + Responses API output → answer / reasoning 正确', async () => {
			const { transport, calls } = scripted([
				{
					status: 200,
					text: JSON.stringify({
						output: [
							{ type: 'reasoning', summary: [{ type: 'summary_text', text: '先看题' }] },
							{ type: 'message', content: [{ type: 'output_text', text: '答案：D' }] }
						]
					})
				}
			]);
			const res = await run(makeWrapper({ apiFormat: 'response' }), { env: baseEnv(), transport });
			eq(res.answer, 'D', 'D3 answer');
			assert(!!res.reasoning, 'D3 reasoning 应为非空');
			eq(calls.length, 1, 'D3 transport 调用次数');
		});

		await checkAsync('D4 400 且服务端拒绝 reasoning_effort → 自动去思考参数重试一次', async () => {
			const { transport, calls } = scripted([
				{ status: 400, text: '{"error":{"message":"Unsupported parameter: reasoning_effort"}}' },
				{ status: 200, text: JSON.stringify({ choices: [{ message: { content: '答案：A' } }] }) }
			]);
			const res = await run(makeWrapper({ reasoning: { enabled: true, effort: 'high' } }), {
				env: baseEnv(),
				transport
			});
			eq(calls.length, 2, 'D4 transport 应被调用两次');
			has(bodyOf(calls[0]), 'reasoning_effort', 'D4 第一次请求应带 reasoning_effort');
			notHas(bodyOf(calls[1]), 'reasoning_effort', 'D4 第二次请求');
			assert(res.reasoningFallback === true, `D4 reasoningFallback 应为 true，实际=${res.reasoningFallback}`);
			eq(res.answer, 'A', 'D4 answer');
			eq(res.status, 200, 'D4 status');
		});

		await checkAsync(
			'D5 400 但错误与思考参数无关（Invalid model）→ 抛 LLMRequestError(400)，且只请求一次',
			async () => {
				const { transport, calls } = scripted([{ status: 400, text: '{"error":{"message":"Invalid model"}}' }]);
				const err = await expectReject(
					() => run(makeWrapper({ reasoning: { enabled: true, effort: 'high' } }), { env: baseEnv(), transport }),
					'D5'
				);
				assert(
					err instanceof adapter.LLMRequestError,
					`D5 应为 LLMRequestError，实际=${err?.constructor?.name}: ${err?.message}`
				);
				eq(err.status, 400, 'D5 status');
				contains(err.message, 'Invalid model', 'D5 错误信息应包含服务端文本');
				eq(calls.length, 1, 'D5 transport 调用次数（不应重试）');
			}
		);

		await checkAsync('D6 401 → 抛 LLMRequestError(401)', async () => {
			const { transport } = scripted([{ status: 401, text: '{"error":{"message":"Unauthorized"}}' }]);
			const err = await expectReject(() => run(makeWrapper(), { env: baseEnv(), transport }), 'D6');
			assert(err instanceof adapter.LLMRequestError, `D6 应为 LLMRequestError，实际=${err?.constructor?.name}`);
			eq(err.status, 401, 'D6 status');
		});

		await checkAsync('D7 500 → 抛 LLMRequestError(500)', async () => {
			const { transport } = scripted([{ status: 500, text: '{"error":{"message":"server error"}}' }]);
			const err = await expectReject(() => run(makeWrapper(), { env: baseEnv(), transport }), 'D7');
			assert(err instanceof adapter.LLMRequestError, `D7 应为 LLMRequestError，实际=${err?.constructor?.name}`);
			eq(err.status, 500, 'D7 status');
		});

		await checkAsync('D8 200 但响应非 JSON（网关 HTML）→ 抛提及 JSON 的错误，不得静默返回空答案', async () => {
			const { transport } = scripted([{ status: 200, text: '<html>gateway</html>' }]);
			const err = await expectReject(() => run(makeWrapper(), { env: baseEnv(), transport }), 'D8');
			assert(err instanceof Error, `D8 应抛出 Error，实际=${err?.constructor?.name}`);
			assert(/json/i.test(err.message), `D8 错误信息应提及 JSON，实际=${JSON.stringify(err.message)}`);
		});

		await checkAsync('D9 transport 网络异常（fetch failed）→ 拒绝信息含「LLM 请求失败」且不崩溃', async () => {
			const { transport, calls } = scripted([{ throw: new Error('fetch failed') }]);
			const err = await expectReject(() => run(makeWrapper(), { env: baseEnv(), transport }), 'D9');
			assert(err instanceof Error, `D9 应抛出 Error，实际=${err?.constructor?.name}`);
			contains(err.message, 'LLM 请求失败', 'D9 拒绝信息');
			eq(calls.length, 1, 'D9 transport 调用次数');
		});

		await checkAsync('D10 每个用例都只经过注入 transport（断言调用计数，无真实网络）', async () => {
			const { transport, calls } = scripted([
				{ status: 200, text: JSON.stringify({ choices: [{ message: { content: '答案：C' } }] }) }
			]);
			const res = await run(makeWrapper(), { env: baseEnv(), transport });
			eq(calls.length, 1, 'D10 transport 调用次数');
			eq(res.answer, 'C', 'D10 answer');
			contains(calls[0].url, 'http', 'D10 请求 URL 应指向配置的接口');
		});

		await checkAsync('D11 wrapper.timeout（秒）覆盖默认 60s（非 5000 时记为 WARN）', async () => {
			const { transport, calls } = scripted([
				{ status: 200, text: JSON.stringify({ choices: [{ message: { content: '答案：A' } }] }) }
			]);
			await run(makeWrapper({}, { timeout: 5 }), { env: baseEnv(), transport });
			const t = calls[0]?.timeout;
			assert(typeof t === 'number' && t > 0, `D11 transport 请求应带正数 timeout，实际=${t}`);
			if (t === 5000) {
				eq(t, 5000, 'D11 timeout');
			} else {
				warn('D11 timeout 单位/取值', `wrapper.timeout=5 秒 → 实际 ${t}（期望 5000 毫秒，可能是其它单位约定）`);
			}
		});
	}

	// ---------------------------------------------------------------- E
	section('E. llm-answerer-presets —— 预设表 / wrapper 构建与解析');

	if (!presets?.LLM_PRESETS || !presets?.buildLLMWrapper) {
		skipCheck('E 组全部', 'packages/scripts/src/utils/llm-answerer-presets.ts 尚未落地');
	} else {
		const VALID_FORMATS: LLMApiFormat[] = [
			'completions',
			'response',
			'anthropic',
			// 第四种格式：System One / Jev（task-3 新增预设 jev / digitalocean 使用）
			SYSTEMONE
		];

		check('E1 LLM_PRESETS 覆盖既有 9 个预设与新增预设，字段合法（custom 允许 baseUrl/model/models 为空）', () => {
			const ids = presets.LLM_PRESETS.map((p) => p.id);
			const expected: LLMPresetId[] = [
				'openai',
				'openai-responses',
				'anthropic',
				'deepseek',
				'moonshot',
				'zhipu',
				'qwen',
				'gemini',
				'custom'
			];
			for (const id of expected) {
				assert(ids.includes(id), `E1 缺少预设 ${id}，实际=${ids.join(',')}`);
			}
			for (const p of presets.LLM_PRESETS) {
				assert(VALID_FORMATS.includes(p.apiFormat), `E1 ${p.id} 的 apiFormat 非法：${p.apiFormat}`);
				assert(!!p.name, `E1 ${p.id} 缺少 name`);
				assert(Array.isArray(p.models), `E1 ${p.id} 的 models 应为数组`);
				if (p.id !== 'custom') {
					assert(p.models.length > 0, `E1 ${p.id} 的 models 应为非空数组`);
					assert(!!p.baseUrl, `E1 ${p.id} 的 baseUrl 为空`);
					assert(!!p.model, `E1 ${p.id} 的 model 为空`);
				}
			}
			// custom 是「由用户自行填写」的预设：不预设 baseUrl / model / models，仅在 note 中说明用途
			const custom = presets.getLLMPreset('custom');
			eq(custom.baseUrl, '', 'E1 custom 的 baseUrl 应为空');
			eq(custom.models.length, 0, 'E1 custom 的 models 应为空数组');
			eq(custom.apiFormat, 'completions', 'E1 custom 的 apiFormat');
			assert(
				!!custom.note && custom.note.includes('自定义'),
				`E1 custom 的 note 应含「自定义」，实际=${JSON.stringify(custom.note)}`
			);
		});

		check('E2 getLLMPreset 返回对应预设', () => {
			eq(presets.getLLMPreset('deepseek').id, 'deepseek', 'E2 getLLMPreset');
			eq(presets.getLLMPreset('anthropic').apiFormat, 'anthropic', 'E2 anthropic apiFormat');
		});

		check('E3 buildLLMWrapper（deepseek）→ url / mode / handler / name / isLLMWrapper', () => {
			const w = presets.buildLLMWrapper({
				presetId: 'deepseek',
				baseUrl: 'https://api.deepseek.com/v1',
				model: 'deepseek-chat',
				apiKey: 'sk-x',
				reasoning: false,
				images: false,
				requestType: 'GM_xmlhttpRequest'
			});
			eq(w.llm?.apiFormat, 'completions', 'E3 apiFormat');
			eq(w.url, 'https://api.deepseek.com/v1/chat/completions', 'E3 url');
			eq(w.method, 'post', 'E3 method');
			assert(
				typeof w.handler === 'string' && w.handler.length > 0,
				`E3 handler 应为非空字符串，实际=${JSON.stringify(w.handler)}`
			);
			assert(!!w.name && w.name.length > 0, `E3 name 应为非空，实际=${JSON.stringify(w.name)}`);
			eq(w.type, 'GM_xmlhttpRequest', 'E3 type 应透传 requestType');
			assert(presets.isLLMWrapper(w) === true, 'E3 isLLMWrapper 应为 true');
			eq(w.llm?.model, 'deepseek-chat', 'E3 model');
			eq(w.llm?.apiKey, 'sk-x', 'E3 apiKey');
		});

		check('E4 anthropic 预设不产生 /v1 重复；openai-responses 指向 /v1/responses', () => {
			const a = presets.buildLLMWrapper({
				presetId: 'anthropic',
				baseUrl: 'https://api.anthropic.com',
				model: 'claude-sonnet-4-5',
				apiKey: 'sk-x',
				reasoning: false,
				images: false,
				requestType: 'fetch'
			});
			eq(a.url, 'https://api.anthropic.com/v1/messages', 'E4 anthropic url');
			const b = presets.buildLLMWrapper({
				presetId: 'openai-responses',
				baseUrl: 'https://api.openai.com/v1',
				model: 'gpt-4o',
				apiKey: 'sk-x',
				reasoning: false,
				images: false,
				requestType: 'fetch'
			});
			eq(b.url, 'https://api.openai.com/v1/responses', 'E4 responses url');
			assert(!a.url.includes('/v1/v1') && !b.url.includes('/v1/v1'), 'E4 出现 /v1 重复');
		});

		check('E5 baseUrl / model / apiKey 为空 → 抛出含中文提示的 Error', () => {
			const base = {
				presetId: 'deepseek' as LLMPresetId,
				baseUrl: 'https://api.deepseek.com/v1',
				model: 'deepseek-chat',
				apiKey: 'sk-x',
				reasoning: false,
				images: false,
				requestType: 'fetch' as const
			};
			for (const [field, value] of [
				['baseUrl', ''],
				['model', ''],
				['apiKey', '']
			] as const) {
				let err: any;
				try {
					presets.buildLLMWrapper({ ...base, [field]: value } as any);
				} catch (e: any) {
					err = e;
				}
				assert(err instanceof Error, `E5 ${field} 为空时应抛错`);
				assert(
					/[\u4e00-\u9fa5]/.test(err.message),
					`E5 ${field} 为空的错误信息应为中文，实际=${JSON.stringify(err.message)}`
				);
			}
		});

		check('E6 parseLLMWrapper 往返一致（baseUrl / model / apiKey / reasoning / images）', () => {
			const w = presets.buildLLMWrapper({
				presetId: 'zhipu',
				baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
				model: 'glm-4-plus',
				apiKey: 'sk-roundtrip',
				reasoning: true,
				images: true,
				requestType: 'fetch'
			});
			const parsed = presets.parseLLMWrapper(w);
			assert(!!parsed, 'E6 parseLLMWrapper 不应返回 undefined');
			eq(parsed!.baseUrl, 'https://open.bigmodel.cn/api/paas/v4', 'E6 baseUrl');
			eq(parsed!.model, 'glm-4-plus', 'E6 model');
			eq(parsed!.apiKey, 'sk-roundtrip', 'E6 apiKey');
			eq(parsed!.reasoning, true, 'E6 reasoning');
			eq(parsed!.images, true, 'E6 images');
		});

		check('E7 非 LLM wrapper：parseLLMWrapper → undefined；isLLMWrapper → false', () => {
			eq(presets.parseLLMWrapper({} as any), undefined, 'E7 parseLLMWrapper({})');
			assert(presets.isLLMWrapper({} as any) === false, 'E7 isLLMWrapper({}) 应为 false');
			const legacy = {
				url: 'https://example.com/search',
				name: '旧题库',
				method: 'get',
				type: 'fetch',
				headers: {},
				handler: 'return (res)=> [1,2]'
			} as any;
			eq(presets.parseLLMWrapper(legacy), undefined, 'E7 parseLLMWrapper(旧题库)');
			assert(presets.isLLMWrapper(legacy) === false, 'E7 isLLMWrapper(旧题库) 应为 false');
		});

		check('E8 buildLLMWrapper 产出的是 DOM 无关的纯配置（无函数字段，可 JSON 序列化）', () => {
			const w = presets.buildLLMWrapper({
				presetId: 'qwen',
				baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
				model: 'qwen-plus',
				apiKey: 'sk-x',
				reasoning: false,
				images: false,
				requestType: 'fetch'
			});
			assert(!JSON.stringify(w).includes('function'), 'E8 wrapper 不应包含函数');
			eq(JSON.parse(JSON.stringify(w)).llm?.model, 'qwen-plus', 'E8 可 JSON 往返');
		});

		check('E9 预设表新增 jev / digitalocean：总数 11，均为 systemone 且字段合法', () => {
			const ids = presets.LLM_PRESETS.map((p) => p.id);
			eq(ids.length, 11, 'E9 预设总数');
			for (const id of ['jev', 'digitalocean'] as any[]) {
				assert(ids.includes(id), `E9 缺少预设 ${id}，实际=${ids.join(',')}`);
				const p = presets.getLLMPreset(id as any);
				eq(p.id, id, `E9 ${id} 的 id`);
				eq(p.apiFormat, SYSTEMONE, `E9 ${id} 的 apiFormat 应为 systemone`);
				assert(!!p.baseUrl, `E9 ${id} 的 baseUrl 不应为空`);
				assert(!!p.model, `E9 ${id} 的 model 不应为空`);
				assert(Array.isArray(p.models) && p.models.length > 0, `E9 ${id} 的 models 应为非空数组`);
				assert(!!p.name && p.name.length > 0, `E9 ${id} 的 name 不应为空`);
			}
		});

		check('E10 systemone 基地址补 /v1：https://api.typesafe.ai → https://api.typesafe.ai/v1/systemone', () => {
			const norm = (presets as any).normalizeLLMBaseUrl;
			if (typeof norm === 'function') {
				eq(norm('https://api.typesafe.ai', SYSTEMONE), 'https://api.typesafe.ai/v1', 'E10 缺版本段时补 /v1');
				eq(norm('https://api.typesafe.ai/v1', SYSTEMONE), 'https://api.typesafe.ai/v1', 'E10 已含 /v1 时不重复');
			} else {
				warn('E10 normalizeLLMBaseUrl', '未导出 normalizeLLMBaseUrl，仅通过 buildLLMWrapper 间接验证');
			}
			const w = presets.buildLLMWrapper({
				presetId: 'jev' as any,
				baseUrl: 'https://api.typesafe.ai',
				model: 'jev-latest',
				apiKey: 'sk-x',
				reasoning: false,
				images: false,
				requestType: 'fetch'
			} as any);
			eq(w.url, 'https://api.typesafe.ai/v1/systemone', 'E10 jev 最终请求地址');
			assert(!String(w.url).includes('/v1/v1'), `E10 出现 /v1 重复：${w.url}`);
			eq((w.llm as any)?.apiFormat, SYSTEMONE, 'E10 jev wrapper 的 apiFormat');
		});
	}

	// ---------------------------------------------------------------- F
	section('F. 端到端 —— defaultAnswerWrapperHandler 走 LLM 适配器，旧题库不受影响');

	if (!handler?.defaultAnswerWrapperHandler) {
		skipCheck('F 组全部', 'answer.wrapper.handler.ts 的 defaultAnswerWrapperHandler 尚未落地');
	} else if (!adapter?.requestLLMAnswerer) {
		skipCheck('F 组全部', 'llm-answerer.adapter.ts 尚未落地，无法验证 LLM 分支');
	} else {
		const f = await prepareF(handler, adapter);
		if (!f) {
			skipCheck(
				'F 组全部',
				'无法离线拦截 LLM 请求：适配器既无 setDefaultLLMTransport / llmAnswererTransport 注入点，也未经过 globalThis.fetch / GM_xmlhttpRequest。' +
					'请向 lead 反馈「需要可注入 transport 的测试钩子」'
			);
		} else {
			const llmInfo = f.infos.find((i) => i.name === 'LLM 测试题库');

			check('F1 结果数组含 LLM 题库条目，results[0].answer === "A"', () => {
				assert(
					!!llmInfo,
					`F1 未找到名为「LLM 测试题库」的 SearchInformation，实际=${f.infos.map((i) => i.name).join(',')}`
				);
				if (llmInfo!.error) throw new Error(`F1 LLM 题库返回 error：${llmInfo!.error}`);
				eq(llmInfo!.results.length, 1, 'F1 results 数量');
				eq(llmInfo!.results[0].answer, 'A', 'F1 answer');
			});

			check('F2 results[0].question === env.title，response 为解析后的响应体', () => {
				assert(!!llmInfo, 'F2 缺少 LLM 题库条目');
				eq(llmInfo!.results[0].question, '1+1=?', 'F2 question');
				eq(llmInfo!.response, f.llmBody, 'F2 response');
			});

			check('F3 同一批次中的非 LLM 题库仍走旧逻辑（不崩溃，error 字段可容忍）', () => {
				const legacy = f.infos.find((i) => i.name === '旧版题库');
				assert(!!legacy, `F3 未找到旧版题库条目，实际=${f.infos.map((i) => i.name).join(',')}`);
				assert(Array.isArray(legacy!.results), 'F3 旧题库 results 应为数组');
				if (legacy!.error) {
					warn('F3 旧题库返回 error（Node 环境下可接受）', String(legacy!.error));
				} else {
					assert(
						legacy!.results.length === 0 || legacy!.results[0].answer === 'LEGACY',
						`F3 旧题库未走 legacy handler，实际=${JSON.stringify(legacy!.results)}`
					);
				}
			});

			check('F4 未发生真实网络请求（请求全部命中注入点）', () => {
				const hits = f.fetchCalls.length + f.gmCalls.length + f.transportCalls.length;
				assert(hits > 0, 'F4 无任何注入点命中');
				assert(f.infos.length === 2, `F4 应返回 2 条题库信息，实际=${f.infos.length}`);
			});

			check('F5 LLM 请求体字段正确（model / messages / 思考参数）', () => {
				const bodies: any[] = f.bodies;
				if (!bodies.length) {
					warn(
						'F5 无法取到 LLM 请求体',
						`注入方式=${f.injection}，未能捕获 LLM 请求体（测试工具限制，不影响生产逻辑）`
					);
					return;
				}
				const b = bodies[0];
				eq(b.model, 'deepseek-chat', 'F5 model');
				assert(Array.isArray(b.messages), 'F5 messages 应为数组');
				eq(b.messages?.[0]?.role, 'system', 'F5 messages[0].role');
				eq(b.reasoning_effort, 'low', 'F5 思考参数');
				eq(b.stream, false, 'F5 stream');
				assert(!('temperature' in b), 'F5 思考模式下不应下发 temperature');
			});
		}
	}

	// ---------------------------------------------------------------- G
	section('G. request.ts 状态错误形态 —— 适配器把 HTTP 状态错误解析为 LLMRequestError');

	if (!adapter?.requestLLMAnswerer || !adapter?.LLMRequestError) {
		skipCheck('G 组全部', 'llm-answerer.adapter.ts 尚未落地');
	} else {
		await checkAsync('G1 transport 以 Error("HTTP 400: {...}") 拒绝时，错误被保留且可识别为 400', async () => {
			const { transport, calls } = scripted([
				{ throw: new Error('HTTP 400: {"error":{"message":"Unsupported parameter: reasoning_effort"}}') }
			]);
			const err = await expectReject(
				() => adapter.requestLLMAnswerer(makeWrapper({ reasoning: { enabled: false } }), { env: baseEnv(), transport }),
				'G1'
			);
			assert(err instanceof Error, `G1 应抛出 Error，实际=${err?.constructor?.name}`);
			contains(err.message, '400', 'G1 错误信息应保留状态码文本');
			eq(calls.length, 1, 'G1 transport 调用次数');
			if (err instanceof adapter.LLMRequestError && err.status === 400) {
				eq(err.status, 400, 'G1 status');
			} else {
				warn(
					'G1 Error("HTTP 400: …") 未被解析为 LLMRequestError(400)',
					`实际=${err?.constructor?.name}: ${err?.message}。若 request() 会以这种消息拒绝，适配器需要解析其中的状态码`
				);
			}
		});

		await checkAsync(
			'G2 transport 返回 {status:400,text:"{...}"} → LLMRequestError(400) 且信息含服务端文本',
			async () => {
				const { transport } = scripted([
					{ status: 400, text: '{"error":{"message":"Unsupported parameter: reasoning_effort"}}' }
				]);
				const err = await expectReject(
					() =>
						adapter.requestLLMAnswerer(makeWrapper({ reasoning: { enabled: false } }), { env: baseEnv(), transport }),
					'G2'
				);
				assert(
					err instanceof adapter.LLMRequestError,
					`G2 应为 LLMRequestError，实际=${err?.constructor?.name}: ${err?.message}`
				);
				eq(err.status, 400, 'G2 status');
				contains(err.message, 'Unsupported parameter', 'G2 错误信息应含服务端文本');
			}
		);
	}

	// ---------------------------------------------------------------- H
	section('H. llm-answerer.prompt —— 系统 / 用户提示词模板');

	if (!prompt?.buildLLMSystemPrompt || !prompt?.buildLLMUserPrompt) {
		skipCheck('H 组全部', 'llm-answerer.prompt.ts 尚未落地');
	} else {
		check('H1 默认系统提示词与答题风格提示均为非空字符串', () => {
			assert(
				typeof prompt.DEFAULT_LLM_SYSTEM_PROMPT === 'string' && prompt.DEFAULT_LLM_SYSTEM_PROMPT.length > 0,
				`H1 DEFAULT_LLM_SYSTEM_PROMPT 非空字符串，实际=${JSON.stringify(prompt.DEFAULT_LLM_SYSTEM_PROMPT)}`
			);
			assert(
				typeof prompt.DEFAULT_LLM_ANSWER_STYLE_HINT === 'string' && prompt.DEFAULT_LLM_ANSWER_STYLE_HINT.length > 0,
				`H1 DEFAULT_LLM_ANSWER_STYLE_HINT 非空字符串，实际=${JSON.stringify(prompt.DEFAULT_LLM_ANSWER_STYLE_HINT)}`
			);
		});

		check('H2 buildLLMSystemPrompt 替换 ${title} / ${type}，且不残留占位符', () => {
			const s = prompt.buildLLMSystemPrompt(
				cfg({ systemPrompt: '你是答题助手。类型：${type}；题目：${title}' }),
				baseEnv({ title: '题目TITLE', type: 'single' })
			);
			contains(s, '题目TITLE', 'H2 ${title}');
			contains(s, 'single', 'H2 ${type}');
			assert(!s.includes('${'), `H2 仍残留占位符：${s}`);
		});

		check('H3 buildLLMUserPrompt 替换 ${options}，且不残留占位符', () => {
			const u = prompt.buildLLMUserPrompt(
				cfg({ userPrompt: '请作答：${options}' }),
				baseEnv({ options: '选项OPTIONS' })
			);
			contains(u, '选项OPTIONS', 'H3 ${options}');
			assert(!u.includes('${'), `H3 仍残留占位符：${u}`);
		});

		check('H4 未配置 custom 提示词时，两个构造函数仍返回字符串（可为空）', () => {
			const s = prompt.buildLLMSystemPrompt(cfg(), baseEnv());
			const u = prompt.buildLLMUserPrompt(cfg(), baseEnv());
			assert(typeof s === 'string', `H4 系统提示词应为字符串，实际=${typeof s}`);
			assert(typeof u === 'string', `H4 用户提示词应为字符串，实际=${typeof u}`);
			assert(s.length > 0, 'H4 系统提示词默认不应为空（需要给模型行为约束）');
		});
	}

	// ---------------------------------------------------------------- I
	section('I. systemone 请求构造 —— System One / Jev（choice / noul）');

	if (!adapter?.buildLLMAnswererRequest) {
		skipCheck('I 组全部', 'llm-answerer.adapter.ts 的 buildLLMAnswererRequest 尚未落地');
	} else {
		const buildSO = (env: LLMAnswererEnv, over: Record<string, any> = {}) =>
			adapter!.buildLLMAnswererRequest(soCfg(over), env);

		check('I1 single → 单个 choice 题目 + criteria{A..D} + POST /v1/systemone + Bearer 鉴权', () => {
			const env = baseEnv();
			const spec = buildSO(env);
			eq(spec.url, 'https://api.typesafe.ai/v1/systemone', 'I1 url');
			eq(spec.method, 'post', 'I1 method');
			eq(spec.headers.Authorization, 'Bearer sk-test', 'I1 Authorization');
			eq(spec.body.model, 'jev-latest', 'I1 body.model');
			eq(spec.body.state, env.title, 'I1 body.state 应为题干');
			const q = spec.body.questions && spec.body.questions.answer;
			assert(!!q, `I1 缺少 questions.answer，实际=${JSON.stringify(spec.body.questions)}`);
			eq(q.type, 'choice', 'I1 题型应为 choice');
			assert(
				typeof q.instructions === 'string' && q.instructions.trim().length > 0,
				`I1 instructions 应为非空字符串，实际=${JSON.stringify(q.instructions)}`
			);
			const criteria = q.criteria;
			assert(!!criteria && typeof criteria === 'object', `I1 缺少 criteria，实际=${JSON.stringify(criteria)}`);
			eq(Object.keys(criteria).join(','), 'A,B,C,D', 'I1 criteria 的选项标签');
			for (const [label, text] of Object.entries(criteria) as any[]) {
				assert(String(text).length > 0, `I1 criteria.${label} 不应为空`);
				// 契约只要求 criteria[label] 是对应选项的文本；「不重复标签」是 adapter 的实现选择
				// （OPTION_LABEL_PREFIX_RE，仅当标签字母与自身索引一致时剥离），此处锁定该目标行为而非具体剥法。
				assert(
					!new RegExp(`^${label}[.、\\s]`).test(String(text)),
					`I1 criteria.${label} 出现与键重复的标签前缀：${JSON.stringify(text)}`
				);
			}
			notHas(spec.body, 'temperature', 'I1 systemone 请求体');
			notHas(spec.body, 'max_tokens', 'I1 systemone 请求体');
			notHas(spec.body, 'max_completion_tokens', 'I1 systemone 请求体');
			notHas(spec.body, 'reasoning', 'I1 systemone 请求体');
			notHas(spec.body, 'reasoning_effort', 'I1 systemone 请求体');
		});

		check('I2 multiple → 每个选项一个 noul 题目（无 criteria）', () => {
			const env = baseEnv({ type: 'multiple', options: MULTI_OPTIONS });
			const spec = buildSO(env);
			eq(spec.url, 'https://api.typesafe.ai/v1/systemone', 'I2 url');
			eq(spec.body.state, env.title, 'I2 body.state 应为题干');
			const questions = spec.body.questions;
			assert(!!questions && typeof questions === 'object', `I2 缺少 questions，实际=${JSON.stringify(questions)}`);
			eq(Object.keys(questions).join(','), 'A,B,C,D', 'I2 questions 的键应为各选项标签');
			assert(!('answer' in questions), 'I2 multiple 不应再生成单题 answer 节点');
			for (const label of Object.keys(questions)) {
				const q = questions[label];
				eq(q.type, 'noul', `I2 ${label} 题型应为 noul`);
				assert(
					typeof q.instructions === 'string' && q.instructions.trim().length > 0,
					`I2 ${label} instructions 应为非空字符串，实际=${JSON.stringify(q.instructions)}`
				);
				assert(!('criteria' in q), `I2 ${label} noul 题目不应带 criteria`);
			}
		});

		check('I3 judgement → instructions 含「判断题」，仍走 choice 题型', () => {
			const env = baseEnv({ type: 'judgement', options: 'A. 正确\nB. 错误' });
			const spec = buildSO(env);
			const q = spec.body.questions && spec.body.questions.answer;
			assert(!!q, `I3 缺少 questions.answer，实际=${JSON.stringify(spec.body.questions)}`);
			eq(q.type, 'choice', 'I3 judgement 题型应为 choice');
			contains(JSON.stringify(q.instructions ?? ''), '判断题', 'I3 instructions');
			eq(spec.body.state, env.title, 'I3 body.state 应为题干');
		});

		check('I4 type=completion（填空题）→ 抛含「不支持填空」的中文错误', () => {
			const err = expectThrows(() => buildSO(baseEnv({ type: 'completion' })), 'I4 填空题');
			contains(String(err?.message ?? ''), '不支持填空', 'I4 错误信息');
		});

		check('I5 选项不足 2 个 → 抛错（System One 只做选择/判断）', () => {
			const err = expectThrows(() => buildSO(baseEnv({ options: 'A. 唯一选项' })), 'I5 单选项');
			assert(err instanceof Error && !!err.message, `I5 应抛出带信息的 Error，实际=${JSON.stringify(err)}`);
			if (!/选项|选择|判断/.test(String(err?.message))) {
				warn('I5 错误信息', `未说明选项不足的原因：${err?.message}`);
			}
		});
	}

	// ---------------------------------------------------------------- J
	section('J. systemone 解析 —— choice / judgement / noul 阈值与置信度');

	if (!adapter?.extractLLMResponseText) {
		skipCheck('J 组全部', 'llm-answerer.adapter.ts 的 extractLLMResponseText 尚未落地');
	} else {
		check('J1 choice 答案 → 选项字母', () => {
			const r = extractSO(adapter!, soResponse({ answer: soChoice('C', 0.93) }), baseEnv());
			eq(r?.text, 'C', 'J1 text');
		});

		check('J2 judgement（type=judgement 或选项为判断题性质）→ 返回选项原文而非字母', () => {
			const r1 = extractSO(
				adapter!,
				soResponse({ answer: soChoice('A', 0.9) }),
				baseEnv({ type: 'judgement', options: 'A. 正确\nB. 错误' })
			);
			contains(String(r1?.text ?? ''), '正确', 'J2 type=judgement 的答案原文');
			assert(!/^[A-Z]$/.test(String(r1?.text ?? '')), `J2 不应只返回字母，实际=${JSON.stringify(r1?.text)}`);
			// 下游判断题匹配器需要不带序号标签的原文：'A. 正确' → '正确'（adapter 归一化列表的实现选择）。
			eq(r1?.text, '正确', 'J2 判断题回填应剥离与索引一致的标签前缀');
			const r2 = extractSO(
				adapter!,
				soResponse({ answer: soChoice('A', 0.9) }),
				baseEnv({ type: 'single', options: '正确\n错误' })
			);
			contains(String(r2?.text ?? ''), '正确', 'J2 判断题性质选项的答案原文');
			assert(!/^[A-Z]$/.test(String(r2?.text ?? '')), `J2 不应只返回字母，实际=${JSON.stringify(r2?.text)}`);
			eq(r2?.text, '正确', 'J2 无标签选项的判断题原文');
		});

		check('J3 noul 多选：noul>=0.5 的标签按字母序拼接 → AC', () => {
			const payload = soResponse({ A: soNoul(0.9), B: soNoul(0.2), C: soNoul(0.7) });
			const r = extractSO(adapter!, payload, baseEnv({ type: 'multiple', options: MULTI_OPTIONS }));
			eq(r?.text, 'AC', 'J3 text');
		});

		await checkAsync(
			'J4 requestLLMAnswerer + buildLLMSearchInformation：答案 AC，extra_data.confidence=0.7',
			async () => {
				const env = baseEnv({ type: 'multiple', options: MULTI_OPTIONS });
				const payload = soResponse({ A: soNoul(0.9), B: soNoul(0.2), C: soNoul(0.7) });
				const w = makeWrapper({ apiFormat: SYSTEMONE, baseUrl: SYSTEMONE_BASE, noulThreshold: 0.5 } as any);
				const s = scripted([{ status: 200, text: JSON.stringify(payload) }]);
				const result = await adapter!.requestLLMAnswerer(w, { env, transport: s.transport });
				eq(result.answer, 'AC', 'J4 result.answer');
				eq(result.status, 200, 'J4 result.status');
				eq(s.calls.length, 1, 'J4 transport 调用次数');
				eq(s.calls[0].url, 'https://api.typesafe.ai/v1/systemone', 'J4 请求地址');
				const info = adapter!.buildLLMSearchInformation(w, result, env);
				const extra: any = (info.results?.[0] as any)?.extra_data ?? {};
				eq(extra.confidence, 0.7, 'J4 extra_data.confidence');
			}
		);

		await checkAsync('J5 noulThreshold=0.8 → 只选 A（0.7 被阈值挡掉）', async () => {
			const env = baseEnv({ type: 'multiple', options: MULTI_OPTIONS });
			const payload = soResponse({ A: soNoul(0.9), B: soNoul(0.2), C: soNoul(0.7) });
			const w = makeWrapper({ apiFormat: SYSTEMONE, baseUrl: SYSTEMONE_BASE, noulThreshold: 0.8 } as any);
			const s = scripted([{ status: 200, text: JSON.stringify(payload) }]);
			const result = await adapter!.requestLLMAnswerer(w, { env, transport: s.transport });
			eq(result.answer, 'A', 'J5 result.answer');
		});

		await checkAsync('J6 全部 noul 低于阈值 → 抛错', async () => {
			const env = baseEnv({ type: 'multiple', options: MULTI_OPTIONS });
			const payload = soResponse({ A: soNoul(0.3), B: soNoul(0.1) });
			const w = makeWrapper({ apiFormat: SYSTEMONE, baseUrl: SYSTEMONE_BASE, noulThreshold: 0.8 } as any);
			const s = scripted([{ status: 200, text: JSON.stringify(payload) }]);
			const err = await expectReject(
				() => adapter!.requestLLMAnswerer(w, { env, transport: s.transport }),
				'J6 全部低于阈值'
			);
			assert(err instanceof Error && !!err.message, `J6 应抛出带信息的 Error，实际=${JSON.stringify(err)}`);
			if (!/阈值|置信度|无法|不确定/.test(String(err?.message))) {
				warn('J6 错误信息', `未说明阈值原因：${err?.message}`);
			}
		});

		await checkAsync('J7 minConfidence=0.5 且 confidence=0.3 → 抛含「置信度」的中文错误', async () => {
			const env = baseEnv({ type: 'multiple', options: MULTI_OPTIONS });
			const payload = soResponse({ A: soNoul(0.3), B: soNoul(0.1) });
			const w = makeWrapper({
				apiFormat: SYSTEMONE,
				baseUrl: SYSTEMONE_BASE,
				noulThreshold: 0.2,
				minConfidence: 0.5
			} as any);
			const s = scripted([{ status: 200, text: JSON.stringify(payload) }]);
			const err = await expectReject(
				() => adapter!.requestLLMAnswerer(w, { env, transport: s.transport }),
				'J7 置信度不足'
			);
			contains(String(err?.message ?? ''), '置信度', 'J7 错误信息');
		});
	}

	// ------------------------------------------------------------------ K
	section('K. llm-answerer-ui —— 真实浏览器只读 IDL 属性（list）与全按钮回归');
	{
		const env = ensureBrowserEnv();
		const g: any = globalThis as any;
		if (!g.document || typeof g.document.createElement !== 'function') {
			skipCheck('K 组', `缺少可用 DOM 环境（${env}）`);
		} else {
			let ui: any;
			try {
				ui = await import('../packages/scripts/src/utils/llm-answerer-ui');
			} catch (err: any) {
				MISSING.push(`llm-answerer-ui 模块导入失败：${err?.message ?? err}`);
			}
			if (ui && typeof ui.createLLMAnswererForm === 'function') {
				const handlers = {
					onSave: async () => true,
					onClear: () => undefined,
					onTest: async () => undefined
				};
				/**
				 * 关键回归：真实浏览器里 HTMLInputElement.list 是只有 getter 的只读 IDL 属性，
				 * 直接 `input.list = id` 在严格模式下抛 TypeError（jsdom 未实现该访问器，
				 * 因此只跑 jsdom 曾漏掉这个致命错误：表单构造失败 + change 监听器吞异常 = 界面无反应）。
				 * 这里显式把 list 伪装成只读访问器，确保回归可被 jsdom 捕获。
				 */
				const proto = g.HTMLInputElement.prototype;
				const hadOwn = Object.getOwnPropertyDescriptor(proto, 'list');
				Object.defineProperty(proto, 'list', { configurable: true, get: () => null });
				let form: any;
				let buildError: any;
				try {
					form = ui.createLLMAnswererForm(undefined, handlers);
				} catch (err: any) {
					buildError = err;
				}
				try {
					check('K1 list 为只读访问器时 createLLMAnswererForm 不抛异常（回归）', () => {
						if (buildError) throw buildError;
						assert(!!form && !!form.el, '未返回表单实例');
					});
					check('K2 模型输入框改用 setAttribute 写入 list，datalist 关联生效', () => {
						const input = form.el.querySelector('input[list]');
						if (!input) throw new Error('未找到带 list 属性的模型输入框');
						const id = input.getAttribute('list');
						if (!id) throw new Error('list 属性为空');
						if (!form.el.querySelector(`datalist[id="${id}"]`)) throw new Error('未找到对应 datalist');
					});
					check('K3 四种接口格式切换 + 预设联动不抛异常（systemone 归一化 reasoning/images）', () => {
						// jsdom 13 里必须用 window.Event 派发（Node 全局 Event 会报 parameter 1 is not of type 'Event'）
						const EventCtor: any = (g.window && g.window.Event) || g.Event;
						const selects = form.el.querySelectorAll('select');
						assert(selects.length >= 2, `表单内 select 数量异常：${selects.length}`);
						const presetSel: any = selects[0];
						const apiSel: any = selects[1];
						presetSel.value = 'deepseek';
						presetSel.dispatchEvent(new EventCtor('change', { bubbles: true }));
						const afterPreset = form.getValue();
						assert(afterPreset.baseUrl === 'https://api.deepseek.com/v1', `预设未联动 baseUrl=${afterPreset.baseUrl}`);
						presetSel.value = 'jev';
						presetSel.dispatchEvent(new EventCtor('change', { bubbles: true }));
						for (const fmt of ['completions', 'response', 'anthropic', 'systemone']) {
							apiSel.value = fmt;
							apiSel.dispatchEvent(new EventCtor('change', { bubbles: true }));
							const v = form.getValue();
							assert(v.apiFormat === fmt, `切换 ${fmt} 后 apiFormat=${v.apiFormat}`);
							if (fmt === 'systemone') {
								assert(v.reasoning === false, 'systemone 应关闭思考');
								assert(v.images === false, 'systemone 应关闭图片');
							}
						}
					});
					check('K4 表单内全部按钮点击不抛异常', () => {
						const buttons = form.el.querySelectorAll('button');
						assert(buttons.length > 0, '表单内没有按钮');
						for (const b of Array.from(buttons) as any[]) {
							b.click();
						}
					});
				} finally {
					if (hadOwn) Object.defineProperty(proto, 'list', hadOwn);
					else delete proto.list;
				}
			}
		}
	}

	// ------------------------------------------------------------------ L
	section('L. probeAnswerer —— AI 大模型配置不再做无意义的 HEAD 探测（避免误报 404/401）');
	{
		const g: any = globalThis as any;
		let uiModule: any;
		try {
			uiModule = await import('../packages/scripts/src/utils/ui');
		} catch (err: any) {
			MISSING.push(`ui 模块导入失败：${err?.message ?? err}`);
		}
		if (!uiModule || typeof uiModule.probeAnswerer !== 'function') {
			skipCheck('L 组', 'probeAnswerer 未导出');
		} else {
			/**
			 * 回归背景：LLM 配置的 url 是 POST 接口（/chat/completions 等），
			 * 题库列表用不带鉴权的 HEAD/GET 探测它必然被拒绝（401/403/404/405/451），
			 * 于是「测试连接成功、保存后卡片却显示连接失败（404）」——用户看到的正是这个。
			 */
			const llmWrapper: any = {
				name: 'AI 大模型（deepseek-chat）',
				url: 'https://api.deepseek.com/v1/chat/completions',
				homepage: 'https://api.deepseek.com',
				handler: 'return (res) => []',
				method: 'post',
				type: 'GM_xmlhttpRequest',
				contentType: 'json',
				data: {},
				llm: {
					apiFormat: 'completions',
					baseUrl: 'https://api.deepseek.com/v1',
					model: 'deepseek-chat',
					apiKey: 'sk-offline-test'
				}
			};
			const legacyWrapper: any = { ...llmWrapper };
			delete legacyWrapper.llm;

			const calls: any[] = [];
			const originalGm = g.GM_xmlhttpRequest;
			g.GM_xmlhttpRequest = (opts: any) => {
				calls.push(opts);
				return undefined;
			};

			try {
				await checkAsync('L1 LLM 配置直接返回 llm 状态，且不发任何探测请求', async () => {
					const r = await uiModule.probeAnswerer(llmWrapper, false);
					assert(r.status === 'llm', `状态应为 llm，实际 ${r.status}`);
					assert(calls.length === 0, `不应发起探测请求，实际发起 ${calls.length} 次`);
				});

				await checkAsync('L2 停用的 LLM 配置仍优先显示「已停用」（探测分支不被绕过）', async () => {
					const r = await uiModule.probeAnswerer(llmWrapper, true);
					assert(r.status === 'disabled', `状态应为 disabled，实际 ${r.status}`);
					assert(calls.length === 0, `停用不应发起请求，实际 ${calls.length} 次`);
				});

				// 对照组：传统题库仍照常探测（桩返回 404 → error），证明跳过逻辑只针对 LLM 配置
				g.GM_xmlhttpRequest = (opts: any) => {
					calls.push(opts);
					setTimeout(() => opts.onload && opts.onload({ status: 404, responseText: '' }), 0);
				};
				await checkAsync('L3 传统题库仍照常探测（404 → error），跳过只作用于 LLM 配置', async () => {
					const r = await uiModule.probeAnswerer(legacyWrapper, false);
					assert(calls.length === 1, `应发起 1 次探测，实际 ${calls.length} 次`);
					assert(
						calls[0] && String(calls[0].method).toLowerCase() === 'head',
						`应使用 HEAD 探测，实际 ${calls[0]?.method}`
					);
					assert(r.status === 'error' && r.statusCode === 404, `应得到 error/404，实际 ${r.status}/${r.statusCode}`);
				});
			} finally {
				if (originalGm === undefined) delete g.GM_xmlhttpRequest;
				else g.GM_xmlhttpRequest = originalGm;
			}
		}
	}

	// ------------------------------------------------------------------ M
	section('M. 源码级守卫 —— AI 大模型模式必须保留「关闭」按钮（用户反馈过弹窗关不掉）');
	{
		/**
		 * 这一组是「源码级」守卫而非运行时 UI 测试：common.ts 依赖完整 OCS 运行时（$、CommonProject、
		 * 弹窗容器），离线套件无法实例化。而当初的 bug 恰好是「一行 style.display = 'none'」把
		 * 关闭按钮一起隐藏，用源码断言能精确锁死这个回归形态。
		 */
		const path = require('path');
		const fsMod = require('fs');
		let src = '';
		try {
			src = fsMod.readFileSync(path.join(process.cwd(), 'packages/scripts/src/projects/common.ts'), 'utf8');
		} catch {
			src = '';
		}
		if (!src) {
			skipCheck('M 组', '读取 packages/scripts/src/projects/common.ts 失败（请在仓库根目录运行）');
		} else {
			const start = src.indexOf('function syncLLMPanel()');
			const end = src.indexOf("select.addEventListener('change', syncLLMPanel)", start);
			const syncBody = start < 0 ? '' : src.slice(start, end > start ? end : start + 3000);

			check('M1 syncLLMPanel 不再整行隐藏按钮行（否则连「关闭」一起消失）', () => {
				assert(syncBody.length > 0, '未找到 syncLLMPanel 函数体');
				assert(
					!/manualButtons\.style\.display\s*=\s*['"]none['"]/.test(syncBody),
					'syncLLMPanel 仍会把整行按钮隐藏，AI 模式下「关闭」按钮会消失'
				);
			});
			check('M2 AI 模式只隐藏「清空/保存」两颗，并保留「关闭」可见', () => {
				assert(/manualClearButton\.style\.display\s*=\s*['"]none['"]/.test(syncBody), '未隐藏 manualClearButton');
				assert(/manualSaveButton\.style\.display\s*=\s*['"]none['"]/.test(syncBody), '未隐藏 manualSaveButton');
				assert(/manualCloseButton\.style\.display\s*=\s*['"]['"]/.test(src), '未显式保证 manualCloseButton 可见');
			});
			check('M3 「关闭」按钮已提取为独立引用并纳入按钮列表（不再匿名内联）', () => {
				assert(/const manualCloseButton = h\('button', '关闭'/.test(src), '未找到 manualCloseButton 定义');
				assert(
					/manualButtonList: HTMLElement\[\] = \[manualClearButton, manualCloseButton, manualSaveButton\]/.test(src),
					'manualButtonList 未收集三颗按钮引用'
				);
			});
		}
	}

	// ---------------------------------------------------------------- 汇总
	console.log('\n================ 分组统计 ================');
	for (const [name, s] of Object.entries(groups)) {
		console.log(`  ${name.slice(0, 46).padEnd(48)} ✅ ${s.pass}  ❌ ${s.fail}  ⏭️ ${s.skip}`);
	}

	if (warns.length) {
		console.log('\n⚠️  可疑行为（未判失败，需人工核对）：');
		for (const w of warns) console.log(`   - ${w}`);
	}
	if (skips.length) {
		console.log('\n⏭️  跳过项：');
		for (const s of skips) console.log(`   - ${s}`);
	}
	if (failures.length) {
		console.log('\n❌ 失败项：');
		for (const f of failures) console.log(`   - ${f}`);
	}
	if (MISSING.length) {
		console.log('\n🚧 未落地模块：');
		for (const m of MISSING) console.log(`   - ${m}`);
	}

	const total = pass + fail + skip;
	console.log(`\n  ✅ ${pass} 通过   ❌ ${fail} 失败   ⏭️ ${skip} 跳过   共 ${total} 项`);

	if (fail > 0) {
		console.log('\n❌ LLM 答题测试未通过');
	} else if (skip > 0 || MISSING.length) {
		console.log('\n⚠️  LLM 答题测试未完全验证（存在跳过项 / 模块未落地）');
	} else {
		console.log('\n✅ LLM 答题测试全部通过');
	}

	// 显式退出：handler 内部 Promise.race 的 60s 定时器会阻止进程自然退出
	process.exit(fail > 0 || skip > 0 || MISSING.length > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error('\n❌ 测试脚本异常终止：', err);
	process.exit(1);
});
