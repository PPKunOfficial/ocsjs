import type { LLMApiFormat, LLMAnswererResult } from '@ocsjs/core';
import { LLM_PRESETS, buildLLMWrapper, getLLMPreset } from './llm-answerer-presets';
import type { LLMAnswererFormValue, LLMPreset, LLMPresetId } from './llm-answerer-presets';

/** 供调用方按需导入的类型（表单值与预设 id 由 presets 模块统一定义） */
export type { LLMAnswererFormValue, LLMPresetId, LLMPresetInput } from './llm-answerer-presets';

/**
 * LLM（大模型）答题配置表单
 *
 * 设计约束（便于测试与解耦）：
 * - 纯 DOM：只用 document.createElement 与本文件的 el() 小工具，**不 import easy-us / common.ts / work.ts**；
 * - 零副作用：不读写配置 / localStorage / 不发网络请求（「测试连接」「保存」全部通过 handlers 回调交给调用方）；
 * - 只依赖纯数据模块 llm-answerer-presets.ts（预设默认值 + buildLLMWrapper 校验）。
 *
 * 调用方（common.ts 的「题库配置」弹窗）只需把 form.el 放进弹窗内容区，并在 handlers 里落库即可。
 */

/** 表单内状态提示类型 */
export type LLMFormStatusType = 'info' | 'success' | 'warning' | 'error';

/** LLM 答题表单回调（网络请求、配置读写、弹窗控制都由调用方负责） */
export interface LLMAnswererFormHandlers {
	/** 保存配置：调用方负责校验风险（confirmRiskyAnswerWrappers）、合并写入配置并提示；返回 true 时表单回填并复位按钮 */
	onSave: (value: LLMAnswererFormValue) => Promise<boolean>;
	/** 清空题库配置 / 退出 AI 模式：调用方负责二次确认与写入 */
	onClear: () => void;
	/**
	 * 测试连接：调用方发起真实请求（例如 requestLLMAnswerer），并：
	 * - 调用 pending(true) 禁用测试按钮并显示加载，pending(false) 结束；
	 * - 返回 LLMAnswererResult 时表单展示成功预览（答案 / 思考 / HTTP 状态 / 耗时）；
	 * - 抛异常时表单展示 e.message（中文）。
	 */
	onTest: (value: LLMAnswererFormValue, pending: (loading: boolean) => void) => Promise<LLMAnswererResult | void>;
	/**
	 * 关闭弹窗：AI 大模型模式下，底部按钮行整体换成表单自己的按钮行（见 LLMAnswererForm.footer），
	 * 因此「关闭」按钮由表单提供，调用方只需在这里关掉弹窗容器。
	 */
	onClose: () => void;
}

/** LLM 答题配置表单实例 */
export interface LLMAnswererForm {
	/** 表单字段区（含输入框与提示，不含按钮） */
	el: HTMLElement;
	/**
	 * 表单自己的按钮行：「🗑️ 清空 AI 配置 / 🔌 测试连接 / 关闭 / 💾 保存配置」，
	 * 由调用方放进弹窗底部按钮行，与普通题库模式的底部按钮保持同一样式与位置
	 * （注意：该节点不在 el 内，需单独插入 DOM，否则按钮不会显示）。
	 */
	footer: HTMLElement;
	/** 读取当前表单值（已做 trim 与数值兜底归一化） */
	getValue: () => LLMAnswererFormValue;
	/** 回填表单（编辑已保存配置 / 保存成功后回填归一化值），只需传需要修改的字段 */
	setValue: (value?: Partial<LLMAnswererFormValue>) => void;
	/** 设置表单内状态文字（测试连接结果等），传空字符串隐藏 */
	setStatus: (text: string, type?: LLMFormStatusType) => void;
}

/** el() 的属性表：style 单独处理，其余按 DOM 属性赋值 */
type ElAttrs = { style?: Partial<CSSStyleDeclaration> } & Record<string, any>;

/** 沿原型链查找属性描述符（判断某个键能否安全地按属性名赋值） */
function findPropertyDescriptor(target: any, key: string): PropertyDescriptor | undefined {
	let cur = target;
	while (cur) {
		const desc = Object.getOwnPropertyDescriptor(cur, key);
		if (desc) return desc;
		cur = Object.getPrototypeOf(cur);
	}
	return undefined;
}

