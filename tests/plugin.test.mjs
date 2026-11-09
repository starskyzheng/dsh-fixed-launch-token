/**
 * dsh-fixed-launch-token 离线测试。
 *
 * 三层：
 *  1. 单元：normalizeToken / rewriteBrowserAuth 的边界与形状。
 *  2. 契约：直接对**已安装的官方包源码**断言「launch token 只从
 *     browserAuth.launchToken 一个字段读取」这一前提仍然成立——本插件的正确性
 *     完全依赖它，官方改形状时必须在此 RED，而不是静默失效。
 *  3. 清单：patch/package.json/locale/icon 自洽。
 *
 * 运行：node --test tests/
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { name, normalizeToken, rewriteBrowserAuth } from '../index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// 测试夹具：合成的假 token，绝不能用真实部署值（真实值只存在于使用者自己的 profile 配置里）。
const FIXED = 'TEST_FIXTURE_TOKEN_not_a_real_credential_000';

test('normalizeToken accepts a well-formed fixed token', () => {
  assert.equal(normalizeToken(FIXED), FIXED);
});

test('normalizeToken trims surrounding whitespace', () => {
  assert.equal(normalizeToken(`  ${FIXED}\n`), FIXED);
});

test('normalizeToken returns undefined for absent or empty config', () => {
  assert.equal(normalizeToken(undefined), undefined);
  assert.equal(normalizeToken(null), undefined);
  assert.equal(normalizeToken(''), undefined);
  assert.equal(normalizeToken('   '), undefined);
  assert.equal(normalizeToken(42), undefined);
});

test('normalizeToken rejects a too-short token', () => {
  assert.throws(() => normalizeToken('short'), /too short/);
});

test('normalizeToken rejects a too-long token', () => {
  assert.throws(() => normalizeToken('a'.repeat(257)), /too long/);
});

test('normalizeToken rejects characters that break URL carriage', () => {
  // 每个样本都必须 ≥16 字符，否则会先撞长度检查、测不到字符检查这条分支。
  for (const bad of ['has space here!!!!!', 'has?questionmark!!!!', 'has#fragment!!!!!!!!']) {
    assert.ok(bad.length >= 16, `fixture ${bad} must reach the character check`);
    assert.throws(() => normalizeToken(bad), /must not contain/, `expected reject for ${bad}`);
  }
});

test('rewriteBrowserAuth pins the single field the official service reads', () => {
  const service = { browserAuth: { launchToken: 'random-per-process-value' } };
  assert.equal(rewriteBrowserAuth(service, FIXED), 1);
  assert.equal(service.browserAuth.launchToken, FIXED);
});

test('rewriteBrowserAuth is idempotent', () => {
  const service = { browserAuth: { launchToken: FIXED } };
  assert.equal(rewriteBrowserAuth(service, FIXED), 1);
  assert.equal(service.browserAuth.launchToken, FIXED);
});

test('rewriteBrowserAuth fails loud when the official shape is absent', () => {
  assert.equal(rewriteBrowserAuth(undefined, FIXED), 0);
  assert.equal(rewriteBrowserAuth({}, FIXED), 0);
  assert.equal(rewriteBrowserAuth({ browserAuth: {} }, FIXED), 0);
  assert.equal(rewriteBrowserAuth({ browserAuth: null }, FIXED), 0);
});

test('plugin declares the connection dependency it rewrites', async () => {
  const mod = await import('../index.js');
  assert.equal(mod.name, name);
  assert.deepEqual(mod.inject, ['connection']);
});

/**
 * 定位已安装的官方 connection 包源码。
 *
 * 实测本机 pnpm 全局布局有两代且层数不同：
 *   - 旧：<pnpm>/global/5/.pnpm/@deepseek-ai+dsh-client-connection@.../node_modules/...
 *   - 新：<pnpm>/global/v11/<hash>/node_modules/.pnpm/@deepseek-ai+dsh-client-connection@.../node_modules/...
 * 且 profile 的 node_modules 里并没有它的软链。因此这里用**有界递归**找
 * `.pnpm/@deepseek-ai+dsh-client-connection@*`，不猜层数；找不到就返回 undefined，
 * 由调用方显式失败（绝不静默跳过，否则契约测试会变成空断言）。
 */
function officialConnectionSource() {
  const rel = 'node_modules/@deepseek-ai/dsh-client-connection/lib/index.js';
  const direct = [
    `${ROOT}node_modules/@deepseek-ai/dsh-client-connection/lib/index.js`,
    `${process.env.HOME}/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js`,
  ];
  for (const candidate of direct) {
    if (existsSync(candidate)) return { path: candidate, source: readFileSync(candidate, 'utf8') };
  }

  const pnpmHome = process.env.PNPM_HOME ?? `${process.env.HOME}/.local/share/pnpm`;
  const found = [];
  /** 在 dir 下最多再下探 depth 层，收集 .pnpm 里官方 connection 包的真实路径。 */
  const walk = (dir, depth) => {
    if (depth < 0) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const full = `${dir}/${entry.name}`;
      if (entry.name === '.pnpm') {
        let packages;
        try {
          packages = readdirSync(full);
        } catch {
          continue;
        }
        for (const pkg of packages) {
          if (!pkg.startsWith('@deepseek-ai+dsh-client-connection@')) continue;
          const file = `${full}/${pkg}/${rel}`;
          if (existsSync(file)) found.push(file);
        }
        continue;
      }
      if (entry.name.startsWith('@deepseek-ai+dsh-client-connection@')) {
        const file = `${full}/${rel}`;
        if (existsSync(file)) found.push(file);
        continue;
      }
      walk(full, depth - 1);
    }
  };
  walk(`${pnpmHome}/global`, 6);

  if (found.length === 0) return undefined;
  // 多版本时取路径字典序最大的（近似最高版本），确定性且不依赖 readdir 顺序。
  found.sort();
  const path = found[found.length - 1];
  return { path, source: readFileSync(path, 'utf8') };
}

