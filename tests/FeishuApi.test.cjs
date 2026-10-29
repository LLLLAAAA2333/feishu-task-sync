'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFeishuClient, FeishuError, taskUrl, tasklistUrl } = require('../lib/feishu-api.cjs');

const TASK_1 = '3555af03-3379-445c-a758-00720ed5c135';
const TASK_2 = '3555af03-3379-445c-a758-00720ed5c136';
const LIST_1 = 'cc371766-6584-cf50-a222-c22cd9055004';
const LIST_2 = 'cc371766-6584-cf50-a222-c22cd9055005';
const SECTION_1 = 'e6e37dcc-f75a-5936-f589-12fb4b5c80c2';
const SECTION_2 = 'e6e37dcc-f75a-5936-f589-12fb4b5c80c3';
const FIELD_1 = '34d4b29f-3d58-4bc5-b752-6be80fb687c8';
const FIELD_2 = '34d4b29f-3d58-4bc5-b752-6be80fb687c9';
const OPTION_1 = '4216f79b-3fda-4dc6-a0c4-a16022e47152';
const token = (value = 'PRIVATE_TOKEN', expire = 7200) => ({ code: 0, tenant_access_token: value, expire });
const ok = data => ({ code: 0, data });
const task = (guid = TASK_1, overrides = {}) => ({ guid, summary: '下一步行动', completed_at: '0', mode: 2, ...overrides });
const tasklist = (guid = LIST_1) => ({ guid, name: '项目清单' });
const section = (guid = SECTION_1, extra = {}) => ({ guid, name: '编程', is_default: false,
  resource_type: 'tasklist', tasklist: tasklist(), ...extra });
const customField = (guid = FIELD_1, extra = {}) => ({ guid, name: '项目状态', type: 'single_select',
  single_select_setting: { options: [{ guid: OPTION_1, name: 'active', color_index: 1, is_hidden: false }] }, ...extra });
const relation = (tasklist_guid = LIST_1, section_guid = SECTION_1) => ({ tasklist_guid, section_guid });
const page = (items = [], extra = {}) => ok({ items, has_more: false, ...extra });

function fixture(responses, options = {}) {
  const calls = [];
  const delays = [];
  const client = createFeishuClient({
    appId: 'cli_test_app', appSecret: 'PRIVATE_SECRET', sleep: async ms => delays.push(ms),
    request: async request => {
      calls.push(request);
      assert.ok(responses.length, 'unexpected HTTP request');
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(request);
      return next.status === undefined ? { status: 200, json: next } : next;
    }, ...options,
  });
  return { client, calls, delays };
}

function errorIs(code, uncertain = false, extra = {}) {
  return error => {
    assert.ok(error instanceof FeishuError);
    assert.equal(error.code, code);
    assert.equal(error.uncertain, uncertain);
    for (const [key, value] of Object.entries(extra)) assert.equal(error[key], value);
    assert.doesNotMatch(JSON.stringify(error) + error.message + error.stack, /PRIVATE_|SENSITIVE_|access_token=/);
    return true;
  };
}

test('check is read-only, consumes every tasklist page, and caches credentials', async () => {
  const { client, calls } = fixture([
    token(), page([tasklist()], { has_more: true, page_token: 'next+1=' }),
    page([tasklist(LIST_2)]), page([]),
  ]);
  const checked = await client.check();
  assert.equal(checked.tasklistCount, 2);
  assert.equal(checked.ok, true);
  assert.equal(checked.writePermission, 'unverified');
  assert.deepEqual(checked.tasklists.map(item => item.guid), [LIST_1, LIST_2]);
  await client.listTasklists();
  assert.equal(calls.length, 4);
  assert.deepEqual(JSON.parse(calls[0].body), { app_id: 'cli_test_app', app_secret: 'PRIVATE_SECRET' });
  assert.equal(calls[0].url, 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal');
  assert.equal(new URL(calls[2].url).searchParams.get('page_token'), 'next+1=');
  for (const request of calls.slice(1)) {
    assert.equal(request.method, 'GET');
    assert.equal(request.throw, false);
    assert.equal(new URL(request.url).host, 'open.feishu.cn');
    assert.equal(new URL(request.url).searchParams.get('user_id_type'), 'open_id');
    assert.equal(request.headers.Authorization, 'Bearer PRIVATE_TOKEN');
  }
});

test('listTasks reads all statuses and all pages then retrieves full details', async () => {
  const { client, calls } = fixture([
    token(), page([{ guid: TASK_1 }], { has_more: true, page_token: 'page-2' }),
    page([{ guid: TASK_2 }]), ok({ task: task(TASK_1, { extra: 'local-id-1' }) }),
    ok({ task: task(TASK_2, { extra: 'local-id-2', completed_at: '1790000000000' }) }),
  ]);
  const tasks = await client.listTasks(LIST_1);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].extra, 'local-id-1');
  assert.equal(tasks[1].completed_at, '1790000000000');
  for (const request of calls.slice(1, 3)) {
    assert.equal(new URL(request.url).pathname, `/open-apis/task/v2/tasklists/${LIST_1}/tasks`);
    assert.equal(new URL(request.url).searchParams.has('completed'), false);
  }
  assert.equal(new URL(calls[3].url).pathname, `/open-apis/task/v2/tasks/${TASK_1}`);
});

