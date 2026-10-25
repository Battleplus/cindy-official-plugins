import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const pluginDir = path.join(root, 'cindy-web-search');
const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'ghost.json'), 'utf8'));
const source = fs.readFileSync(path.join(pluginDir, 'main.js'), 'utf8');
const settingsSource = fs.readFileSync(path.join(pluginDir, 'settings.js'), 'utf8');
const settingsHtml = fs.readFileSync(path.join(pluginDir, 'settings.html'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const readmeZh = fs.readFileSync(path.join(root, 'README.zh-CN.md'), 'utf8');
const locales = ['zh-CN', 'en', 'ja', 'ko'].map((locale) =>
  JSON.parse(fs.readFileSync(path.join(pluginDir, 'locales', `${locale}.json`), 'utf8')),
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsync() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function createHarness(options = {}) {
  const kv = options.kv ?? {};
  const networkCalls = [];
  const cindyRequests = [];
  const toolResults = [];
  let handler = null;

  const cindy = {
    onHostMessage(fn) {
      handler = fn;
    },
    async fetch(request) {
      networkCalls.push(request);
      if (options.networkResult) return options.networkResult(request);
      throw new Error('unexpected network request');
    },
    async send(message) {
      if (message.type === 'cindy-request') {
        cindyRequests.push(message);
        if (options.cindyError) throw options.cindyError;
        return options.cindyResult ?? {
          ok: true,
          provider: 'cindy',
          results: [
            {
              title: 'Cindy',
              url: 'https://example.test/cindy',
              snippet: 'Managed result',
            },
          ],
        };
      }
      if (message.type === 'tool-result') {
        toolResults.push(message);
        return { ok: true };
      }
      throw new Error(`unexpected cindy.send type ${message.type}`);
    },
  };

  vm.runInNewContext(source, {
    cindy,
    fetch: async (url, init) => {
      if (options.kvFetch) return options.kvFetch(url, init);
      assert.equal(url, '/kv');
      return {
        ok: true,
        async json() {
          return kv;
        },
      };
    },
    encodeURIComponent,
    isFinite,
    JSON,
    String,
    Error,
    URL,
  });
  assert.equal(typeof handler, 'function');

  return {
    networkCalls,
    cindyRequests,
    toolResults,
    async tool(tool, args = {}) {
      await handler({
        type: 'tool-call',
        tool,
        callId: 'call-1',
        args,
      });
      return toolResults.at(-1);
    },
    async search(args = {}) {
      return this.tool('search_web', { query: 'Cindy', ...args });
    },
    async fetchPage(args = {}) {
      return this.tool('fetch_page', {
        url: 'https://example.test/article',
        confirm_public_url: true,
        ...args,
      });
    },
  };
}

function createSettingsHarness(options = {}) {
  function control(initial = {}) {
    const listeners = new Map();
    return {
      checked: initial.checked ?? false,
      value: initial.value ?? '',
      disabled: initial.disabled ?? false,
      textContent: '',
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      emit(type) {
        const listener = listeners.get(type);
        assert.ok(listener, `missing ${type} listener`);
        return listener();
      },
    };
  }

  const cindyAiEnabled = control({ checked: true, disabled: true });
  const byoDefaultProvider = control({ value: 'brave', disabled: true });
  const status = control();
  const elements = new Map([
    ['cindy-ai-enabled', cindyAiEnabled],
    ['byo-default-provider', byoDefaultProvider],
    ['status', status],
  ]);
  const fetchCalls = [];
  const document = {
    getElementById(id) {
      return elements.get(id);
    },
    querySelectorAll(selector) {
      assert.equal(selector, '.secret');
      return [];
    },
  };

  vm.runInNewContext(settingsSource, {
    document,
    fetch: async (url, init = {}) => {
      fetchCalls.push({ url, init });
      if (url === '/secrets') {
        return {
          ok: true,
          async json() {
            return [];
          },
        };
      }
      assert.equal(url, '/kv');
      if (init.method === 'PUT') {
        return options.writeKv ? options.writeKv(init) : { ok: true };
      }
      return options.readKv
        ? options.readKv()
        : {
            ok: true,
            async json() {
              return {};
            },
          };
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    JSON,
    Error,
  });

  return {
    cindyAiEnabled,
    byoDefaultProvider,
    status,
    fetchCalls,
  };
}

test('manifest declares Cindy Web Search and keeps BYO providers explicit', () => {
  assert.equal(manifest.version, '1.5.0');
  assert.equal(manifest.minCindyVersion, '0.1.64');
  assert.equal(manifest.schemaVersion, 3);
  assert.deepEqual(manifest.cindy, { search: ['web'] });
  // Manifest v3 用顶层直接字段声明能力,不再提供 slots。
  assert.equal(Object.hasOwn(manifest, 'slots'), false);
  assert.deepEqual(manifest.network.hosts, ['api.search.brave.com', 'api.tavily.com', 'api.deepseek.com']);
  assert.deepEqual(manifest.setup, { requires: [] });
  const searchTool = manifest.tools.find((tool) => tool.name === 'search_web');
  const fetchTool = manifest.tools.find((tool) => tool.name === 'fetch_page');
  assert.ok(searchTool);
  assert.ok(fetchTool);
  const provider = searchTool.parameters.properties.provider;
  assert.deepEqual(provider.enum, ['cindy', 'brave', 'tavily', 'deepseek']);
  assert.equal(provider.enum.includes('auto'), false);
  const query = searchTool.parameters.properties.query;
  assert.equal(query.maxLength, 2000);
  assert.match(searchTool.description, /2000/);
  assert.match(query.description, /2000/);
  assert.equal(fetchTool.parameters.properties.url.maxLength, 2048);
  assert.equal(fetchTool.parameters.properties.confirm_public_url.type, 'boolean');
  assert.deepEqual(fetchTool.parameters.required, ['url', 'confirm_public_url']);
  assert.deepEqual(fetchTool.parameters.properties.extract_depth.enum, ['basic', 'advanced']);
  assert.match(fetchTool.description, /50000/);
  assert.match(fetchTool.description, /不可信/);
  assert.match(fetchTool.description, /响应过大/);
  assert.match(fetchTool.description, /浏览器登录/);
  assert.match(fetchTool.description, /执行页面脚本/);
  assert.match(fetchTool.description, /confirm_public_url=true/);
  assert.match(manifest.whenToUse, /任意公开 HTTP\(S\) 页面/);
  assert.match(manifest.whenToUse, /包括但不限于搜索结果页/);
  assert.match(manifest.description, /用户明确确认/);
  assert.match(manifest.whenToUse, /用户明确确认/);
  const localeRoutingContracts = [
    [/任意公开 HTTP\(S\) 页面/, /包括但不限于搜索结果页/, /明确确认/],
    [/any public HTTP\(S\) page/, /including but not limited to search results/, /explicit.*confirm/i],
    [/任意の公開 HTTP\(S\) ページ/, /検索結果ページを含む/, /明示的.*確認/],
    [/모든 공개 HTTP\(S\) 페이지/, /검색 결과 페이지를 포함한/, /명시적.*확인/],
  ];
  for (const [index, locale] of locales.entries()) {
    assert.match(locale.tools.search_web.description, /2000/);
    assert.match(locale.tools.fetch_page.description, /50000/);
    assert.match(locale.tools.fetch_page.description, /confirm_public_url=true/);
    assert.match(locale.whenToUse, localeRoutingContracts[index][0]);
    assert.match(locale.whenToUse, localeRoutingContracts[index][1]);
    assert.match(locale.description, localeRoutingContracts[index][2]);
    assert.match(locale.whenToUse, localeRoutingContracts[index][2]);
  }
  assert.match(readme, /explicitly confirmed public HTTP\(S\) page/);
  assert.match(readmeZh, /用户明确确认的任意公开 HTTP\(S\) 网页正文/);
});

test('fetch_page calls Tavily Extract without handling credentials in the sandbox', async () => {
  const harness = createHarness({
    networkResult(request) {
      assert.equal(request.url, 'https://api.tavily.com/extract');
      assert.equal(request.method, 'POST');
      assert.equal(request.headers['Content-Type'], 'application/json');
      assert.equal(request.headers.Accept, 'application/json');
      assert.equal(request.timeoutMs, 55000);
      assert.equal(request.callId, 'call-1');
      assert.equal('Authorization' in request.headers, false);
      assert.deepEqual(JSON.parse(request.body), {
        urls: 'https://example.test/article',
        extract_depth: 'basic',
        include_images: false,
        include_favicon: false,
        format: 'markdown',
        timeout: 20,
      });
      return {
        ok: true,
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          results: [{ url: 'https://example.test/article', raw_content: '# Article\n\nBody' }],
          failed_results: [],
        }),
      };
    },
  });

  const result = await harness.fetchPage();

  assert.equal(harness.networkCalls.length, 1);
  assert.equal(harness.cindyRequests.length, 0);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
    provider: 'tavily',
    url: 'https://example.test/article',
    content: '# Article\n\nBody',
    format: 'markdown',
    extract_depth: 'basic',
    content_chars: 15,
    truncated: false,
    content_is_untrusted: true,
  });
});

