/**
 * LLM 答案文本解析器（纯函数，无副作用）
 *
 * 负责把大模型五花八门的回复文本转换成可直接参与题库答案匹配的答案字符串，
 * 完整解析顺序见 {@link parseLLMAnswerText}。
 */

/** 需要整体剔除的思考 / 推理标签 */
const THINK_TAGS = ['thinking', 'redacted_thinking', 'reasoning', 'think', 'analysis'];

/** 判断题「正确」的等价写法（比较前已转小写） */
const TRUE_WORDS = ['对', '√', '✓', '正确', 'true', 'yes'];

/** 判断题「错误」的等价写法（比较前已转小写） */
const FALSE_WORDS = ['错', '×', '✗', '错误', 'false', 'no'];

/** 答案里不允许出现的多余包裹字符（引号 / markdown 强调） */
const WRAP_CHARS_RE_SOURCE = '["\'“”‘’「」]';

/** 纯字母答案（整串字母，如 `AB` / `bc`） */
const LETTERS_TOKEN_RE = /^[A-Za-z]+$/;

/** 单字母选项组合（`A B` / `A、B` / `A,B`，分隔符必须非空且每段只有一个字母） */
const LETTER_SEQUENCE_RE = /^[A-Za-z](?:[ \t,，、;；/|]+[A-Za-z])*$/;

/** 是否为纯字母选项答案（`AB` / `A B` / `A、B`）；`A because` 这类英文句子不算 */
function isLetterAnswer(text: string): boolean {
	return LETTERS_TOKEN_RE.test(text) || LETTER_SEQUENCE_RE.test(text);
}

/**
 * 「有意义」的答案字符：拉丁字母、数字、带音标字母、希腊/西里尔字母、日文假名、CJK 汉字
 *
 * 纯标点（如 `!@#$%^&*()`）不算答案，直接返回空串，交给上层提示「未解析出答案」。
 */
const MEANINGFUL_LATIN_RE = /[A-Za-z0-9\u00c0-\u024f\u0370-\u04ff]/;

/** 「有意义」的东亚字符：日文假名、CJK 扩展 A、CJK 汉字、兼容汉字 */
const MEANINGFUL_CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 答案标签行：`答案：` / `答案是：` / `答案为 X` / `Answer:` / `answer is`（取最后一次出现） */
const LABEL_LINE_RE = new RegExp(
	'^(.*?)(?:' +
		'(?:最终答案|正确选项|答案|answer)\\s*(?:是|为)?\\s*[:：]|' +
		'(?:最终答案|正确选项|答案)\\s*(?:是|为)\\s*[:：]?|' +
		'answer\\s+is\\s*[:：]?' +
		')\\s*(.*)$',
	'i'
);

/**
 * 归一化答案文本：
 * - 去掉 markdown 强调、行内代码、包裹引号、`选项 / option` 前缀
 * - 判断题统一成「正确 / 错误」
 * - 纯字母答案去掉分隔符（`a、b` / `A B` / `A,B` → `AB`）并大写
 * - 中文短答案去掉结尾句号；「这道题选 B」这类叙述只取结尾的选项字母
 *
 * @param value 待归一化的文本
 */