test('details missing during list recovery reject the entire result, never imply completion', async () => {
  const { client } = fixture([
    token(), page([{ guid: TASK_1 }, { guid: TASK_2 }]), ok({ task: task() }),
    { status: 404, json: { code: 1470404, msg: 'SENSITIVE_API_DATA' } },
  ]);
  await assert.rejects(client.listTasks(LIST_1), errorIs('NOT_FOUND', false, { apiCode: 1470404, status: 404 }));
});

test('expired cache refreshes automatically and concurrent requests share token acquisition', async () => {
  let clock = 0;
  let tokenCalls = 0;
  const client = createFeishuClient({ appId: 'app', appSecret: 'PRIVATE_SECRET', now: () => clock,
    request: async request => {
      if (request.url.endsWith('/internal')) {
        tokenCalls += 1;
        await new Promise(resolve => setImmediate(resolve));
        return { status: 200, json: token(`token-${tokenCalls}`, 10) };
      }
      return { status: 200, json: page([]) };
    },
  });
  await Promise.all([client.listTasklists(), client.listTasklists()]);
  assert.equal(tokenCalls, 1);
  clock = 9001;
  await client.listTasklists();
  assert.equal(tokenCalls, 2);
});

test('explicit token rejection refreshes once before retrying exactly the same create', async () => {
  const { client, calls } = fixture([
    token('old-token'), { status: 401, json: { code: 99991663, msg: 'SENSITIVE_TOKEN' } },
    token('new-token'), ok({ task: task() }),
  ]);
  await client.createTask({ summary: '下一步行动', client_token: 'fixed-token-123' });
  assert.equal(calls.length, 4);
  assert.equal(calls[1].body, calls[3].body);
  assert.equal(calls[3].headers.Authorization, 'Bearer new-token');
});

test('a second token rejection is surfaced without an endless refresh loop', async () => {
  const rejection = { status: 401, json: { code: 99991665, msg: 'SENSITIVE_TOKEN' } };
  const { client, calls } = fixture([token(), rejection, token(), rejection]);
  await assert.rejects(client.getTask(TASK_1), errorIs('AUTH_ERROR', false, { apiCode: 99991665 }));
  assert.equal(calls.length, 4);
});

test('permission failures are explicit and do not trigger writes or retries', async () => {
  for (const response of [
    { status: 403, json: { code: 1470403, msg: 'PRIVATE_SECRET' } },
    { status: 400, json: { code: 99991672, msg: 'PRIVATE_TOKEN' } },
  ]) {
    const { client, calls } = fixture([token(), response]);
    await assert.rejects(client.getTasklist(LIST_1), errorIs('PERMISSION_DENIED', false, { apiCode: response.json.code }));
    assert.equal(calls.length, 2);
  }
});

test('explicit 429 is retried within a bound, honoring bounded Retry-After', async () => {
  const { client, calls, delays } = fixture([
    token(), { status: 429, headers: { 'Retry-After': '2' }, json: { code: 99991400 } }, ok({ task: task() }),
  ]);
  await client.createTask({ summary: '下一步行动', client_token: 'fixed-token-123' });
  assert.deepEqual(delays, [2000]);
  assert.equal(calls[1].body, calls[2].body);
  const exhausted = fixture([token(), ...Array(3).fill({ status: 429, json: {} })]);
  await assert.rejects(exhausted.client.getTask(TASK_1), errorIs('RATE_LIMITED'));
  assert.equal(exhausted.calls.length, 4);
});

test('safe GET retries network and server failure but does not return partial data', async () => {
  const { client, calls, delays } = fixture([
    token(), new Error('PRIVATE_SECRET'), { status: 503, text: 'PRIVATE_TOKEN' }, ok({ task: task() }),
  ]);
  assert.equal((await client.getTask(TASK_1)).guid, TASK_1);
  assert.equal(calls.length, 4);
  assert.deepEqual(delays, [500, 1000]);
});