/* eslint-disable indent */
/**
 * 极简元素创建工具（等价项目里 h() 的用法，但不依赖 easy-us，保证本模块纯 DOM 可测试）
 * 这里用重载而不是 HTMLElementTagNameMap，避免 eslint no-undef 对 TS 专有全局类型误报。
 * @param tag 标签名
 * @param attrs 属性表（style 会合并到内联样式，其余按 DOM 属性赋值）
 * @param children 子节点
 */
function el(tag: 'input', attrs?: ElAttrs, children?: (Node | string)[]): HTMLInputElement;
function el(tag: 'select', attrs?: ElAttrs, children?: (Node | string)[]): HTMLSelectElement;
function el(tag: 'textarea', attrs?: ElAttrs, children?: (Node | string)[]): HTMLTextAreaElement;
function el(tag: 'button', attrs?: ElAttrs, children?: (Node | string)[]): HTMLButtonElement;
function el(tag: string, attrs?: ElAttrs, children?: (Node | string)[]): HTMLElement;
function el(tag: string, attrs?: ElAttrs, children?: (Node | string)[]): HTMLElement {
	const node = document.createElement(tag);
	if (attrs) {
		for (const [key, value] of Object.entries(attrs)) {
			if (value === undefined || value === null) continue;
			if (key === 'style') {
				Object.assign(node.style, value);
			} else if (key in node) {
				// list / form / labels 等是只有 getter 的只读 IDL 属性：按属性名赋值在严格模式下会抛
				// TypeError（真实浏览器会抛，jsdom 里则会静默失败、HTML 属性也不会写入），
				// 因此这类键一律用 setAttribute 写成 HTML 属性。
				const desc = findPropertyDescriptor(node, key);
				if (desc && !desc.set && desc.writable !== true) {
					node.setAttribute(key, String(value));
				} else {
					try {
						(node as unknown as Record<string, any>)[key] = value;
					} catch {
						node.setAttribute(key, String(value));
					}
				}
			} else {
				node.setAttribute(key, String(value));
			}
		}
	}
	if (children && children.length) node.append(...children);
	return node;
}

/** 表单行：标题 + 控件 + 可选说明 */
function field(label: string, control: HTMLElement, hint?: HTMLElement | string): HTMLElement {
	return el('div', { style: { marginBottom: '12px' } }, [
		el('div', { style: { fontSize: '13px', marginBottom: '4px', color: '#333' } }, [label]),
		control,
		...(hint ? [hint instanceof HTMLElement ? hint : hintText(hint)] : [])
	]);
}

/** 灰字说明 */
function hintText(text: string): HTMLElement {
	return el('div', { style: HINT_STYLE }, [text]);
}

/** 说明文字样式 */
const HINT_STYLE: Partial<CSSStyleDeclaration> = {
	fontSize: '12px',
	color: '#909399',
	marginTop: '4px',
	lineHeight: '1.6'
};

/** 普通输入控件占满一行 */
const FULL_WIDTH: Partial<CSSStyleDeclaration> = { width: '100%', boxSizing: 'border-box' };

/** 可勾选行（checkbox + 文案） */
function checkRow(checkbox: HTMLInputElement, text: string, hint?: string): HTMLElement {
	return el('div', { style: { marginBottom: '12px' } }, [
		el('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', cursor: 'pointer' } }, [
			checkbox,
			text
		]),
		...(hint ? [hintText(hint)] : [])
	]);
}

/** 底部/内联小按钮的统一放大样式（与 common.ts 的 enlargeFooterButton 保持一致） */
const FOOTER_BUTTON_STYLE: Partial<CSSStyleDeclaration> = { padding: '4px 12px', fontSize: '14px' };

/** 接口格式候选（下拉顺序） */
const API_FORMAT_OPTIONS: { value: LLMApiFormat; label: string }[] = [
	{ value: 'completions', label: 'OpenAI 兼容 Chat Completions（/chat/completions）' },
	{ value: 'response', label: 'OpenAI Responses API（/responses）' },
	{ value: 'anthropic', label: 'Anthropic Messages API（/messages）' },
	{ value: 'systemone', label: '系统一（System One / Jev）' }
];

