# dsh-fixed-launch-token

把 `dsh web` 启动时打印的 `?token=...` 固定成你自己配置的值。

**默认不生效。** 不配置 `fixedLaunchToken` 时插件什么都不做，官方随机 token 照旧。
要用必须由你显式设一个值——固定 token 是凭据，不该由包本身携带。

## 它解决什么

官方 `@deepseek-ai/dsh-client-connection` 每次进程启动都会 `randomBytes(32)`
生成一个 **launch token**，并在启动横幅里打印：

```
dsh web: https://<public-url>/?token=<每次启动都不同的随机串>
```

该 token 同时是 `/connect` 与 `GET /?token=` 的唯一校验依据。本插件把运行中
connection 服务的 `browserAuth.launchToken` 改写为固定值，于是启动横幅、
`/connect?token=...`、`/?token=...` 三条路径统一使用你写死的 token。

适用场景：把 GUI 的配对链接固定下来（存书签、写进脚本、贴进内部文档），
不必每次重启都去日志里捞新 token。

## 它不做什么（安全边界）

- **不替换**官方 Connection 提供方，**不引入免登录**语义。这与
  `@iasiv5/dsh-skip-browser-auth` 是两回事：那个插件跳过 BrowserAuth，
  本插件只是把 token 从随机改成固定，校验逻辑原样保留。
- 不匹配的 token 仍然返回 **401**，无 token 仍然 **401**。
- Host/Origin 信任栅栏不变，伪造 Host 仍然 **403**。

固定 token 的代价是**它变成了长期凭据**：一旦泄露，攻击者拿到的是长期有效的
入口 token（有效期到下次你改配置为止），而不像随机 token 那样每次重启作废。
因此本插件要求 token ≥16 字符，并拒绝含空白/`?`/`#` 的值。

## 安装

```bash
dsh plugin --profile <你的 profile> add /path/to/dsh-fixed-launch-token
```

或在 GUI 的插件管理里安装这个目录。装完包本身**不会改变任何行为**。

## 配置（必须手动设置才生效）

在**你自己的** profile 配置里按 id 覆盖这一行的 config。用户 patch 是最后一层，
优先级最高，所以这样做不会被包的默认值盖回去：

`~/.dsh/profiles/<你的 profile>/cordis.patch.yml`

```yaml
- id: fixed-launch-token
  config:
    fixedLaunchToken: "在这里填你的固定值"
```

生成一个强随机值（43 字符 base64url，32 字节熵）：

```bash
head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'
```

改完**重启 `dsh web` 生效**（该值在插件 apply 时读取一次）。

约束：长度 16–256，不含空白、`?`、`#`。

## 工作原理（为什么是改实例字段）

官方 `processLaunchToken(owner)` 把 token 存在模块私有
`WeakMap<owner, string>`，且**没有导出**；同时 `BrowserAuth.create(ctx.root, ...)`
在 `await` 之后才 provide `connection` 服务。因此：

1. `ctx.inject(['connection'], cb)` 的回调必然晚于随机 token 生成；
2. 回调里把 `service.browserAuth.launchToken` 改成固定值 —— 官方
   `authorizeConnect` / `authorizeIndex` / `authenticatedUrl` 读的都是这同一个字段；
3. 若官方将来改掉这个字段形状，插件**抛错**（fail loud），不会静默沿用随机
   token 让你误以为固定值生效了。

### 启动横幅为什么也是固定值

官方 web-app 打印横幅前会先 `connectionCtx.get("loader")?.await()`：

- **loader 在场**（`dsh web` 的常态）→ 横幅推迟到所有行 apply 完成之后才取值，
  必然晚于本插件的改写，所以**官方那一行横幅本身就是固定 token**；
- **loader 缺席** → 横幅在 inject 回调里同步打印，而官方行注册得比本插件早，
  会先打印尚未改写的随机值；此时插件才补打一行 `dsh web: ...` 说明实际生效值。

实测（隔离 `DSH_HOME` 冷启动，端口 3199）：

| 配置 | `dsh web:` 行数 | 横幅 token |
| --- | --- | --- |
| 配置了固定值 | 1 | 配置里的固定值 |
| 未配置（对照） | 1 | 每次启动都不同的随机串 |

对照跑还确认了官方包的三条读取路径都只认 `browserAuth.launchToken`
（见 `tests/plugin.test.mjs` 的契约测试），并对该前提做了 4 组变异验证：
改校验字段、去掉 `await`、删存储写入、改横幅取值——全部转 RED。

## 卸载 / 回滚

```bash
dsh plugin --profile <你的 profile> remove dsh-fixed-launch-token
```

或只删掉上面那段 `- id: fixed-launch-token` 覆盖，插件恢复「不生效」状态，
token 回到每次随机。

## 测试

```bash
node --test tests/plugin.test.mjs
```

`node --test tests/`（传目录）会以 MODULE_NOT_FOUND 失败，属 Node 的行为，请直接传文件。

## 限制

- 固定 token 是**明文配置**。若要更强的保管，可改从 `ctx.credentials` 读取，
  当前版本未实现。
- 只在 `dsh web`（Host 有 `connection` 服务）下有意义；无 webServer 的 profile
  里该插件行会因 `inject: ['connection']` 不满足而保持 dormant。
- 依赖官方 `browserAuth.launchToken` 这一内部字段形状。这是刻意的取舍：官方
  没有提供固定 token 的开关，改这个字段是唯一不改官方包就能生效的路径，
  代价是官方改形状时需要跟着更新（届时插件会抛错而不是静默失效）。

## License

MIT
