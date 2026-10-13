import { $ } from '../../utils/common';

/**
 * 发起请求
 * @param url 请求地址
 * @param opts 请求参数
 */
export function request<T extends 'json' | 'text'>(
	url: string,
	opts: {
		type: 'fetch' | 'GM_xmlhttpRequest';
		method?: 'get' | 'post' | 'head';
		responseType?: T;
		headers?: Record<string, string>;
		data?: Record<string, any>;
		/**
		 * 状态探测场景：收到任何 HTTP 状态码都不 reject，
		 * 统一 resolve `{ status: number, responseText: string }`（仅网络错误才 reject）。
		 * 不传时保持原行为（GM 分支仅 200 resolve，fetch 分支不校验状态码）。
		 */
		anyStatus?: boolean;
		/**
		 * 超时时间（毫秒）：超时后 reject，错误信息为中文「请求超时（...ms）」。
		 * fetch 分支使用 AbortController，GM 分支使用 GM_xmlhttpRequest 自带的 timeout。
		 */
		timeout?: number;
	}
): Promise<T extends 'json' ? any : string> {
	return new Promise((resolve, reject) => {
		try {
			/** 默认参数 */
			const { responseType = 'json', method = 'get', type = 'fetch', data = {}, headers = {} } = opts || {};
			/** 环境变量 */
			const env = $.isInBrowser() ? 'browser' : 'node';

			/** 如果是跨域模式并且是浏览器环境 */
			if (type === 'GM_xmlhttpRequest' && env === 'browser') {
				if (typeof GM_xmlhttpRequest !== 'undefined') {
					const contentType = headers['Content-Type'] || headers['content-type'];
					const requestData =
						contentType === 'application/x-www-form-urlencoded'
							? new URLSearchParams(data).toString()
							: Object.keys(data).length
							? JSON.stringify(data)
							: undefined;
					// eslint-disable-next-line no-undef
					GM_xmlhttpRequest({
						url,
						method: method.toUpperCase() as 'GET' | 'HEAD' | 'POST',
						data: requestData,
						headers: Object.keys(headers).length ? headers : undefined,
						responseType: responseType === 'json' ? 'json' : undefined,
						timeout: opts.timeout,
						ontimeout: () => {
							reject(new Error(`请求超时（${opts.timeout}ms）`));
						},
						onload: (response) => {
							if (opts.anyStatus) {
								resolve({ status: response.status, responseText: response.responseText || '' } as any);
								return;
							}
							if (response.status === 200) {
								if (responseType === 'json') {
									try {
										resolve(JSON.parse(response.responseText));
									} catch (error) {
										reject(error);
									}
								} else {
									resolve(response.responseText || '');
								}
							} else {
								const bodyText = response.responseText || '';
								reject(new Error('HTTP ' + response.status + (bodyText ? ': ' + bodyText.slice(0, 500) : '')));
							}
						},
						onerror: (err) => {
							console.error('GM_xmlhttpRequest error', err);
							reject(err);
						}
					});
				} else {
					reject(new Error('GM_xmlhttpRequest is not defined'));
				}
			} else {
				const fet: typeof fetch = env === 'node' ? require('node-fetch').default : fetch;

				/** 超时控制：超时后中止请求 */
				const controller = opts.timeout ? new AbortController() : undefined;
				const timer = controller ? setTimeout(() => controller.abort(), opts.timeout) : undefined;
				const clearTimer = () => {
					if (timer !== undefined) clearTimeout(timer);
				};

				fet(url, {
					body: method === 'post' ? JSON.stringify(data) : undefined,
					method,
					headers,
					signal: controller ? controller.signal : undefined
				})
					.then((response) => {
						if (opts.anyStatus) {
							response
								.text()
								.then((text) => {
									clearTimer();
									resolve({ status: response.status, responseText: text } as any);
								})
								.catch((error) => {
									clearTimer();
									reject(error);
								});
							return;
						}
						if (response.status >= 400) {
							// 把状态码与响应体写进错误信息，方便上层识别 400 / 422 等具体错误
							response
								.text()
								.then((bodyText) => {
									clearTimer();
									reject(new Error('HTTP ' + response.status + (bodyText ? ': ' + bodyText.slice(0, 500) : '')));
								})
								.catch(() => {
									clearTimer();
									reject(new Error('HTTP ' + response.status));
								});
							return;
						}
						if (responseType === 'json') {
							response
								.json()
								.then((res) => {
									clearTimer();
									resolve(res);
								})
								.catch((error) => {
									clearTimer();
									reject(error);
								});
						} else {
							response
								.text()
								.then((res) => {
									clearTimer();
									resolve(res as any);
								})
								.catch((error) => {
									clearTimer();
									reject(error);
								});
						}
					})
					.catch((error) => {
						clearTimer();
						const aborted =
							!!opts.timeout &&
							!!error &&
							(error.name === 'AbortError' || String(error).toLowerCase().indexOf('abort') >= 0);
						if (aborted) {
							reject(new Error(`请求超时（${opts.timeout}ms）`));
						} else {
							reject(new Error(error));
						}
					});
			}
		} catch (error) {
			reject(error);
		}
	});
}