test('network or server errors during writes are uncertain and never automatically repeated', async () => {
  for (const response of [
    new Error('PRIVATE_SECRET at access_token=PRIVATE_TOKEN'),
    { status: 500, json: { code: 1470500, msg: 'SENSITIVE_API_DATA' } },
    { status: 200, json: { code: 1470500, msg: 'SENSITIVE_API_DATA' } },
  ]) {
    const { client, calls } = fixture([token(), response]);
    const code = response instanceof Error ? 'NETWORK_ERROR' : 'SERVICE_ERROR';
    await assert.rejects(client.createTask({ summary: '下一步行动', client_token: 'fixed-token-123' }), errorIs(code, true));
    assert.equal(calls.length, 2);
  }
});

test('write timeout is bounded and late completion cannot cause automatic retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, calls } = fixture([token(), () => new Promise(() => {})]);
  const pending = client.createTask({ summary: '下一步行动', client_token: 'fixed-token-123' });
  const assertion = assert.rejects(pending, errorIs('TIMEOUT', true));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  t.mock.timers.tick(20000);
  await assertion;
  assert.equal(calls.length, 2);
});

test('malformed successful responses reject writes as uncertain without exposing content', async () => {
  for (const malformed of [
    {}, { code: '0', data: {} }, { code: 0 }, ok({ task: { guid: TASK_1 } }),
    ok({ task: task(TASK_1, { completed_at: undefined }) }),
    ok({ task: task(TASK_1, { completed_at: false }) }),
    { status: 200, text: 'PRIVATE_SECRET invalid JSON' },
  ]) {
    const { client, calls } = fixture([token(), malformed]);
    await assert.rejects(client.createTask({ summary: '下一步行动' }), errorIs('INVALID_RESPONSE', true));
    assert.equal(calls.length, 2);
  }
});

test('malformed pagination and repeated tokens reject instead of returning incomplete arrays', async () => {
  for (const pages of [
    [ok({ items: [], has_more: 'false' })],
    [ok({ items: null, has_more: false })],
    [page([], { has_more: true })],
    [page([], { has_more: true, page_token: 'same' }), page([], { has_more: true, page_token: 'same' })],
    [page([tasklist()], { has_more: true, page_token: 'next' }), page([tasklist()])],
  ]) {
    const { client } = fixture([token(), ...pages]);
    await assert.rejects(client.listTasklists(), error => {
      assert.ok(['INVALID_RESPONSE', 'INVALID_PAGINATION'].includes(error.code));
      assert.equal(error.uncertain, false);
      return true;
    });
  }
});

test('completion and reopen serialize the exact Task v2 patch fields', async () => {
  const completedAt = '1790000000000';
  const { client, calls } = fixture([
    token(), ok({ task: task(TASK_1, { completed_at: completedAt }) }), ok({ task: task() }),
  ]);
  await client.updateTask(TASK_1, { completed_at: completedAt });
  await client.updateTask(TASK_1, { completed_at: '0', summary: '新标题', description: '' });
  assert.equal(calls[1].method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[1].body), { task: { completed_at: completedAt }, update_fields: ['completed_at'] });
  assert.deepEqual(JSON.parse(calls[2].body), {
    task: { completed_at: '0', summary: '新标题', description: '' }, update_fields: ['completed_at', 'summary', 'description'],
  });
});

test('createTasklist uses only the supplied name/members and cannot repeat an uncertain create', async () => {
  const members = [{ id: 'ou_test_user', type: 'user', role: 'editor' }];
  const { client, calls } = fixture([token(), ok({ tasklist: tasklist() })]);
  assert.equal((await client.createTasklist({ name: '项目清单', members })).guid, LIST_1);
  assert.deepEqual(JSON.parse(calls[1].body), { name: '项目清单', members });
  const uncertain = fixture([token(), new Error('PRIVATE_SECRET')]);
  await assert.rejects(uncertain.client.createTasklist({ name: '项目' }), errorIs('NETWORK_ERROR', true));
  assert.equal(uncertain.calls.length, 2);
});

test('create preserves caller client_token, assignee, start, due/reminder, and stable extra metadata', async () => {
  const payload = { summary: '下一步行动', mode: 2, client_token: 'fixed-token-123', extra: 'obsidian-action-123',
    members: [{ id: 'ou_test_user', type: 'user', role: 'assignee' }],
    tasklists: [{ tasklist_guid: LIST_1 }], due: { timestamp: '1790000000000', is_all_day: false },
    reminders: [{ relative_fire_minute: 30 }], start: { timestamp: '1789996400000', is_all_day: false },
  };
  const { client, calls } = fixture([token(), ok({ task: task() })]);
  await client.createTask(payload);
  assert.deepEqual(JSON.parse(calls[1].body), payload);
});