test('fetch_page supports advanced extraction and marks content truncation explicitly', async () => {
  const content = 'x'.repeat(50001);
  const harness = createHarness({
    networkResult(request) {
      const body = JSON.parse(request.body);
      assert.equal(body.extract_depth, 'advanced');
      assert.equal(body.timeout, 45);
      return {
        ok: true,
        status: 200,
        headers: {},
        body: JSON.stringify({
          results: [{ url: 'https://example.test/dynamic', raw_content: content }],
          failed_results: [],
        }),
      };
    },
  });

  const result = await harness.fetchPage({
    url: 'https://example.test/dynamic',
    extract_depth: 'advanced',
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.extract_depth, 'advanced');
  assert.equal(result.result.content.length, 50000);
  assert.equal(result.result.content_chars, 50001);
  assert.equal(result.result.truncated, true);
});

test('fetch_page accepts uppercase characters in valid public URLs', async (t) => {
  const cases = [
    ['https://example.test/Article', 'https://example.test/Article'],
    ['https://example.test/?Token=ABC', 'https://example.test/?Token=ABC'],
    ['HTTPS://EXAMPLE.TEST/Article', 'https://example.test/Article'],
  ];
  for (const [url, normalizedUrl] of cases) {
    await t.test(url, async () => {
      const harness = createHarness({
        networkResult(request) {
          assert.equal(JSON.parse(request.body).urls, normalizedUrl);
          return {
            ok: true,
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              results: [{ url: normalizedUrl, raw_content: '# Article' }],
              failed_results: [],
            }),
          };
        },
      });
      const result = await harness.fetchPage({ url });
      assert.equal(result.ok, true);
      assert.equal(result.result.url, normalizedUrl);
      assert.equal(harness.networkCalls.length, 1);
    });
  }
});

