'use strict';

// Task v2 only. The injected transport is Obsidian requestUrl, not browser fetch.
// Credentials and tokens never leave this closure except in the official API request.
const API_BASE = 'https://open.feishu.cn/open-apis';
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 2;
const MAX_PAGES = 1000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_ERRORS = new Set([99991663, 99991665]);

class FeishuError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FeishuError';
    this.code = code;
    this.apiCode = Number.isSafeInteger(details.apiCode) ? details.apiCode : null;
    this.status = Number.isInteger(details.status) ? details.status : null;
    this.uncertain = Boolean(details.uncertain);
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validTime = value => typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value);

function requireGuid(value) {
  if (typeof value !== 'string' || !GUID.test(value)) {
    throw new FeishuError('INVALID_INPUT', '飞书任务或清单 GUID 格式无效，请完整复制 GUID。');
  }
  return value;
}

function textField(value, label, maximum, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || [...value].length > maximum) {
    throw new FeishuError('INVALID_INPUT', `${label}须为文字，${allowEmpty ? '' : '不能为空，'}且不能超过 ${maximum} 个字符。`);
  }
}

function taskUrl(guid) {
  return `https://applink.feishu.cn/client/todo/detail?guid=${requireGuid(guid)}`;
}

function tasklistUrl(guid) {
  return `https://applink.feishu.cn/client/todo/task_list?guid=${requireGuid(guid)}`;
}

function invalidResponse(write = false, status) {
  return new FeishuError('INVALID_RESPONSE', '飞书响应不完整或格式异常，请核实远端状态后再操作。', { uncertain: write, status });
}

function validateTask(task, write = false, expectedGuid) {
  if (!isObject(task) || typeof task.guid !== 'string' || !GUID.test(task.guid)
    || typeof task.summary !== 'string' || !task.summary.trim() || !validTime(task.completed_at)
    || (task.mode !== undefined && task.mode !== 1 && task.mode !== 2)
    || (task.parent_task_guid != null && task.parent_task_guid !== ''
      && (typeof task.parent_task_guid !== 'string' || !GUID.test(task.parent_task_guid)))
    || (expectedGuid && task.guid.toLowerCase() !== expectedGuid.toLowerCase())) {
    throw invalidResponse(write);
  }
  if (task.tasklists !== undefined) validateTasklistRelations(task.tasklists, write);
  return task;
}

function validateTasklist(tasklist, write = false, expectedGuid) {
  if (!isObject(tasklist) || typeof tasklist.guid !== 'string' || !GUID.test(tasklist.guid)
    || typeof tasklist.name !== 'string' || !tasklist.name.trim()
    || (tasklist.is_archived !== undefined && typeof tasklist.is_archived !== 'boolean')
    || (expectedGuid && tasklist.guid.toLowerCase() !== expectedGuid.toLowerCase())) {
    throw invalidResponse(write);
  }
  return tasklist;
}

function validateTasklistRelations(items, write = false) {
  if (!Array.isArray(items)) throw invalidResponse(write);
  const seen = new Set();
  for (const item of items) {
    if (!isObject(item) || typeof item.tasklist_guid !== 'string' || !GUID.test(item.tasklist_guid)
      || typeof item.section_guid !== 'string' || !GUID.test(item.section_guid)
      || seen.has(item.tasklist_guid.toLowerCase())) throw invalidResponse(write);
    seen.add(item.tasklist_guid.toLowerCase());
  }
  return items;
}

function inputFields(value, allowed) {
  if (!isObject(value) || !Object.keys(value).length
    || Object.keys(value).some(key => !allowed.includes(key) || value[key] === undefined || value[key] === null)) {
    throw new FeishuError('INVALID_INPUT', '飞书请求包含缺失或不支持的字段。');
  }
}

function validateSection(section, write = false, expectedGuid, resourceGuid, detail = false) {
  if (!isObject(section) || typeof section.guid !== 'string' || !GUID.test(section.guid)
    || typeof section.name !== 'string' || (!section.name.trim() && section.is_default !== true)
    || typeof section.is_default !== 'boolean'
    || (expectedGuid && section.guid.toLowerCase() !== expectedGuid.toLowerCase())
    || (detail && (section.resource_type !== 'tasklist' || !isObject(section.tasklist)
      || typeof section.tasklist.guid !== 'string' || !GUID.test(section.tasklist.guid)))
    || (resourceGuid && section.tasklist?.guid?.toLowerCase() !== resourceGuid.toLowerCase())) throw invalidResponse(write);
  return section;
}