/** 思考强度候选 */
const REASONING_EFFORT_OPTIONS: { value: LLMAnswererFormValue['reasoningEffort']; label: string }[] = [
	{ value: 'minimal', label: 'minimal（最少思考，最快）' },
	{ value: 'low', label: 'low（较少）' },
	{ value: 'medium', label: 'medium（默认）' },
	{ value: 'high', label: 'high（最多思考，最慢但更准）' }
];

/** 状态提示的配色（沿用项目里的浅色底 + 同色系文字） */
const STATUS_STYLES: Record<LLMFormStatusType, Partial<CSSStyleDeclaration>> = {
	info: { color: '#1c7ed6', background: '#e7f5ff', border: '1px solid #a5d8ff' },
	success: { color: '#2f9e44', background: '#ebfbee', border: '1px solid #b2f2bb' },
	warning: { color: '#e8590c', background: '#fff4e6', border: '1px solid #ffd8a8' },
	error: { color: '#c92a2a', background: '#fff5f5', border: '1px solid #ffc9c9' }
};

/** 提示词占位符说明（${title} 等由适配器替换，需关闭 eslint 的模板字符串误报） */
// eslint-disable-next-line no-template-curly-in-string
const PROMPT_PLACEHOLDER_HINT = '支持占位符：${title} 题目、${options} 选项、${type} 题型。';
// eslint-disable-next-line no-template-curly-in-string
const SYSTEM_PROMPT_PLACEHOLDER = '留空使用内置默认提示词。可写：你是答题助手，请根据 ${title} 的 ${options} 作答。';
// eslint-disable-next-line no-template-curly-in-string
const USER_PROMPT_PLACEHOLDER = '留空由程序按题面自动拼装。可写：题目：${title}\n选项：${options}\n题型：${type}';

/** 表单实例自增序号（避免同一页面多个表单的 datalist id 冲突） */
let formSeq = 0;

/** 截断长文本（测试预览用） */
function truncate(text: string, max = 120): string {
	return text.length > max ? text.slice(0, max) + '…' : text;
}

/**
 * 创建 LLM 答题配置表单
 * @param initial 表单初始值（编辑已保存配置时传 parseLLMWrapper 的结果）
 * @param handlers 保存 / 清空 / 测试连接回调（由调用方实现副作用）
 */
