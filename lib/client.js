// dsh-notify 客户端插件：任务完成 / 需要确认时的桌面通知与页内小卡片。
//
// 事件源：uiSession.sessionStatus 这个客户端聚合快照（running / pendingInteraction /
// completionUnread），因此不需要拦截 approval/request 之类的 waterfall，零干扰风险。
//   · running 从 true 变成 false            → 任务完成
//   · pendingInteraction 的 key 发生变化     → 需要确认（approval / plan-review / question）
//
// 双通道：
//   · 窗口隐藏或失焦 → HTML5 Notification（Windows 通知中心）+ 标题栏计数徽标
//   · 窗口可见但没在看那个会话 → shell.overlay 里右下角的小卡片
//   · 点击通知或卡片 → 回焦窗口并直接打开对应会话
//
// 偏好存在 localStorage，设置行注册在 settings.general.item。
window.__ModuleLoader__.load({
	id: "dsh-notify",
	factory: (require) => {
		const React = require("react");
		const h = React.createElement;

		/** 需要的客户端服务：会话列表、聚合状态、导航、插槽、文案。 */
		const inject = ["sessions", "uiSession", "uiWorkspace", "slots", "locale"];

		const NS = "dsh-notify";
		const PREFS_KEY = "dsh-notify:prefs";
		const DEFAULTS = { complete: true, attention: true, sound: false };
		const MAX_CARDS = 4;
		/**
		 * 恢复窗口时，多久以内的提醒才算「用户刚点的这条」：只有这种单条提醒才自动切换会话，
		 * 更旧或积压的提醒一律落成页内卡片，避免用户只是切回窗口就被带去别的会话。
		 */
		const PENDING_FRESH_MS = 45 * 1000;

		/** Simplified Chinese dictionary（键集基准）。 */
		const zh = {
			"settings.title": "通知",
			"settings.hint": "后台或最小化时提醒任务完成与需要确认的操作；页面可见时在右下角显示小卡片。",
			"settings.complete": "任务完成",
			"settings.attention": "需要确认",
			"settings.sound": "提示音",
			"settings.permission": "系统通知",
			"settings.granted": "已启用",
			"settings.default": "未授权",
			"settings.denied": "已被系统拒绝，请在系统设置中允许",
			"settings.unsupported": "当前环境不支持",
			"settings.enable": "启用",
			"settings.test": "测试通知",
			"settings.last": "最近提醒：{time} · {channel}",
			"settings.last.none": "最近提醒：暂无",
			"settings.channel.host": "Windows 通知",
			"settings.channel.system": "系统通知",
			"settings.channel.card": "页内卡片",
			"settings.channel.blocked": "页内卡片（系统通知未授权）",
			"settings.channel.failed": "页内卡片（系统通知发送失败）",
			"settings.channel.silent": "未打扰（正在查看该会话）",
			"notify.title.complete": "DSH · 任务完成",
			"notify.title.attention": "DSH · 需要确认",
			"notify.body": "{session}：{detail}",
			"notify.complete.detail": "本轮任务已结束",
			"notify.attention.approval": "有操作等待你批准",
			"notify.attention.plan-review": "有一份计划等待你确认",
			"notify.attention.question": "有一个问题等待你回答",
			"notify.attention.generic": "有操作等待你处理",
			"card.complete": "任务完成",
			"card.attention": "需要确认",
			"card.open": "打开",
			"card.dismiss": "忽略",
			"session.new": "新会话",
			"session.untitled": "未命名会话",
			"preview.title": "测试会话",
			"preview.body": "这是一条测试通知",
		};

		/** English dictionary（与中文键集一致）。 */
		const en = {
			"settings.title": "Notifications",
			"settings.hint": "Remind you about finished tasks and confirmations while DSH is in the background or minimized; visible windows get a small card in the corner.",
			"settings.complete": "Task finished",
			"settings.attention": "Confirmation needed",
			"settings.sound": "Sound",
			"settings.permission": "System notifications",
			"settings.granted": "Enabled",
			"settings.default": "Not granted",
			"settings.denied": "Blocked by the system; allow it in system settings",
			"settings.unsupported": "Not supported here",
			"settings.enable": "Enable",
			"settings.test": "Test notification",
			"settings.last": "Last reminder: {time} · {channel}",
			"settings.last.none": "Last reminder: none yet",
			"settings.channel.host": "Windows notification",
			"settings.channel.system": "system notification",
			"settings.channel.card": "in-page card",
			"settings.channel.blocked": "in-page card (system notifications not granted)",
			"settings.channel.failed": "in-page card (system notification failed)",
			"settings.channel.silent": "skipped (you were viewing this session)",
			"notify.title.complete": "DSH · Task finished",
			"notify.title.attention": "DSH · Confirmation needed",
			"notify.body": "{session}: {detail}",
			"notify.complete.detail": "This turn has finished",
			"notify.attention.approval": "An action is waiting for your approval",
			"notify.attention.plan-review": "A plan is waiting for your review",
			"notify.attention.question": "A question is waiting for your answer",
			"notify.attention.generic": "Something is waiting for your input",
			"card.complete": "Task finished",
			"card.attention": "Confirmation needed",
			"card.open": "Open",
			"card.dismiss": "Dismiss",
			"session.new": "New session",
			"session.untitled": "Untitled session",
			"preview.title": "Test session",
			"preview.body": "This is a test notification",
		};

		const css = [
			// 右下角卡片栈：shell.overlay 的浮层本身是 click-through，这里只让卡片本身接收指针事件。
			".dshn-overlay{position:fixed;right:16px;bottom:16px;z-index:30;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none}",
			// 卡片是普通页面浮层，必须跟随当前主题：用宿主弹层表面 token（bg-layer-1 + label-primary + elevation-panel），
			// 不要用 toast token——toast 在亮色主题下也是深色底，会渲染成一块黑卡。
			".dshn-card{pointer-events:auto;box-sizing:border-box;width:340px;max-width:calc(100vw - 48px);display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-panel);animation:dshn-card-in .16s ease-out}",
			"@keyframes dshn-card-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}",
			"@media (prefers-reduced-motion:reduce){.dshn-card{animation:none}}",
			".dshn-mark{flex:none;width:8px;height:8px;margin-top:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}",
			".dshn-card[data-kind=attention] .dshn-mark{background:var(--dsw-alias-state-warn-primary)}",
			".dshn-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
			".dshn-eyebrow{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
			".dshn-title{font-size:14px;font-weight:500;line-height:22px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}",
			".dshn-body{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}",
			".dshn-actions{display:flex;align-items:center;gap:6px;margin-top:6px}",
			".dshn-open{height:26px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff);font:inherit;font-size:12px;line-height:1;cursor:pointer}",
			".dshn-open:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 84%,var(--dsw-alias-bg-layer-1))}",
			".dshn-dismiss{height:26px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer}",
			".dshn-dismiss:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary)}",
			".dshn-open:focus-visible,.dshn-dismiss:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary);outline-offset:2px}",
			// 设置行：与 General 区其它行共用 16px 纵向内边距 + 细分割线。
			".dshn-row{display:flex;flex-direction:column;gap:12px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}",
			".dshn-row-head{display:flex;flex-direction:column;gap:4px}",
			".dshn-row-title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}",
			".dshn-row-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".dshn-toggles{display:flex;flex-wrap:wrap;align-items:center;gap:8px 24px}",
			".dshn-toggle{display:flex;align-items:center;gap:10px}",
			".dshn-toggle-label{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}",
			// 开关样式照抄宿主 General 设置里的 switch（role=switch + aria-checked）。
			".dshn-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer}",
			".dshn-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}",
			".dshn-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}",
			".dshn-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb);transition:transform .12s ease}",
			".dshn-switch[aria-checked=true] .dshn-thumb{transform:translate(16px)}",
			".dshn-foot{display:flex;flex-wrap:wrap;align-items:center;gap:12px}",
			".dshn-state{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".dshn-last{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".dshn-action{border:0;background:transparent;color:var(--dsw-alias-link,var(--dsw-alias-state-business-primary));font:inherit;font-size:12px;line-height:18px;padding:0;cursor:pointer}",
			".dshn-action:hover{text-decoration:underline}",
			".dshn-action:disabled{opacity:.5;cursor:default;text-decoration:none}",
		].join("\n");

		/** 极简外部 store：组件用 useStore 订阅，apply 侧只负责 set。 */
		function createStore(initial, onSet) {
			let snapshot = initial;
			const listeners = new Set();
			return {
				getSnapshot: () => snapshot,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				set(next) {
					snapshot = next;
					onSet?.(next);
					for (const listener of [...listeners]) listener();
				},
			};
		}

		/** React 侧订阅 store。 */
		function useStore(store) {
			const [snapshot, setSnapshot] = React.useState(store.getSnapshot);
			React.useEffect(() => {
				const sync = () => setSnapshot(store.getSnapshot());
				sync();
				return store.subscribe(sync);
			}, [store]);
			return snapshot;
		}

		function loadPrefs() {
			try {
				const raw = window.localStorage.getItem(PREFS_KEY);
				if (raw === null) return { ...DEFAULTS };
				const parsed = JSON.parse(raw);
				return {
					complete: parsed.complete !== false,
					attention: parsed.attention !== false,
					sound: parsed.sound === true,
				};
			} catch {
				return { ...DEFAULTS };
			}
		}

		/** 把 pendingInteraction.kind 收敛成四种提醒类别。 */
		function pendingKind(kind) {
			return kind === "approval" || kind === "plan-review" || kind === "question" ? kind : "generic";
		}

		/** 当前页面是否跑在 DSH 桌面壳里（自定义协议 dsh-app://）。 */
		function isDesktopShell() {
			try {
				return window.location.protocol === "dsh-app:" || window.dshDesktop?.protocolVersion === 1;
			} catch {
				return false;
			}
		}

		/** 通知与卡片的控制器：监听聚合状态，决定走系统通知还是页内卡片。 */
		class Notifier {
			constructor(ctx, prefs, t) {
				this.ctx = ctx;
				this.prefs = prefs;
				this.t = t;
				this.cards = createStore([]);
				// 系统通知权限与最近一次提醒的通道，设置行直接订阅这两个 store。
				this.permissionStore = createStore(this.permission());
				this.lastStore = createStore(null);
				// 逐会话跟踪上一帧的 running / pending key：新会话在插件启动后才出现时，
				// 只靠对比两份快照会漏掉它的第一次完成，所以维护自己的状态表。
				this.tracked = new Map();
				this.badgeCount = 0;
				this.audio = null;
				this.seq = 0;
				this.unsubscribeStatus = null;
				this.pendingInFlight = false;
				// 标题栏徽标与宿主共享 document.title：记下自己写过的整串标题和当时的正文。
				this.appliedTitle = null;
				this.badgeBaseTitle = "";
				this.titleObserver = null;
			}

			start() {
				// 先播种当前快照，避免插件激活（或页面刷新）时把历史状态重放成提醒。
				for (const [sessionId, status] of this.ctx.uiSession.sessionStatus.getSnapshot()) {
					this.tracked.set(sessionId, {
						running: status.running === true,
						pendingKey: status.pendingInteraction?.key,
					});
				}
				this.unsubscribeStatus = this.ctx.uiSession.sessionStatus.subscribe(() => this.onStatusChange());
				this.onFocus = () => {
					this.setBadge(0);
					this.refreshPermission();
					// 点 toast 回焦与「从托盘/最小化恢复」都会走到这里；提醒本身按 45 s 内的
					// 单条才自动打开会话，所以单纯 Alt-Tab 切回来不会平白切走当前对话。
					this.consumePendingOpen();
				};
				this.onVisibilityChange = () => {
					if (document.visibilityState === "visible") {
						this.setBadge(0);
						this.consumePendingOpen();
					}
					this.refreshPermission();
					this.recordDiag("visibility");
				};
				window.addEventListener("focus", this.onFocus);
				document.addEventListener("visibilitychange", this.onVisibilityChange);
				// 标题归宿主所有（DocumentTitle 会整体重写 document.title）：盯着标题元素，
				// 宿主改完标题后把计数徽标补回去，避免徽标被吞、badgeCount 与实际显示失同步。
				if (typeof MutationObserver !== "undefined") {
					this.titleObserver = new MutationObserver(() => this.refreshTitleBadge());
					this.titleObserver.observe(document.head ?? document.documentElement, {
						childList: true,
						subtree: true,
						characterData: true,
					});
				}
				this.recordDiag("start");
				// 桌面壳里 Chromium 的通知权限由主进程自动授权，页面无需用户手势也能请求；
				// 用户没点过「启用」时自动请求一次，避免后台/托盘时只能落进看不见的页内卡片。
				if (this.permission() === "default" && isDesktopShell()) this.requestPermission();
			}

			stop() {
				this.unsubscribeStatus?.();
				this.unsubscribeStatus = null;
				window.removeEventListener("focus", this.onFocus);
				document.removeEventListener("visibilitychange", this.onVisibilityChange);
				this.titleObserver?.disconnect();
				this.titleObserver = null;
				this.setBadge(0);
				this.releaseAudio();
			}

			/** 关掉提示音用的 AudioContext：插件停用/重载后不把音频资源留在页面里。 */
			releaseAudio() {
				const audio = this.audio;
				this.audio = null;
				if (audio === null) return;
				try {
					const closing = audio.close();
					closing?.catch?.(() => {});
				} catch {
					// 已经关过或环境不支持：忽略。
				}
			}

			/** 会话列表快照（客户端 SessionSummary 行）。 */
			list() {
				return this.ctx.sessions.list.getSnapshot();
			}

			/** 当前主视图正在显示的会话 id。 */
			currentSessionId() {
				const list = this.list();
				for (const row of Object.values(list.byId ?? {})) {
					if ((row.retainedBy?.mainView ?? 0) > 0) return row.id;
				}
				return undefined;
			}

			sessionTitle(sessionId) {
				const row = this.list().byId?.[sessionId];
				if (row === undefined) return this.t("session.untitled");
				if (row.blank === true) return this.t("session.new");
				const title = row.title?.trim() ?? "";
				return title === "" ? this.t("session.untitled") : title;
			}

			/**
			 * 从会话事件窗口里取最后一条「有文本的助手消息」，作为完成通知的正文摘要。
			 * 事件类型与内容块形状见客户端 SessionEvent 契约（assistant/message →
			 * data.message.content[]，文本块的 type === "text"）；取不到时返回 undefined。
			 */
			summaryFor(sessionId) {
				if (sessionId === undefined) return undefined;
				try {
					const binding = this.ctx.sessions.binding?.(sessionId);
					const entries = binding?.eventSource?.getSnapshot?.()?.entries ?? [];
					for (let index = entries.length - 1; index >= 0; index -= 1) {
						const entry = entries[index];
						if (entry?.type !== "event") continue;
						const event = entry.event;
						if (event?.type !== "assistant/message") continue;
						const content = event.data?.message?.content;
						if (!Array.isArray(content)) continue;
						const text = content
							.filter((block) => block?.type === "text")
							.map((block) => block.text ?? "")
							.join(" ")
							.replace(/\s+/g, " ")
							.trim();
						if (text === "") continue;
						return text.length > 120 ? `${text.slice(0, 120)}…` : text;
					}
				} catch {
					// 事件窗口不可用（未 retain / 已被清理）时退回默认文案。
				}
				return undefined;
			}

			/**
			 * 桌面壳里点击 Windows toast 会经 dsh://open 把应用拉回前台；此时向 Host 取
			 * 最近弹过通知的会话。恢复窗口后 45 s 内的单条提醒视为「刚点的这条」，直接打开；
			 * 更旧或积压多条时只补成页内卡片，不替用户切换会话。
			 * 由「隐藏 → 可见」的恢复与窗口获得焦点触发，pendingInFlight 挡住同一轮重复取。
			 */
			async consumePendingOpen() {
				if (!isDesktopShell()) return;
				if (this.pendingInFlight === true) return;
				if (document.visibilityState !== "visible" || !document.hasFocus()) return;
				this.pendingInFlight = true;
				try {
					const response = await fetch("/api/dsh-notify/pending", {
						headers: { "x-dsh-notify-request": "1" },
					});
					if (!response.ok) return;
					const payload = await response.json().catch(() => null);
					// 宿主还没重启时返回的仍是旧协议（只有单值 sessionId）：保持「点通知即打开」。
					if (!Array.isArray(payload?.items)) {
						const legacy = typeof payload?.sessionId === "string" ? payload.sessionId : "";
						this.recordDiag("pending-open", { legacy: true, sessionId: legacy });
						if (legacy === "" || legacy === this.currentSessionId()) return;
						this.ctx.uiWorkspace.openSession(legacy);
						return;
					}
					const items = payload.items;
					const viewing = this.currentSessionId();
					const fresh = items.filter(
						(entry) => typeof entry?.sessionId === "string" && entry.sessionId !== "" && entry.sessionId !== viewing,
					);
					this.recordDiag("pending-open", {
						items: items.length,
						fresh: fresh.length,
						viewing: viewing ?? null,
					});
					if (fresh.length === 0) return;
					const latest = fresh[fresh.length - 1];
					if (fresh.length === 1 && Date.now() - latest.at <= PENDING_FRESH_MS) {
						this.ctx.uiWorkspace.openSession(latest.sessionId);
						return;
					}
					for (const entry of fresh) {
						this.pushCard({
							kind: entry.kind === "attention" ? "attention" : "complete",
							sessionId: entry.sessionId,
							title: entry.title,
							detail: entry.text,
						});
					}
				} catch {
					// 宿主还没加载新路由时静默忽略。
				} finally {
					this.pendingInFlight = false;
				}
			}

			/** sessionStatus 变化：把 running 的 true→false 与新的 pendingInteraction 翻译成事件。 */
			onStatusChange() {
				const next = this.ctx.uiSession.sessionStatus.getSnapshot();
				const list = this.list();
				for (const [sessionId, status] of next) {
					// 只提醒普通主会话：subagent 子会话只是父会话的内部执行体，不单独提醒。
					if (list.byId?.[sessionId]?.origin === "subagent" || list.byId?.[sessionId] === undefined) continue;
					const before = this.tracked.get(sessionId) ?? {};
					if (before.running === true && status.running !== true) {
						this.dispatch({
							kind: "complete",
							sessionId,
							title: this.sessionTitle(sessionId),
							detail: this.t("notify.complete.detail"),
						});
					}
					const pending = status.pendingInteraction;
					if (pending !== undefined && pending.key !== before.pendingKey) {
						const kind = pendingKind(pending.kind);
						this.dispatch({
							kind: "attention",
							sessionId,
							title: this.sessionTitle(sessionId),
							detail: this.t(`notify.attention.${kind}`),
						});
					}
					this.tracked.set(sessionId, {
						running: status.running === true,
						pendingKey: pending?.key,
					});
				}
				for (const sessionId of [...this.tracked.keys()]) {
					if (!next.has(sessionId)) this.tracked.delete(sessionId);
				}
			}

			/**
			 * 决定通道：后台/失焦时先让 Host 进程发一条 Windows 原生 toast（桌面壳里最可靠），
			 * 再退回 HTML5 Notification，最后退回页内卡片；前台则直接卡片。
			 */
			async dispatch(item) {
				const prefs = this.prefs.getSnapshot();
				if (item.kind === "complete" ? prefs.complete !== true : prefs.attention !== true) return;
				// 完成通知带一句任务结果摘要（取不到时保留默认文案）。
				if (item.kind === "complete") {
					const summary = this.summaryFor(item.sessionId);
					if (summary !== undefined) item = { ...item, detail: summary };
				}
				const visible = document.visibilityState === "visible";
				const focused = document.hasFocus();
				const viewing = item.sessionId !== undefined && this.currentSessionId() === item.sessionId;
				// 人就在这个会话前面：原生审批卡已经可见，不打扰。
				if (visible && focused && viewing) {
					this.record(item, "silent");
					return;
				}
				if (!visible || !focused) {
					// 第一优先：Host 进程用 Windows 原生通知投递。桌面壳里 renderer 的
					// HTML5 Notification 权限是 granted 却静默失败（到不了 Windows 通知平台）。
					if (await this.nativeToast(item)) {
						this.setBadge(this.badgeCount + 1);
						this.record(item, "host");
						return;
					}
					if (isDesktopShell()) {
						// 桌面壳的 HTML5 Notification 已证实是假成功（channel=system 的通知从未进入
						// Windows 通知平台），不再走这条已知失效的通道：直接留一张回页可见的卡片。
						// 此时 Host 没参与投递，声音只能由这里补（提示音打开时）。
						this.setBadge(this.badgeCount + 1);
						this.pushCard(item);
						this.record(item, "failed");
						if (prefs.sound === true) this.beep();
						return;
					}
					const system = this.permission() === "granted";
					const delivered = system && this.showSystem(item);
					this.setBadge(this.badgeCount + 1);
					// 系统通知不可用或发送失败时也要留痕：回到页面就能看到卡片。
					if (!delivered) this.pushCard(item);
					this.record(item, delivered ? "system" : system ? "failed" : "blocked");
				} else {
					this.pushCard(item);
					this.record(item, "card");
				}
				if (prefs.sound === true) this.beep();
			}

			/** 通知通道共用的标题与正文：Host toast 与 HTML5 Notification 必须说同样的话。 */
			compose(item) {
				return {
					title: this.t(item.kind === "complete" ? "notify.title.complete" : "notify.title.attention"),
					body: this.t("notify.body", { session: item.title, detail: item.detail }),
				};
			}

			/**
			 * 通过本插件 Host 半的同源路由发 Windows 原生 toast，返回是否成功。
			 * 桌面壳把 dsh-app://app/api/... 转发到 Host web server；网页里就是同源请求。
			 */
			async nativeToast(item) {
				// 只有桌面壳的 renderer 需要走 Host 发 Windows 原生 toast：
				// 网页客户端（浏览器标签）用标准 HTML5 Notification 即可，否则同一个宿主
				// 被桌面应用和浏览器同时打开时，一次完成会弹两条系统通知。
				if (!isDesktopShell()) return false;
				try {
					const response = await fetch("/api/dsh-notify/toast", {
						method: "POST",
						headers: { "content-type": "application/json", "x-dsh-notify-request": "1" },
						body: JSON.stringify({
							...this.compose(item),
							kind: item.kind,
							sessionId: item.sessionId,
							sound: this.prefs.getSnapshot().sound === true,
						}),
					});
					if (!response.ok) return false;
					const payload = await response.json().catch(() => null);
					return payload?.ok === true;
				} catch {
					return false;
				}
			}

			permission() {
				return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
			}

			requestPermission() {
				if (typeof Notification === "undefined") return Promise.resolve("unsupported");
				try {
					return Promise.resolve(Notification.requestPermission()).then((result) => {
						this.refreshPermission();
						this.recordDiag("permission", { result });
						return result;
					});
				} catch {
					return Promise.resolve(this.permission());
				}
			}

			/** 把最新的系统权限同步到设置行。 */
			refreshPermission() {
				const next = this.permission();
				if (next !== this.permissionStore.getSnapshot()) this.permissionStore.set(next);
			}

			/** 记录最近一次提醒走了哪条通道，设置行会显示，便于排查“后台收不到”一类问题。 */
			record(item, channel) {
				this.lastStore.set({ at: Date.now(), channel });
				this.recordDiag("dispatch", { kind: item.kind, sessionId: item.sessionId, channel });
			}

			/** 把运行环境与通道决策写进 localStorage，便于从磁盘离线排查桌面端问题。 */
			recordDiag(type, extra) {
				try {
					const key = "dsh-notify:diag";
					const previous = JSON.parse(window.localStorage.getItem(key) ?? "null");
					const events = Array.isArray(previous?.events) ? previous.events : [];
					events.push({
						at: Date.now(),
						type,
						permission: this.permission(),
						visibility: document.visibilityState,
						focus: document.hasFocus(),
						desktop: isDesktopShell(),
						...extra,
					});
					window.localStorage.setItem(key, JSON.stringify({ ua: navigator.userAgent, events: events.slice(-40) }));
				} catch {
					// 写不进去就放弃：诊断信息不能影响提醒本身。
				}
			}

			/** Windows 通知中心里的系统通知；点击后回焦并打开会话。返回是否真的发出。 */
			showSystem(item) {
				if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
				try {
					const { title, body } = this.compose(item);
					const notification = new Notification(title, {
						body,
						tag: `dsh-notify:${item.sessionId ?? "preview"}:${item.kind}`,
						requireInteraction: item.kind !== "complete",
					});
					notification.onclick = () => {
						this.activate(item.sessionId);
						notification.close();
					};
					return true;
				} catch (error) {
					console.warn("[dsh-notify] failed to show a system notification", error);
					return false;
				}
			}

			pushCard(item) {
				const id = `${item.kind}:${item.sessionId ?? "preview"}:${++this.seq}`;
				const card = { ...item, id };
				const kept = this.cards.getSnapshot().filter((existing) => !(existing.kind === item.kind && existing.sessionId === item.sessionId));
				this.cards.set([...kept.slice(-(MAX_CARDS - 1)), card]);
			}

			dismiss(card) {
				this.cards.set(this.cards.getSnapshot().filter((existing) => existing.id !== card.id));
			}

			open(card) {
				this.activate(card.sessionId);
				this.dismiss(card);
			}

			activate(sessionId) {
				try {
					window.focus();
				} catch {
					// 忽略：Electron 可能拒绝从通知回调里聚焦窗口。
				}
				if (sessionId !== undefined) {
					try {
						this.ctx.uiWorkspace.openSession(sessionId);
					} catch (error) {
						console.warn("[dsh-notify] failed to open session", sessionId, error);
					}
				}
				this.setBadge(0);
			}

			/** 标题栏徽标：只要窗口里还有未回焦的提醒，就在标题前加计数。 */
			setBadge(count) {
				this.badgeCount = count;
				this.refreshTitleBadge();
			}

			/**
			 * 给宿主标题补徽标，但不抢标题：appliedTitle 记住自己写过的整串标题，
			 * 宿主重写后按新正文重新补；取消徽标时只还原自己写的那份，因此不会
			 * 剥离别人标题里本来就有的 "(n) " 前缀。
			 */
			refreshTitleBadge() {
				const current = document.title;
				if (this.appliedTitle === null && this.badgeCount <= 0) return;
				const base = current === this.appliedTitle ? this.badgeBaseTitle : current;
				this.badgeBaseTitle = base;
				const next = this.badgeCount > 0 ? `(${this.badgeCount}) ${base}` : base;
				this.appliedTitle = next;
				if (next !== current) document.title = next;
			}

			/** 设置行里的“测试通知”按钮：同时走卡片（受权限限制再补一条系统通知）。 */
			async preview() {
				const sessionId = this.currentSessionId();
				const item = {
					kind: "complete",
					sessionId,
					title: sessionId === undefined ? this.t("preview.title") : this.sessionTitle(sessionId),
					detail: this.t("preview.body"),
				};
				// 测试按钮优先走真实投递通道，这样点一次就知道桌面端能不能弹出来。
				if (await this.nativeToast(item)) {
					this.record(item, "host");
					return;
				}
				this.pushCard(item);
				const system = this.permission() === "granted";
				if (system) this.showSystem(item);
				this.record(item, system ? "system" : "card");
			}

			/** 两声短提示音，默认关闭。 */
			beep() {
				try {
					const AudioCtor = window.AudioContext ?? window.webkitAudioContext;
					if (AudioCtor === undefined) return;
					this.audio ??= new AudioCtor();
					if (this.audio.state === "suspended") this.audio.resume().catch(() => {});
					const start = this.audio.currentTime;
					for (const [offset, frequency] of [[0, 880], [0.16, 660]]) {
						const oscillator = this.audio.createOscillator();
						const gain = this.audio.createGain();
						oscillator.type = "sine";
						oscillator.frequency.value = frequency;
						gain.gain.setValueAtTime(0.0001, start + offset);
						gain.gain.exponentialRampToValueAtTime(0.12, start + offset + 0.01);
						gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.14);
						oscillator.connect(gain).connect(this.audio.destination);
						oscillator.start(start + offset);
						oscillator.stop(start + offset + 0.16);
					}
				} catch (error) {
					console.warn("[dsh-notify] failed to play the notification sound", error);
				}
			}
		}

		/** 右下角卡片栈，注册在 shell.overlay。 */
		function OverlayStack({ t, notifier }) {
			const cards = useStore(notifier.cards);
			if (cards.length === 0) return null;
			return h(
				"div",
				{ className: "dshn-overlay" },
				cards.map((card) =>
					h(
						"div",
						{ key: card.id, className: "dshn-card", "data-kind": card.kind },
						h("span", { className: "dshn-mark", "aria-hidden": "true" }),
						h(
							"div",
							{ className: "dshn-main" },
							h("div", { className: "dshn-eyebrow" }, t(card.kind === "complete" ? "card.complete" : "card.attention")),
							h("div", { className: "dshn-title", title: card.title }, card.title),
							h("div", { className: "dshn-body" }, card.detail),
							h(
								"div",
								{ className: "dshn-actions" },
								h("button", { type: "button", className: "dshn-open", onClick: () => notifier.open(card) }, t("card.open")),
								h("button", { type: "button", className: "dshn-dismiss", onClick: () => notifier.dismiss(card) }, t("card.dismiss")),
							),
						),
					),
				),
			);
		}

		/** 设置行里的一个开关。 */
		function Toggle({ label, checked, onChange }) {
			return h(
				"label",
				{ className: "dshn-toggle" },
				h("span", { className: "dshn-toggle-label" }, label),
				h(
					"button",
					{ type: "button", role: "switch", className: "dshn-switch", "aria-checked": checked, onClick: onChange },
					h("span", { className: "dshn-thumb", "aria-hidden": "true" }),
				),
			);
		}

		function permissionText(t, permission) {
			if (permission === "granted") return t("settings.granted");
			if (permission === "denied") return t("settings.denied");
			if (permission === "unsupported") return t("settings.unsupported");
			return t("settings.default");
		}

		/** General 设置里的“通知”行，注册在 settings.general.item。 */
		function SettingsRow({ t, notifier, prefs }) {
			const current = useStore(prefs);
			const permission = useStore(notifier.permissionStore);
			const last = useStore(notifier.lastStore);
			const toggle = (key) => prefs.set({ ...current, [key]: current[key] !== true });
			const enable = () => {
				notifier.requestPermission();
			};
			return h(
				"div",
				{ className: "dshn-row" },
				h(
					"div",
					{ className: "dshn-row-head" },
					h("div", { className: "dshn-row-title" }, t("settings.title")),
					h("div", { className: "dshn-row-hint" }, t("settings.hint")),
				),
				h(
					"div",
					{ className: "dshn-toggles" },
					h(Toggle, { label: t("settings.complete"), checked: current.complete, onChange: () => toggle("complete") }),
					h(Toggle, { label: t("settings.attention"), checked: current.attention, onChange: () => toggle("attention") }),
					h(Toggle, { label: t("settings.sound"), checked: current.sound, onChange: () => toggle("sound") }),
				),
				h(
					"div",
					{ className: "dshn-foot" },
					h("span", { className: "dshn-state" }, `${t("settings.permission")}：${permissionText(t, permission)}`),
					permission === "default" && h("button", { type: "button", className: "dshn-action", onClick: enable }, t("settings.enable")),
					h("button", { type: "button", className: "dshn-action", onClick: () => notifier.preview() }, t("settings.test")),
				),
				last === null
					? h("div", { className: "dshn-last" }, t("settings.last.none"))
					: h(
							"div",
							{ className: "dshn-last" },
							t("settings.last", {
								time: new Date(last.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
								channel: t(`settings.channel.${last.channel}`),
							}),
						),
			);
		}

		/**
		 * 安装文案、样式、全局监听、右下角卡片与设置行。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-notify: dictionaries");
			const t = ctx.locale.bind(NS);

			const prefs = createStore(loadPrefs(), (next) => {
				try {
					window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
				} catch {
					// 隐私模式等场景写不进去：本次会话内仍然生效。
				}
			});
			const notifier = new Notifier(ctx, prefs, t);

			ctx.effect(() => {
				const style = document.createElement("style");
				style.dataset.plugin = "dsh-notify";
				style.dataset.pluginCss = "dsh-notify/notify.css";
				style.textContent = css;
				document.head.appendChild(style);
				return () => style.remove();
			}, "dsh-notify: styles");

			ctx.effect(() => {
				notifier.start();
				return () => notifier.stop();
			}, "dsh-notify: session status and window listeners");

			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: "dsh-notify:cards",
						order: 60,
						label: t("settings.title"),
						locale: NS,
						inject: () => ({ notifier }),
					},
					OverlayStack,
				),
			);

			ctx.slots.inject("settings.general.item", () =>
				ctx.slots.register(
					{
						name: "settings.general.item",
						id: "dsh-notify:settings",
						order: 95,
						locale: NS,
						inject: () => ({ notifier, prefs }),
					},
					SettingsRow,
				),
			);
		}

		return { inject, apply };
	},
});
