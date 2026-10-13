/**
 * LLM 答题 —— 在线（真实 API）测试脚本
 *
 * 这是 tests/llm-answerer.test.ts 的「可选」补充：离线套件全部使用注入的 transport，
 * 永远不会访问网络；本脚本才会真正调用你配置的大模型接口，用于人工冒烟验证。
 *
 * 用法：
 *   1) 复制示例配置并填入真实密钥：
 *        cp tests/llm-answerer.live.config.example.json tests/llm-answerer.live.config.json
 *      ⚠️ 该文件内含明文密钥，已被 .gitignore 忽略（真实配置不入库，示例配置保留）。
 *   2) 运行：
 *        pnpm test:llm:live
 *        pnpm test:llm:live -- --config ./path/to/other.json
 *
 * 配置文件字段（JSON 无注释，说明写在这里）：
 *   baseUrl   接口基地址，例如 https://api.deepseek.com/v1 ；
 *             支持 ${apiKey} 占位符（如 Gemini：https://generativelanguage.googleapis.com/v1beta/openai?key=${apiKey}）
 *   apiKey    API 密钥（只会脱敏打印，绝不输出明文）
 *   model     模型名，例如 deepseek-chat
 *   apiFormat 'completions' | 'response' | 'anthropic'（缺省 completions）
 *   reasoning 是否开启思考模式（布尔；缺省 false）
 *   reasoningEffort 'minimal' | 'low' | 'medium' | 'high'（缺省 medium）
 *   budgetTokens  思考预算 token（仅 anthropic 生效，缺省 2048）
 *   images    是否允许上传题干图片（布尔；缺省 false）
 *   title / options / type  题目信息（缺省使用内置示例题）
 *   timeoutSeconds   请求超时秒数（缺省 60）
 *   expected  期望答案（可选）：填写后会与解析结果比对，不一致则退出码 1
 *
 * 退出码：
 *   0 —— 调用成功；或请求失败被判定为「网络不可用」而跳过；或显式 --help
 *   1 —— 未找到配置文件（什么都没跑，不能算通过）、调用失败、HTTP 报错、或答案与 expected 不一致
 *
 * 浏览器环境垫片由 `tsx --import ./tests/setup-browser-env.ts` 预加载；
 * 直接 `npx tsx tests/llm-answerer.live.ts` 时本脚本也会自行兜底安装最小 DOM 垫片。
 */

import fs from 'fs';

import type {
	AnswererWrapper,
	LLMApiFormat,
	SearchInformation
} from '../packages/core/src/core/answer-wrapper/interface';
import type { LLMPresetId } from '../packages/scripts/src/utils/llm-answerer-presets';

type HandlerModule = typeof import('../packages/core/src/core/answer-wrapper/answer.wrapper.handler');
type PresetsModule = typeof import('../packages/scripts/src/utils/llm-answerer-presets');
type AdapterModule = typeof import('../packages/core/src/core/answer-wrapper/llm-answerer.adapter');

// ========== CLI 参数解析（与 tests/answerer.test.ts 一致的 --config 约定） ==========

function getArg(flag: string): string | undefined {
	const idx = process.argv.indexOf(flag);
	return idx !== -1 ? process.argv[idx + 1] : undefined;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
	console.log('LLM 答题在线测试');
	console.log('用法：pnpm test:llm:live [-- --config <配置文件路径>]');
	console.log('默认配置路径：tests/llm-answerer.live.config.json');
	console.log('字段说明见本文件头部注释或 tests/llm-answerer.live.config.example.json');
	process.exit(0);
}

const DEFAULT_CONFIG_PATH = 'tests/llm-answerer.live.config.json';
const CONFIG_PATH = getArg('--config') || DEFAULT_CONFIG_PATH;

interface LiveConfig {
	presetId?: LLMPresetId;
	baseUrl: string;
	apiKey: string;
	model: string;
	apiFormat?: LLMApiFormat;
	reasoning?: boolean;
	reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
	budgetTokens?: number;
	images?: boolean;
	title?: string;
	options?: string;
	type?: string;
	systemPrompt?: string;
	userPrompt?: string;
	maxTokens?: number;
	temperature?: number;
	timeoutSeconds?: number;
	expected?: string;
}

// ========== 敏感信息脱敏 ==========

let SECRET = '';

function mask(text: string): string {
	if (!text) return '';
	if (!SECRET) return text;
	return text.split(SECRET).join(maskKey(SECRET));
}

function maskKey(key: string): string {
	if (key.length <= 6) return '****';
	return `${key.slice(0, 3)}****${key.slice(-2)}`;
}