test('contract: official launch-token validation reads only browserAuth.launchToken', () => {
  const found = officialConnectionSource();
  assert.ok(
    found !== undefined,
    'the official @deepseek-ai/dsh-client-connection package must be discoverable; '
    + 'without it this contract test would assert nothing (a vacuous pass)',
  );
  const { path, source } = found;

  // 三条消费路径都必须比对 this.launchToken —— 单字段改写才足够。
  assert.match(
    source,
    /tokenMatches\(tokens\.join\(""\), this\.launchToken\)/,
    `authorizeIndex/authorizeConnect must compare against this.launchToken (${path})`,
  );
  assert.match(
    source,
    /url\.searchParams\.set\(TOKEN_QUERY, this\.launchToken\)/,
    `authenticatedUrl must read this.launchToken for the startup banner (${path})`,
  );
  // 存储仍是模块私有 WeakMap，且只由 processLaunchToken 写入。
  assert.match(source, /const PROCESS_LAUNCH_TOKENS = [^\n]*new WeakMap\(\)/, `token store shape changed (${path})`);
  assert.match(source, /PROCESS_LAUNCH_TOKENS\.set\(owner, created\)/, `token store write site changed (${path})`);
  // 服务必须在 await BrowserAuth.create 之后才 provide，否则 inject 回调会早于随机值生成。
  assert.match(
    source,
    /new HostConnectionService\(ctx, trustedHosts, await BrowserAuth\.create\(/,
    `connection service provide ordering changed; the inject callback may now run too early (${path})`,
  );
});

test('manifest, patch, locale and icon are self-consistent', () => {
  const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8'));
  assert.equal(pkg.name, 'dsh-fixed-launch-token');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  for (const entry of ['index.js', 'cordis.patch.yml', 'README.md']) {
    assert.ok(pkg.files.includes(entry), `files must list ${entry}`);
  }
  assert.ok(pkg.files.includes('locale/*.json'));
  assert.ok(pkg.files.includes('icon.svg'));
  assert.ok(pkg.exports['./icon'] !== undefined);

  const patch = readFileSync(`${ROOT}cordis.patch.yml`, 'utf8');
  assert.match(patch, /id: fixed-launch-token/);
  assert.match(patch, /name: dsh-fixed-launch-token/);
  // 出厂 patch 必须留空：固定 token 是使用者的凭据，不能由包携带。
  const configured = patch.match(/fixedLaunchToken:\s*(.*)/)?.[1]?.trim();
  assert.equal(configured, '""', 'the shipped patch must leave fixedLaunchToken empty (default inert)');

  for (const locale of ['en', 'zh']) {
    const meta = JSON.parse(readFileSync(`${ROOT}locale/${locale}.json`, 'utf8'));
    assert.ok(meta.meta.title.length > 0, `${locale} title`);
    assert.ok(meta.meta.description.length > 0, `${locale} description`);
  }

  const icon = readFileSync(`${ROOT}icon.svg`, 'utf8');
  assert.match(icon, /^<svg[\s>]/, 'icon must be SVG');
  assert.ok(Buffer.byteLength(icon) < 256 * 1024, 'icon must stay under 256 KiB');
});

test('no shipped source file carries a real pinned token', () => {
  // 真实部署值只能存在于使用者自己的 profile 配置里。包内任何非空 fixedLaunchToken
  // 都意味着凭据被带进了公开仓库，必须在此 RED。
  const patch = readFileSync(`${ROOT}cordis.patch.yml`, 'utf8');
  const configured = patch.match(/fixedLaunchToken:\s*(.*)/)?.[1]?.trim();
  assert.equal(configured, '""', 'cordis.patch.yml must ship with an empty fixedLaunchToken');

  // 测试夹具允许出现，但必须是显式合成的、不可能被误用的值。
  assert.match(FIXED, /^TEST_FIXTURE_/, 'the test fixture must be self-labelling as fake');

  for (const file of ['index.js', 'package.json', 'README.md', 'locale/en.json', 'locale/zh.json']) {
    const body = readFileSync(`${ROOT}${file}`, 'utf8');
    // 任何 43 字符 base64url 串都视作疑似真实 token（本插件配置值的实际长度）。
    const suspicious = body.match(/[A-Za-z0-9_-]{43}/g) ?? [];
    assert.deepEqual(suspicious, [], `${file} must not embed a 43-char token-like literal: ${suspicious.join(', ')}`);
  }
});

