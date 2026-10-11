/**
 * dsh-webenhance 的浏览器半边：插件设置页。
 *
 * 页面注册进设置的 settings.section 槽位，只在该插件被 Host 服务时出现。
 * 三个 API key 走 credentials 域（不落设置文件），供应商选择走普通配置项。
 *
 * 这里刻意不 import 任何 Host 包：配置命名空间是 profile 条目 id，用字面量写死。
 */

window.__ModuleLoader__.load({
	id: "dsh-webenhance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let prim = require("@deepseek-ai/dsh-client-ui-primitives");

		//#region locales
		/** English copy. */
		const en = {
			title: "Web enhance",
			description: "Search with Parallel, fetch with Tavily and fall back to Firecrawl.",
			searchApiKey: "Parallel API key",
			searchApiKeyHint:
				"Used by web_search. Stored outside the settings file. Leave blank to keep the current key.",
			searchApiKeySet: "A Parallel key is configured.",
			searchApiKeyUnset: "No Parallel key is configured, so web_search has no provider.",
			tavilyApiKey: "Tavily API key",
			tavilyApiKeyHint:
				"Used by web_fetch first. Stored outside the settings file. Leave blank to keep the current key.",
			tavilyApiKeySet: "A Tavily key is configured.",
			tavilyApiKeyUnset: "No Tavily key is configured; web_fetch will start at Firecrawl.",
			firecrawlApiKey: "Firecrawl API key",
			firecrawlApiKeyHint:
				"Used by web_fetch as the fallback. Stored outside the settings file. Leave blank to keep the current key.",
			firecrawlApiKeySet: "A Firecrawl key is configured.",
			firecrawlApiKeyUnset: "No Firecrawl key is configured; web_fetch has no fallback.",
			vendor: "Fetch provider",
			vendorHint: "Tavily first, Firecrawl as the fallback. Auto decides on every call.",
			vendorAuto: "Auto",
			vendorTavily: "Tavily",
			vendorFirecrawl: "Firecrawl",
			overridden: "Overridden",
			reset: "Reset to default",
			readOnly: "This deployment stores settings read-only.",
			unavailable: "This plugin is not loaded, so it cannot be configured right now.",
			save: "Save",
			saving: "Saving…",
			saveFailed: "The deployment did not accept these values; they were left for you to correct."
		};
		/** 简体中文文案。 */
		const zh = {
			title: "网页增强",
			description: "搜索走 Parallel，抓取优先 Tavily，失败降级 Firecrawl。",
			searchApiKey: "Parallel API Key",
			searchApiKeyHint: "供 web_search 使用。不写入设置文件。留空表示保持当前密钥。",
			searchApiKeySet: "已配置 Parallel 密钥。",
			searchApiKeyUnset: "未配置 Parallel 密钥，web_search 将没有可用提供方。",
			tavilyApiKey: "Tavily API Key",
			tavilyApiKeyHint: "供 web_fetch 首先使用。不写入设置文件。留空表示保持当前密钥。",
			tavilyApiKeySet: "已配置 Tavily 密钥。",
			tavilyApiKeyUnset: "未配置 Tavily 密钥，web_fetch 将直接从 Firecrawl 开始。",
			firecrawlApiKey: "Firecrawl API Key",
			firecrawlApiKeyHint: "供 web_fetch 兜底使用。不写入设置文件。留空表示保持当前密钥。",
			firecrawlApiKeySet: "已配置 Firecrawl 密钥。",
			firecrawlApiKeyUnset: "未配置 Firecrawl 密钥，web_fetch 没有兜底。",
			vendor: "抓取提供方",
			vendorHint: "先用 Tavily，失败降级 Firecrawl；自动模式每次调用时自行判断。",
			vendorAuto: "自动",
			vendorTavily: "Tavily",
			vendorFirecrawl: "Firecrawl",
			overridden: "已覆盖",
			reset: "恢复默认",
			readOnly: "本部署的设置为只读。",
			unavailable: "该插件当前未加载，暂时无法配置。",
			save: "保存",
			saving: "保存中…",
			saveFailed: "本部署没有接受这些值，已保留供你修改。"
		};
		/**
		 * 表单框架自己的文案，从本页字典取。
		 * @param t - 本页的字典读取函数。
		 * @returns 共享设置表单渲染所需的标签。
		 */
		function formLabels(t) {
			return {
				unavailable: t("unavailable"),
				readOnly: t("readOnly"),
				saveFailed: t("saveFailed"),
				save: t("save"),
				saving: t("saving")
			};
		}
		//#endregion

		//#region credentials
		/**
		 * 可选的抓取提供方，顺序即分段控件里的显示顺序。
		 *
		 * `label` 是字典键而不是现成的文案：分段控件只该拿到翻好的字符串，翻译留
		 * 在渲染处做。
		 */
		const VENDOR_OPTIONS = [
			{ value: "auto", label: "vendorAuto" },
			{ value: "tavily", label: "vendorTavily" },
			{ value: "firecrawl", label: "vendorFirecrawl" }
		];
		/** 取值集合；config 里认不出时会退回 auto。 */
		const VENDORS = VENDOR_OPTIONS.map((option) => option.value);
		/** 供应商控件的基础 id；分段控件由它派生出每一段的 id。 */
		const VENDOR_CONTROL_ID = "plugin-config-web-enhance-vendor";

		/**
		 * 三个 API key 各自的设置项、环境变量兜底与文案键。
		 *
		 * `envField` 指向 config 里的 credential-ref 字段：Host 用那个字段决定读哪个
		 * 凭据引用。字段会被拍平成顶层，因为设置表单只认顶层字段名。
		 */
		const SECRETS = [
			{
				field: "searchApiKey",
				envField: "searchApiKeyEnv",
				fallback: "PARALLEL_API_KEY",
				id: "plugin-config-web-enhance-search-key",
				label: "searchApiKey",
				hint: "searchApiKeyHint",
				set: "searchApiKeySet",
				unset: "searchApiKeyUnset"
			},
			{
				field: "tavilyApiKey",
				envField: "tavilyApiKeyEnv",
				fallback: "TAVILY_API_KEY",
				id: "plugin-config-web-enhance-tavily-key",
				label: "tavilyApiKey",
				hint: "tavilyApiKeyHint",
				set: "tavilyApiKeySet",
				unset: "tavilyApiKeyUnset"
			},
			{
				field: "firecrawlApiKey",
				envField: "firecrawlApiKeyEnv",
				fallback: "FIRECRAWL_API_KEY",
				id: "plugin-config-web-enhance-firecrawl-key",
				label: "firecrawlApiKey",
				hint: "firecrawlApiKeyHint",
				set: "firecrawlApiKeySet",
				unset: "firecrawlApiKeyUnset"
			}
		];
		//#endregion

		//#region card
		/**
		 * 供应商选择行：标签、分段控件、说明，外加覆盖时的重置。
		 *
		 * 分段控件是受控的——选中值取自表单快照里的暂存文本，点击只调用 edit。这样
		 * 它和文本字段共用同一条「暂存 → 保存」路径，校验与提交时机都不必另起一套。
		 * @param props - 字典、该字段的表单状态与编辑动作。
		 * @returns 供应商选择行。
		 */
		function VendorField(props) {
			const { t, state, disabled } = props;
			const options = VENDOR_OPTIONS.map((option) => ({
				value: option.value,
				label: t(option.label)
			}));
			/* 存下来的值理论上都在 VENDORS 里；万一被手改坏了，控件仍要有段可选中。 */
			const selected = VENDORS.includes(state.text) ? state.text : VENDORS[0];
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "webenhance-field",
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: "webenhance-head",
						children: [
							(0, react_jsx_runtime.jsx)("span", {
								className: "webenhance-label",
								children: t("vendor")
							}),
							state.overridden
								? (0, react_jsx_runtime.jsxs)("span", {
										className: "webenhance-badges",
										children: [
											(0, react_jsx_runtime.jsx)(prim.Tag, {
												tone: "neutral",
												children: t("overridden")
											}),
											(0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "webenhance-reset",
												disabled,
												onClick: props.onReset,
												children: t("reset")
											})
										]
									})
								: null
						]
					}),
					(0, react_jsx_runtime.jsx)(prim.SegmentedControl, {
						id: VENDOR_CONTROL_ID,
						value: selected,
						options,
						onChange: props.onChange,
						label: t("vendor"),
						disabled
					}),
					(0, react_jsx_runtime.jsx)("p", {
						className: "webenhance-hint",
						children: t("vendorHint")
					})
				]
			});
		}

		/**
		 * 按设置分区的要求，渲染一行摘要或完整设置表单。
		 * @param props - 请求的视图、字典、表单快照与动作。
		 * @returns 摘要字符串，或设置表单。
		 */
		function WebEnhanceCard(props) {
			const { t } = props;
			const state = props.useWebEnhanceCard((snapshot) => snapshot);
			if (props.view === "summary") return t("description");
			const disabled = !state.writable;
			return (0, react_jsx_runtime.jsxs)(prim.SettingsForm, {
				labels: formLabels(t),
				state,
				onSave: props.save,
				onDiscard: props.discard,
				children: [
					...SECRETS.map((secret) =>
						(0, react_jsx_runtime.jsx)(
							prim.SettingsSecretField,
							{
								id: secret.id,
								label: t(secret.label),
								hint: t(secret.hint),
								disabled: !state.secrets[secret.field].writable,
								text: state.secrets[secret.field].text,
								configured: state.secrets[secret.field].configured,
								stateLabel: state.secrets[secret.field].configured
									? t(secret.set)
									: t(secret.unset),
								onEdit: (text) => {
									props.edit(secret.field, text);
								}
							},
							secret.field
						)
					),
					(0, react_jsx_runtime.jsx)(VendorField, {
						t,
						state: state.fetchVendor,
						disabled,
						onChange: (value) => {
							props.edit(VENDOR_FIELD, value);
						},
						onReset: () => {
							props.resetField(VENDOR_FIELD);
						}
					})
				]
			});
		}
		//#endregion

		//#region controller
		/**
		 * 本插件在 profile 里的条目 id，也就是配置命名空间。
		 *
		 * 用字面量写死：客户端包不能依赖 Host 包；Host 侧同一常量定义在 lib/index.js。
		 */
		const WEB_ENHANCE_NS = "web-enhance";
		/** 供应商字段；取值受 VENDORS 限制。 */
		const VENDOR_FIELD = "fetchVendor";

		/**
		 * 供应商字段的 spec。
		 *
		 * 复用 settingsTextField 的形状，只把 parse 换掉：填了 VENDORS 之外的值时返回
		 * undefined，表单据此判定非法并拒绝保存，而不是把错值静默写进 patch。
		 * @param field - 顶层字段名。
		 * @returns 表单字段 spec。
		 */
		function settingsVendorField(field) {
			const base = prim.settingsTextField(field);
			return {
				...base,
				parse(text) {
					const value = text.trim();
					if (value.length === 0) return { kind: "clear" };
					if (!VENDORS.includes(value)) return undefined;
					return { kind: "set", value };
				}
			};
		}

		/**
		 * 读取某个 secret 对应 config 字段声明的凭据引用，缺省时回退到默认环境变量名。
		 * @param snapshot - 当前 scope 快照。
		 * @param secret - SECRETS 里的一项。
		 * @returns 要写入 credentials 域的引用。
		 */
		function refOf(snapshot, secret) {
			const declared = snapshot.value?.[secret.envField];
			return typeof declared === "string" && declared.length > 0 ? declared : secret.fallback;
		}

		/** 把 web-enhance 的配置作用域与 credentials 域接到页面上。 */
		var WebEnhanceCardController = class {
			scope;
			ctx;
			form;
			store;
			unsubscribe;
			/** field -> { ref, configured, writable } */
			credentials = new Map();

			/**
			 * @param scope - 绑定到 web-enhance 命名空间的设置作用域。
			 * @param ctx - 页面插件的上下文，其 remote.credentials 域回答凭据状态。
			 */
			constructor(scope, ctx) {
				this.scope = scope;
				this.ctx = ctx;
				this.form = new prim.SettingsFormModel(
					scope,
					[settingsVendorField(VENDOR_FIELD)],
					SECRETS.map((secret) => ({
						field: secret.field,
						write: (text) => this.writeKey(secret, text)
					}))
				);
				this.store = this.form.bind(() => this.projection());
				this.unsubscribe = scope.subscribe(() => {
					this.readAllCredentials();
				});
				this.readAllCredentials();
			}

			/** 表单快照加三个密钥的存在性状态。 */
			projection() {
				const secrets = {};
				for (const secret of SECRETS) {
					const credential = this.credentials.get(secret.field) ?? {
						configured: false,
						writable: true
					};
					secrets[secret.field] = {
						...this.form.field(secret.field),
						configured: credential.configured,
						writable: credential.writable
					};
				}
				return {
					...this.form.shell(),
					fetchVendor: this.form.field(VENDOR_FIELD),
					secrets
				};
			}

			/** 三个密钥一起重读，scope 变更时调用。 */
			readAllCredentials() {
				for (const secret of SECRETS) this.readCredential(secret);
			}

			/**
			 * 查询某个密钥的引用当前是否已配置。
			 *
			 * 响应带着它所描述的引用一起保存：env 名可以在请求与响应之间被改掉，两次
			 * 读取也可能乱序返回，所以只有仍对应当前引用时才发布结果。
			 * @param secret - SECRETS 里的一项。
			 */
			async readCredential(secret) {
				const ref = refOf(this.scope.getSnapshot(), secret);
				const current = this.credentials.get(secret.field);
				if (current?.ref !== ref) {
					this.credentials.set(secret.field, { ref, configured: false, writable: true });
					this.store.set(this.projection());
				}
				const response = await this.ctx.remote.credentials.describe([ref]);
				if (!response.ok || ref !== refOf(this.scope.getSnapshot(), secret)) return;
				const view = response.value[ref];
				const next = {
					ref,
					configured: view?.configured ?? false,
					writable: view?.writable ?? true
				};
				const previous = this.credentials.get(secret.field);
				if (
					previous !== undefined &&
					previous.configured === next.configured &&
					previous.writable === next.writable
				) {
					return;
				}
				this.credentials.set(secret.field, next);
				this.store.set(this.projection());
			}

			/**
			 * Host 报告某个引用变化后就重读它。
			 *
			 * 密钥可能从别处写入（模型页可能指向同一个引用），而设置分区不会因此改变，
			 * 没有这一步的话状态标记会一直显示已经被替换掉的旧状态。
			 * @param ref - Host 报告发生变化的引用。
			 */
			refreshCredential(ref) {
				for (const secret of SECRETS) {
					if (this.credentials.get(secret.field)?.ref === ref) this.readCredential(secret);
				}
			}

			/**
			 * 构造槽位注册要注入的接口。
			 * @returns 页面快照与表单动作。
			 */
			inject() {
				return {
					hooks: { webEnhanceCard: this.store },
					...this.form.actions()
				};
			}

			/**
			 * 写入暂存的密钥，然后重读 Host 是否已持有。
			 * @param secret - SECRETS 里的一项。
			 * @param value - 暂存的密钥明文。
			 * @returns Host 之后是否报告已配置。
			 */
			async writeKey(secret, value) {
				await this.ctx.remote.credentials.set(refOf(this.scope.getSnapshot(), secret), value);
				await this.readCredential(secret);
				return this.credentials.get(secret.field)?.configured ?? false;
			}

			/** 释放配置订阅。 */
			dispose() {
				this.unsubscribe();
				this.form.dispose();
			}
		};
		//#endregion

		//#region index
		/** 本插件拥有的字典命名空间。 */
		const NS = "settings.webEnhance";
		/** 需要的服务（cordis fiber inject）。 */
		const inject = ["slots", "locale", "remote", "remote.credentials", "configForms"];

		/**
		 * 供应商行的样式。
		 *
		 * 设置表单的类名来自它自己的 CSS module，外部拿不到，所以这里按同一套值自带
		 * 一份：字号、间距与分隔线照 fields.module.css 的字段行来，颜色全部走主题
		 * token，深色浅色跟随宿主。选择器统一挂 webenhance- 前缀，避免撞上宿主。
		 */
		const VENDOR_FIELD_CSS = [
			".webenhance-field{display:flex;flex-direction:column;gap:6px;padding:12px 0;border-top:0.5px solid var(--dsw-alias-border-l2);}",
			".webenhance-head{display:flex;align-items:center;gap:8px;}",
			".webenhance-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary);}",
			".webenhance-badges{display:inline-flex;align-items:center;gap:8px;}",
			".webenhance-reset{border:none;background:none;padding:0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer;}",
			".webenhance-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary);}",
			".webenhance-reset:disabled{cursor:default;}",
			".webenhance-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}"
		].join("");

		/**
		 * Host 服务本插件命名空间期间挂载设置页。
		 * @param ctx - 浏览器插件上下文。
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(
				() =>
					ctx.locale.register(NS, {
						zh,
						en
					}),
				"webenhance: dictionaries"
			);
			const card = new WebEnhanceCardController(ctx.configForms.get(WEB_ENHANCE_NS), ctx);
			ctx.effect(() => {
				const style = document.createElement("style");
				style.setAttribute("data-webenhance", "vendor-field");
				style.textContent = VENDOR_FIELD_CSS;
				document.head.append(style);
				return () => {
					style.remove();
				};
			}, "webenhance: field styles");
			ctx.effect(
				() => () => {
					card.dispose();
				},
				"webenhance: form subscription"
			);
			ctx.effect(
				() =>
					ctx.remote.$on("credentials/reference-updated", (ref) => {
						card.refreshCredential(ref);
					}),
				"webenhance: credential invalidations"
			);
			ctx.effect(
				() =>
					ctx.configForms.whileServed([WEB_ENHANCE_NS], () =>
						ctx.slots.inject("settings.section", () =>
							ctx.slots.register(
								{
									name: "settings.section",
									id: "web-enhance",
									order: 45,
									label: () => t("title"),
									inject: () => ({ ...card.inject(), t })
								},
								WebEnhanceCard
							)
						)
					),
				"webenhance: page"
			);
		}
		//#endregion

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
