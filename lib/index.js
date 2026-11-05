/**
 * dsh-notify 的 Host 半。
 *
 * 背景：桌面壳（Electron）里 renderer 的 HTML5 Notification 可能静默失败——
 * new Notification() 不抛错，但通知从未到达 Windows 通知平台（权限已是 granted）。
 * 因此把「后台提醒」的投递搬到 Host 进程里：渲染层 POST 一条同源路由，
 * 这里用 PowerShell 调 WinRT ToastNotificationManager 直接发 Windows 原生 toast。
 *
 * 桌面壳把 dsh-app://app/api/... 转发到本 Host 的 web server，浏览器里则是同源请求，
 * 所以同一条路由在桌面窗口和网页里都可用；失败时客户端会回退到 HTML5 Notification 或页内卡片。
 *
 * 安全：路由先问 composition 的 connection 服务要一个拒绝码（Host/Origin 围栏 + 登录 cookie），
 * 与 @deepseek-ai/dsh-host-open-in-app 的宿主路由同一套策略；因此只有本机的已登录页面能触发。
 */
import { spawn } from "node:child_process";

/** POST route receiving one native toast request. */
const TOAST_PATH = "/api/dsh-notify/toast";

/** Bounded JSON body: title + body + flags only. */
const MAX_BODY_BYTES = 16 * 1024;

/** Fallback AUMID: Electron 用 exe 的 ProductName 生成 `electron.app.<ProductName>`。 */
const DEFAULT_APP_ID = "electron.app.DeepSeek Harness";

/** PowerShell 的最长存活时间；执行失败不能让 Host 请求悬挂。 */
const SCRIPT_TIMEOUT_MS = 8000;

/**
 * 去重窗口：同一个提醒可能被重复提交（热重载残留的控制器、失败后重试），
 * 有 sessionId 时按交付侧的 tag（kind + session）去重，避免同一件事弹两条；
 * 没有 sessionId（测试通知）时退回按内容去重。
 */
const DEDUPE_WINDOW_MS = 10000;

/** 最近投递过的 { 内容 -> 时间 }，仅在 Host 进程内存里。 */
const recentToasts = new Map();

/** GET route：把「刚弹过通知的会话」交给聚焦后的客户端，用于点击 toast 打开会话。 */
const PENDING_PATH = "/api/dsh-notify/pending";

/** 点击 toast 后多久内仍允许打开对应会话。 */
const PENDING_TTL_MS = 5 * 60 * 1000;

/**
 * toast 左下角的应用图标（appLogoOverride）。
 * 包是 link 安装的，图标就在包内 assets/ 下；从模块 URL 推导路径，
 * 不写死工作区绝对路径（换目录、别处安装都能用）。
 */
const TOAST_ICON_URL = new URL("../assets/toast-icon.png", import.meta.url).href;

/** 最多记住几条待打开提醒：多会话先后提醒时不互相覆盖，客户端按需取用。 */
const MAX_PENDING_OPENS = 5;

/** 最近的可被打开的提醒（从旧到新）；由聚焦客户端读取并清空。 */
let pendingOpens = [];

/** Cordis 函数插件名。 */
const name = "dsh-notify";

/** 路由载体与信任围栏。 */
const inject = ["webServer", "connection"];

/** The composition's connection service (其包在浏览器侧，这里按本地类型读取)。 */
function connectionOf(ctx) {
	return Reflect.get(ctx, "connection");
}

function sendJson(response, status, payload) {
	response.statusCode = status;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.setHeader("cache-control", "no-store");
	response.end(JSON.stringify(payload));
}

function sendMethodNotAllowed(response, allow) {
	response.statusCode = 405;
	response.setHeader("allow", allow);
	response.end();
}

/** 收集有限长度的 UTF-8 JSON body；超限返回 null。 */
async function readJsonBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.byteLength;
		if (size > MAX_BODY_BYTES) {
			request.resume();
			return null;
		}
		chunks.push(chunk);
	}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** XML 文本转义，避免标题里的 < & 破坏 toast 负载。 */