test('start-time backfill sends a start-only update mask and rejects malformed or reversed times before requesting', async () => {
  const start = { timestamp: '1789996400000', is_all_day: false };
  const { client, calls } = fixture([token(), ok({ task: task(TASK_1, { start }) })]);
  await client.updateTask(TASK_1, { start });
  assert.deepEqual(JSON.parse(calls[1].body), { task: { start }, update_fields: ['start'] });
  const invalid = fixture([]);
  for (const payload of [{ start: null }, { start: { timestamp: 1789996400000, is_all_day: false } },
    { start: { timestamp: '1789996400000', is_all_day: 'false' } }, { start: { timestamp: '-1', is_all_day: false } },
    { start, due: { timestamp: '1789996300000', is_all_day: false } },
    { start, due: { timestamp: '1790000000000', is_all_day: true } }]) {
    await assert.rejects(invalid.client.createTask({ summary: '行动', ...payload }), errorIs('INVALID_INPUT'));
    await assert.rejects(invalid.client.updateTask(TASK_1, payload), errorIs('INVALID_INPUT'));
  }
  assert.equal(invalid.calls.length, 0);
});

test('mismatched detail IDs and invalid completion state are rejected', async () => {
  for (const returnedTask of [task(TASK_2), task(TASK_1, { completed_at: '-1' }), task(TASK_1, { mode: 3 })]) {
    const { client } = fixture([token(), ok({ task: returnedTask })]);
    await assert.rejects(client.getTask(TASK_1), errorIs('INVALID_RESPONSE'));
  }
  const { client } = fixture([token(), ok({ tasklist: tasklist(LIST_2) })]);
  await assert.rejects(client.getTasklist(LIST_1), errorIs('INVALID_RESPONSE'));
});

test('bad inputs cannot change host/path or accidentally clear undefined patch fields', async () => {
  const { client, calls } = fixture([]);
  for (const id of ['https://evil.invalid', '../tasks', TASK_1 + '?x=1', undefined]) {
    await assert.rejects(client.getTask(id), errorIs('INVALID_INPUT'));
    assert.throws(() => taskUrl(id), errorIs('INVALID_INPUT'));
    assert.throws(() => tasklistUrl(id), errorIs('INVALID_INPUT'));
  }
  for (const patch of [{ summary: undefined }, { completed_at: true }, { reminders: [] }, {}]) {
    await assert.rejects(client.updateTask(TASK_1, patch), errorIs('INVALID_INPUT'));
  }
  await assert.rejects(client.createTask({ summary: 'a', client_token: 'short' }), errorIs('INVALID_INPUT'));
  assert.equal(calls.length, 0);
  assert.equal(taskUrl(TASK_1), `https://applink.feishu.cn/client/todo/detail?guid=${TASK_1}`);
  assert.equal(tasklistUrl(LIST_1), `https://applink.feishu.cn/client/todo/task_list?guid=${LIST_1}`);
});

test('invalid token response and arbitrary API data cannot leak to errors', async () => {
  const brokenToken = fixture([{ code: 0, tenant_access_token: 'PRIVATE_TOKEN', expire: '7200' }]);
  await assert.rejects(brokenToken.client.check(), errorIs('INVALID_RESPONSE'));
  const { client, calls } = fixture([token(), { code: 123456, msg: 'PRIVATE_SECRET PRIVATE_TOKEN', error: { detail: 'SENSITIVE_RECORD' } }]);
  await assert.rejects(client.createTask({ summary: '下一步行动' }), errorIs('API_ERROR', false, { apiCode: 123456, status: 200 }));
  assert.equal(calls.length, 2);
});

test('concurrent client_token conflict remains uncertain and is never auto-created again', async () => {
  for (const status of [200, 400, 422]) {
    const { client, calls } = fixture([token(), { status, json: { code: 1470422, msg: 'SENSITIVE_REQUEST' } }]);
    await assert.rejects(client.createTask({ summary: '下一步行动', client_token: 'fixed-token-123' }), errorIs('API_ERROR', true));
    assert.equal(calls.length, 2);
  }
});

test('updateTasklist renames the existing list with an explicit name-only update mask', async () => {
  const renamed = { ...tasklist(), name: '项目新名称' };
  const { client, calls } = fixture([token(), ok({ tasklist: renamed })]);
  assert.deepEqual(await client.updateTasklist(LIST_1, { name: '项目新名称' }), renamed);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(new URL(calls[1].url).pathname, `/open-apis/task/v2/tasklists/${LIST_1}`);
  assert.equal(new URL(calls[1].url).searchParams.get('user_id_type'), 'open_id');
  assert.deepEqual(JSON.parse(calls[1].body), { tasklist: { name: '项目新名称' }, update_fields: ['name'] });
});