export function normalizeLLMAnswer(value: string): string {
	let out =
		typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim();
	if (!out) return '';
	// 去掉 markdown 加粗与行内代码
	out = out.replace(/\*\*/g, '').replace(/`/g, '').trim();
	// 去掉包裹引号
	out = out
		.replace(new RegExp('^' + WRAP_CHARS_RE_SOURCE + '+'), '')
		.replace(new RegExp(WRAP_CHARS_RE_SOURCE + '+$'), '')
		.trim();
	// 去掉「选项 / option」前缀
	out = out.replace(/^(?:选项|option)\s*[:：]?\s*/i, '').trim();
	if (!out) return '';
	// 结尾标点（仅用于判断，不改变返回值）
	const bare = out.replace(/[。.\s]+$/, '').trim();
	const lower = bare.toLowerCase();
	if (TRUE_WORDS.indexOf(lower) >= 0) return '正确';
	if (FALSE_WORDS.indexOf(lower) >= 0) return '错误';
	// 纯字母答案：去掉选项之间的分隔符并大写（注意 \n 不算分隔符，多空填空答案保持原样）
	if (isLetterAnswer(bare)) {
		return bare.replace(/[ \t,，、;；/|]+/g, '').toUpperCase();
	}
	// 中文等短答案：去掉结尾的单个句号（句子内部还有标点时保持原样）
	if (out.length <= 50 && /[。．.]$/.test(out) && !/[。．.;；!！?？]/.test(out.slice(0, -1))) {
		return out.slice(0, -1).trim();
	}
	// 「这道题选 B」「故选B」这类叙述：只取结尾的选项字母
	// 注意：必须出现「选 / 答案」这类叙述词才允许截断，否则会把填空题答案（如「维生素C」）误截成单个字母。
	const tail = /([A-Za-z]{1,4})\s*(?:项|。|．|\.)?$/.exec(out);
	if (tail && out.length <= 30) {
		const before = out.slice(0, tail.index);
		if (/[\u4e00-\u9fa5]/.test(before) && !/[A-Za-z]/.test(before) && /选|答案/.test(before)) {
			return tail[1].toUpperCase();
		}
	}
	// 无意义输入（纯标点 / 纯空白）不算答案；注意本判定必须在 判断题映射 之后，
	// 以保证 √ / × / ✓ / ✗ 已经在上方被转换成「正确 / 错误」
	if (!MEANINGFUL_LATIN_RE.test(out) && !MEANINGFUL_CJK_RE.test(out)) return '';
	return out;
}

/**
 * 去掉思考标签 / 代码块围栏 / `---` 分隔线，返回干净正文（内部使用，可导出）
 *
 * @param raw 模型回复原文
 */
export function stripLLMAnswerNoise(raw: string): string {
	if (typeof raw !== 'string' || !raw) return '';
	let text = raw;
	// 1. 整体剔除思考标签（含未闭合的尾巴）
	for (const tag of THINK_TAGS) {
		text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '');
		text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, 'gi'), '');
		text = text.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), '');
	}
	// 2. 去掉代码块围栏（保留围栏内的内容）
	text = text.replace(/^[ \t]*```[^\n]*$/gm, '');
	text = text.replace(/^[ \t]*~~~[^\n]*$/gm, '');
	// 3. 去掉 --- / *** / ___ 分隔线
	text = text.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, '');
	return text;
}