function sectionInput(value, creating) {
  inputFields(value, creating ? ['name', 'resource_type', 'resource_id', 'insert_before', 'insert_after']
    : ['name', 'insert_before', 'insert_after']);
  if (creating || 'name' in value) textField(value.name, '分组名称', 100);
  if (creating) {
    if (value.resource_type !== 'tasklist') throw new FeishuError('INVALID_INPUT', '分组仅支持本仓库的任务清单。');
    requireGuid(value.resource_id);
  }
  if ('insert_before' in value && 'insert_after' in value) throw new FeishuError('INVALID_INPUT', '不能同时指定分组前后位置。');
  for (const key of ['insert_before', 'insert_after']) if (key in value) requireGuid(value[key]);
}

const FIELD_TYPES = new Set(['number', 'member', 'datetime', 'single_select', 'multi_select', 'text']);

function validateCustomField(field, write = false, expectedGuid) {
  if (!isObject(field) || typeof field.guid !== 'string' || !GUID.test(field.guid)
    || typeof field.name !== 'string' || !field.name.trim() || !FIELD_TYPES.has(field.type)
    || (expectedGuid && field.guid.toLowerCase() !== expectedGuid.toLowerCase())) throw invalidResponse(write);
  if (field.type === 'single_select' || field.type === 'multi_select') {
    const options = field[field.type + '_setting']?.options;
    if (!Array.isArray(options) || options.length > 100) throw invalidResponse(write);
    const seen = new Set();
    for (const option of options) {
      if (!isObject(option) || typeof option.guid !== 'string' || !GUID.test(option.guid)
        || typeof option.name !== 'string' || !option.name.trim() || typeof option.is_hidden !== 'boolean'
        || !Number.isInteger(option.color_index) || option.color_index < 0 || option.color_index > 54
        || seen.has(option.guid.toLowerCase())) throw invalidResponse(write);
      seen.add(option.guid.toLowerCase());
    }
  }
  return field;
}

function customFieldInput(value, creating) {
  inputFields(value, creating ? ['name', 'type', 'resource_type', 'resource_id', 'single_select_setting']
    : ['name', 'single_select_setting']);
  if (creating || 'name' in value) textField(value.name, '自定义字段名称', 50);
  if (creating) {
    if (value.type !== 'single_select' || value.resource_type !== 'tasklist') {
      throw new FeishuError('INVALID_INPUT', '本次同步仅支持任务清单的单选自定义字段。');
    }
    requireGuid(value.resource_id);
  }
  if (creating || 'single_select_setting' in value) {
    const setting = value.single_select_setting;
    inputFields(setting, ['options']);
    if (!Array.isArray(setting.options) || setting.options.length > 100) {
      throw new FeishuError('INVALID_INPUT', '单选字段选项须为最多 100 项的列表。');
    }
    const ids = new Set(), names = new Set();
    for (const option of setting.options) {
      inputFields(option, creating ? ['name', 'color_index', 'is_hidden'] : ['guid', 'name', 'color_index']);
      if (creating || !('guid' in option) || 'name' in option) textField(option.name, '选项名称', 50);
      if ('guid' in option) {
        requireGuid(option.guid);
        if (ids.has(option.guid.toLowerCase())) throw new FeishuError('INVALID_INPUT', '单选字段选项 GUID 重复。');
        ids.add(option.guid.toLowerCase());
      }
      if ('color_index' in option && (!Number.isInteger(option.color_index) || option.color_index < 0 || option.color_index > 54)) {
        throw new FeishuError('INVALID_INPUT', '选项颜色须为 0 至 54 的整数。');
      }
      if ('is_hidden' in option && typeof option.is_hidden !== 'boolean') throw new FeishuError('INVALID_INPUT', '选项隐藏设置须为布尔值。');
      if (option.name !== undefined && !option.is_hidden) {
        if (names.has(option.name)) throw new FeishuError('INVALID_INPUT', '可见单选选项不能重名。');
        names.add(option.name);
      }
    }
  }
}