/** 截断长文本，避免刷屏 */
function truncate(text: string, max: number): string {
	if (!text) return '';
	return text.length > max ? `${text.slice(0, max)}…（共 ${text.length} 字）` : text;
}

/**
 * 收尾退出。
 * 注意：真实网络请求经由 Node 内置 fetch(undici)，若在网络句柄尚未关闭时直接
 * process.exit()，Windows 上会触发 libuv 断言
 * （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c），
 * 退出码会变成 0xC0000409 从而掩盖真实结果。这里先设置 exitCode，再延迟退出。
 */
function finish(code: number): void {
	process.exitCode = code;
	setTimeout(() => process.exit(code), 100);
}

// ========== 浏览器环境垫片（仅为让 easy-us 顶层 class extends HTMLElement 可加载） ==========

function ensureBrowserEnv(): string {
	const g: any = globalThis as any;
	if (typeof g.window !== 'undefined' && typeof g.document !== 'undefined' && typeof g.HTMLElement !== 'undefined') {
		return 'already';
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		require('browser-env')();
		g.unsafeWindow = g.unsafeWindow || {};
		return 'browser-env';
	} catch {
		/* 退化到手写垫片 */
	}
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
	return '手写最小 DOM 垫片';
}

// ========== 主流程 ==========

async function main() {
	console.log('🔌 LLM 答题 —— 在线（真实 API）测试');

	// 未找到配置文件：什么都没跑，属于失败（exit 1），不能报成「通过」
	if (!fs.existsSync(CONFIG_PATH)) {
		console.log(`❌ 未找到在线测试配置文件：${CONFIG_PATH}`);
		console.log('   复制示例配置并填写真实密钥（该文件已被 .gitignore 忽略）：');
		console.log('     cp tests/llm-answerer.live.config.example.json tests/llm-answerer.live.config.json');
		console.log('   或使用 --config <路径> 指定其它配置文件：');
		console.log('     pnpm test:llm:live -- --config ./path/to/your-config.json');
		console.log('   只想跑离线验证请运行：pnpm test:llm');
		// 此时尚未发起任何网络请求，立即退出不会有句柄未关闭的问题
		process.exit(1);
	}

	let config: LiveConfig;
	try {
		config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
	} catch (err: any) {
		console.log(`❌ 配置文件解析失败：${CONFIG_PATH}`);
		console.log(`   ${err?.message ?? err}`);
		return finish(1);
	}

	const missing = (['baseUrl', 'apiKey', 'model'] as const).filter((k) => !String((config as any)[k] ?? '').trim());
	if (missing.length) {
		console.log(`❌ 配置文件缺少必填字段：${missing.join(' / ')}`);
		return finish(1);
	}

	SECRET = config.apiKey;

	const domMode = ensureBrowserEnv();
	const presets: PresetsModule = require('../packages/scripts/src/utils/llm-answerer-presets');
	const handler: HandlerModule = require('../packages/core/src/core/answer-wrapper/answer.wrapper.handler');
	const adapter: AdapterModule = require('../packages/core/src/core/answer-wrapper/llm-answerer.adapter');

	const apiFormat: LLMApiFormat = config.apiFormat || 'completions';
	const reasoning = !!config.reasoning;
	const images = !!config.images;
	const env = {
		title: config.title ?? '1 + 1 = ?',
		options: config.options ?? 'A. 1\nB. 2\nC. 3\nD. 4',
		type: config.type ?? 'single'
	};

	let wrapper: AnswererWrapper;
	try {
		wrapper = presets.buildLLMWrapper({
			presetId: config.presetId as LLMPresetId,
			baseUrl: config.baseUrl,
			model: config.model,
			apiKey: config.apiKey,
			apiFormat,
			reasoning,
			reasoningEffort: config.reasoningEffort,
			budgetTokens: config.budgetTokens,
			images,
			systemPrompt: config.systemPrompt,
			userPrompt: config.userPrompt,
			maxTokens: config.maxTokens,
			temperature: config.temperature,
			requestType: 'fetch',
			timeoutSeconds: config.timeoutSeconds
		} as any);
	} catch (err: any) {
		console.log(`❌ 构建 wrapper 失败：${mask(String(err?.message ?? err))}`);
		return finish(1);
	}

	console.log('--- 配置 ---');
	console.log(`   配置文件 : ${CONFIG_PATH}`);
	console.log(`   DOM 垫片 : ${domMode}`);
	console.log(`   接口格式 : ${apiFormat}`);
	console.log(`   请求地址 : ${mask(wrapper.url)}`);
	console.log(`   模型     : ${wrapper.llm?.model}`);
	console.log(`   思考模式 : ${reasoning ? `开（effort=${config.reasoningEffort ?? 'medium'}）` : '关'}`);
	console.log(`   图片上传 : ${images ? '开' : '关'}`);
	console.log(`   apiKey   : ${maskKey(config.apiKey)}`);
	console.log(`   超时     : ${wrapper.timeout ?? 60}s`);
	console.log('--- 题目 ---');
	console.log(`   title   : ${truncate(env.title, 200)}`);
	console.log(`   options : ${truncate(env.options, 300)}`);
	console.log(`   type    : ${env.type}`);
	console.log('--- 请求 ---');

	const started = Date.now();
	let infos: SearchInformation[] | undefined;
	let thrown: any;
	try {
		infos = await handler.defaultAnswerWrapperHandler([wrapper], env as any);
	} catch (err: any) {
		thrown = err;
	}
	const cost = Date.now() - started;

	if (thrown) {
		const message = mask(String(thrown?.message ?? thrown));
		const httpStatus = typeof thrown?.status === 'number' ? thrown.status : undefined;
		console.log(`❌ 请求抛出异常（${cost}ms）：${truncate(message, 800)}`);
		if (httpStatus === undefined && isNetworkError(message)) {
			console.log('⏭️ 判定为网络不可用，跳过在线测试（退出码 0）');
			return finish(0);
		}
		return finish(1);
	}

	const info = infos?.[0];
	if (!info) {
		console.log('❌ 未返回任何题库信息');
		return finish(1);
	}
	if (info.error) {
		const message = mask(String(info.error));
		console.log(`❌ 题库返回 error（${cost}ms）：${truncate(message, 800)}`);
		if (isNetworkError(message)) {
			console.log('⏭️ 判定为网络不可用，跳过在线测试（退出码 0）');
			return finish(0);
		}
		return finish(1);
	}

	console.log('--- 原始响应 ---');
	console.log(truncate(mask(JSON.stringify(info.response, null, 2) ?? ''), 2000));

	// 适配器把 LLM 元信息放在 results[0].extra_data（SearchInformation 上没有 llmResult 字段）
	const extra: any = (info.results?.[0] as any)?.extra_data ?? {};
	const meta: any = extra.llm ?? {};
	let rawText = '';
	let reasoningText = String(extra.reasoning_content ?? '');
	try {
		const extracted = adapter.extractLLMResponseText(
			(config.apiFormat || 'completions') as LLMApiFormat,
			info.response
		);
		rawText = extracted.text ?? '';
		if (extracted.reasoning) reasoningText = extracted.reasoning;
	} catch (err: any) {
		console.log(`   ⚠️ 从原始响应中提取文本失败：${mask(String(err?.message ?? err))}`);
	}

	if (reasoningText) {
		console.log('--- 思考过程（截断） ---');
		console.log(truncate(mask(reasoningText), 1000));
	}
	if (meta.reasoningFallback) {
		console.log('   ⚠️ 接口不支持思考参数，已自动降级重试（reasoningFallback=true）');
	}

	console.log('--- 结果 ---');
	console.log(`   耗时     : ${cost}ms`);
	console.log(`   HTTP     : ${meta.status ?? 200}`);
	console.log(`   question : ${truncate(String(info.results?.[0]?.question ?? ''), 200)}`);
	console.log(`   原始文本 : ${truncate(mask(rawText), 500)}`);
	console.log(`   最终答案 : ${mask(String(info.results?.[0]?.answer ?? ''))}`);

	if (config.expected !== undefined) {
		const actual = String(info.results?.[0]?.answer ?? '');
		if (actual !== String(config.expected)) {
			console.log(`❌ 答案与 expected 不一致：期望=${config.expected} 实际=${actual}`);
			return finish(1);
		}
		console.log(`   ✅ 与 expected 一致（${config.expected}）`);
	}

	console.log('✅ 在线测试通过');
	// handler 内部的 Promise.race 会留下 60s 的 sleep 定时器，必须主动退出
	return finish(0);
}

/** 网络层错误（未收到 HTTP 响应）判定 */
function isNetworkError(message: string): boolean {
	if (/HTTP \d{3}/.test(message)) return false;
	return /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|请求超时|network|abort|CERT|self-signed|EPROTO/i.test(
		message
	);
}

main().catch((err) => {
	console.log(`❌ 在线测试异常：${mask(String(err?.stack ?? err))}`);
	finish(1);
});