test('fetch_page preserves a search result query and strips its browser-only fragment', async () => {
  const harness = createHarness({
    networkResult(request) {
      const body = JSON.parse(request.body);
      assert.equal(body.urls, 'https://example.test/article?id=42');
      return {
        ok: true,
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          results: [{ url: body.urls, raw_content: '# Callback' }],
          failed_results: [],
        }),
      };
    },
  });

  const result = await harness.fetchPage({
    url: 'https://example.test/article?id=42#section',
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.url, 'https://example.test/article?id=42');
  assert.equal(harness.networkCalls.length, 1);
});

test('fetch_page requires explicit confirmation before disclosing the full URL to Tavily', async () => {
  const harness = createHarness();
  for (const confirmation of [undefined, false]) {
    const result = await harness.tool('fetch_page', {
      url: 'https://example.test/reset/session-secret?token=SECRET',
      ...(confirmation === undefined ? {} : { confirm_public_url: confirmation }),
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /confirm_public_url:true/);
    assert.match(result.message, /Tavily/);
    assert.doesNotMatch(result.message, /session-secret|SECRET/);
  }
  assert.equal(harness.networkCalls.length, 0);
});

test('fetch_page rejects invalid URLs before any network request', async (t) => {
  const invalidUrls = [
    '',
    '/relative',
    'file:///etc/passwd',
    'ftp://example.test/file',
    'https://user:pass@example.test/',
    'https:\\example.test\\article',
    'https://example.test/\u0000article',
    'https://example.test/\tarticle',
    'https://example.test/\narticle',
    'https://example.test/\u007farticle',
    ' https://example.test/article',
    'http://localhost/admin',
    'http://127.0.0.1/admin',
    'http://10.0.0.1/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://192.168.1.1/admin',
    'http://[::1]/admin',
    'http://[fd00::1]/admin',
    'http://[::ffff:127.0.0.1]/admin',
    `https://example.test/${'x'.repeat(2048)}`,
  ];
  for (const url of invalidUrls) {
    await t.test(JSON.stringify(url).slice(0, 80), async () => {
      const harness = createHarness();
      const result = await harness.fetchPage({ url });
      assert.equal(result.ok, false);
      assert.match(result.message, /HTTP\(S\)/);
      assert.equal(harness.networkCalls.length, 0);
    });
  }
});

test('fetch_page returns actionable errors without exposing upstream response bodies', async (t) => {
  const cases = [
    [401, /API Key/],
    [403, /权限|账户/],
    [429, /频繁|限流/],
    [432, /额度|账户/],
    [433, /额度|账户/],
    [500, /暂时不可用/],
  ];
  for (const [status, expected] of cases) {
    await t.test(String(status), async () => {
      const harness = createHarness({
        networkResult() {
          return {
            ok: true,
            status,
            headers: {},
            body: 'sensitive upstream response',
          };
        },
      });
      const result = await harness.fetchPage();
      assert.equal(result.ok, false);
      assert.match(result.message, expected);
      assert.doesNotMatch(result.message, /sensitive/);
    });
  }
});

test('fetch_page fails closed on transport and malformed provider responses', async (t) => {
  const cases = [
    {
      name: 'missing key',
      response: { ok: false, message: 'secret not configured: sensitive-name' },
      expected: /API Key 未配置/,
    },
    {
      name: 'host truncation',
      response: { ok: true, status: 200, headers: {}, body: '{', truncated: true },
      expected: /数据过大/,
    },
    {
      name: 'oversized response',
      response: { ok: true, status: 200, headers: {}, body: 'x'.repeat(1000001) },
      expected: /数据过大/,
    },
    {
      name: 'invalid json',
      response: { ok: true, status: 200, headers: {}, body: '<html>upstream</html>' },
      expected: /无法解析/,
    },
    {
      name: 'failed result',
      response: {
        ok: true,
        status: 200,
        headers: {},
        body: JSON.stringify({ results: [], failed_results: [{ url: 'https://example.test/article' }] }),
      },
      expected: /无法读取/,
    },
    {
      name: 'unsafe result url',
      response: {
        ok: true,
        status: 200,
        headers: {},
        body: JSON.stringify({
          results: [{ url: 'file:///etc/passwd', raw_content: 'bad' }],
          failed_results: [],
        }),
      },
      expected: /格式异常/,
    },
    {
      name: 'empty content',
      response: {
        ok: true,
        status: 200,
        headers: {},
        body: JSON.stringify({
          results: [{ url: 'https://example.test/article', raw_content: '   ' }],
          failed_results: [],
        }),
      },
      expected: /没有可读取/,
    },
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const harness = createHarness({ networkResult: () => testCase.response });
      const result = await harness.fetchPage();
      assert.equal(result.ok, false);
      assert.match(result.message, testCase.expected);
      assert.doesNotMatch(result.message, /sensitive-name|upstream/);
    });
  }
});