test('updateTasklist rejects clearing names, excessive names, extra fields and invalid identifiers before requesting', async () => {
  const { client, calls } = fixture([]);
  for (const patch of [
    undefined, null, [], {}, { name: undefined }, { name: null }, { name: '' }, { name: '  ' }, { name: 1 },
    { name: '名'.repeat(101) }, { name: '项目', owner: { id: 'ou_other', type: 'user' } },
    { name: '项目', update_fields: ['owner'] }, { name: '项目', members: [] }, Object.create({ name: '继承名称' }),
  ]) await assert.rejects(client.updateTasklist(LIST_1, patch), errorIs('INVALID_INPUT'));
  await assert.rejects(client.updateTasklist('https://evil.invalid', { name: '项目' }), errorIs('INVALID_INPUT'));
  assert.equal(calls.length, 0);
});

test('updateTasklist requires a valid returned list identity and name', async () => {
  for (const data of [
    {}, { tasklist: null }, { tasklist: { guid: LIST_1 } }, { tasklist: { guid: LIST_1, name: '' } },
    { tasklist: tasklist(LIST_2) },
  ]) {
    const { client, calls } = fixture([token(), ok(data)]);
    await assert.rejects(client.updateTasklist(LIST_1, { name: '项目' }), errorIs('INVALID_RESPONSE', true));
    assert.equal(calls.length, 2);
  }
});

test('uncertain list rename is not automatically repeated and does not create a replacement list', async () => {
  for (const response of [new Error('PRIVATE_SECRET'), { status: 503, json: { code: 1470500 } }]) {
    const { client, calls } = fixture([token(), response]);
    await assert.rejects(client.updateTasklist(LIST_1, { name: '项目新名称' }),
      errorIs(response instanceof Error ? 'NETWORK_ERROR' : 'SERVICE_ERROR', true));
    assert.equal(calls.length, 2);
    assert.equal(calls[1].method, 'PATCH');
  }
});

test('section and custom-field pagination keep the tasklist filter across empty and nonempty pages', async () => {
  for (const [method, endpoint, first, second] of [
    ['listSections', 'sections', { guid: SECTION_1, name: '默认', is_default: true }, { guid: SECTION_2, name: '编程', is_default: false }],
    ['listCustomFields', 'custom_fields', customField(), customField(FIELD_2, { type: 'text' })],
  ]) {
    const { client, calls } = fixture([token(), page([], { has_more: true, page_token: 'empty+' }),
      page([first], { has_more: true, page_token: 'last=' }), page([second])]);
    assert.deepEqual(await client[method](LIST_1), [first, second]);
    for (const call of calls.slice(1)) {
      const url = new URL(call.url);
      assert.equal(url.pathname, '/open-apis/task/v2/' + endpoint);
      assert.equal(url.searchParams.get('resource_type'), 'tasklist');
      assert.equal(url.searchParams.get('resource_id'), LIST_1);
      assert.equal(url.searchParams.get('user_id_type'), 'open_id');
      assert.equal(call.method, 'GET');
    }
    assert.equal(new URL(calls[3].url).searchParams.get('page_token'), 'last=');
  }
});

test('fresh tasklists accept the real unnamed default section while custom sections must have names', async () => {
  const unnamedDefault = { guid: '230cdd88-b11c-df2c-354d-d19e1ac8c223', is_default: true, name: '' };
  const detail = { ...unnamedDefault, resource_type: 'tasklist', tasklist: tasklist() };
  const { client } = fixture([token(), ok({ has_more: false, items: [unnamedDefault], page_token: '' }),
    ok({ section: detail }), page([])]);
  assert.deepEqual(await client.listSections(LIST_1), [unnamedDefault]);
  assert.deepEqual(await client.getSection(unnamedDefault.guid), detail);
  assert.deepEqual(await client.listCustomFields(LIST_1), []);
  for (const name of ['', '  ']) {
    const invalid = fixture([token(), page([{ ...unnamedDefault, is_default: false, name }])]);
    await assert.rejects(invalid.client.listSections(LIST_1), errorIs('INVALID_RESPONSE'));
  }
  for (const name of [null, undefined]) {
    const invalid = fixture([token(), page([{ ...unnamedDefault, name }])]);
    await assert.rejects(invalid.client.listSections(LIST_1), errorIs('INVALID_RESPONSE'));
  }
});