/** 从 JSON 文本中提取答案字段，解析失败或没有答案字段时返回 undefined */
function extractAnswerFromJSONText(text: string): string | undefined {
	if (!/^[{["]/.test(text)) return undefined;
	let parsed: any;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	return pickAnswerField(parsed);
}

/** 依次取 answer / answers / result / content 字段，数组用 `#` 连接 */
function pickAnswerField(parsed: any): string | undefined {
	if (typeof parsed === 'string') return parsed;
	if (parsed === null || typeof parsed !== 'object') return undefined;
	if (Array.isArray(parsed)) {
		return parsed.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('#');
	}
	for (const key of ['answer', 'answers', 'result', 'content']) {
		if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
		const value = parsed[key];
		if (value === undefined || value === null) continue;
		if (typeof value === 'string') return value;
		if (Array.isArray(value)) {
			return value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('#');
		}
		return JSON.stringify(value);
	}
	return undefined;
}

/** 取标签内容：`<answer>x</answer>` / `<final_answer>x</final_answer>`（大小写不敏感，取最后一个） */
function extractFromTag(raw: string): string | undefined {
	const re = /<(answer|final_answer)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
	let match: RegExpExecArray | null;
	let last: string | undefined;
	while ((match = re.exec(raw)) !== null) {
		last = match[2];
		if (match.index === re.lastIndex) re.lastIndex++;
	}
	if (last !== undefined) return last;
	// 兼容未闭合标签
	const open = /<(answer|final_answer)\b[^>]*>([\s\S]*)$/i.exec(raw);
	if (open) {
		const lines = stripLLMAnswerNoise(open[2])
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		return lines.length ? lines[lines.length - 1] : undefined;
	}
	return undefined;
}

/**
 * 「答案 token + 解释」只取前面的 token：
 * `A。因为…` → `A`、`A because…` → `A`、`正确。因为…` → `正确`、`北京。因为首都嘛` → `北京`；
 * `A、B` / `A B` 这类纯选项组合保持原样。
 */
function extractLeadingAnswerToken(value: string): string {
	const trimmed = value.trim();
	const matched = /^([A-Za-z]{1,8}|正确|错误|对|错|√|×|✓|✗)([\s\S]*)$/.exec(trimmed);
	if (matched) {
		const rest = matched[2];
		if (!rest || !rest.trim()) return trimmed;
		// 纯选项组合（A/B、A B、AB）不是「答案 + 解释」
		if (isLetterAnswer(trimmed)) return trimmed;
		const isProse = /^[。．.;；,，：:、!！?？\u4e00-\u9fa5]/.test(rest) || /^\s+[A-Za-z]{2,}/.test(rest);
		return isProse ? matched[1] : trimmed;
	}
	// 中文等答案 + 解释：只保留第一个句子
	const cut = /^(.{1,20}?)[。．.](?=\s*[\u4e00-\u9fa5])/.exec(trimmed);
	return cut ? cut[1] : trimmed;
}

/** 取最后一个「答案：/ Answer: / 最终答案：/ 正确选项：/ answer is」标签之后的内容 */
function extractAfterLabel(raw: string): string | undefined {
	const lines = raw.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const match = LABEL_LINE_RE.exec(lines[i]);
		if (!match) continue;
		let value = extractLeadingAnswerToken((match[2] || '').trim());
		if (!value) {
			for (let j = i + 1; j < lines.length; j++) {
				if (lines[j].trim()) {
					value = lines[j].trim();
					break;
				}
			}
		}
		if (value) return value;
	}
	return undefined;
}

/** 取 ```answer 代码块内容；没有则取最后一个代码块内容 */
function extractFromFence(raw: string): string | undefined {
	const re = /```([^\n`]*)\r?\n([\s\S]*?)```/g;
	const blocks: { info: string; body: string }[] = [];
	let match: RegExpExecArray | null;
	while ((match = re.exec(raw)) !== null) {
		blocks.push({ info: (match[1] || '').trim().toLowerCase(), body: match[2] });
		if (match.index === re.lastIndex) re.lastIndex++;
	}
	if (!blocks.length) return undefined;
	const answerBlocks = blocks.filter((block) => block.info === 'answer' || block.info === 'final_answer');
	const picked = answerBlocks.length ? answerBlocks[answerBlocks.length - 1] : blocks[blocks.length - 1];
	const body = picked.body.trim();
	if (!body) return undefined;
	const fromJson = extractAnswerFromJSONText(body);
	return fromJson !== undefined ? fromJson : body;
}

/**
 * 从模型回复文本中解析答案
 *
 * 依次尝试：整体 JSON 字段 → `<answer>` 标签 → 「答案:」标签行 → 代码块 → 去噪后取最后一行，
 * 最后统一归一化（见 {@link normalizeLLMAnswer}）。任何异常都返回 `''`，不会抛出。
 *
 * @param raw 模型回复原文
 */
export function parseLLMAnswerText(raw: string): string {
	try {
		if (typeof raw !== 'string' || !raw.trim()) return '';
		// 1. 整体就是 JSON
		const fromJson = extractAnswerFromJSONText(raw.trim());
		if (fromJson !== undefined) return normalizeLLMAnswer(fromJson);
		// 2. <answer> / <final_answer> 标签
		const fromTag = extractFromTag(raw);
		if (fromTag !== undefined) return normalizeLLMAnswer(fromTag);
		// 3. 「答案：」等标签行（取最后一次出现）
		const fromLabel = extractAfterLabel(raw);
		if (fromLabel !== undefined) return normalizeLLMAnswer(fromLabel);
		// 4. 代码块
		const fromFence = extractFromFence(raw);
		if (fromFence !== undefined) return normalizeLLMAnswer(fromFence);
		// 5 ~ 6. 去掉思考与寒暄后取最后一行（单行则直接用该行）
		const lines = stripLLMAnswerNoise(raw)
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		if (!lines.length) return '';
		const candidate = lines.length > 1 ? lines[lines.length - 1] : lines[0];
		return normalizeLLMAnswer(candidate);
	} catch {
		return '';
	}
}
