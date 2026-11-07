/**
 * dsh-balance — one HTTP request for the DeepSeek Harness account balance.
 *
 *   GET /api/balance              → JSON snapshot
 *   GET /api/balance?format=text  → "12.4639 CNY"
 *
 * The number is the same wallet the Web UI shows under 设置 → 账号与余额
 * (platform.deepseek.com): recharge credit plus granted bonus, read through
 * the harness `deepseekAccount` service so DSH owns the credential, the
 * issuer check and the expiry handling. Nothing is stored here.
 *
 * The route is loopback-only: the peer socket must be a loopback address and
 * the Host header must name a loopback host. DSH's web server binds
 * 127.0.0.1 by default, so a local script needs exactly one request:
 *
 *   curl -s http://127.0.0.1:3080/api/balance
 *
 * @module dsh-balance
 */

/** Stable Cordis plugin name. */
const name = "dsh-balance";

/** Services required before this plugin activates. */
const inject = ["webServer"];

/** The one route this plugin owns. */
const BALANCE_PATH = "/api/balance";

/** How long one upstream reading is reused before asking Platform again. */
const CACHE_TTL_MS = 15_000;

/**
 * Client-identity headers sent to Platform. They are telemetry only; the
 * balance payload itself is keyed by the stored grant.
 */
const CLIENT_IDENTITY = {
	version: "0.2.1",
	locale: "zh-CN",
	timezoneOffsetSeconds: 8 * 3600
};

/** Write a JSON response. */
function json(res, status, value) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(value));
}

/** Loopback IPv4/IPv6 check with the IPv4-mapped IPv6 form normalized. */
function isLoopbackAddress(address) {
	if (typeof address !== "string") return false;
	const value = address.toLowerCase();
	if (value === "::1") return true;
	const ipv4 = value.startsWith("::ffff:") ? value.slice(7) : value;
	const parts = ipv4.split(".");
	return parts.length === 4 && parts[0] === "127"
		&& parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Host header names a loopback authority (port and IPv6 brackets handled). */
function isLoopbackHost(value) {
	if (typeof value !== "string") return false;
	const host = value.trim().toLowerCase();
	if (host.startsWith("[")) {
		const close = host.indexOf("]");
		if (close < 1) return false;
		const suffix = host.slice(close + 1);
		if (suffix !== "" && !/^:\d+$/.test(suffix)) return false;
		return isLoopbackAddress(host.slice(1, close));
	}
	const colon = host.indexOf(":");
	const hostname = colon < 0 ? host.replace(/\.$/, "") : host.slice(0, colon).replace(/\.$/, "");
	if (colon >= 0 && !/^\d+$/.test(host.slice(colon + 1))) return false;
	return hostname === "localhost" || isLoopbackAddress(hostname);
}

/** Numeric wallet amount, or 0 for anything unusable. */
function amountOf(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : 0;
}

/** Round without pretending to more precision than Platform reports. */
function round(value) {
	return Math.round(value * 1e6) / 1e6;
}

/** Error carrying an HTTP status and a stable machine code. */
function httpError(status, code, message) {
	const error = new Error(message ?? code);
	error.status = status;
	error.code = code;
	return error;
}

/** Fold one Platform balance outcome into the public snapshot. */
function snapshotOf(result) {
	const wallets = Array.isArray(result.value) ? result.value : [];
	const bonusWallets = Array.isArray(result.bonusWallets) ? result.bonusWallets : [];
	const currency = wallets[0]?.currency ?? bonusWallets[0]?.currency ?? "CNY";
	const sumOf = (rows) => rows
		.filter((row) => row?.currency === currency)
		.reduce((sum, row) => sum + amountOf(row.balance), 0);
	const recharge = sumOf(wallets);
	const bonus = sumOf(bonusWallets);
	return {
		ok: true,
		currency,
		recharge: round(recharge),
		bonus: round(bonus),
		total: round(recharge + bonus),
		fetchedAt: Date.now()
	};
}

/** Latest reading shared by concurrent callers. */
let cache = null;

/** In-flight upstream read, so a burst costs one Platform request. */
let inflight = null;

/** Read the account balance through the harness account service. */
function fetchBalance(ctx) {
	if (cache !== null && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return Promise.resolve(cache);
	if (inflight !== null) return inflight;
	inflight = (async () => {
		const account = ctx.get("deepseekAccount");
		if (account === null || account === void 0 || typeof account.getBalance !== "function") {
			throw httpError(503, "account-unavailable", "the deepseekAccount service is not mounted");
		}
		const result = await account.getBalance(CLIENT_IDENTITY);
		if (result === null) throw httpError(401, "signed-out", "no stored DeepSeek account grant");
		if (result.status === "failed") throw httpError(502, "upstream-failed", "Platform balance query failed");
		if (result.status !== "ready") throw httpError(502, "upstream-failed", `unexpected status ${String(result.status)}`);
		cache = snapshotOf(result);
		return cache;
	})().finally(() => {
		inflight = null;
	});
	return inflight;
}

/** Route handler. */
async function handle(ctx, req, res) {
	if (req.method !== "GET") {
		json(res, 405, { ok: false, error: "method-not-allowed" });
		return;
	}
	if (!isLoopbackAddress(req.socket?.remoteAddress) || !isLoopbackHost(req.headers.host)) {
		json(res, 403, { ok: false, error: "forbidden" });
		return;
	}
	const url = new URL(req.url ?? "/", "http://localhost");
	try {
		const snapshot = await fetchBalance(ctx);
		if (url.searchParams.get("format") === "text") {
			res.writeHead(200, {
				"content-type": "text/plain; charset=utf-8",
				"cache-control": "no-store"
			});
			res.end(`${snapshot.total} ${snapshot.currency}\n`);
			return;
		}
		json(res, 200, snapshot);
	} catch (error) {
		ctx.logger?.warn?.(`dsh-balance: ${error instanceof Error ? error.message : String(error)}`);
		json(res, error?.status ?? 502, {
			ok: false,
			error: error?.code ?? "upstream-failed",
			message: error instanceof Error ? error.message : String(error)
		});
	}
}

/** Plugin body. */
function apply(ctx) {
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: BALANCE_PATH,
		handler: (req, res) => {
			void handle(ctx, req, res);
		}
	}), "dsh-balance: balance route");
}

export { apply, inject, name };