function validateTaskInput(payload, creating) {
  if (!isObject(payload) || !Object.keys(payload).length || Object.values(payload).some(v => v === undefined)) {
    throw new FeishuError('INVALID_INPUT', '缺少有效的飞书任务内容。');
  }
  if (creating || 'summary' in payload) textField(payload.summary, '任务标题', 3000);
  if ('description' in payload) textField(payload.description, '任务说明', 3000, true);
  if ('completed_at' in payload && !validTime(payload.completed_at)) {
    throw new FeishuError('INVALID_INPUT', '完成时间须为毫秒时间戳字符串，重开任务请使用 "0"。');
  }
  if ('mode' in payload && payload.mode !== 1 && payload.mode !== 2) {
    throw new FeishuError('INVALID_INPUT', '任务完成模式无效。');
  }
  for (const key of ['start', 'due']) {
    if (!(key in payload)) continue;
    const value = payload[key];
    if (!isObject(value) || !validTime(value.timestamp) || typeof value.is_all_day !== 'boolean'
      || Object.keys(value).some(field => !['timestamp', 'is_all_day'].includes(field))) {
      throw new FeishuError('INVALID_INPUT', '开始或截止时间须包含毫秒时间戳字符串和全天设置。');
    }
  }
  if (payload.start && payload.due && payload.start.timestamp !== '0' && payload.due.timestamp !== '0'
    && (BigInt(payload.start.timestamp) > BigInt(payload.due.timestamp) || payload.start.is_all_day !== payload.due.is_all_day)) {
    throw new FeishuError('INVALID_INPUT', '开始时间不能晚于截止时间，且两者全天设置必须一致。');
  }
  if ('client_token' in payload && (typeof payload.client_token !== 'string'
    || payload.client_token.length < 10 || payload.client_token.length > 100)) {
    throw new FeishuError('INVALID_INPUT', '任务幂等标识须为 10 至 100 个字符。');
  }
  if ('custom_fields' in payload) {
    if (!Array.isArray(payload.custom_fields)) throw new FeishuError('INVALID_INPUT', '任务自定义字段须为列表。');
    const seen = new Set();
    for (const field of payload.custom_fields) {
      inputFields(field, ['guid', 'single_select_value']);
      requireGuid(field.guid);
      if (typeof field.single_select_value !== 'string') throw new FeishuError('INVALID_INPUT', '单选字段值须为选项 GUID 字符串。');
      if (field.single_select_value !== '') requireGuid(field.single_select_value);
      if (seen.has(field.guid.toLowerCase())) throw new FeishuError('INVALID_INPUT', '任务自定义字段重复。');
      seen.add(field.guid.toLowerCase());
    }
  }
  if (!creating && ['members', 'reminders', 'tasklists', 'client_token'].some(key => key in payload)) {
    throw new FeishuError('INVALID_INPUT', '任务成员、提醒和所属清单不能通过此更新接口修改。');
  }
}

function encodeBody(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    throw new FeishuError('INVALID_INPUT', '飞书请求内容无法转换为 JSON。');
  }
}