test('section create/get/rename and move follow the official payload and keep resource identity', async () => {
  const { client, calls } = fixture([token(), ok({ section: section() }), ok({ section: section() }), ok({ section: section() })]);
  const payload = { name: '编程', resource_type: 'tasklist', resource_id: LIST_1, insert_after: SECTION_2 };
  assert.deepEqual(await client.createSection(payload), section());
  assert.deepEqual(await client.getSection(SECTION_1), section());
  await client.updateSection(SECTION_1, { name: '程序设计', insert_before: SECTION_2 });
  assert.deepEqual(JSON.parse(calls[1].body), payload);
  assert.equal(new URL(calls[2].url).pathname, `/open-apis/task/v2/sections/${SECTION_1}`);
  assert.deepEqual(JSON.parse(calls[3].body), {
    section: { name: '程序设计', insert_before: SECTION_2 }, update_fields: ['name', 'insert_before'],
  });
  assert.equal(calls[3].method, 'PATCH');
});

test('section task inspection follows every page without filtering out completed tasks', async () => {
  const { client, calls } = fixture([token(), page([], { has_more: true, page_token: 'next' }),
    page([{ guid: TASK_1, completed_at: '1234' }, { guid: TASK_2, completed_at: '0' }])]);
  assert.deepEqual((await client.listSectionTasks(SECTION_1)).map(item => item.guid), [TASK_1, TASK_2]);
  for (const call of calls.slice(1)) {
    const url = new URL(call.url);
    assert.equal(url.pathname, `/open-apis/task/v2/sections/${SECTION_1}/tasks`);
    assert.equal(url.searchParams.has('completed'), false);
  }
  assert.equal(new URL(calls[2].url).searchParams.get('page_token'), 'next');
});

test('empty-section deletion checks ownership and emptiness before issuing DELETE', async () => {
  const { client, calls } = fixture([token(), ok({ section: section() }), page([]), ok({})]);
  await client.deleteEmptySection(SECTION_1, LIST_1);
  assert.equal(calls.at(-1).method, 'DELETE');
  assert.equal(new URL(calls.at(-1).url).pathname, `/open-apis/task/v2/sections/${SECTION_1}`);
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 1);
});

test('section cleanup retains default, foreign, occupied and incompletely read groups', async () => {
  for (const responses of [
    [ok({ section: section(SECTION_1, { is_default: true }) })],
    [ok({ section: section(SECTION_1, { tasklist: tasklist(LIST_2) }) })],
    [ok({ section: section() }), page([{ guid: TASK_1, completed_at: '1234' }])],
    [ok({ section: section() }), page([], { has_more: true })],
  ]) {
    const { client, calls } = fixture([token(), ...responses]);
    await assert.rejects(client.deleteEmptySection(SECTION_1, LIST_1));
    assert.equal(calls.some(call => call.method === 'DELETE'), false);
  }
});

test('section validators reject unintended resources, field clears, ambiguous positioning and mismatched responses', async () => {
  const { client, calls } = fixture([]);
  for (const payload of [
    { name: '领域', resource_type: 'my_tasks' }, { name: '领域', resource_type: 'tasklist', resource_id: '../tasks' },
    { name: '领域', resource_type: 'tasklist', resource_id: LIST_1, extra: 'unsupported' },
  ]) await assert.rejects(client.createSection(payload), errorIs('INVALID_INPUT'));
  for (const patch of [{ name: undefined }, { name: '' }, { resource_id: LIST_2 },
    { insert_before: SECTION_2, insert_after: SECTION_2 }, { insert_before: SECTION_1 }]) {
    await assert.rejects(client.updateSection(SECTION_1, patch), errorIs('INVALID_INPUT'));
  }
  assert.equal(calls.length, 0);
  for (const returned of [section(SECTION_2), section(SECTION_1, { is_default: 'false' }), section(SECTION_1, { tasklist: null })]) {
    const invalid = fixture([token(), ok({ section: returned })]);
    await assert.rejects(invalid.client.getSection(SECTION_1), errorIs('INVALID_RESPONSE'));
  }
  const wrongList = fixture([token(), ok({ section: section(SECTION_1, { tasklist: tasklist(LIST_2) }) })]);
  await assert.rejects(wrongList.client.createSection({ name: '领域', resource_type: 'tasklist', resource_id: LIST_1 }), errorIs('INVALID_RESPONSE', true));
});

test('single-select field creation and updates preserve option GUIDs and explicit update masks', async () => {
  const { client, calls } = fixture([token(), ok({ custom_field: customField() }), ok({ custom_field: customField() }), ok({ custom_field: customField() })]);
  const payload = { name: '项目状态', type: 'single_select', resource_type: 'tasklist', resource_id: LIST_1,
    single_select_setting: { options: [{ name: 'active', color_index: 1 }] } };
  assert.deepEqual(await client.createCustomField(payload), customField());
  assert.deepEqual(await client.getCustomField(FIELD_1), customField());
  const patch = { single_select_setting: { options: [{ guid: OPTION_1 }, { name: 'done', color_index: 2 }] } };
  await client.updateCustomField(FIELD_1, patch);
  assert.deepEqual(JSON.parse(calls[1].body), payload);
  assert.equal(new URL(calls[2].url).pathname, `/open-apis/task/v2/custom_fields/${FIELD_1}`);
  assert.deepEqual(JSON.parse(calls[3].body), { custom_field: patch, update_fields: ['single_select_setting'] });
});