test('fetch_page hides unexpected runtime errors behind an actionable message', async () => {
  const harness = createHarness({ networkResult: () => null });
  const result = await harness.fetchPage();

  assert.equal(result.type, 'tool-result');
  assert.equal(result.callId, 'call-1');
  assert.equal(result.ok, false);
  assert.equal(result.message, '网页正文读取失败，请稍后重试');
  assert.doesNotMatch(result.message, /search|搜索|TypeError|Cannot read/i);
});

test('missing provider uses Cindy AI by default and does not touch BYO network', async () => {
  const harness = createHarness();
  const result = await harness.search();

  assert.equal(harness.networkCalls.length, 0);
  assert.equal(harness.cindyRequests.length, 1);
  const request = harness.cindyRequests[0];
  assert.equal(request.type, 'cindy-request');
  assert.equal(request.kind, 'search_web');
  assert.equal(request.query, 'Cindy');
  assert.equal(request.limit, 5);
  assert.equal(request.provider, 'cindy');
  assert.equal(request.callId, 'call-1');
  assert.equal(request.callerTool, 'search_web');
  assert.equal(result.ok, true);
  assert.equal(result.result.provider, 'cindy');
});

test('disabled Cindy AI uses the configured BYO default only', async () => {
  const harness = createHarness({
    kv: { cindyAiEnabled: false, byoDefaultProvider: 'tavily' },
    networkResult(request) {
      assert.equal(request.url, 'https://api.tavily.com/search');
      return {
        ok: true,
        status: 200,
        body: JSON.stringify({
          results: [
            {
              title: 'Tavily',
              url: 'https://example.test/tavily',
              content: 'BYO result',
            },
          ],
        }),
      };
    },
  });
  const result = await harness.search();

  assert.equal(harness.cindyRequests.length, 0);
  assert.equal(harness.networkCalls.length, 1);
  assert.equal(result.ok, true);
  assert.equal(result.result.provider, 'tavily');
});