export function createLLMAnswererForm(
	initial: Partial<LLMAnswererFormValue> | undefined,
	handlers: LLMAnswererFormHandlers
): LLMAnswererForm {
	const uid = 'llm-model-options-' + ++formSeq;

	/** 用户是否手动改写过接口地址 / 模型（改写后切换预设不再自动覆盖，可用「恢复预设默认」重置） */
	const edited = { baseUrl: false, model: false };

	// ============================ 控件 ============================
	const presetSelect = el('select', { className: 'base-style-active-form-control', style: FULL_WIDTH });
	for (const preset of LLM_PRESETS) {
		presetSelect.append(el('option', { value: preset.id }, [preset.name]));
	}

	const presetNote = el('div', { style: HINT_STYLE });

	const apiFormatSelect = el('select', { className: 'base-style-active-form-control', style: FULL_WIDTH });
	for (const item of API_FORMAT_OPTIONS) {
		apiFormatSelect.append(el('option', { value: item.value }, [item.label]));
	}

	const baseUrlInput = el('input', {
		type: 'text',
		className: 'modal-input',
		style: FULL_WIDTH,
		placeholder: 'https://api.openai.com/v1'
	});

	const modelOptions = el('datalist', { id: uid });
	const modelInput = el('input', {
		type: 'text',
		list: uid,
		className: 'modal-input',
		style: FULL_WIDTH,
		placeholder: '例如 deepseek-chat'
	});

	const apiKeyInput = el('input', {
		type: 'password',
		className: 'modal-input',
		style: FULL_WIDTH,
		placeholder: 'sk-...',
		autocomplete: 'off'
	});
	// 字段内的行内小按钮，尺寸比底部按钮小一号（底部按钮统一放大到 4px 12px / 14px）
	const apiKeyToggle = el(
		'button',
		{ type: 'button', className: 'modal-cancel-button', style: { padding: '2px 8px', fontSize: '12px' } },
		['显示']
	);
	const apiKeyRow = el('div', { style: { display: 'flex', gap: '8px' } }, [
		el('div', { style: { flex: '1' } }, [apiKeyInput]),
		apiKeyToggle
	]);

	const maxTokensInput = el('input', {
		type: 'number',
		min: '1',
		step: '1',
		className: 'modal-input',
		style: FULL_WIDTH,
		value: '512'
	});

	const temperatureInput = el('input', {
		type: 'number',
		min: '0',
		max: '2',
		step: '0.1',
		className: 'modal-input',
		style: FULL_WIDTH,
		value: '0.3'
	});

	const reasoningCheckbox = el('input', { type: 'checkbox' });

	const effortSelect = el('select', { className: 'base-style-active-form-control', style: FULL_WIDTH });
	for (const item of REASONING_EFFORT_OPTIONS) {
		effortSelect.append(el('option', { value: item.value }, [item.label]));
	}
	// 原生 select 默认选中第一项，这里显式设为 medium（与「思考强度默认 medium」的约定一致）
	effortSelect.value = 'medium';

	const budgetInput = el('input', {
		type: 'number',
		min: '1',
		step: '1',
		className: 'modal-input',
		style: FULL_WIDTH,
		value: '2048'
	});

	const fallbackCheckbox = el('input', { type: 'checkbox', checked: true });

	const imagesCheckbox = el('input', { type: 'checkbox' });

	const systemPromptInput = el('textarea', {
		className: 'modal-input',
		style: { ...FULL_WIDTH, minHeight: '60px' },
		placeholder: SYSTEM_PROMPT_PLACEHOLDER
	});

	const userPromptInput = el('textarea', {
		className: 'modal-input',
		style: { ...FULL_WIDTH, minHeight: '60px' },
		placeholder: USER_PROMPT_PLACEHOLDER
	});

	const requestTypeSelect = el('select', { className: 'base-style-active-form-control', style: FULL_WIDTH }, [
		el('option', { value: 'GM_xmlhttpRequest' }, ['GM_xmlhttpRequest（可跨域，推荐）']),
		el('option', { value: 'fetch' }, ['fetch（需要接口允许 CORS）'])
	]);

	const timeoutInput = el('input', {
		type: 'number',
		min: '5',
		step: '1',
		className: 'modal-input',
		style: FULL_WIDTH,
		value: '120'
	});

	// System One（Jev）专属参数：仅该格式显示（多选题判定阈值 / 最低置信度）
	const noulThresholdInput = el('input', {
		type: 'number',
		min: '0',
		max: '1',
		step: '0.05',
		className: 'modal-input',
		style: FULL_WIDTH,
		value: '0.5'
	});

	const minConfidenceInput = el('input', {
		type: 'number',
		min: '0',
		max: '1',
		step: '0.05',
		className: 'modal-input',
		style: FULL_WIDTH,
		value: '0'
	});

	const restoreButton = el(
		'button',
		{
			type: 'button',
			className: 'modal-cancel-button',
			style: { ...FOOTER_BUTTON_STYLE, padding: '2px 8px', fontSize: '12px' }
		},
		['恢复预设默认']
	);

	// ============================ 状态与按钮 ============================
	const statusEl = el('div', {
		style: {
			display: 'none',
			whiteSpace: 'pre-wrap',
			padding: '8px',
			borderRadius: '4px',
			fontSize: '12px',
			lineHeight: '1.6',
			marginBottom: '12px'
		}
	});

	const testButton = el('button', { type: 'button', className: 'modal-cancel-button', style: FOOTER_BUTTON_STYLE }, [
		'🔌 测试连接'
	]);
	const saveButton = el('button', { type: 'button', className: 'modal-confirm-button', style: FOOTER_BUTTON_STYLE }, [
		'💾 保存配置'
	]);
	const clearButton = el('button', { type: 'button', className: 'modal-cancel-button', style: FOOTER_BUTTON_STYLE }, [
		'🗑️ 清空 AI 配置'
	]);
	/** 「关闭」按钮：与普通题库模式底部按钮同名同样式，保证两种模式看起来完全一致 */
	const closeButton = el('button', { type: 'button', className: 'modal-cancel-button', style: FOOTER_BUTTON_STYLE }, [
		'关闭'
	]);
	/**
	 * 按钮行：由调用方放进弹窗底部，与普通题库模式的底部按钮行同一位置、同一布局
	 * （清空类按钮靠左，其余靠右）。宽度撑满，便于操作按钮右对齐。
	 */
	clearButton.style.marginRight = 'auto';
	const buttonRow = el(
		'div',
		{
			style: {
				display: 'flex',
				flexWrap: 'wrap',
				alignItems: 'center',
				justifyContent: 'flex-end',
				// 间距与官方题库面板底部（gap: 12px）保持一致，AI 模式与普通模式看起来完全同款
				gap: '12px',
				width: '100%'
			}
		},
		[clearButton, testButton, closeButton, saveButton]
	);

	// ============================ 可见性联动 ============================
	const effortRow = field('思考强度', effortSelect, 'minimal 最快、high 最准，缺省 medium。');
	const budgetRow = field(
		'思考预算 token',
		budgetInput,
		'仅 Anthropic 思考模式生效（默认 2048），预算越大思考越充分。'
	);
	const fallbackRow = checkRow(fallbackCheckbox, '接口不支持思考参数时自动去掉重试一次（推荐开启）');
	/** 思考开关整行（System One 格式下整体隐藏） */
	const reasoningRow = checkRow(
		reasoningCheckbox,
		'开启思考（推理）',
		'思考模型（o 系列、deepseek-reasoner、claude 扩展思考等）请开启。'
	);
	/** System One（Jev）格式提示：只做选择/判断、不支持填空题与图片 */
	const systemoneHint = el(
		'div',
		{
			style: {
				...STATUS_STYLES.info,
				display: 'none',
				padding: '8px',
				borderRadius: '4px',
				fontSize: '12px',
				lineHeight: '1.6',
				marginBottom: '12px'
			}
		},
		['⚡ System One（Jev）只返回选择/判断，填空题会自动跳过；不支持图片输入。']
	);
	const noulThresholdRow = field(
		'多选判定阈值',
		noulThresholdInput,
		'0 ~ 1，默认 0.5：多选题里判定值 ≥ 阈值的选项才算正确答案。'
	);
	const minConfidenceRow = field(
		'最低置信度',
		minConfidenceInput,
		'0 ~ 1，0 = 不校验；模型置信度低于该值的题目不会自动作答。'
	);
	const reasoningHint = el('div', { style: { ...HINT_STYLE, marginBottom: '12px' } }, [
		'💡 思考模型（o 系列、deepseek-reasoner、claude 扩展思考等）请开启：开启后回答更准但更慢更贵。',
		el('br'),
		'思考模式会移除 temperature、改用推理参数；Anthropic 思考模式下 max_tokens 会自动大于思考预算；若服务端不支持推理参数会自动重试一次。'
	]);

	/**
	 * 根据思考开关与接口格式显示/隐藏相关字段。
	 *
	 * System One（Jev）没有思考参数、也不支持图片：整体隐藏思考区、禁用「发送图片」并展示其专属参数；
	 * 切回其它格式时所有控件恢复原状（这里每次都是重新计算 display / disabled，不留一次性状态）。
	 */
	const updateVisibility = () => {
		const isSystemOne = apiFormatSelect.value === 'systemone';
		const reasoning = reasoningCheckbox.checked && !isSystemOne;
		const isAnthropic = apiFormatSelect.value === 'anthropic';
		reasoningRow.style.display = isSystemOne ? 'none' : '';
		effortRow.style.display = reasoning ? '' : 'none';
		budgetRow.style.display = reasoning && isAnthropic ? '' : 'none';
		fallbackRow.style.display = reasoning ? '' : 'none';
		reasoningHint.style.display = reasoning ? '' : 'none';
		systemoneHint.style.display = isSystemOne ? '' : 'none';
		noulThresholdRow.style.display = isSystemOne ? '' : 'none';
		minConfidenceRow.style.display = isSystemOne ? '' : 'none';
		imagesCheckbox.disabled = isSystemOne;
		modelInput.placeholder = isSystemOne ? 'jev-latest' : '例如 deepseek-chat';
	};

	// ============================ 预设联动 ============================
	/** 刷新模型名下拉候选 */
	const refreshModelOptions = (preset: LLMPreset) => {
		modelOptions.textContent = '';
		modelOptions.append(...preset.models.map((model) => el('option', { value: model })));
	};

	/**
	 * 带出预设默认值
	 * @param force 是否强制覆盖用户输入（「恢复预设默认」按钮使用）
	 */
	const applyPresetDefaults = (force: boolean) => {
		const preset = getLLMPreset(presetSelect.value as LLMPresetId);
		apiFormatSelect.value = preset.apiFormat;
		refreshModelOptions(preset);
		presetNote.textContent = preset.note ?? '';
		if (force || !edited.baseUrl) baseUrlInput.value = preset.baseUrl;
		if (force || !edited.model) modelInput.value = preset.model;
		if (force) {
			edited.baseUrl = false;
			edited.model = false;
		}
		updateVisibility();
	};

	presetSelect.onchange = () => applyPresetDefaults(false);
	apiFormatSelect.onchange = () => {
		const preset = getLLMPreset(presetSelect.value as LLMPresetId);
		refreshModelOptions(preset);
		if (!edited.baseUrl) baseUrlInput.value = preset.baseUrl;
		if (!edited.model) modelInput.value = preset.model;
		updateVisibility();
	};
	reasoningCheckbox.onchange = updateVisibility;
	restoreButton.onclick = () => applyPresetDefaults(true);
	baseUrlInput.addEventListener('input', () => {
		edited.baseUrl = true;
	});
	modelInput.addEventListener('input', () => {
		edited.model = true;
	});
	apiKeyToggle.onclick = () => {
		const hidden = apiKeyInput.type === 'password';
		apiKeyInput.type = hidden ? 'text' : 'password';
		apiKeyToggle.textContent = hidden ? '隐藏' : '显示';
	};

	// ============================ 表单值 ============================
	/** 正整数读取：空 / 非法 / <=0 一律回退默认值 */
	const readPositiveInt = (input: HTMLInputElement, fallback: number): number => {
		const value = Number(input.value.trim());
		return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
	};

	/** 温度读取：空 = undefined（不下发该参数），超范围夹到 0 ~ 2 */
	const readTemperature = (input: HTMLInputElement): number | undefined => {
		if (input.value.trim() === '') return undefined;
		const value = Number(input.value.trim());
		if (!Number.isFinite(value)) return undefined;
		return Math.min(2, Math.max(0, value));
	};

	/** 0 ~ 1 比例读取（多选判定阈值 / 最低置信度）：空或非法回退默认值，超范围夹到 0 ~ 1 */
	const readUnitNumber = (input: HTMLInputElement, fallback: number): number => {
		if (input.value.trim() === '') return fallback;
		const value = Number(input.value.trim());
		if (!Number.isFinite(value)) return fallback;
		return Math.min(1, Math.max(0, value));
	};

	const getValue = (): LLMAnswererFormValue => ({
		presetId: presetSelect.value as LLMPresetId,
		apiFormat: apiFormatSelect.value as LLMApiFormat,
		baseUrl: baseUrlInput.value.trim(),
		model: modelInput.value.trim(),
		apiKey: apiKeyInput.value.trim(),
		systemPrompt: systemPromptInput.value.trim(),
		userPrompt: userPromptInput.value.trim(),
		maxTokens: readPositiveInt(maxTokensInput, 512),
		temperature: readTemperature(temperatureInput),
		// System One（Jev）没有思考参数、也不支持图片：即使隐藏的开关仍是勾选状态，提交时也按 false
		reasoning: reasoningCheckbox.checked && apiFormatSelect.value !== 'systemone',
		reasoningEffort: effortSelect.value as LLMAnswererFormValue['reasoningEffort'],
		budgetTokens: readPositiveInt(budgetInput, 2048),
		fallback: fallbackCheckbox.checked,
		images: imagesCheckbox.checked && apiFormatSelect.value !== 'systemone',
		timeoutSeconds: readPositiveInt(timeoutInput, 120),
		requestType: requestTypeSelect.value === 'fetch' ? 'fetch' : 'GM_xmlhttpRequest',
		// System One（Jev）专属参数
		noulThreshold: readUnitNumber(noulThresholdInput, 0.5),
		minConfidence: readUnitNumber(minConfidenceInput, 0)
	});

	const setValue = (value?: Partial<LLMAnswererFormValue>) => {
		if (!value) return;
		if ('presetId' in value && value.presetId) {
			presetSelect.value = value.presetId;
			const preset = getLLMPreset(value.presetId);
			refreshModelOptions(preset);
			presetNote.textContent = preset.note ?? '';
		}
		if ('apiFormat' in value && value.apiFormat) apiFormatSelect.value = value.apiFormat;
		if ('baseUrl' in value && value.baseUrl !== undefined) {
			baseUrlInput.value = value.baseUrl;
			// 回填的配置视为用户输入，避免切换预设时被默认值覆盖
			edited.baseUrl = value.baseUrl !== '';
		}
		if ('model' in value && value.model !== undefined) {
			modelInput.value = value.model;
			edited.model = value.model !== '';
		}
		if ('apiKey' in value && value.apiKey !== undefined) apiKeyInput.value = value.apiKey;
		if ('systemPrompt' in value && value.systemPrompt !== undefined) systemPromptInput.value = value.systemPrompt;
		if ('userPrompt' in value && value.userPrompt !== undefined) userPromptInput.value = value.userPrompt;
		if ('maxTokens' in value && value.maxTokens !== undefined) maxTokensInput.value = String(value.maxTokens);
		if ('temperature' in value)
			temperatureInput.value = value.temperature === undefined ? '' : String(value.temperature);
		if ('reasoning' in value && value.reasoning !== undefined) reasoningCheckbox.checked = value.reasoning;
		if ('reasoningEffort' in value && value.reasoningEffort) effortSelect.value = value.reasoningEffort;
		if ('budgetTokens' in value && value.budgetTokens !== undefined) budgetInput.value = String(value.budgetTokens);
		if ('fallback' in value && value.fallback !== undefined) fallbackCheckbox.checked = value.fallback;
		if ('images' in value && value.images !== undefined) imagesCheckbox.checked = value.images;
		if ('timeoutSeconds' in value && value.timeoutSeconds !== undefined)
			timeoutInput.value = String(value.timeoutSeconds);
		if ('requestType' in value && value.requestType) requestTypeSelect.value = value.requestType;
		if ('noulThreshold' in value && value.noulThreshold !== undefined)
			noulThresholdInput.value = String(value.noulThreshold);
		if ('minConfidence' in value && value.minConfidence !== undefined)
			minConfidenceInput.value = String(value.minConfidence);
		updateVisibility();
	};

	const setStatus = (text: string, type: LLMFormStatusType = 'info') => {
		if (!text) {
			statusEl.style.display = 'none';
			statusEl.textContent = '';
			return;
		}
		Object.assign(statusEl.style, STATUS_STYLES[type], { display: 'block' });
		statusEl.textContent = text;
	};

	// ============================ 保存 / 测试 / 清空 ============================
	const setSavePending = (loading: boolean) => {
		saveButton.disabled = loading;
		saveButton.textContent = loading ? '保存中 ...' : '💾 保存配置';
	};

	saveButton.onclick = async () => {
		const value = getValue();
		// 本地必填校验：与 buildLLMWrapper 共用同一套规则与中文提示（仅校验必填/格式，不落库）
		try {
			buildLLMWrapper(value);
		} catch (error: any) {
			setStatus('⚠️ ' + (error?.message || '配置不完整，请检查后重试'), 'error');
			return;
		}
		setSavePending(true);
		try {
			const saved = await handlers.onSave(value);
			if (saved) {
				// 保存成功：用刚提交的归一化值回填自身（去掉首尾空格 / 圆整数值），并复位按钮
				setValue(value);
				setStatus('✅ 已保存 LLM 答题配置，重新答题或刷新界面即可生效。', 'success');
			}
		} catch (error: any) {
			setStatus('❌ 保存失败：' + (error?.message || String(error)), 'error');
		} finally {
			setSavePending(false);
		}
	};

	clearButton.onclick = () => handlers.onClear();
	closeButton.onclick = () => handlers.onClose();

	const setTestPending = (loading: boolean) => {
		testButton.disabled = loading;
		testButton.textContent = loading ? '测试中 ...' : '🔌 测试连接';
	};

	/** 展示测试结果预览：答案 / 思考（截断）+ HTTP 状态 + 本地计时 */
	const renderTestResult = (result: LLMAnswererResult, elapsed: number) => {
		const lines: string[] = [`✅ 接口请求成功（HTTP ${result.status}，耗时 ${elapsed} 毫秒）`];
		lines.push('模型答案：' + truncate(result.answer || result.answerText || '（空）'));
		if (result.reasoning) lines.push('思考内容：' + truncate(result.reasoning));
		if (result.reasoningFallback) lines.push('提示：服务端未接受思考参数，本次已自动去掉思考参数重试。');
		setStatus(lines.join('\n'), 'success');
	};

	testButton.onclick = async () => {
		const value = getValue();
		try {
			buildLLMWrapper(value);
		} catch (error: any) {
			setStatus('⚠️ ' + (error?.message || '配置不完整，请检查后重试'), 'error');
			return;
		}
		setTestPending(true);
		setStatus('⏳ 正在带上题目调用接口测试，会消耗少量额度，请稍候…', 'info');
		const startedAt = Date.now();
		try {
			const result = await handlers.onTest(value, setTestPending);
			const elapsed = Date.now() - startedAt;
			if (result) {
				renderTestResult(result, elapsed);
			} else {
				setStatus(`✅ 测试完成（耗时 ${elapsed} 毫秒）。`, 'success');
			}
		} catch (error: any) {
			setStatus('❌ 测试失败：' + (error?.message || String(error)), 'error');
		} finally {
			setTestPending(false);
		}
	};

	// ============================ 组装 ============================
	const advancedSection = el(
		'details',
		{ style: { marginBottom: '12px', border: '1px solid #e9ecef', borderRadius: '4px', padding: '8px' } },
		[
			el('summary', { style: { cursor: 'pointer', fontSize: '13px', color: '#555' } }, [
				'⚙️ 高级设置（提示词 / 图片 / 请求方式 / 超时）'
			]),
			el('div', { style: { marginTop: '10px' } }, [
				field('系统提示词', systemPromptInput, '留空使用内置默认提示词，一般无需修改。' + PROMPT_PLACEHOLDER_HINT),
				field('用户提示词模板', userPromptInput, '留空由程序按题面自动拼装。' + PROMPT_PLACEHOLDER_HINT),
				checkRow(imagesCheckbox, '发送题目图片（需要多模态模型，会略微增加费用）'),
				field('请求方式', requestTypeSelect, '脚本管理器环境下推荐 GM_xmlhttpRequest（可跨域）。'),
				field('超时秒数', timeoutInput, '思考模型较慢，建议 120 秒以上，最长等待单次请求。')
			])
		]
	);

	const root = el('div', { style: { width: '100%', fontSize: '13px', color: '#333' } }, [
		statusEl,
		field(
			'接口预设',
			el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [
				el('div', { style: { flex: '1' } }, [presetSelect]),
				restoreButton
			]),
			presetNote
		),
		field('接口格式', apiFormatSelect, '决定请求路径与请求体结构；选择预设时自动带出，一般无需修改。'),
		field('接口地址', baseUrlInput, '只填到版本号即可，例如 https://api.deepseek.com/v1，不要带 /chat/completions。'),
		el('div', { style: { marginBottom: '12px' } }, [
			el('div', { style: { fontSize: '13px', marginBottom: '4px', color: '#333' } }, ['模型名称']),
			modelInput,
			modelOptions,
			hintText('可直接手填模型名，或从下拉候选里选择。')
		]),
		field('API Key', apiKeyRow, '仅保存在本地题库配置中，答题时作为请求头发送，不会显示到页面其他地方。'),
		field('最大输出 token', maxTokensInput, '答案长度上限，512 一般足够；太小可能导致答案被截断。'),
		field('温度', temperatureInput, '越大越发散，答题建议 0.1 ~ 0.5；留空则不下发该参数（思考模式推荐留空）。'),
		systemoneHint,
		noulThresholdRow,
		minConfidenceRow,
		reasoningRow,
		reasoningHint,
		effortRow,
		budgetRow,
		fallbackRow,
		advancedSection
	]);

	// 初始化：先应用默认预设，再用 initial 覆盖（initial 通常来自 parseLLMWrapper）
	applyPresetDefaults(true);
	updateVisibility();
	if (initial) setValue(initial);

	return { el: root, footer: buttonRow, getValue, setValue, setStatus };
}