test('single-select input rejects type changes, duplicate options, undefined values and unsupported settings', async () => {
  const { client, calls } = fixture([]);
  for (const patch of [{ type: 'text' }, { name: '' }, { single_select_setting: {} }, { single_select_setting: undefined },
    { single_select_setting: { options: [{ guid: OPTION_1 }, { guid: OPTION_1 }] } },
    { single_select_setting: { options: [{ name: 'active' }, { name: 'active' }] } },
    { single_select_setting: { options: [{ guid: OPTION_1, is_hidden: true }] } },
    { single_select_setting: { options: [{ name: 'active', color_index: 55 }] } },
    { single_select_setting: { options: [{ guid: '../tasks' }] } },
    { single_select_setting: { options: Array.from({ length: 101 }, (_, i) => ({ name: String(i) })) } },
  ]) await assert.rejects(client.updateCustomField(FIELD_1, patch), errorIs('INVALID_INPUT'));
  await assert.rejects(client.createCustomField({ name: '状态', type: 'number', resource_type: 'tasklist', resource_id: LIST_1,
    single_select_setting: { options: [] } }), errorIs('INVALID_INPUT'));
  assert.equal(calls.length, 0);
});

test('malformed custom-field responses and pagination fail rather than losing option identity', async () => {
  for (const returned of [customField(FIELD_2), customField(FIELD_1, { type: 'unknown' }),
    customField(FIELD_1, { single_select_setting: {} }),
    customField(FIELD_1, { single_select_setting: { options: [{ name: 'active' }] } }),
  ]) {
    const { client } = fixture([token(), ok({ custom_field: returned })]);
    await assert.rejects(client.updateCustomField(FIELD_1, { name: '新状态' }), errorIs('INVALID_RESPONSE', true));
  }
  for (const method of ['listSections', 'listCustomFields']) {
    const { client } = fixture([token(), page([], { has_more: true, page_token: 'repeat' }), page([], { has_more: true, page_token: 'repeat' })]);
    await assert.rejects(client[method](LIST_1), errorIs('INVALID_PAGINATION'));
  }
});

test('task custom_fields uses option GUID strings and allows explicit clearing only', async () => {
  const { client, calls } = fixture([token(), ok({ task: task() }), ok({ task: task() })]);
  for (const value of [OPTION_1, '']) {
    const patch = { custom_fields: [{ guid: FIELD_1, single_select_value: value }] };
    await client.updateTask(TASK_1, patch);
    assert.deepEqual(JSON.parse(calls.at(-1).body), { task: patch, update_fields: ['custom_fields'] });
  }
  for (const fields of [null, [{ guid: FIELD_1 }], [{ guid: FIELD_1, single_select_value: { option_guid: OPTION_1 } }],
    [{ guid: FIELD_1, single_select_value: OPTION_1 }, { guid: FIELD_1, single_select_value: '' }]]) {
    await assert.rejects(client.updateTask(TASK_1, { custom_fields: fields }), errorIs('INVALID_INPUT'));
  }
  assert.equal(calls.length, 3);
});

test('setting and clearing a parent target the existing task GUID without creating another task', async () => {
  const { client, calls } = fixture([token(), ok({}), ok({}), ok({ task: task(TASK_1, { parent_task_guid: TASK_2 }) })]);
  assert.deepEqual(await client.setTaskParent(TASK_1, TASK_2), {});
  assert.deepEqual(await client.setTaskParent(TASK_1, null), {});
  assert.equal((await client.getTask(TASK_1)).parent_task_guid, TASK_2);
  assert.deepEqual(JSON.parse(calls[1].body), { ancestor_guid: TASK_2 });
  assert.deepEqual(JSON.parse(calls[2].body), {});
  for (const call of calls.slice(1, 3)) {
    assert.equal(new URL(call.url).pathname, `/open-apis/task/v2/tasks/${TASK_1}/set_ancestor_task`);
    assert.equal(call.method, 'POST');
  }
  for (const parent of [TASK_1, '', '../tasks']) await assert.rejects(client.setTaskParent(TASK_1, parent), errorIs('INVALID_INPUT'));
});