test('missing provider fails closed when preferences cannot be read', async () => {
  const harness = createHarness({
    kvFetch: async () => {
      throw new Error('kv unavailable');
    },
  });
  const result = await harness.search();

  assert.equal(harness.cindyRequests.length, 0);
  assert.equal(harness.networkCalls.length, 0);
  assert.equal(result.ok, false);
  assert.match(result.message, /搜索偏好读取失败/);
});

test('Cindy transport failures return an actionable service error', async () => {
  const harness = createHarness({
    cindyError: new Error('Failed to fetch'),
  });
  const result = await harness.search({ provider: 'cindy' });

  assert.equal(harness.cindyRequests.length, 1);
  assert.equal(harness.networkCalls.length, 0);
  assert.equal(result.ok, false);
  assert.equal(result.message, 'Cindy AI 搜索服务暂时不可用，请稍后再试');
  assert.equal(result.errorCode, 'INTERNAL');
  assert.doesNotMatch(result.message, /Failed to fetch/);
});

test('explicit provider wins over settings and provider failures never fall back', async () => {
  const brave = createHarness({
    kvFetch: async () => {
      throw new Error('explicit provider must not read kv');
    },
    networkResult(request) {
      assert.match(request.url, /^https:\/\/api\.search\.brave\.com\//);
      return {
        ok: true,
        status: 200,
        body: JSON.stringify({
          web: {
            results: [
              {
                title: 'Brave',
                url: 'https://example.test/brave',
                description: 'BYO result',
              },
            ],
          },
        }),
      };
    },
  });
  const braveResult = await brave.search({ provider: 'brave' });
  assert.equal(brave.cindyRequests.length, 0);
  assert.equal(brave.networkCalls.length, 1);
  assert.equal(braveResult.result.provider, 'brave');

  const failedCindy = createHarness({
    cindyResult: {
      ok: false,
      errorCode: 'QUOTA_EXHAUSTED',
      message: 'Cindy AI quota exhausted',
    },
  });
  const failedResult = await failedCindy.search({ provider: 'cindy' });
  assert.equal(failedCindy.cindyRequests.length, 1);
  assert.equal(failedCindy.networkCalls.length, 0);
  assert.equal(failedResult.ok, false);
  assert.equal(failedResult.message, 'Cindy AI quota exhausted');
  assert.equal(failedResult.errorCode, 'QUOTA_EXHAUSTED');
});

for (const provider of ['cindy', 'brave', 'tavily']) {
  for (const errorCode of ['RATE_LIMITED', 'QUOTA_EXHAUSTED', 'INVALID_INPUT', 'PERMISSION_DENIED']) {
    test(`${provider} preserves Host error ${errorCode} without retry or fallback`, async () => {
      const failure = { ok: false, errorCode, message: 'Host failure details' };
      const harness = createHarness({ cindyResult: failure, networkResult: () => failure });
      const result = await harness.search({ provider });

      assert.equal(result.ok, false);
      assert.equal(result.errorCode, errorCode);
      assert.equal(result.message, failure.message);
      assert.equal(result.callId, 'call-1');
      assert.equal(harness.toolResults.length, 1);
      assert.equal(harness.cindyRequests.length, provider === 'cindy' ? 1 : 0);
      assert.equal(harness.networkCalls.length, provider === 'cindy' ? 0 : 1);
    });
  }

  test(`${provider} preserves structured exceptions`, async () => {
    const failure = Object.assign(new Error('Search quota exhausted; check your balance'), {
      errorCode: 'QUOTA_EXHAUSTED',
    });
    const harness = createHarness({
      cindyError: failure,
      networkResult: () => { throw failure; },
    });
    const result = await harness.search({ provider });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'QUOTA_EXHAUSTED');
    assert.ok(result.message.includes(failure.message));
    assert.equal(harness.toolResults.length, 1);
    assert.equal(harness.cindyRequests.length, provider === 'cindy' ? 1 : 0);
    assert.equal(harness.networkCalls.length, provider === 'cindy' ? 0 : 1);
  });

  test(`${provider} classifies unstructured exceptions as INTERNAL`, async () => {
    const failure = new Error('Unexpected failure');
    const harness = createHarness({
      cindyError: failure,
      networkResult: () => { throw failure; },
    });
    const result = await harness.search({ provider });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'INTERNAL');
    assert.equal(harness.toolResults.length, 1);
  });
}