function createFeishuClient({ request, appId, appSecret, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (typeof request !== 'function' || typeof now !== 'function' || typeof sleep !== 'function') {
    throw new FeishuError('INVALID_CONFIG', '缺少有效的 Obsidian 请求配置。');
  }
  textField(appId, 'App ID', 200);
  textField(appSecret, 'App Secret', 1000);
  let cachedToken;
  let tokenPromise;

  async function transport(path, { method = 'GET', body, token, write = false } = {}) {
    // path is assembled only by this module; user input is never used as a host/path.
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    let response;
    let timer;
    const timeoutError = new FeishuError('TIMEOUT', '连接飞书超时，请核实远端状态。', { uncertain: write });
    try {
      response = await Promise.race([
        Promise.resolve().then(() => request({ url: API_BASE + path, method, headers,
          throw: false, ...(body === undefined ? {} : { body, contentType: headers['Content-Type'] }),
        })),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(timeoutError), REQUEST_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      if (error === timeoutError) throw error;
      throw new FeishuError('NETWORK_ERROR', '连接飞书失败，请检查网络并核实远端状态。', { uncertain: write });
    } finally {
      clearTimeout(timer);
    }
    if (!response || !Number.isInteger(response.status)) throw invalidResponse(write);
    const status = response.status;
    let json;
    try {
      json = response.json;
      if (json == null && typeof response.text === 'string') json = JSON.parse(response.text);
    } catch (_) { /* Never expose transport data or the API's msg/error fields. */ }
    const apiCode = isObject(json) && Number.isSafeInteger(json.code) ? json.code : null;
    const details = { status, apiCode };
    if (status >= 500 || apiCode === 1470500) {
      throw new FeishuError('SERVICE_ERROR', '飞书服务暂时异常，请稍后核实状态。', { ...details, uncertain: write });
    }
    if (status === 429 || apiCode === 99991400) {
      const error = new FeishuError('RATE_LIMITED', '飞书调用过于频繁，请稍后重试。', details);
      // Retry-After is interpreted only as bounded numeric seconds, never as a URL.
      const retryHeader = response.headers && Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'retry-after');
      const retrySeconds = retryHeader && /^\d+(\.\d+)?$/.test(String(retryHeader[1])) ? Number(retryHeader[1]) : NaN;
      if (Number.isFinite(retrySeconds)) error.retryAfterMs = Math.min(10000, retrySeconds * 1000);
      throw error;
    }
    if (status === 403 || apiCode === 1470403 || apiCode === 99991672 || apiCode === 99991679) {
      throw new FeishuError('PERMISSION_DENIED', '飞书权限不足，请检查应用权限及清单、任务成员权限。', details);
    }
    if (status === 404 || apiCode === 1470404) {
      throw new FeishuError('NOT_FOUND', '飞书任务或清单不存在、已删除或不可访问，请在飞书中核实；不会将其视为完成。', details);
    }
    if (status === 401 || TOKEN_ERRORS.has(apiCode)) {
      throw new FeishuError('AUTH_ERROR', '飞书调用凭据无效，请检查应用配置或重新检查连接。', details);
    }
    if (apiCode === 1470422) {
      throw new FeishuError('API_ERROR', '同一飞书任务正在创建，请稍后查询关联结果。', { ...details, uncertain: write });
    }
    if (status < 200 || status >= 300) {
      throw new FeishuError('HTTP_ERROR', '飞书返回 HTTP 异常，请核实远端状态。', {
        ...details, uncertain: write && (status === 408 || status < 400),
      });
    }
    if (apiCode === null) throw invalidResponse(write, status);
    if (apiCode !== 0) {
      const message = apiCode === 99991401 ? '当前 IP 不在飞书应用白名单中，请检查开放平台设置。'
          : apiCode === 99991403 ? '飞书本月 API 调用量已达上限。'
            : '飞书接口拒绝了请求，请检查应用配置、任务内容及接口权限。';
      throw new FeishuError('API_ERROR', message, details);
    }
    return json;
  }

  async function send(path, options) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await transport(path, options);
      } catch (error) {
        const retryable = error.code === 'RATE_LIMITED' || (!options.write
          && ['NETWORK_ERROR', 'TIMEOUT', 'SERVICE_ERROR'].includes(error.code));
        if (!retryable || attempt >= MAX_RETRIES) throw error;
        await sleep(error.retryAfterMs ?? 500 * (2 ** attempt));
      }
    }
  }

  async function accessToken() {
    if (cachedToken && cachedToken.expiresAt > Number(now())) return cachedToken.value;
    if (!tokenPromise) {
      tokenPromise = (async () => {
        const json = await send('/auth/v3/tenant_access_token/internal', {
          method: 'POST', body: encodeBody({ app_id: appId, app_secret: appSecret }), write: false,
        });
        if (typeof json.tenant_access_token !== 'string' || !json.tenant_access_token
          || /\s/.test(json.tenant_access_token) || !Number.isFinite(json.expire) || json.expire <= 0) {
          throw invalidResponse();
        }
        const lifetime = json.expire * 1000;
        cachedToken = { value: json.tenant_access_token,
          expiresAt: Number(now()) + lifetime - Math.min(60000, lifetime / 10) };
        return cachedToken.value;
      })().finally(() => { tokenPromise = undefined; });
    }
    return tokenPromise;
  }

  async function api(path, { method = 'GET', payload, query = {} } = {}) {
    const params = new URLSearchParams({ user_id_type: 'open_id', ...query });
    const endpoint = `/task/v2/${path}?${params}`;
    const options = { method, write: method !== 'GET',
      ...(payload === undefined ? {} : { body: encodeBody(payload) }) };
    let token = await accessToken();
    let json;
    try {
      json = await send(endpoint, { ...options, token });
    } catch (error) {
      // Only an explicit token rejection proves a write was not accepted.
      if (!TOKEN_ERRORS.has(error.apiCode) || error.uncertain) throw error;
      if (cachedToken && cachedToken.value === token) cachedToken = undefined;
      token = await accessToken();
      json = await send(endpoint, { ...options, token });
    }
    if (!isObject(json.data)) throw invalidResponse(options.write);
    return json.data;
  }

  async function allPages(path, validateItem, query = {}) {
    const result = [];
    const tokens = new Set();
    const ids = new Set();
    let pageToken;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await api(path, { query: { ...query, page_size: '100', ...(pageToken ? { page_token: pageToken } : {}) } });
      if (!Array.isArray(data.items) || typeof data.has_more !== 'boolean') throw invalidResponse();
      for (const item of data.items) {
        const valid = validateItem(item);
        const key = valid.guid.toLowerCase();
        if (ids.has(key)) throw new FeishuError('INVALID_PAGINATION', '飞书分页中出现重复记录，请重新同步以取得完整结果。');
        ids.add(key);
        result.push(valid);
      }
      if (!data.has_more) return result;
      if (typeof data.page_token !== 'string' || !data.page_token || data.page_token.length > 1000
        || tokens.has(data.page_token)) {
        throw new FeishuError('INVALID_PAGINATION', '飞书分页标记无效，请重新同步以取得完整结果。');
      }
      tokens.add(data.page_token);
      pageToken = data.page_token;
    }
    throw new FeishuError('PAGINATION_LIMIT', '飞书分页数量超过本次安全上限，请缩小清单范围后再同步。');
  }

  async function listTasklists() {
    return allPages('tasklists', item => validateTasklist(item));
  }

  async function getTask(guid) {
    requireGuid(guid);
    return validateTask((await api(`tasks/${guid}`)).task, false, guid);
  }

  return {
    async check() {
      const tasklists = await listTasklists();
      return { ok: true, tasklistCount: tasklists.length, tasklists, writePermission: 'unverified',
        message: '凭据和清单查询可用；尚未验证任务读取、写入及清单创建权限。' };
    },
    listTasklists,
    async getTasklist(guid) {
      requireGuid(guid);
      return validateTasklist((await api(`tasklists/${guid}`)).tasklist, false, guid);
    },
    async createTasklist({ name, members } = {}) {
      textField(name, '清单名称', 100);
      if (members !== undefined && !Array.isArray(members)) throw new FeishuError('INVALID_INPUT', '清单成员须为列表。');
      const data = await api('tasklists', { method: 'POST', payload: { name, ...(members === undefined ? {} : { members }) } });
      return validateTasklist(data.tasklist, true);
    },
    async updateTasklist(guid, patch) {
      requireGuid(guid);
      // This integration follows project names only. Never let a rename request
      // transfer ownership, change members, or clear an omitted field.
      if (!isObject(patch) || Object.keys(patch).length !== 1 || !Object.hasOwn(patch, 'name')) {
        throw new FeishuError('INVALID_INPUT', '清单更新仅支持明确填写 name，不能更改其他字段。');
      }
      textField(patch.name, '清单名称', 100);
      const data = await api(`tasklists/${guid}`, { method: 'PATCH',
        payload: { tasklist: { name: patch.name }, update_fields: ['name'] } });
      return validateTasklist(data.tasklist, true, guid);
    },
    async listSections(tasklistGuid) {
      requireGuid(tasklistGuid);
      return allPages('sections', item => validateSection(item), { resource_type: 'tasklist', resource_id: tasklistGuid });
    },
    async getSection(guid) {
      requireGuid(guid);
      return validateSection((await api(`sections/${guid}`)).section, false, guid, undefined, true);
    },
    async createSection(payload) {
      sectionInput(payload, true);
      const data = await api('sections', { method: 'POST', payload });
      return validateSection(data.section, true, undefined, payload.resource_id, true);
    },
    async updateSection(guid, patch) {
      requireGuid(guid);
      sectionInput(patch, false);
      if ([patch.insert_before, patch.insert_after].some(id => id?.toLowerCase() === guid.toLowerCase())) {
        throw new FeishuError('INVALID_INPUT', '分组不能相对自身调整位置。');
      }
      const data = await api(`sections/${guid}`, { method: 'PATCH', payload: { section: patch, update_fields: Object.keys(patch) } });
      return validateSection(data.section, true, guid, undefined, true);
    },
    async listCustomFields(tasklistGuid) {
      requireGuid(tasklistGuid);
      return allPages('custom_fields', item => validateCustomField(item), { resource_type: 'tasklist', resource_id: tasklistGuid });
    },
    async getCustomField(guid) {
      requireGuid(guid);
      return validateCustomField((await api(`custom_fields/${guid}`)).custom_field, false, guid);
    },
    async createCustomField(payload) {
      customFieldInput(payload, true);
      const data = await api('custom_fields', { method: 'POST', payload });
      const field = validateCustomField(data.custom_field, true);
      if (field.type !== payload.type) throw invalidResponse(true);
      return field;
    },
    async updateCustomField(guid, patch) {
      requireGuid(guid);
      customFieldInput(patch, false);
      // The supplied options are the complete visible set: omitted existing
      // options become hidden. Callers must preserve the options they still use.
      const data = await api(`custom_fields/${guid}`, { method: 'PATCH',
        payload: { custom_field: patch, update_fields: Object.keys(patch) } });
      const field = validateCustomField(data.custom_field, true, guid);
      if (patch.single_select_setting && field.type !== 'single_select') throw invalidResponse(true);
      return field;
    },
    async setTaskParent(guid, parentGuid = null) {
      requireGuid(guid);
      if (parentGuid !== null) {
        requireGuid(parentGuid);
        if (parentGuid.toLowerCase() === guid.toLowerCase()) throw new FeishuError('INVALID_INPUT', '任务不能成为自己的父任务。');
      }
      // The official endpoint returns data:{}; read getTask afterwards to verify
      // parent_task_guid, especially after a timeout or other uncertain outcome.
      return api(`tasks/${guid}/set_ancestor_task`, { method: 'POST',
        payload: parentGuid === null ? {} : { ancestor_guid: parentGuid } });
    },
    async listTasklistsForTask(guid) {
      requireGuid(guid);
      // This endpoint is not paginated. It returns only lists visible to the caller.
      return validateTasklistRelations((await api(`tasks/${guid}/tasklists`)).tasklists);
    },
    async addTasklist(guid, tasklistGuid, sectionGuid) {
      requireGuid(guid); requireGuid(tasklistGuid);
      if (sectionGuid !== undefined) requireGuid(sectionGuid);
      const data = await api(`tasks/${guid}/add_tasklist`, { method: 'POST', payload: {
        tasklist_guid: tasklistGuid, ...(sectionGuid === undefined ? {} : { section_guid: sectionGuid }),
      } });
      const task = validateTask(data.task, true, guid);
      const relation = validateTasklistRelations(task.tasklists, true).find(item => item.tasklist_guid.toLowerCase() === tasklistGuid.toLowerCase());
      if (!relation || (sectionGuid && relation.section_guid.toLowerCase() !== sectionGuid.toLowerCase())) throw invalidResponse(true);
      return task;
    },
    async removeTasklist(guid, tasklistGuid) {
      requireGuid(guid); requireGuid(tasklistGuid);
      const data = await api(`tasks/${guid}/remove_tasklist`, { method: 'POST', payload: { tasklist_guid: tasklistGuid } });
      const task = validateTask(data.task, true, guid);
      if (validateTasklistRelations(task.tasklists, true).some(item => item.tasklist_guid.toLowerCase() === tasklistGuid.toLowerCase())) throw invalidResponse(true);
      return task;
    },
    async listTasks(tasklistGuid) {
      requireGuid(tasklistGuid);
      const summaries = await allPages(`tasklists/${tasklistGuid}/tasks`, item => {
        if (!isObject(item) || typeof item.guid !== 'string' || !GUID.test(item.guid)) throw invalidResponse();
        return item;
      });
      // Listing returns summaries without extra. Fetch every detail to recover stable IDs
      // and never infer completion from a missing task or a partial page.
      const tasks = [];
      for (const summary of summaries) tasks.push(await getTask(summary.guid));
      return tasks;
    },
    async createTask(payload) {
      validateTaskInput(payload, true);
      return validateTask((await api('tasks', { method: 'POST', payload })).task, true);
    },
    getTask,
    async updateTask(guid, patch) {
      requireGuid(guid);
      validateTaskInput(patch, false);
      const data = await api(`tasks/${guid}`, { method: 'PATCH', payload: { task: patch, update_fields: Object.keys(patch) } });
      return validateTask(data.task, true, guid);
    },
  };
}

module.exports = { createFeishuClient, FeishuError, taskUrl, tasklistUrl };