test('parent task details reject malformed GUIDs while independent tasks may omit the parent', async () => {
  for (const parent of ['not-a-guid', [TASK_2], {}]) {
    const { client } = fixture([token(), ok({ task: task(TASK_1, { parent_task_guid: parent }) })]);
    await assert.rejects(client.getTask(TASK_1), errorIs('INVALID_RESPONSE'));
  }
  for (const parent of [null, '', undefined]) {
    const { client } = fixture([token(), ok({ task: task(TASK_1, { parent_task_guid: parent }) })]);
    assert.equal((await client.getTask(TASK_1)).guid, TASK_1);
  }
});

test('membership reads are unpaginated; moves preserve GUIDs and confirm section and removal', async () => {
  const initial = [relation(), relation(LIST_2, SECTION_2)];
  const { client, calls } = fixture([token(), ok({ tasklists: initial }),
    ok({ task: task(TASK_1, { tasklists: initial }) }), ok({ task: task(TASK_1, { tasklists: [relation(LIST_2, SECTION_2)] }) })]);
  assert.deepEqual(await client.listTasklistsForTask(TASK_1), initial);
  assert.equal(new URL(calls[1].url).searchParams.has('page_size'), false);
  assert.equal((await client.addTasklist(TASK_1, LIST_2, SECTION_2)).guid, TASK_1);
  assert.deepEqual(JSON.parse(calls[2].body), { tasklist_guid: LIST_2, section_guid: SECTION_2 });
  assert.equal((await client.removeTasklist(TASK_1, LIST_1)).guid, TASK_1);
  assert.deepEqual(JSON.parse(calls[3].body), { tasklist_guid: LIST_1 });
  assert.equal(new URL(calls[3].url).pathname, `/open-apis/task/v2/tasks/${TASK_1}/remove_tasklist`);
});

test('membership mutation rejects mismatched, missing or contradictory relationship responses', async () => {
  for (const returned of [task(TASK_2, { tasklists: [relation()] }), task(),
    task(TASK_1, { tasklists: [] }), task(TASK_1, { tasklists: [relation(LIST_1, SECTION_2)] })]) {
    const { client } = fixture([token(), ok({ task: returned })]);
    await assert.rejects(client.addTasklist(TASK_1, LIST_1, SECTION_1), errorIs('INVALID_RESPONSE', true));
  }
  const retained = fixture([token(), ok({ task: task(TASK_1, { tasklists: [relation()] }) })]);
  await assert.rejects(retained.client.removeTasklist(TASK_1, LIST_1), errorIs('INVALID_RESPONSE', true));
  for (const data of [{}, { tasklists: [relation(), relation()] }, { tasklists: [{ tasklist_guid: LIST_1 }] }]) {
    const { client } = fixture([token(), ok(data)]);
    await assert.rejects(client.listTasklistsForTask(TASK_1), errorIs('INVALID_RESPONSE'));
  }
});

test('hierarchy writes never automatically retry an unknown result and redact transport errors', async () => {
  const operations = [
    c => c.createSection({ name: '领域', resource_type: 'tasklist', resource_id: LIST_1 }),
    c => c.updateSection(SECTION_1, { name: '领域' }),
    c => c.createCustomField({ name: '状态', type: 'single_select', resource_type: 'tasklist', resource_id: LIST_1, single_select_setting: { options: [] } }),
    c => c.updateCustomField(FIELD_1, { name: '状态' }),
    c => c.setTaskParent(TASK_1, TASK_2), c => c.addTasklist(TASK_1, LIST_1, SECTION_1), c => c.removeTasklist(TASK_1, LIST_1),
  ];
  for (const operation of operations) {
    const { client, calls } = fixture([token(), new Error('PRIVATE_SECRET PRIVATE_TOKEN SENSITIVE_REMOTE_RESPONSE')]);
    await assert.rejects(operation(client), errorIs('NETWORK_ERROR', true));
    assert.equal(calls.length, 2);
  }
  const missing = fixture([token(), { code: 0 }]);
  await assert.rejects(missing.client.setTaskParent(TASK_1, TASK_2), errorIs('INVALID_RESPONSE', true));
});

test('undocumented archive mutation is rejected; optional archive metadata remains readable', async () => {
  const { client, calls } = fixture([token(), ok({ tasklist: { ...tasklist(), is_archived: true } })]);
  assert.equal((await client.getTasklist(LIST_1)).is_archived, true);
  await assert.rejects(client.updateTasklist(LIST_1, { is_archived: true }), errorIs('INVALID_INPUT'));
  assert.equal(typeof client.archiveTasklist, 'undefined');
  assert.equal(calls.length, 2);
  const malformed = fixture([token(), ok({ tasklist: { ...tasklist(), is_archived: 'false' } })]);
  await assert.rejects(malformed.client.getTasklist(LIST_1), errorIs('INVALID_RESPONSE'));
});