test('legacy failures without errorCode remain failures without guessing their category', async () => {
  const harness = createHarness({ cindyResult: { ok: false, message: 'Legacy failure' } });
  const result = await harness.search({ provider: 'cindy' });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, undefined);
  assert.equal(result.message, 'Legacy failure');
});

test('settings explains that Tavily independently enables page reading', () => {
  assert.match(settingsHtml, /Tavily Key 还会独立启用经用户确认的公开网页正文读取/);
  assert.match(settingsHtml, /即使保持 Cindy AI 搜索也可单独使用正文读取/);
});

test('settings controls stay disabled until initial preferences load', async () => {
  const pendingKv = deferred();
  const harness = createSettingsHarness({
    readKv: () => pendingKv.promise,
  });

  assert.equal(harness.cindyAiEnabled.disabled, true);
  assert.equal(harness.byoDefaultProvider.disabled, true);

  pendingKv.resolve({
    ok: true,
    async json() {
      return { cindyAiEnabled: false, byoDefaultProvider: 'tavily' };
    },
  });
  await flushAsync();

  assert.equal(harness.cindyAiEnabled.checked, false);
  assert.equal(harness.byoDefaultProvider.value, 'tavily');
  assert.equal(harness.cindyAiEnabled.disabled, false);
  assert.equal(harness.byoDefaultProvider.disabled, false);
});

test('settings remain disabled when initial preferences fail to load', async () => {
  const harness = createSettingsHarness({
    readKv: async () => {
      throw new Error('kv unavailable');
    },
  });
  await flushAsync();

  assert.equal(harness.cindyAiEnabled.disabled, true);
  assert.equal(harness.byoDefaultProvider.disabled, true);
  assert.match(harness.status.textContent, /搜索偏好加载失败/);
  assert.match(settingsHtml, /id="cindy-ai-enabled"[^>]*disabled/);
  assert.match(settingsHtml, /id="byo-default-provider"[^>]*disabled/);
});

test('settings save failure restores the last successfully loaded preferences', async () => {
  const harness = createSettingsHarness({
    readKv: async () => ({
      ok: true,
      async json() {
        return { cindyAiEnabled: false, byoDefaultProvider: 'tavily' };
      },
    }),
    writeKv: async () => ({ ok: false }),
  });
  await flushAsync();

  harness.cindyAiEnabled.checked = true;
  harness.cindyAiEnabled.emit('change');
  await flushAsync();

  assert.equal(harness.cindyAiEnabled.checked, false);
  assert.equal(harness.byoDefaultProvider.value, 'tavily');
  assert.equal(harness.cindyAiEnabled.disabled, false);
  assert.equal(harness.byoDefaultProvider.disabled, false);
  assert.match(harness.status.textContent, /搜索偏好保存失败/);
});

function deepSeekResponse(results = []) {
  return { ok: true, status: 200, body: JSON.stringify({ results }) };
}

function deepSeekItem(overrides = {}) {
  return {
    title: 'Example page', url: 'https://example.test/page',
    summary: 'Long summary for the model', snippet: 'Short display snippet',
    content: '', ...overrides,
  };
}