function escapeXml(value) {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** 生成 ToastGeneric 负载；attention 用 reminder 场景（停留更久），点击后经协议拉起应用。 */
function toastXml({ title, text, kind, silent }) {
	const scenario = kind === "attention" ? ' scenario="reminder"' : "";
	const duration = kind === "attention" ? ' duration="long"' : "";
	const audio = silent ? '<audio silent="true"/>' : "";
	// activationType=protocol + launch=dsh://open：点击 toast 由 Windows 拉起桌面应用，
	// 应用的单实例逻辑会把既有窗口从最小化/托盘恢复到前台；具体会话由客户端 focus 后向 Host 取。
	// 通知头部已经会显示应用名，正文里不再重复第三行 attribution。
	return (
		`<toast${scenario}${duration} activationType="protocol" launch="dsh://open">` +
		'<visual><binding template="ToastGeneric">' +
		`<image placement="appLogoOverride" hint-crop="circle" src="${TOAST_ICON_URL}"/>` +
		`<text>${escapeXml(title)}</text>` +
		`<text>${escapeXml(text)}</text>` +
		"</binding></visual>" +
		audio +
		"</toast>"
	);
}

/** 把脚本按 PowerShell -EncodedCommand 要求编码（UTF-16LE base64）。 */
function encodeCommand(script) {
	return Buffer.from(script, "utf16le").toString("base64");
}

/** 由 kind + sessionId 生成稳定、合法的 toast tag（≤64 字符，仅字母数字与连字符）。 */
function toastTag(kind, sessionId) {
	const cleaned = String(sessionId ?? "").replace(/[^0-9a-zA-Z-]/g, "");
	if (cleaned === "") return "";
	return `${kind === "attention" ? "a" : "c"}-${cleaned}`.slice(0, 60);
}

function powershellScript({ appId, xml, tag }) {
	const xmlBase64 = Buffer.from(xml, "utf8").toString("base64");
	const appIdLiteral = String(appId).replace(/'/g, "''");
	const tagLiteral = String(tag ?? "").replace(/'/g, "''");
	const lines = [
		"$ErrorActionPreference = 'Stop'",
		"$ProgressPreference = 'SilentlyContinue'",
		// AUMID 由 Electron 依据 exe 的 ProductName 生成；进程在运行就用真实产品名，找不到再用默认值。
		`$appId = '${appIdLiteral}'`,
		"try {",
		"  $proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1",
		"  if ($null -ne $proc) {",
		"    $product = (Get-Item -LiteralPath $proc.Path).VersionInfo.ProductName",
		"    if ($product) { $appId = 'electron.app.' + $product }",
		"  }",
		"} catch { }",
		"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
		"[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
		"$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
		`$xml.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${xmlBase64}')))`,
		"$toast = New-Object Windows.UI.Notifications.ToastNotification $xml",
		...(tagLiteral === "" ? [] : [`$toast.Tag = '${tagLiteral}'`, "$toast.Group = 'dsh-notify'"]),
		"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)",
	];
	return lines.join("\n");
}

/** 播一条 Windows 原生 toast；返回 { ok, error? }。 */
function showNativeToast({ title, text, kind, silent, sessionId }) {
	return new Promise((resolve) => {
		if (process.platform !== "win32") {
			resolve({ ok: false, error: `native toast is only implemented on win32 (current: ${process.platform})` });
			return;
		}
		const tag = toastTag(kind, sessionId);
		// 有 sessionId 时 tag 本身就是去重键：同一次完成先到先投递，窗口期内后来的忽略。
		const dedupeKey = tag !== "" ? tag : `${kind}\u0000${title}\u0000${text}`;
		const now = Date.now();
		for (const [seenKey, seenAt] of recentToasts) {
			if (now - seenAt > DEDUPE_WINDOW_MS) recentToasts.delete(seenKey);
		}
		if (recentToasts.has(dedupeKey)) {
			resolve({ ok: true, deduped: true });
			return;
		}
		recentToasts.set(dedupeKey, now);
		let child;
		try {
			child = spawn(
				"powershell.exe",
				["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encodeCommand(powershellScript({ appId: DEFAULT_APP_ID, xml: toastXml({ title, text, kind, silent }), tag }))],
				{ windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
			);
		} catch (error) {
			recentToasts.delete(dedupeKey);
			resolve({ ok: false, error: String(error?.message ?? error) });
			return;
		}
		let stderr = "";
		let settled = false;
		const settle = (value) => {
			if (settled === true) return;
			settled = true;
			clearTimeout(timer);
			// 投递失败时不占着去重窗口，下一次请求还能重试。
			if (value?.ok !== true) recentToasts.delete(dedupeKey);
			resolve(value);
		};
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				// 已经退出
			}
			settle({ ok: false, error: "powershell timed out" });
		}, SCRIPT_TIMEOUT_MS);
		child.stderr?.on("data", (chunk) => {
			if (stderr.length < 2000) stderr += chunk.toString();
		});
		child.on("error", (error) => settle({ ok: false, error: String(error?.message ?? error) }));
		child.on("close", (code) => {
			if (code === 0) settle({ ok: true });
			else settle({ ok: false, error: stderr.trim().split(/\r?\n/).slice(-4).join(" | ") || `powershell exited with code ${code}` });
		});
	});
}

/** 清掉超过 TTL 的待打开提醒（用户可能一直没回来看）。 */
function prunePendingOpens(now) {
	pendingOpens = pendingOpens.filter((entry) => now - entry.at <= PENDING_TTL_MS);
}

/** 记下一条已投递的提醒；同一会话只留最新一条，总量有上限。 */
function rememberPendingOpen(entry) {
	const now = Date.now();
	prunePendingOpens(now);
	pendingOpens = pendingOpens.filter((existing) => existing.sessionId !== entry.sessionId);
	pendingOpens.push({ ...entry, at: now });
	if (pendingOpens.length > MAX_PENDING_OPENS) pendingOpens = pendingOpens.slice(-MAX_PENDING_OPENS);
}

/** 校验并派发一条 toast 请求；返回给 HTTP 层的 { status, payload }。 */
async function handleToastRequest(request) {
	if (request.method !== "POST") return { status: 405 };
	const body = await readJsonBody(request);
	if (body === null) return { status: 400, payload: { ok: false, error: "invalid JSON body" } };
	const title = typeof body.title === "string" ? body.title.trim() : "";
	const text = typeof body.body === "string" ? body.body.trim() : "";
	if (title === "" || text === "") return { status: 400, payload: { ok: false, error: "title and body are required" } };
	const kind = body.kind === "attention" ? "attention" : "complete";
	const sound = body.sound === true;
	const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
	const safeTitle = title.slice(0, 120);
	const safeText = text.slice(0, 400);
	const result = await showNativeToast({ title: safeTitle, text: safeText, kind, silent: sound !== true, sessionId });
	if (result?.ok === true) {
		// toast 已送达 Windows 通知中心；记下会话与文案，等用户点击后聚焦的客户端来取。
		if (sessionId !== "") rememberPendingOpen({ sessionId, kind, title: safeTitle, text: safeText });
		return { status: 200, payload: { ok: true } };
	}
	return { status: 500, payload: { ok: false, error: result?.error ?? "native toast failed" } };
}

/** 处理 GET /api/dsh-notify/pending：返回并清空待打开提醒（TTL 外视为过期）。 */
function handlePendingRequest(request) {
	if (request.method !== "GET") return { status: 405 };
	const now = Date.now();
	prunePendingOpens(now);
	const items = pendingOpens;
	pendingOpens = [];
	// sessionId 保留给只认单值的旧客户端；items 才是完整队列（含 kind / title / text / at）。
	return { status: 200, payload: { ok: true, sessionId: items.at(-1)?.sessionId ?? null, items } };
}

function apply(ctx) {
	const connection = () => connectionOf(ctx);
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "exact",
				path: TOAST_PATH,
				handler: async (request, response) => {
					const rejection = connection()?.requestRejection?.(request);
					if (rejection !== undefined) {
						response.statusCode = rejection;
						response.end();
						return;
					}
					const result = await handleToastRequest(request);
					if (result.status === 405) {
						sendMethodNotAllowed(response, "POST");
						return;
					}
					sendJson(response, result.status, result.payload ?? { ok: false });
				},
			}),
		`dsh-notify: POST ${TOAST_PATH}`,
	);
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "exact",
				path: PENDING_PATH,
				handler: async (request, response) => {
					const rejection = connection()?.requestRejection?.(request);
					if (rejection !== undefined) {
						response.statusCode = rejection;
						response.end();
						return;
					}
					const result = handlePendingRequest(request);
					if (result.status === 405) {
						sendMethodNotAllowed(response, "GET");
						return;
					}
					sendJson(response, result.status, result.payload);
				},
			}),
		`dsh-notify: GET ${PENDING_PATH}`,
	);
}

export { PENDING_PATH, TOAST_PATH, apply, inject, name };
