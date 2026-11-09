/**
 * dsh-fixed-launch-token — 把 `dsh web` 的启动 token（`?token=...`）固定为配置里的值。
 *
 * 官方 `@deepseek-ai/dsh-client-connection` 的 `processLaunchToken(owner)` 每次进程
 * 启动都 `randomBytes(32)` 生成一个 launch token，缓存在模块私有
 * `WeakMap<owner, string>` 中（键是 root application context）。该 token 同时是：
 *   - 启动横幅 `dsh web: <url>?token=...` 的来源（BrowserAuth.authenticatedUrl）；
 *   - `/connect` 与 `GET /?token=` 的唯一校验依据（timingSafeEqual 比对）。
 *
 * 本插件不替换 Connection 提供方、不引入免登录语义：它只把运行中 connection 服务
 * 的 `browserAuth.launchToken` 改写为配置里的固定 token。因此：
 *   - 启动横幅变成固定 token；
 *   - `/connect?token=<固定值>` 仍走官方 authorizeConnect，成功 302；
 *   - 其它 token / 无 token 依旧 401，信任栅栏（evil Host 403）不变。
 *
 * 默认不生效：未配置 `fixedLaunchToken` 时插件什么都不做，官方随机 token 照旧
 * （并打印一行说明）。这是刻意选择的默认值——插件要能安全地公开发布，而固定
 * token 属于凭据，不该由包本身携带。要用必须由使用者在自己的配置里显式设置。
 *
 * 时序依据：官方 apply 里 `new HostConnectionService(ctx, hosts, await BrowserAuth.create(...))`
 * ——服务是在 await 之后才 provide 的，所以 `ctx.inject(['connection'], cb)` 的回调
 * 必然在随机 token 生成之后触发，改写不会被官方 create() 覆盖。
 *
 * fail-loud：一旦配置了 token，官方若改掉 `browserAuth.launchToken` 这个形状，
 * 这里抛错而不是静默沿用随机 token（静默降级会让用户以为固定值生效了，实际没有）。
 */

/** Stable Cordis plugin name. */
export const name = 'dsh-fixed-launch-token';

/** 需要 connection 服务在场才谈得上改写 launch token。 */
export const inject = ['connection'];

const MIN_TOKEN_LENGTH = 16;
const MAX_TOKEN_LENGTH = 256;
/** 启动横幅前缀，与官方 web-app 打印格式一致（仅用于兜底补打）。 */
const URL_PREFIX = 'dsh web: ';

/**
 * 校验并规范化配置里的固定 token。
 * @param raw - 插件行 config.fixedLaunchToken 的原始值。
 * @returns 规范化后的 token；未配置或空串返回 undefined（由 apply 决定为「不生效」）。
 */
export function normalizeToken(raw) {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (value.length === 0) return undefined;
  if (value.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `${name}: fixedLaunchToken is too short (${String(value.length)} characters); `
      + `use at least ${String(MIN_TOKEN_LENGTH)} so the fixed value stays unguessable`,
    );
  }
  if (value.length > MAX_TOKEN_LENGTH) {
    throw new Error(
      `${name}: fixedLaunchToken is too long (${String(value.length)} characters); maximum is ${String(MAX_TOKEN_LENGTH)}`,
    );
  }
  if (/[\s?#]/.test(value)) {
    throw new Error(`${name}: fixedLaunchToken must not contain whitespace, "?" or "#" because it travels in a URL query`);
  }
  return value;
}

/**
 * 把运行中 connection 服务的 launch token 改写为固定值。
 *
 * 官方 `/connect`、`GET /?token=` 与启动横幅读的都是 `browserAuth.launchToken`
 * 这一个字段，所以实例字段改写对三条路径同时生效。
 *
 * @param service - 官方 HostConnectionService 实例。
 * @param fixedToken - 要写入的固定 token。
 * @returns 1 表示已改写或已是固定值；0 表示形状不符（调用方据此 fail loud）。
 */
export function rewriteBrowserAuth(service, fixedToken) {
  const auth = service?.browserAuth;
  if (auth === null || typeof auth !== 'object') return 0;
  if (typeof auth.launchToken !== 'string') return 0;
  if (auth.launchToken === fixedToken) return 1;
  auth.launchToken = fixedToken;
  return 1;
}

/**
 * 兜底补打一行启动横幅。
 *
 * 官方 web-app 的横幅会先 `connectionCtx.get("loader")?.await()` 再取值：
 *   - loader 在场（`dsh web` 的常态）→ 横幅推迟到所有行 apply 完成之后才打印，
 *     必然晚于本插件的改写，因此它打印的已经是固定 token，无需兜底；
 *   - loader 缺席 → 横幅在 inject 回调里同步打印，而官方行注册得比本插件早，
 *     它会先打印出**尚未被改写的随机 token**。此时才需要补一行说明实际生效值。
 *
 * 所以只在 loader 缺席时补打，避免常态下出现两行内容相同的 `dsh web:` 噪音。
 *
 * @param ctx - plugin context carrying the webApp service.
 * @param fixedToken - 当前生效的固定 token。
 */
function reprintAdvertisedUrl(ctx, fixedToken) {
  const webApp = ctx.get('webApp');
  if (webApp === undefined || typeof webApp.getAdvertisedUrl !== 'function') return;
  let advertised;
  try {
    advertised = webApp.getAdvertisedUrl();
  } catch {
    return;
  }
  if (typeof advertised !== 'string' || advertised === '') return;
  try {
    const url = new URL(advertised);
    url.searchParams.set('token', fixedToken);
    console.log(`${URL_PREFIX}${url.href}`);
  } catch {
    /* 非法 URL 时静默跳过：横幅补打是尽力而为，不影响 token 已生效的事实 */
  }
}

/**
 * Cordis Host 插件入口。
 *
 * 未配置 `fixedLaunchToken` 时**不生效**：直接返回，连 connection 都不注入，
 * 官方随机 token 行为完全不变。配置了才改写，且改写失败（官方形状变了）抛错。
 *
 * @param ctx - owning plugin context.
 * @param config - resolved plugin config, optionally carrying `fixedLaunchToken`.
 */
export function apply(ctx, config) {
  const fixedToken = normalizeToken(config?.fixedLaunchToken);
  if (fixedToken === undefined) {
    console.log(
      `${name}: no fixedLaunchToken configured; leaving the official per-process random token in place `
      + '(set config.fixedLaunchToken to pin it)',
    );
    return;
  }

  // 服务在官方 BrowserAuth.create() 之后才 provide，故此回调必然晚于随机 token 生成。
  ctx.inject(['connection'], (connectionCtx) => {
    const service = connectionCtx.get('connection');
    if (rewriteBrowserAuth(service, fixedToken) === 0) {
      throw new Error(
        `${name}: the active connection service exposes no browserAuth.launchToken to pin; `
        + 'the official @deepseek-ai/dsh-client-connection shape changed, so the fixed token was NOT applied',
      );
    }
    // loader 在场时官方横幅会推迟到改写之后打印，无需补打（见 reprintAdvertisedUrl 注释）。
    if (connectionCtx.get('loader') === undefined) reprintAdvertisedUrl(connectionCtx, fixedToken);
    console.log(`${name}: launch token pinned to the configured fixed value (${String(fixedToken.length)} characters)`);
  });
}