test('DeepSeek uses the independent Search API with Host-only credential injection', async () => {
  const harness = createHarness({
    kvFetch: () => { throw new Error('explicit selection must not read preferences'); },
    networkResult: () => deepSeekResponse([
      deepSeekItem(), deepSeekItem({ summary: '', snippet: 'Fallback snippet' }),
      deepSeekItem({ title: 'Extra result' }),
    ]),
  });
  const result = await harness.search({ provider: 'deepseek', query: '  示例 site:example.test  ', limit: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.result.provider, 'deepseek');
  assert.deepEqual(JSON.parse(JSON.stringify(result.result.results)), [
    { title: 'Example page', url: 'https://example.test/page', snippet: 'Long summary for the model' },
    { title: 'Example page', url: 'https://example.test/page', snippet: 'Fallback snippet' },
  ]);
  assert.equal(harness.networkCalls.length, 1);
  assert.equal(harness.cindyRequests.length, 0);
  assert.equal(harness.toolResults.length, 1);
  const request = harness.networkCalls[0];
  assert.equal(request.url, 'https://api.deepseek.com/v1/tools/search');
  assert.equal(request.method, 'POST');
  assert.equal(request.callId, 'call-1');
  assert.deepEqual(JSON.parse(JSON.stringify(request.headers)), { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(request.body), { query: '示例 site:example.test', count: 2, need_content: false });
});

test('DeepSeek may be the BYO default while Cindy AI remains the initial default', async () => {
  const configured = { cindyAiEnabled: false, byoDefaultProvider: 'deepseek' };
  const harness = createHarness({ kv: configured, networkResult: () => deepSeekResponse() });
  const result = await harness.search();
  assert.equal(result.ok, true);
  assert.equal(result.result.provider, 'deepseek');
  assert.equal(result.result.results.length, 0);
  assert.equal(JSON.parse(harness.networkCalls[0].body).count, 5);
  assert.equal(harness.cindyRequests.length, 0);

  const enabled = createHarness({ kv: { ...configured, cindyAiEnabled: true } });
  assert.equal((await enabled.search()).result.provider, 'cindy');
  assert.equal(enabled.networkCalls.length, 0);
});

test('DeepSeek limit respects the shared 1–10 result contract', async () => {
  for (const [limit, count] of [[0, 1], [2.9, 2], [50, 10]]) {
    const harness = createHarness({ networkResult: () => deepSeekResponse() });
    assert.equal((await harness.search({ provider: 'deepseek', limit })).ok, true);
    assert.equal(JSON.parse(harness.networkCalls[0].body).count, count);
  }
});

test('DeepSeek validates 128 Unicode code points without truncation for both routing paths', async () => {
  for (const unit of ['中', '😀']) {
    const query = unit.repeat(128);
    const harness = createHarness({ networkResult: () => deepSeekResponse() });
    assert.equal((await harness.search({ provider: 'deepseek', query })).ok, true);
    assert.equal(JSON.parse(harness.networkCalls[0].body).query, query);
    for (const provider of ['deepseek', undefined]) {
      const rejected = createHarness({ kv: { cindyAiEnabled: false, byoDefaultProvider: 'deepseek' } });
      const result = await rejected.search({ provider, query: query + unit });
      assert.equal(result.ok, false);
      assert.equal(result.errorCode, 'INVALID_INPUT');
      assert.match(result.message, /128/);
      assert.equal(rejected.networkCalls.length, 0);
      assert.equal(rejected.cindyRequests.length, 0);
    }
  }
  const existing = createHarness();
  assert.equal((await existing.search({ provider: 'cindy', query: 'a'.repeat(2000) })).ok, true);
  assert.equal(existing.cindyRequests[0].query.length, 2000);
  const empty = createHarness();
  assert.equal((await empty.search({ provider: 'deepseek', query: ' \n ' })).ok, false);
  assert.equal(empty.networkCalls.length, 0);
});

test('DeepSeek preserves structured Host error codes with safe, actionable messages', async () => {
  for (const [errorCode, guidance] of [
    ['NOT_CONFIGURED', /配置 DeepSeek API Key/], ['AUTH_REJECTED', /更新 Key/],
    ['PERMISSION_DENIED', /授权/], ['QUOTA_EXHAUSTED', /充值/],
    ['RATE_LIMITED', /稍后重试/], ['INVALID_INPUT', /128/], ['HOST_NETWORK_FAILURE', /网络连接/],
  ]) {
    for (const throws of [false, true]) {
      const harness = createHarness({ networkResult: () => {
        if (throws) throw Object.assign(new Error('private-host-detail'), { errorCode });
        return { ok: false, errorCode, message: 'private-host-detail' };
      } });
      const result = await harness.search({ provider: 'deepseek' });
      assert.equal(result.errorCode, errorCode);
      assert.match(result.message, guidance);
      assert.doesNotMatch(result.message, /private-host-detail/);
      assert.equal(harness.networkCalls.length, 1);
      assert.equal(harness.cindyRequests.length, 0);
      assert.equal(harness.toolResults.length, 1);
    }
  }
});

test('DeepSeek handles legacy Host failures and exceptions without exposing diagnostics', async () => {
  for (const failure of [null, { ok: false, message: 'private-host-detail' }, new Error('private-host-detail')]) {
    const harness = createHarness({ networkResult: () => {
      if (failure instanceof Error) throw failure;
      return failure;
    } });
    const result = await harness.search({ provider: 'deepseek' });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'INTERNAL');
    assert.match(result.message, /网络连接/);
    assert.match(result.message, /DeepSeek API Key/);
    assert.doesNotMatch(result.message, /private-host-detail/);
    assert.equal(harness.networkCalls.length, 1);
  }
});

test('DeepSeek rejects malformed, truncated and oversized results instead of returning empty success', async () => {
  const bodies = ['invalid-json', 'null', '{}', '{"results":{}}', '{"results":[null]}',
    JSON.stringify({ results: [deepSeekItem({ title: null })] }),
    JSON.stringify({ results: [deepSeekItem({ summary: null })] }),
    JSON.stringify({ results: [deepSeekItem({ url: 42 })] }),
    JSON.stringify({ results: [deepSeekItem({ snippet: null })] }),
    ' '.repeat(1000001), null,
  ];
  for (const response of [
    ...bodies.map(body => ({ ok: true, status: 200, body })),
    { ...deepSeekResponse(), truncated: true },
  ]) {
    const harness = createHarness({ networkResult: () => response });
    const result = await harness.search({ provider: 'deepseek' });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'RESPONSE_INVALID');
    assert.equal(harness.networkCalls.length, 1);
    assert.equal(harness.cindyRequests.length, 0);
  }
});

test('DeepSeek credentials are declared only for the API host and have a settings row', () => {
  const secret = manifest.network.secrets.find(item => item.key === 'deepseek_api_key');
  assert.deepEqual(secret.inject, {
    header: 'Authorization', format: 'Bearer {value}', hosts: ['api.deepseek.com'],
  });
  assert.equal(secret.url, 'https://platform.deepseek.com/api_keys');
  assert.equal(manifest.network.hosts.includes('platform.deepseek.com'), false);
  assert.match(settingsHtml, /data-key="deepseek_api_key"/);
  assert.match(settingsHtml, /href="https:\/\/platform\.deepseek\.com\/api_keys"/);
  assert.match(settingsHtml, /<option value="deepseek">DeepSeek<\/option>/);
  for (const locale of locales) {
    assert.match(locale.description, /DeepSeek/);
    assert.match(locale.whenToUse, /DeepSeek/);
    assert.match(locale.tools.search_web.description, /128/);
  }
});

test('settings load and persist DeepSeek as the BYO default without losing other preferences', async () => {
  const original = { cindyAiEnabled: false, byoDefaultProvider: 'deepseek', unrelated: 'keep' };
  const harness = createSettingsHarness({ readKv: async () => ({ ok: true, json: async () => original }) });
  await flushAsync();
  assert.equal(harness.byoDefaultProvider.value, 'deepseek');
  harness.byoDefaultProvider.emit('change');
  await flushAsync();
  const write = harness.fetchCalls.find(call => call.init.method === 'PUT');
  assert.deepEqual(JSON.parse(write.init.body), original);
  assert.match(harness.status.textContent, /已保存/);
});
