import React, { createContext, useContext, useState, useRef, useEffect, useCallback, useMemo } from 'react';
import * as Obsidian from 'obsidian';
import { Settings, SettingInput, SettingSwitch, SettingDescription, SettingTextarea } from './controls';
import { label as scopeLabel } from '../../lib/feishu-scope.cjs';

const Runtime = createContext(null);
const SECTIONS = ['overview', 'notes', 'connection', 'transfer', 'help'];
function useRuntime() {
  const runtime = useContext(Runtime);
  if (!runtime) throw new Error('飞书插件上下文未加载。');
  return runtime;
}
function useObsidianApp() { return useRuntime().plugin.app; }
function useDataStorage() { return useRuntime().storage; }

function FeishuHelp() {
  return <ol className="feishu-sync--help">
    <li>在 <a href="https://open.feishu.cn/app" target="_blank" rel="noopener noreferrer">飞书开发者后台</a>创建企业自建应用，将 App ID、App Secret 和自己的 Open ID 填入连接设置。</li>
    <li>为应用开通 <code>task:task:write</code>、<code>task:tasklist:write</code>、<code>task:section:write</code>、<code>task:custom_field:write</code> 权限，发布应用版本。Open ID 可在 <a href="https://open.feishu.cn/api-explorer" target="_blank" rel="noopener noreferrer">API 调试台</a>选择当前应用后复制。</li>
    <li>默认同步项目目录中带 <code>project</code> 标签的笔记。在概览建立仓库清单后，按 Area、项目父任务、行动子任务显示；旧版本在同一入口升级层级。</li>
    <li>在连接设置添加额外文件夹或笔记标签，即可同步会议、学习和其他笔记中的 checkbox。匹配任一规则即可纳入；排除文件夹优先。额外行动直接进入仓库清单，日记通过独立开关和清单启用。</li>
    <li>开启自动同步后，编辑笔记会触发同步，插件也会定时检查飞书。本地维护标题和说明，行动完成与重开双向同步。项目使用 <code>todo</code>、<code>doing</code>、<code>done</code>、<code>canceled</code> 四种状态，父任务与子任务独立完成。</li>
    <li>切换设备时，关闭当前设备自动同步并导出接入包；新设备导入后填写 App Secret、检查关联，再启用自动同步。日常在一台设备运行同步。</li>
  </ol>;
}

function feishuConfigValues(config, app) {
  const base = app.vault.adapter.getBasePath?.() || "";
  return {
    appId: config.appId || "", assigneeId: config.assigneeId || "", defaultTasklistGuid: config.defaultTasklistGuid || "", vaultId: config.vaultId || "",
    vaultLabel: config.vaultLabel || app.vault.getName?.() || base.split(/[\\/]/).filter(Boolean).pop() || "本仓库",
    vaultTasklistName: config.vaultTasklistName || config.vaultLabel || app.vault.getName?.() || "本仓库",
    areaNames: config.areaNames || {}, projectNames: config.projectNames || {},
    projectFolder: config.projectFolder ?? "50_Tasks", dailyFolder: config.dailyFolder ?? "20_Review/Daily",
    taskFolders: (config.taskFolders || []).join("\n"), taskTags: (config.taskTags || []).join(", "),
    excludedFolders: (config.excludedFolders || []).join("\n"),
    syncDaily: config.syncDaily ?? false, autoEnabled: config.autoEnabled ?? false,
    pollMinutes: String(config.pollMinutes ?? 2)
  };
}

function readFeishuHierarchy(service) {
  return typeof service.getHierarchyStatus === "function" ? service.getHierarchyStatus() : null;
}

function FeishuTransfer({ service, saved, disabled, onBusy }) {
  const [bundle, setBundle] = useState(null);
  const [folders, setFolders] = useState({ projectFolder: "", dailyFolder: "" });
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const operate = async (action, operation) => {
    if (disabled || busyRef.current) return;
    busyRef.current = true; setBusy(action); setError(""); setMessage("");
    if (onBusy) onBusy(true);
    try { await operation(); }
    catch (failure) { if (alive.current) setError(failure.message || "接入操作失败。"); }
    finally { busyRef.current = false; if (alive.current) { setBusy(""); if (onBusy) onBusy(false); } }
  };
  const exportFile = () => operate("export", async () => {
    const value = service.exportTransfer();
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = "feishu-sync-" + value.config.vaultLabel + "-transfer.json";
    document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (alive.current) setMessage("接入包已导出，包含仓库身份与关联记录，不含 App Secret。切换设备前请使用最新接入包。");
  });
  const readFile = event => {
    const file = event.target.files?.[0];
    setBundle(null); setPreview(null);
    if (!file) return;
    operate("read", async () => {
      if (file.size > 20 * 1024 * 1024) throw new Error("接入包超过 20 MB，请检查文件。");
      let value;
      try { value = JSON.parse(await file.text()); } catch (_) { throw new Error("请选择有效的 JSON 接入包。"); }
      if (alive.current) {
        setBundle(value);
        setFolders({ projectFolder: saved.appId ? saved.projectFolder : value.config?.projectFolder || "",
          dailyFolder: saved.appId ? saved.dailyFolder : value.config?.dailyFolder || "" });
      }
    });
  };
  return <div className="feishu-sync--transfer">
    <h3 className="feishu-sync--subtitle">同一仓库跨设备接入</h3>
    <p className="feishu-sync--hint">先关闭自动同步并保存。导入会保留原飞书 GUID，不创建远端资源；覆盖前备份本机配置与记录。文件夹改名时按笔记标识重新定位。两台设备轮流启用同步。</p>
    <fieldset className="feishu-sync--fieldset" disabled={disabled || !!busy || saved.autoEnabled}>
      <div className="feishu-sync--actions">
        <button className="feishu-sync--button" type="button" disabled={!saved.vaultId} onClick={exportFile}>{busy === "export" ? "正在导出…" : "导出接入包（不含密钥）"}</button>
        <button className="feishu-sync--button" type="button" disabled={!saved.hasSecret} onClick={() => operate("check", async () => {
          const result = await service.checkAssociations();
          if (alive.current) {
            setMessage("已检查 " + result.checked + " 个原关联，失败 " + result.failed + " 个。");
            if (result.failed) setError(result.results.filter(r => !r.ok).map(r => r.name + "：" + r.message).join("\n"));
          }
        })}>{busy === "check" ? "正在核对…" : "检查原关联"}</button>
      </div>
      <Settings>
        <SettingInput label="选择原设备导出的接入包" type="file" accept=".json,application/json" onChange={readFile} />
        {bundle && <SettingInput label="本机项目目录" type="text" value={folders.projectFolder} onChange={event => { setFolders({ ...folders, projectFolder: event.target.value }); setPreview(null); }} />}
        {bundle && <SettingInput label="本机日记目录" type="text" value={folders.dailyFolder} onChange={event => { setFolders({ ...folders, dailyFolder: event.target.value }); setPreview(null); }} />}
      </Settings>
      {bundle && <button className="feishu-sync--button" type="button" onClick={() => operate("preview", async () => {
        setPreview(null);
        const result = await service.previewTransfer(bundle, folders);
        if (alive.current) setPreview(result);
      })}>{busy === "preview" ? "正在预览…" : "预览接入包"}</button>}
      {preview && <div className="feishu-sync--transferPreview" role="status">
        <p>仓库：{preview.vaultLabel} · 飞书清单：{preview.vaultTasklistName}</p>
        <p>仓库标识：<code>{preview.vaultId}</code></p>
        <p>项目 {preview.projects} 个，行动 {preview.tasks} 条；重新定位 {preview.remapped} 个关联。</p>
        <p>项目目录：{preview.projectFolder} · 日记目录：{preview.dailyFolder}</p>
        {preview.vaultListGuid && <p>原清单 GUID：<code>{preview.vaultListGuid}</code></p>}
        {(preview.warnings || []).map(warning => <p className="feishu-sync--notice" key={warning}>{warning}</p>)}
        {preview.conflicts > 0 && <p className="feishu-sync--notice">{preview.conflicts} 个已有记录内容不同，确认后采用接入包版本。本机独有记录会保留。</p>}
        {preview.missing > 0 && <p className="feishu-sync--notice">{preview.missing} 个关联未在目标目录找到笔记标识。请核对目录与笔记是否已同步；记录将保留。</p>}
        <button className="feishu-sync--button feishu-sync--primary" type="button" onClick={() => operate("import", async () => {
          const result = await service.importTransfer(preview.token);
          if (alive.current) { setPreview(null); setBundle(null); setMessage("接入已保存，自动同步保持关闭。本机备份：" + result.backupPath + "。请填写本机 App Secret，检查连接与原关联后再同步。"); }
        })}>{busy === "import" ? "正在导入…" : "确认导入并保留原关联"}</button>
      </div>}
    </fieldset>
    {saved.autoEnabled && <p className="feishu-sync--notice">关闭自动同步并保存后可导入、导出和检查关联。</p>}
    {message && <p className="feishu-sync--message" role="status">{message}</p>}
    {error && <p className="feishu-sync--error" role="alert">{error}</p>}
  </div>;
}

function useFeishuConfig(service, disabled, onState, onBusy) {
  const app = useObsidianApp();
  const [saved, setSaved] = useState(() => service?.getConfig() || {});
  const [hierarchy, setHierarchy] = useState(() => service ? readFeishuHierarchy(service) : null);
  const [form, setForm] = useState(() => feishuConfigValues(saved, app));
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [transferBusy, setTransferBusy] = useState(false);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const dirtyRef = useRef(false);
  const savedValues = feishuConfigValues(saved, app);
  const hierarchyReady = !!saved.hierarchyEnabled && hierarchy?.migration?.state === "ready";
  const dirty = Object.keys(savedValues).some(key => JSON.stringify(form[key]) !== JSON.stringify(savedValues[key])) || !!secret;
  dirtyRef.current = dirty;
  const change = (key, value) => setForm(current => ({ ...current, [key]: value }));
  useEffect(() => { if (service && onState) onState({ saved, dirty }); }, [service, saved, dirty, onState]);
  useEffect(() => {
    alive.current = true;
    if (!service) return;
    const initial = service.getConfig();
    setSaved(initial); setHierarchy(readFeishuHierarchy(service));
    if (!dirtyRef.current) setForm(feishuConfigValues(initial, app));
    const ref = app.workspace.on("feishu-sync:change", () => {
      if (!alive.current) return;
      try {
        const next = service.getConfig();
        setSaved(next);
        setHierarchy(readFeishuHierarchy(service));
        if (!dirtyRef.current) setForm(feishuConfigValues(next, app));
      } catch (failure) { setError(failure.message || "读取本机配置失败。"); }
    });
    return () => { alive.current = false; app.workspace.offref(ref); };
  }, [app, service]);
  const operate = async action => {
    if (!service || disabled || transferBusy || busyRef.current || (action === "check" && dirty)) return;
    busyRef.current = true;
    setBusy(action);
    setError("");
    setMessage("");
    if (onBusy) onBusy(true);
    try {
      if (action === "save") {
        if (form.autoEnabled && !hierarchyReady) throw new Error("请先关闭自动同步并保存，在主面板完成新层级启用或迁移后再开启。");
        const pollMinutes = Number(form.pollMinutes);
        if (!Number.isInteger(pollMinutes) || pollMinutes < 1 || pollMinutes > 60) throw new Error("同步间隔须为 1-60 的整数分钟。");
        const next = await service.saveConfig({
          ...feishuConfigValues(service.getConfig(), app), ...form, secret, pollMinutes,
          appId: form.appId.trim(), assigneeId: form.assigneeId.trim(), defaultTasklistGuid: form.defaultTasklistGuid.trim(),
          vaultLabel: form.vaultLabel.trim(), projectFolder: form.projectFolder.trim(), dailyFolder: form.dailyFolder.trim()
        });
        if (alive.current) {
          const config = next || service.getConfig();
          setSaved(config);
          setForm(feishuConfigValues(config, app));
          setSecret("");
          setMessage(config.autoEnabled ? "配置已保存，自动同步已开启。" : "配置已保存。");
        }
      } else {
        const result = await service.check();
        if (alive.current) setMessage((result && result.message) || "连接正常。");
      }
    } catch (failure) {
      if (alive.current) setError(failure.message || "操作失败，请检查配置后重试。");
    } finally {
      busyRef.current = false;
      if (alive.current) {
        setBusy("");
        if (onBusy) onBusy(false);
      }
    }
  };
  const reset = () => { setForm(feishuConfigValues(saved, app)); setSecret(""); setError(""); setMessage(""); };
  const onTransferBusy = value => { setTransferBusy(value); if (onBusy) onBusy(value); };
  return { saved, hierarchy, form, secret, setSecret, busy, transferBusy, message, error, dirty, change, operate, reset, onTransferBusy };
}

function FeishuIcon({ name }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && typeof Obsidian.setIcon === "function") Obsidian.setIcon(ref.current, name);
    return () => { if (ref.current) ref.current.replaceChildren(); };
  }, [name]);
  return <span className="feishu-sync--icon" ref={ref} aria-hidden="true" />;
}

function FeishuConfigFeedback({ controller }) {
  const { dirty, message, error } = controller;
  return <>
    {dirty && <p className="feishu-sync--notice" role="status">有未保存的修改。后台仍使用已保存的配置。</p>}
    {message && <p className="feishu-sync--message" role="status">{message}</p>}
    {error && <p className="feishu-sync--error" role="alert">{error}</p>}
  </>;
}

function FeishuConfigActions({ controller, disabled, label = "保存修改" }) {
  const { saved, busy, transferBusy, dirty, operate, reset } = controller;
  const waiting = disabled || !!busy || transferBusy;
  return <div className="feishu-sync--editorActions">
    <button className="feishu-sync--button feishu-sync--primary" type="button" disabled={waiting || !dirty}
      onClick={() => operate("save")}><FeishuIcon name="check" />{busy === "save" ? "正在保存…" : label}</button>
    <button className="feishu-sync--button feishu-sync--quiet" type="button" disabled={!!busy || transferBusy || !dirty} onClick={reset}>撤销未保存修改</button>
    {disabled && !busy && <span className="feishu-sync--hint">同步完成后可保存</span>}
    {!saved.appId && <span className="feishu-sync--hint">首次保存需要填写连接设置</span>}
  </div>;
}

function FeishuHierarchyEditor({ controller, disabled, onConnection, notePath, onOpenNote }) {
  const { form, change, hierarchy, busy, transferBusy, dirty } = controller;
  const [active, setActive] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(6);
  const region = useRef("feishu-hierarchy-" + Math.random().toString(36).slice(2));
  const inputRef = useRef(null);
  const stageRefs = useRef({});
  const stages = [
    { id: "vault", label: "仓库清单", icon: "list", title: form.vaultTasklistName || "设置清单名称", hint: "名称与仓库身份" },
    { id: "areas", label: "Area 分组", icon: "layers", title: (hierarchy?.areas || []).length ? hierarchy.areas.length + " 个领域分组" : "按笔记 area 分组", hint: "编辑分组显示名称" },
    { id: "projects", label: "项目父任务", icon: "folder-open", title: form.projectFolder || "设置项目目录", hint: "目录与项目显示名称" },
    { id: "actions", label: "行动子任务", icon: "square-check", title: "笔记中的 checkbox", hint: "行动标题与日记范围" }
  ];
  useEffect(() => {
    setQuery(""); setLimit(6);
    if (active) inputRef.current?.querySelector("input")?.focus({ preventScroll: true });
  }, [active]);
  const rows = (active === "areas" ? hierarchy?.areas || [] : hierarchy?.projects || [])
    .filter(row => !query || (row.name + " " + (row.path || row.key)).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div className="feishu-sync--hierarchyEditor">
    <ol className="feishu-sync--levels" aria-label="点击编辑仓库任务层级">
      {stages.map(stage => <li key={stage.id}>
        <button className={"feishu-sync--stage" + (active === stage.id ? " feishu-sync--stageActive" : "")} type="button"
          ref={element => { stageRefs.current[stage.id] = element; }}
          aria-expanded={active === stage.id} aria-controls={region.current} onClick={() => setActive(current => current === stage.id ? "" : stage.id)}>
          <span className="feishu-sync--stageLabel"><FeishuIcon name={stage.icon} />{stage.label}<FeishuIcon name="pencil" /></span>
          <strong title={stage.title}>{stage.title}</strong><span className="feishu-sync--stageHint">{stage.hint}</span>
        </button>
      </li>)}
    </ol>
    {!active && <p className="feishu-sync--hint feishu-sync--editHint"><FeishuIcon name="mouse-pointer-2" />点击任意层级，在这里修改名称和范围。</p>}
    {active && <section className="feishu-sync--inlineEditor" id={region.current} aria-label={stages.find(s => s.id === active).label + "设置"} ref={inputRef}>
      <div className="feishu-sync--sectionHead"><h4>{stages.find(s => s.id === active).label}</h4>
        <button className="feishu-sync--iconButton" type="button" aria-label="收起层级编辑器" onClick={() => { stageRefs.current[active]?.focus({ preventScroll: true }); setActive(""); }}><FeishuIcon name="x" /></button></div>
      <fieldset className="feishu-sync--fieldset" disabled={!!busy || transferBusy}>
        {active === "vault" && <Settings>
          <SettingInput label="飞书仓库清单名称" type="text" value={form.vaultTasklistName} onChange={event => change("vaultTasklistName", event.target.value)} />
          <SettingInput label="仓库显示名称" type="text" value={form.vaultLabel} onChange={event => change("vaultLabel", event.target.value)} />
          <SettingInput label="仓库标识" type="text" value={form.vaultId} placeholder="首次保存时自动生成，也可填写原 UUID" spellCheck={false}
            onChange={event => change("vaultId", event.target.value)} />
          <SettingDescription>同一仓库可使用不同文件夹名称。已有飞书关联时，通过跨设备接入包恢复原标识与记录。</SettingDescription>
        </Settings>}
        {active === "projects" && <Settings>
          <SettingInput label="项目目录" type="text" value={form.projectFolder} spellCheck={false} placeholder="50_Tasks"
            onChange={event => change("projectFolder", event.target.value)} />
          <SettingDescription>该目录内带 project 标签的笔记对应父任务。下面可单独设置父任务名称，留空跟随笔记名称。</SettingDescription>
        </Settings>}
        {(active === "areas" || active === "projects") && <>
          <Settings><SettingInput label={active === "areas" ? "查找分组" : "查找项目"} type="search" value={query} placeholder="按名称或路径筛选"
            onChange={event => { setQuery(event.target.value); setLimit(6); }} /></Settings>
          <div className="feishu-sync--nameFields"><Settings>
            {rows.slice(0, limit).map(row => <SettingInput key={row.key || row.id} label={row.name} type="text"
              value={active === "areas" ? form.areaNames[row.key] || "" : form.projectNames[row.id] || ""} placeholder="留空跟随笔记名称"
              onChange={event => active === "areas" ? change("areaNames", { ...form.areaNames, [row.key]: event.target.value })
                : change("projectNames", { ...form.projectNames, [row.id]: event.target.value })} />)}
          </Settings></div>
          {!rows.length && <p className="feishu-sync--hint">{query ? "没有匹配的条目。" : "首次同步建立分组与父任务后，可在这里编辑显示名称。"}</p>}
          {rows.length > limit && <button className="feishu-sync--button feishu-sync--quiet" type="button" onClick={() => setLimit(current => current + 6)}>显示更多（剩余 {rows.length - limit} 项）</button>}
        </>}
        {active === "actions" && <>
          <p className="feishu-sync--hint">行动标题取自笔记的 checkbox 文本。修改原笔记后，下次同步更新已有子任务。</p>
          {notePath && <button className="feishu-sync--button" type="button" onClick={onOpenNote}><FeishuIcon name="file-pen-line" />打开所选笔记编辑行动</button>}
          <Settings>
            <SettingSwitch label="同时同步日记行动" value={form.syncDaily} onChange={value => change("syncDaily", value)} />
            <SettingInput label="日记目录" type="text" value={form.dailyFolder} spellCheck={false} onChange={event => change("dailyFolder", event.target.value)} />
            {form.syncDaily && <SettingInput label="日记默认清单 GUID" type="text" value={form.defaultTasklistGuid} spellCheck={false}
              onChange={event => change("defaultTasklistGuid", event.target.value)} />}
            {form.syncDaily && <SettingDescription>日记清单名称以 [{form.vaultLabel || "仓库名称"}] 开头，应用需有编辑权限。</SettingDescription>}
          </Settings>
        </>}
      </fieldset>
      <FeishuConfigActions controller={controller} disabled={disabled} label="保存层级修改" />
      {!controller.saved.appId && onConnection && <button className="feishu-sync--button" type="button" onClick={onConnection}>填写连接设置</button>}
      <p className="feishu-sync--hint">名称修改在下次同步应用，原 GUID 和笔记文件名保留。</p>
    </section>}
    {(active || dirty) && <FeishuConfigFeedback controller={controller} />}
  </div>;
}

function FeishuConfig({ controller, disabled }) {
  const { saved, hierarchy, form, secret, setSecret, busy, transferBusy, dirty, change, operate } = controller;
  const hierarchyReady = !!saved.hierarchyEnabled && hierarchy?.migration?.state === "ready";
  return <div className="feishu-sync--config">
    <div className="feishu-sync--pageHeading"><h3>连接设置</h3><p>连接飞书应用，并设置这台设备的同步方式。</p></div>
    <fieldset className="feishu-sync--fieldset" disabled={!!busy || transferBusy}>
      <section className="feishu-sync--formSection"><h4>应用与接收人</h4><Settings>
        <SettingInput label="App ID" type="text" value={form.appId} autoComplete="off" spellCheck={false}
          placeholder="cli_..." onChange={event => change("appId", event.target.value)} />
        <SettingInput label="App Secret" type="password" value={secret} autoComplete="new-password" spellCheck={false}
          placeholder={saved.hasSecret ? "已加密保存；留空保留" : "输入当前设备的应用密钥"} onChange={event => setSecret(event.target.value)} />
        <SettingInput label="接收任务用户 Open ID" type="text" value={form.assigneeId} autoComplete="off" spellCheck={false}
          placeholder="ou_..." onChange={event => change("assigneeId", event.target.value)} />
        <SettingDescription>密钥使用本机系统加密保存。Open ID 须来自同一个飞书应用。</SettingDescription>
      </Settings></section>
      <section className="feishu-sync--formSection"><h4>同步范围</h4><Settings>
        <SettingInput label="项目目录" type="text" value={form.projectFolder} spellCheck={false}
          onChange={event => change("projectFolder", event.target.value)} />
        <SettingDescription>目录内带 project 标签的笔记按 Area、项目父任务、行动子任务同步。</SettingDescription>
        <SettingTextarea label="额外任务文件夹" value={form.taskFolders} placeholder={"Work/Meetings\nPersonal"} spellCheck={false}
          onChange={event => change("taskFolders", event.target.value)} />
        <SettingInput label="额外笔记标签" type="text" value={form.taskTags} placeholder="action, meeting" spellCheck={false}
          onChange={event => change("taskTags", event.target.value)} />
        <SettingDescription>文件夹每行一个，标签用逗号分隔。匹配任一文件夹或标签的笔记，其 checkbox 直接进入仓库清单。标签支持属性、正文和子标签。</SettingDescription>
        <SettingTextarea label="排除文件夹" value={form.excludedFolders} placeholder={"Templates\nArchive"} spellCheck={false}
          onChange={event => change("excludedFolders", event.target.value)} />
        <SettingDescription>排除规则适用于全部范围。日记仍由概览中的日记开关单独控制。</SettingDescription>
      </Settings></section>
      <section className="feishu-sync--formSection"><h4>自动同步</h4><Settings>
        <SettingSwitch label="开启此仓库的自动同步" value={form.autoEnabled} disabled={!hierarchyReady && !form.autoEnabled}
          onChange={value => change("autoEnabled", value)} />
        <SettingInput label="检查飞书状态的间隔（分钟）" type="number" min="1" max="60" step="1" value={form.pollMinutes}
          onChange={event => change("pollMinutes", event.target.value)} />
        <SettingDescription>{hierarchyReady ? "仅在仓库打开期间运行。两台设备请轮流启用自动同步。" : "先保存连接设置，再从概览启用或迁移层级。"}</SettingDescription>
      </Settings></section>
    </fieldset>
    <FeishuConfigActions controller={controller} disabled={disabled} label="保存连接设置" />
    <button className="feishu-sync--button" type="button" disabled={disabled || !!busy || dirty || !saved.appId || !saved.hasSecret || !saved.assigneeId}
      onClick={() => operate("check")}><FeishuIcon name="plug" />{busy === "check" ? "正在检查…" : "检查连接"}</button>
    <FeishuConfigFeedback controller={controller} />
    {saved.storagePath && <details className="feishu-sync--details"><summary>本机存储位置</summary><p className="feishu-sync--hint"><code>{saved.storagePath}</code></p></details>}
  </div>;
}

function safeFeishuUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && (url.hostname === "feishu.cn" || url.hostname.endsWith(".feishu.cn")) ? url.href : null;
  } catch (_) { return null; }
}

function feishuTaskHasConflict(record) {
  if (!record) return false;
  if (["conflict", "remote_missing"].includes(record.state)) return true;
  return record.state === "error" && /飞书任务.*(?:未找到|不存在|已删除)|(?:未找到|找不到).*飞书任务|task[^\n]*not found|1470404/i.test(record.message || "");
}

function feishuGlobalSyncError(autoStatus) {
  if (Array.isArray(autoStatus?.failures) && autoStatus.failures.length) return "";
  return autoStatus?.lastError || "";
}

function feishuIssueNextStep(issue) {
  const message = issue.message || "";
  if (issue.kind === "task" && feishuTaskHasConflict(issue)) return "点击「处理冲突」，对比本仓库与飞书，再确认采用哪一侧。";
  if (issue.state === "local_missing") return "打开原笔记核对行动是否已移动或改写，再查看关联记录。";
  if (["remote_missing", "missing"].includes(issue.state) || /未找到|不存在|无权|无访问权|无访问权限|not found|forbidden|1470404/i.test(message)) {
    return "先在飞书打开核实；若任务被删且仍需同步，再确认是否重新建立。";
  }
  if (["uncertain", "creating", "unknown"].includes(issue.state)) return "先在飞书核实是否已经创建，再查看此项恢复关联，避免重复创建。";
  if (issue.state === "foreign") return "回到来源仓库核对关联，此仓库不会接管该任务。";
  if (issue.state === "conflict" || /冲突|重新打开/.test(message)) return "先核对本地与飞书的状态，再查看此项决定采用哪一端。";
  if (/凭据|配置|权限|scope|token|permission/i.test(message)) return "检查账号配置与应用权限，修正后再同步此项。";
  if (/网络|超时|timeout|network|fetch|连接/i.test(message)) return "检查网络连接，恢复后重试同步；已有任务关联会保留。";
  return "打开笔记核对内容，并查看此项的同步状态；处理原因后再同步。";
}

function FeishuSyncIssues({ issues, loading, error, actionError, autoStatus, disabled, conflictDisabled, onView, onOpen, onConflict }) {
  const globalError = !issues.length && !loading && !error && feishuGlobalSyncError(autoStatus);
  if (!issues.length && !loading && !error && !globalError) return null;
  return (
    <section className="feishu-sync--issues" aria-label="需要处理的同步异常" aria-busy={loading}>
      <div className="feishu-sync--taskTop">
        <h3 className="feishu-sync--subtitle">{issues.length ? issues.length + " 项需要处理" : "同步异常"}</h3>
        {loading && <span className="feishu-sync--hint" role="status">正在读取异常详情…</span>}
      </div>
      {error && <p className="feishu-sync--error" role="alert">{error}</p>}
      {actionError && <p className="feishu-sync--error" role="alert">{actionError}</p>}
      {globalError && <div className="feishu-sync--notice" role="status">
        <p>{globalError}</p>
        <p>这是当前仓库的同步提示，暂未定位到具体任务。先检查网络、账号配置和应用权限；恢复后再同步查看结果。</p>
      </div>}
      {issues.length > 0 && <ul className="feishu-sync--issueList">{issues.map(issue => {
        const url = safeFeishuUrl(issue.url);
        return <li className="feishu-sync--issue" key={issue.key}>
          <div className="feishu-sync--taskTop">
            <strong className="feishu-sync--issueTitle">{issue.title || (issue.kind === "project" ? "未命名项目" : "未命名行动")}</strong>
            <span className="feishu-sync--status">{issue.kind === "project" ? "项目父任务" : "行动"}</span>
          </div>
          <p className="feishu-sync--hint">笔记：{issue.path || "路径未记录"}{Number.isInteger(issue.line) ? " · 第 " + (issue.line + 1) + " 行" : ""}</p>
          <p className="feishu-sync--issueReason">原因：{issue.message || "同步未完成，请查看此项的关联状态。"}</p>
          <p className="feishu-sync--hint">下一步：{feishuIssueNextStep(issue)}</p>
          <div className="feishu-sync--actions">
            <button className="feishu-sync--button" type="button" disabled={!issue.path} onClick={() => onOpen(issue)}>打开笔记</button>
            <button className="feishu-sync--button" type="button" disabled={disabled || !issue.path} onClick={() => onView(issue)}>查看此项</button>
            {issue.kind === "task" && feishuTaskHasConflict(issue) && <button className="feishu-sync--button" type="button"
              disabled={disabled || conflictDisabled || !issue.id} onClick={() => onConflict(issue)}>处理冲突</button>}
            {url && <a className="feishu-sync--link" href={url} target="_blank" rel="noopener noreferrer">在飞书查看 ↗</a>}
          </div>
        </li>;
      })}</ul>}
    </section>
  );
}

function FeishuTaskConflict({ conflict, disabled, panelRef, onChoose, onReload, onConfirm, onCancel }) {
  const preview = conflict.preview;
  const loading = conflict.phase === "loading";
  const resolving = conflict.phase === "resolving";
  const pending = loading || resolving;
  const statusText = value => typeof value === "boolean" ? value ? "已完成" : "未完成" : "未记录";
  return (
    <section className="feishu-sync--conflict" aria-label="行动冲突对比" aria-busy={pending} ref={panelRef} tabIndex={-1}>
      <div className="feishu-sync--taskTop">
        <h3 className="feishu-sync--subtitle">处理冲突</h3>
        <span className="feishu-sync--status">{preview?.kind === "remote_missing" ? "飞书任务缺失" : preview ? "完成状态冲突" : "读取两侧版本"}</span>
      </div>
      <p className="feishu-sync--conflictTitle">{preview?.local.summary || conflict.target.title || "行动"}</p>
      {conflict.target.path && <p className="feishu-sync--hint">{conflict.target.path}</p>}
      {loading && <p className="feishu-sync--hint" role="status">正在读取本仓库与飞书，尚未修改任务…</p>}
      {conflict.error && <p className="feishu-sync--error" role="alert">{conflict.error}</p>}
      {preview && <>
        <p className="feishu-sync--hint">{preview.kind === "status" ? "本次只选择完成状态；标题与说明继续由本仓库维护。" : "先核对两侧现状，再选择下面的处理结果。"}</p>
        <fieldset className="feishu-sync--fieldset feishu-sync--conflictChoices" disabled={disabled || pending}>
          <legend className="feishu-sync--hint">选择采用哪一侧（确认前不会修改）</legend>
          <div className="feishu-sync--conflictSides">
            {["local", "remote"].map(side => {
              const value = preview[side];
              const missing = side === "remote" && !value.exists;
              const selected = conflict.choice === side;
              return <div className={"feishu-sync--conflictSide" + (selected ? " feishu-sync--conflictChosen" : "")} key={side}>
                <strong>{side === "local" ? "本仓库 · Obsidian" : "飞书"}</strong>
                <p className="feishu-sync--conflictText">{missing ? "未找到或不可访问" : value.summary || "（无标题）"}</p>
                <p className="feishu-sync--hint">{missing ? "飞书返回找不到或已删除，权限变化也需核实。" : "完成状态：" + (side === "local" && value.status === "-" ? "已取消" : statusText(value.done))}{side === "local" && value.status && !/^[ xX]$/.test(value.status) ? " · checkbox [" + value.status + "]" : ""}</p>
                <p className="feishu-sync--conflictOutcome">{preview.choices[side]}</p>
                <button className="feishu-sync--button" type="button" aria-pressed={selected} onClick={() => onChoose(side)}>
                  {selected ? "已选择" : "选择"}{side === "local" ? "本仓库" : "飞书"}
                </button>
              </div>;
            })}
          </div>
        </fieldset>
        <div className="feishu-sync--conflictBase">
          <strong>上次共同状态</strong>
          <span>{preview.baseline ? statusText(preview.baseline.done) + (preview.baseline.summary ? " · " + preview.baseline.summary : "") : "尚无可用记录"}</span>
        </div>
        {conflict.choice && <p className="feishu-sync--notice" role="status">确认后：{preview.choices[conflict.choice]}</p>}
      </>}
      <div className="feishu-sync--actions">
        <button className="feishu-sync--button feishu-sync--primary" type="button" disabled={disabled || pending || !preview || !conflict.choice} onClick={onConfirm}>
          {resolving ? "正在处理…" : conflict.choice ? "确认采用" + (conflict.choice === "local" ? "本仓库" : "飞书") : "先选择采用哪一侧"}
        </button>
        <button className="feishu-sync--button" type="button" disabled={disabled || pending} onClick={onReload}>重新读取对比</button>
        <button className="feishu-sync--button" type="button" disabled={resolving} onClick={onCancel}>取消</button>
      </div>
      {!pending && !preview && <p className="feishu-sync--hint">读取成功后才能选择。请按提示处理原因，再重新读取对比。</p>}
    </section>
  );
}

function FeishuAction({ task, isProject, disabled, sendDisabled, highlighted, onSend, onSync, onRecover, onConflict }) {
  const [recoveryGuid, setRecoveryGuid] = useState("");
  const record = task.record;
  const id = task.id || (record && record.id);
  const linked = !!(record && record.guid);
  const unknown = record && !record.guid && ["uncertain", "creating", "unknown"].includes(record.state);
  const conflict = feishuTaskHasConflict(record);
  const suppressed = record?.state === "suppressed" && !record.cancelPending;
  const foreign = record && record.state === "foreign";
  const regular = /^[ xX]$/.test(task.status);
  const url = record && safeFeishuUrl(record.url);
  const stateNames = {
    synced: "已同步", syncing: "同步中", linked: "已关联", ready: "已关联", creating: "创建结果待确认", uncertain: "创建结果待确认",
    unknown: "创建结果待确认", conflict: "状态冲突", failed: "同步失败", error: "同步失败", missing: "飞书任务未找到",
    remote_missing: "飞书任务未找到", local_missing: "本地行动未找到", pending: "等待同步", draft: "尚未发送", untracked: "需恢复关联", foreign: "来自其他仓库", suppressed: "已取消 · 已停止同步"
  };
  return (
    <li className={"feishu-sync--task" + (highlighted ? " feishu-sync--selected" : "")} tabIndex={highlighted ? -1 : undefined}>
      <div className="feishu-sync--taskTop">
        <span className="feishu-sync--taskText"><span aria-label={task.status === "-" ? "本地已取消" : task.done ? "本地已完成" : "本地未完成"}>{task.status === "-" ? "⊘" : task.done ? "☑" : "☐"}</span> {task.text || "（无标题行动）"}</span>
        <span className="feishu-sync--status">{record?.cancelPending ? "取消结果待确认" : record ? (stateNames[record.state] || "已关联") : id ? "需恢复关联" : "未发送"}</span>
      </div>
      <p className="feishu-sync--hint">{isProject ? "项目子任务" : "日记行动"} · {task.heading || "未分小节"} · 第 {task.line + 1} 行{record && record.lastSyncedAt ? " · 上次同步 " + new Date(record.lastSyncedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : ""}</p>
      {record && record.message && <p className={conflict || unknown ? "feishu-sync--notice" : "feishu-sync--hint"}>{record.message}</p>}
      <div className="feishu-sync--actions">
        {!linked && !unknown && !foreign && !suppressed && <button className="feishu-sync--button" type="button" disabled={disabled || sendDisabled || !regular} onClick={() => onSend(task)}>{record && record.state === "draft" ? "重试发送" : id ? "查找已有任务" : isProject ? "发为子任务" : "发到飞书"}</button>}
        {linked && !foreign && !conflict && !suppressed && <button className="feishu-sync--button" type="button" disabled={disabled || !id || (!regular && !record.cancelPending)} onClick={() => onSync(id)}>{record.cancelPending ? "重试确认取消" : "同步状态"}</button>}
        {url && <a className="feishu-sync--link" href={url} target="_blank" rel="noopener noreferrer">在飞书打开 ↗</a>}
        {conflict && <button className="feishu-sync--button" type="button" disabled={disabled || !id} onClick={() => onConflict({ id, path: task.path || record.path, title: task.text })}>处理冲突</button>}
      </div>
      {conflict && <p className="feishu-sync--hint">点击「处理冲突」查看两侧版本，选择后还需确认。</p>}
      {suppressed && <p className="feishu-sync--hint">已采用飞书结果，行动文本保留。如需恢复同步，先在笔记中重新打开此行动，再处理冲突。</p>}
      {foreign && <p className="feishu-sync--notice">此标记属于其他仓库，请回来源仓库处理原任务。本仓库不会发送、认领或恢复它。</p>}
      {!regular && !suppressed && !conflict && !record?.cancelPending && <p className="feishu-sync--hint">当前是自定义 checkbox 状态，只支持普通未完成和已完成行动。</p>}
      {!linked && task.done && !id && <p className="feishu-sync--hint">首次同步会保留这条行动的已完成状态。</p>}
      {unknown && <div className="feishu-sync--recovery">
        <p className="feishu-sync--hint">创建结果待确认，已暂停重复创建。先尝试同步查询；仍未恢复时，在飞书找到该任务，从分享链接取得 GUID 后绑定。不要删除本机记录重试。</p>
        <div className="feishu-sync--actions">
          <button className="feishu-sync--button" type="button" disabled={disabled || !id} onClick={() => onSync(id)}>查询并恢复关联</button>
        </div>
        <label className="feishu-sync--label">恢复已有任务 GUID
          <input className="feishu-sync--input" type="text" value={recoveryGuid} disabled={disabled} spellCheck={false}
            placeholder="从该任务分享链接复制 GUID" onChange={event => setRecoveryGuid(event.target.value)} />
        </label>
        <button className="feishu-sync--button" type="button" disabled={disabled || !id || !recoveryGuid.trim()} onClick={() => onRecover(id, recoveryGuid.trim())}>校验并恢复任务</button>
      </div>}
    </li>
  );
}

function FeishuResourceRecovery({ resource, disabled, onRecover }) {
  const [guid, setGuid] = useState("");
  const labels = { vaultList: "仓库清单", statusField: "项目状态字段", section: "area 分组" };
  const supported = Object.prototype.hasOwnProperty.call(labels, resource.kind);
  return (
    <div className="feishu-sync--recovery">
      <p className="feishu-sync--label">{labels[resource.kind] || "层级资源"}：{resource.name || "名称待确认"}</p>
      {resource.message && <p className="feishu-sync--hint">{resource.message}</p>}
      <p className="feishu-sync--hint">先在飞书确认此资源已创建，再填写其 GUID。恢复时会核对名称与所属仓库清单；校验通过后只恢复关联，不会另建一份。</p>
      <label className="feishu-sync--label">已有资源 GUID
        <input className="feishu-sync--input" type="text" value={guid} disabled={disabled} spellCheck={false}
          placeholder="粘贴刚才创建的远端资源 GUID" onChange={event => setGuid(event.target.value)} />
      </label>
      <button className="feishu-sync--button" type="button" disabled={disabled || !supported || !guid.trim()}
        onClick={() => onRecover({ kind: resource.kind, key: resource.key, guid: guid.trim() })}>校验并恢复关联</button>
    </div>
  );
}

function App({ navigation }) {
  const { plugin } = useRuntime();
  const runtimePlugin = plugin;
  const app = useObsidianApp();
  const { getData, saveData } = useDataStorage();
  const [service, setService] = useState(null);
  const [config, setConfig] = useState(null);
  const [configDirty, setConfigDirty] = useState(false);
  const [configBusy, setConfigBusy] = useState(false);
  const [section, setSection] = useState(() => ["overview", "notes", "connection", "transfer", "help"].includes((getData() || {}).activeSection) ? getData().activeSection : "overview");
  const [files, setFiles] = useState([]);
  const [candidate, setCandidate] = useState("");
  const [path, setPath] = useState("");
  const [selectedLine, setSelectedLine] = useState(null);
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [note, setNote] = useState(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [due, setDue] = useState("");
  const [reminder, setReminder] = useState("");
  const [hierarchy, setHierarchy] = useState(null);
  const [autoStatus, setAutoStatus] = useState(null);
  const [syncIssues, setSyncIssues] = useState([]);
  const [issuesLoading, setIssuesLoading] = useState(true);
  const [issuesError, setIssuesError] = useState("");
  const [issueActionError, setIssueActionError] = useState("");
  const [conflict, setConflict] = useState(null);
  const [conflictMessage, setConflictMessage] = useState("");
  const [scopePreview, setScopePreview] = useState(null);
  const alive = useRef(true);
  const serviceRef = useRef(null);
  const currentPath = useRef("");
  const busyRef = useRef(false);
  const configRef = useRef({ saved: null, dirty: false, busy: false });
  const selectionVersion = useRef(0);
  const requestVersion = useRef(0);
  const issuesVersion = useRef(0);
  const conflictVersion = useRef(0);
  const conflictScope = useRef("");
  const conflictPanelRef = useRef(null);
  const refreshIssuesRef = useRef(null);
  const noteRef = useRef(null);
  const focusIssue = useRef(false);
  const listId = useRef("feishu-sync-notes-" + Math.random().toString(36).slice(2));

  const updateConflictScope = useCallback(saved => {
    const nextScope = JSON.stringify([saved?.appId || "", saved?.vaultId || "", saved?.assigneeId || ""]);
    if (conflictScope.current && conflictScope.current !== nextScope) {
      conflictVersion.current += 1;
      setConflict(null);
      setConflictMessage("");
    }
    conflictScope.current = nextScope;
  }, []);

  const refreshHierarchy = useCallback(() => {
    if (!alive.current || !serviceRef.current) return;
    try { setHierarchy(readFeishuHierarchy(serviceRef.current)); }
    catch (failure) { setError(failure.message || "读取仓库层级状态失败。"); }
  }, []);

  const refresh = useCallback(async () => {
    const api = serviceRef.current;
    const target = currentPath.current;
    const version = ++requestVersion.current;
    if (!api || !target || !alive.current) return;
    setReading(true);
    try {
      const result = await api.readNote(target);
      if (alive.current && version === requestVersion.current && target === currentPath.current) setNote(result);
    } catch (failure) {
      if (alive.current && version === requestVersion.current && target === currentPath.current) {
        setNote(null);
        setError(failure.message || "读取行动失败，请刷新后重试。");
      }
    } finally {
      if (alive.current && version === requestVersion.current) setReading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    const workspaceRefs = [];
    const vaultRefs = [];
    let issuesTimer = null;
    let metadataRef = null;
    let filesTimer = null;
    try {
      const api = plugin.service;
      if (!api) throw new Error("飞书同步服务未加载，请重新启用插件。");
      serviceRef.current = api;
      setService(api);
      refreshHierarchy();
      const nextConfig = api.getConfig();
      updateConflictScope(nextConfig);
      configRef.current.saved = nextConfig;
      setConfig(nextConfig);
      if (!nextConfig.appId || !nextConfig.hasSecret || !nextConfig.assigneeId) setSection("connection");
      const chooseSelection = selection => {
        if (!alive.current) return;
        const nextPath = selection && selection.path || "";
        currentPath.current = nextPath;
        selectionVersion.current += 1;
        requestVersion.current += 1;
        setPath(nextPath);
        setCandidate(nextPath);
        const nextLine = selection && Number.isInteger(selection.line) ? selection.line : null;
        setSelectedLine(nextLine);
        focusIssue.current = nextLine !== null;
        setSelectedTaskId(null);
        setNote(null);
        setReading(false);
        setError("");
        setMessage("");
        if (nextPath) { setSection("notes"); refresh(); }
      };
      let filesVersion = 0;
      const refreshFiles = () => {
        const version = ++filesVersion;
        clearTimeout(filesTimer);
        filesTimer = setTimeout(async () => {
          try {
            const paths = await api.listNotes();
            if (alive.current && version === filesVersion) setFiles(paths.sort((a, b) => a.localeCompare(b, "zh-CN")));
          } catch (failure) { if (alive.current && version === filesVersion) setError(failure.message); }
        }, 150);
      };
      const updateAutoStatus = status => {
        if (!alive.current) return;
        const plugin = runtimePlugin;
        try {
          const nextStatus = { ...(status || plugin?.getAutoStatus?.() || {}), available: !!plugin };
          setAutoStatus(nextStatus);
          refreshIssues(nextStatus.failures);
        } catch (_) {
          setAutoStatus({ available: !!plugin, lastError: "自动同步状态暂不可用。" });
          refreshIssues([]);
        }
      };
      const refreshIssues = failures => {
        const version = ++issuesVersion.current;
        clearTimeout(issuesTimer);
        setIssuesLoading(true);
        issuesTimer = setTimeout(async () => {
          try {
            if (typeof api.getSyncIssues !== "function") throw new Error("当前服务尚未提供异常详情，请重新启动 Obsidian 后再查看。");
            const issues = await api.getSyncIssues(Array.isArray(failures) ? failures : []);
            if (!alive.current || version !== issuesVersion.current) return;
            setSyncIssues(Array.isArray(issues) ? issues : []);
            setIssuesError("");
          } catch (failure) {
            if (!alive.current || version !== issuesVersion.current) return;
            setIssuesError(failure.message || "读取同步异常失败，请稍后重试。");
          } finally {
            if (alive.current && version === issuesVersion.current) setIssuesLoading(false);
          }
        }, 120);
      };
      refreshIssuesRef.current = () => updateAutoStatus();
      workspaceRefs.push(app.workspace.on("feishu-sync:selection", chooseSelection));
      workspaceRefs.push(app.workspace.on("feishu-sync:change", () => {
        if (!alive.current) return;
        updateConflictScope(api.getConfig());
        refreshFiles();
        setScopePreview(null);
        updateAutoStatus();
        refreshHierarchy();
        refresh();
      }));
      workspaceRefs.push(app.workspace.on("feishu-sync:auto-status", updateAutoStatus));
      vaultRefs.push(app.vault.on("modify", file => { refreshFiles(); if (file.path === currentPath.current) refresh(); }));
      if (app.metadataCache?.on) metadataRef = app.metadataCache.on("changed", refreshFiles);
      ["create", "delete", "rename"].forEach(event => vaultRefs.push(app.vault.on(event, (file, oldPath) => {
        refreshFiles();
        if (file.path === currentPath.current || oldPath === currentPath.current) refresh();
      })));
      refreshFiles();
      updateAutoStatus();
      chooseSelection(api.getSelection());
    } catch (failure) {
      setIssuesLoading(false);
      setError(failure.message || "飞书同步服务加载失败，请重新启用插件。");
    }
    return () => {
      alive.current = false;
      requestVersion.current += 1;
      issuesVersion.current += 1;
      conflictVersion.current += 1;
      clearTimeout(issuesTimer);
      clearTimeout(filesTimer);
      refreshIssuesRef.current = null;
      serviceRef.current = null;
      workspaceRefs.forEach(ref => app.workspace.offref(ref));
      vaultRefs.forEach(ref => app.vault.offref(ref));
      if (metadataRef) app.metadataCache.offref(metadataRef);
    };
  }, [app, plugin, refresh, refreshHierarchy, updateConflictScope]);

  useEffect(() => {
    if (navigation && SECTIONS.includes(navigation.section)) setSection(navigation.section);
  }, [navigation]);

  useEffect(() => {
    if (!note || reading || !focusIssue.current || !noteRef.current) return;
    focusIssue.current = false;
    const target = noteRef.current.querySelector(".feishu-sync--selected") || noteRef.current;
    target.scrollIntoView({ block: "nearest" });
    target.focus({ preventScroll: true });
  }, [note, reading, selectedTaskId, selectedLine]);

  useEffect(() => {
    if (!conflict?.target.id || !conflictPanelRef.current) return;
    conflictPanelRef.current.scrollIntoView({ block: "nearest" });
    conflictPanelRef.current.focus({ preventScroll: true });
  }, [conflict?.target.id]);

  const onConfigState = useCallback(value => {
    updateConflictScope(value.saved);
    configRef.current.saved = value.saved;
    configRef.current.dirty = value.dirty;
    setConfig(value.saved);
    setConfigDirty(value.dirty);
  }, [updateConflictScope]);
  const onConfigBusy = useCallback(value => {
    configRef.current.busy = value;
    setConfigBusy(value);
  }, []);
  const configEditor = useFeishuConfig(service, !!busy || !!autoStatus?.running, onConfigState, onConfigBusy);
  const suggestions = useMemo(() => {
    const query = candidate.trim().toLocaleLowerCase();
    return files.filter(file => !query || file.toLocaleLowerCase().includes(query)).slice(0, 80);
  }, [files, candidate]);
  const configured = !!(config && config.appId && config.hasSecret && config.assigneeId);
  const blocked = !!busy || configBusy || !!autoStatus?.running;
  const remoteBlocked = blocked || configDirty || !configured || reading;
  const tasks = note && note.path === path ? note.tasks || [] : [];
  const hierarchyReady = !!hierarchy?.enabled && hierarchy?.migration?.state === "ready";
  const projectActionCount = tasks.filter(task => /^[ xX]$/.test(task.status)).length;
  const parentRecord = note?.projectRecord || null;
  const parentUrl = parentRecord && safeFeishuUrl(parentRecord.url);
  const resourceStates = { linked: "已关联", syncing: "同步中", error: "同步失败，需处理", conflict: "状态冲突",
    uncertain: "创建结果待确认", creating: "创建结果待确认", retryable: "可重试", pending: "待同步" };
  const parentStateLabel = parentRecord ? resourceStates[parentRecord.state] || (parentRecord.guid ? "已关联" : "待同步") : "尚未创建";
  const parentStatusConflict = parentRecord?.state === "error" && /状态|重新打开/.test(parentRecord.message || "");
  const vaultListUrl = hierarchy?.vaultList && safeFeishuUrl(hierarchy.vaultList.url);
  const legacyListGuid = parentRecord?.legacyTasklistGuid || (!hierarchy?.enabled && note?.listRecord?.guid);
  const archivePending = Number(hierarchy?.migration?.archivePending ?? hierarchy?.migration?.legacyProjects ?? 0);
  const recoveries = Array.isArray(hierarchy?.recoveries) ? hierarchy.recoveries : [];
  const hasLegacyRecords = Number(hierarchy?.migration?.legacyProjects || 0) + Number(hierarchy?.migration?.legacyTasks || 0) > 0;
  const projectStatusNames = { todo: "待办", doing: "进行中", done: "已完成", canceled: "已取消" };
  const migrationState = hierarchy?.migration?.state || "legacy";
  const migrationLabel = hierarchyReady ? "层级已就绪" : migrationState === "migrating" ? "迁移未完成，可继续" : "等待启用或迁移";
  const migrationButton = migrationState === "migrating" ? "继续迁移" : Number(hierarchy?.migration?.legacyProjects || 0) + Number(hierarchy?.migration?.legacyTasks || 0) > 0 ? "迁移旧记录并启用新层级" : "启用仓库层级";
  const run = async (label, operation, success, requireCredentials = true) => {
    const connection = configRef.current;
    if (!service || busyRef.current || connection.busy || connection.dirty || !connection.saved
      || (requireCredentials && (!connection.saved.appId || !connection.saved.hasSecret || !connection.saved.assigneeId))) return;
    busyRef.current = true;
    setBusy(label);
    setError("");
    setMessage("");
    const version = selectionVersion.current;
    try {
      const result = await operation();
      if (alive.current && selectionVersion.current === version) {
        if (success) setMessage(typeof success === "function" ? success(result) : success);
      }
    } catch (failure) {
      if (alive.current && selectionVersion.current === version) setError(failure.message || "操作失败，请检查配置和行动状态后重试。");
    } finally {
      refreshHierarchy();
      if (alive.current && selectionVersion.current === version) await refresh();
      busyRef.current = false;
      if (alive.current) setBusy("");
    }
  };
  const conflictUnavailable = () => {
    const connection = configRef.current;
    if (!service) return "冲突服务尚未加载，请稍后重试。";
    if (busyRef.current || connection.busy || autoStatus?.running) return "飞书操作正在进行，请完成后重新读取对比。";
    if (connection.dirty) return "请先保存账号配置，再重新读取对比。";
    if (!connection.saved?.appId || !connection.saved.hasSecret || !connection.saved.assigneeId) return "请先填写并保存飞书账号配置。";
    return "";
  };
  const readConflict = async target => {
    const unavailable = conflictUnavailable();
    if (busyRef.current) return;
    const version = ++conflictVersion.current;
    setConflictMessage("");
    setConflict({ target, preview: null, choice: "", phase: unavailable ? "" : "loading", error: unavailable });
    if (unavailable) return;
    busyRef.current = true;
    setBusy("读取冲突对比");
    try {
      if (typeof service.getTaskConflict !== "function" || typeof service.resolveTaskConflict !== "function") {
        throw new Error("当前服务尚未提供冲突对比，请重新启动 Obsidian 后再处理。");
      }
      const preview = await service.getTaskConflict(target.id);
      if (!preview || preview.id !== target.id || !preview.token || !preview.local || !preview.remote || !preview.choices?.local || !preview.choices?.remote) {
        throw new Error("未取得完整的两侧状态，请重新读取对比。");
      }
      if (alive.current && version === conflictVersion.current) setConflict({ target, preview, choice: "", phase: "", error: "" });
    } catch (failure) {
      if (alive.current && version === conflictVersion.current) setConflict({ target, preview: null, choice: "", phase: "", error: failure.message || "读取冲突失败，请稍后重试。" });
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy("");
    }
  };
  const confirmConflict = async () => {
    const snapshot = conflict;
    if (!snapshot?.preview || !["local", "remote"].includes(snapshot.choice) || busyRef.current) return;
    const unavailable = conflictUnavailable();
    if (unavailable) {
      setConflict(current => current ? { ...current, error: unavailable } : current);
      return;
    }
    const version = ++conflictVersion.current;
    busyRef.current = true;
    setBusy("处理冲突");
    setConflict(current => ({ ...current, phase: "resolving", error: "" }));
    try {
      const result = await service.resolveTaskConflict(snapshot.target.id, snapshot.choice, snapshot.preview.token);
      if (!result || result.cancelPending || ["conflict", "remote_missing", "error", "uncertain", "creating"].includes(result.state)) {
        throw new Error(result?.message || "处理尚未完成，请重新读取两侧状态后再试。");
      }
      if (alive.current && version === conflictVersion.current) {
        setConflict(null);
        setConflictMessage("已采用" + (snapshot.choice === "local" ? "本仓库" : "飞书") + "，本条冲突已处理。");
      }
    } catch (failure) {
      if (alive.current && version === conflictVersion.current) setConflict({ target: snapshot.target, preview: null, choice: "", phase: "",
        error: failure.code === "CONFLICT_STALE" ? "两侧状态已变化，刚才的选择已清除。请重新读取对比后再确认。" : failure.message || "处理失败，请重新读取两侧状态后重试。" });
    } finally {
      refreshHierarchy();
      refreshIssuesRef.current?.();
      await refresh();
      busyRef.current = false;
      if (alive.current) setBusy("");
    }
  };
  const cancelConflict = () => {
    if (conflict?.phase === "resolving") return;
    conflictVersion.current += 1;
    setConflict(null);
  };
  const choose = event => {
    event.preventDefault();
    if (!service || busyRef.current || configRef.current.busy) return;
    const nextPath = candidate.trim();
    if (!files.includes(nextPath)) { setError("请从候选项选择完整的 Markdown 笔记路径。"); return; }
    try { service.select(nextPath); }
    catch (failure) { setError(failure.message || "选择笔记失败。"); }
  };
  const viewIssue = issue => {
    if (!service || busyRef.current || configRef.current.busy) return;
    setIssueActionError("");
    try {
      service.select(issue.path, issue);
      focusIssue.current = true;
      setSelectedTaskId(issue.kind === "task" ? issue.id || null : null);
    } catch (failure) {
      focusIssue.current = false;
      setIssueActionError(failure.message || "无法查看此项，请检查笔记是否仍在原路径。");
    }
  };
  const openIssueNote = async issue => {
    setIssueActionError("");
    try {
      const file = app.vault.getAbstractFileByPath(issue.path);
      if (!file || file.extension !== "md") throw new Error("原笔记未找到，请核对它是否已移动或改名：" + issue.path);
      const options = Number.isInteger(issue.line) ? { eState: { line: issue.line } } : {};
      await app.workspace.getLeaf("tab").openFile(file, options);
    } catch (failure) {
      if (alive.current) setIssueActionError(failure.message || "打开笔记失败，请检查原路径。");
    }
  };
  const send = task => {
    const options = {};
    if (due) {
      const timestamp = new Date(due + "+08:00").getTime();
      if (!Number.isFinite(timestamp) || timestamp <= Date.now()) { setError("截止时间应是有效的未来时间。"); return; }
      options.due = timestamp;
    }
    if (reminder) {
      const minutes = Number(reminder);
      if (!due || !Number.isInteger(minutes) || minutes < 1 || minutes > 40320) { setError("提醒需先设置截止时间，提前分钟数应为 1-40320 的整数。"); return; }
      options.reminderMinutes = minutes;
    }
    run("发送行动", () => service.sendTask(task, options), "行动已发送到飞书。可在手机完成，再回此面板同步。");
  };
  const sync = id => run("同步行动", () => service.syncTask(id), result =>
    result && feishuTaskHasConflict(result) ? "此行动存在冲突，请点击「处理冲突」查看两侧版本。" : "已检查此行动。请查看下方同步状态。");
  const batchMessage = result => {
    const failures = (result && result.results || []).filter(item => item && item.ok === false);
    const summary = "本次成功 " + Number(result && result.synced || 0) + " 条，失败 " + Number(result && result.failed || 0) + " 条，跳过 " + Number(result && result.skipped || 0) + " 条。";
    const details = failures.slice(0, 5).map(item => {
      const id = typeof item.id === "string" ? "行动 " + item.id.slice(0, 8) + "：" : "";
      const reason = String(item.message || "同步失败，请检查关联记录。").replace(/\s+/g, " ").slice(0, 140);
      return id + reason;
    });
    if (failures.length > 5) details.push("其余 " + (failures.length - 5) + " 条失败，请逐条查看行动状态。");
    return [summary, ...details].join("\n");
  };
  const syncVault = () => run("同步此仓库", () => {
    const plugin = runtimePlugin;
    return plugin?.syncNow ? plugin.syncNow() : service.syncVault({ automatic: false });
  }, batchMessage);
  const migrateVault = () => run("启用或迁移仓库层级", () => service.migrateVault(), result => {
    const status = readFeishuHierarchy(service);
    return (status?.migration?.state === "ready" ? "仓库层级已就绪。自动同步仍保持关闭，可在配置中手动开启。\n" : "迁移尚未完成，请查看状态并处理问题后继续。\n") + batchMessage(result);
  });
  const previewVault = () => run("预览同步范围", async () => {
    const result = await service.previewVault();
    if (alive.current) setScopePreview(result);
    return result;
  }, "已读取本地范围，未修改笔记或飞书。", false);
  const autoLabel = autoStatus?.running ? "正在同步" : !configured ? "等待配置"
    : !hierarchyReady ? "等待层级就绪" : !config?.autoEnabled ? "自动同步未开启" : !autoStatus?.available ? "同步服务未加载"
      : feishuGlobalSyncError(autoStatus) || syncIssues.length > 0 || issuesError ? "有问题需要检查" : "自动同步已开启";
  const lastRun = autoStatus?.lastRunAt ? new Date(autoStatus.lastRunAt) : null;
  return (
    <div className="feishu-sync--root" aria-busy={blocked}>
      <header className="feishu-sync--header">
        <div className="feishu-sync--brand"><span className="feishu-sync--brandMark"><FeishuIcon name="cloud" /></span>
          <div><h2 className="feishu-sync--title">飞书同步</h2><p className="feishu-sync--hint">{config?.vaultLabel || "本仓库"}</p></div></div>
      </header>
      <nav className="feishu-sync--navigation" aria-label="飞书同步导航">
        {[["overview", "同步概览", "layout-dashboard"], ["notes", "行动检查", "square-check"], ["connection", "连接设置", "plug"],
          ["transfer", "跨设备接入", "monitor-smartphone"], ["help", "使用帮助", "circle-help"]].map(([key, label, icon]) =>
          <button key={key} className="feishu-sync--navButton" type="button" aria-current={section === key ? "page" : undefined}
            onClick={() => { setSection(key); saveData({ ...(getData() || {}), activeSection: key }); }}><FeishuIcon name={icon} />{label}</button>)}
      </nav>
      {error && <p className="feishu-sync--error" role="alert">{error}</p>}
      {message && <p className="feishu-sync--message" role="status">{message}</p>}
      <div className="feishu-sync--panel" hidden={section !== "overview"}>
      <section className="feishu-sync--hierarchy" aria-label="仓库清单与迁移状态">
        <div className="feishu-sync--taskTop">
          <h3 className="feishu-sync--subtitle">仓库任务层级</h3>
          <span className="feishu-sync--status" role="status">{hierarchy ? migrationLabel : "状态待加载"}</span>
        </div>
        <FeishuHierarchyEditor controller={configEditor} disabled={blocked} onConnection={() => setSection("connection")}
          notePath={path} onOpenNote={() => app.workspace.openLinkText(path, "", false)} />
        <div className="feishu-sync--connectionLine">
          <FeishuIcon name={hierarchy?.vaultList?.guid ? "link-2" : "unlink"} />
          <span>{hierarchy?.vaultList?.guid ? "已关联飞书清单" : "等待建立仓库清单"}</span>
          {vaultListUrl && <a className="feishu-sync--link" href={vaultListUrl} target="_blank" rel="noopener noreferrer">打开清单</a>}
          {hierarchy?.vaultList?.guid && <details className="feishu-sync--technicalDetails"><summary>关联信息</summary>
            <p className="feishu-sync--hint">GUID：<code>{hierarchy.vaultList.guid}</code></p></details>}
        </div>
        {hierarchy?.vaultList?.message && <p className="feishu-sync--notice">{hierarchy.vaultList.message}</p>}
        {hierarchyReady && hasLegacyRecords && <details className="feishu-sync--maintenance"><summary><FeishuIcon name="archive" />旧清单维护{archivePending > 0 && <span>{archivePending} 个待归档</span>}</summary>
        {hierarchyReady && archivePending > 0 && <p className="feishu-sync--notice">新层级已就绪，仍有 {archivePending} 个旧项目清单待在飞书界面归档。迁移就绪不代表旧清单已归档。</p>}
        {hierarchyReady && hasLegacyRecords && <div className="feishu-sync--finalize">
          <div className="feishu-sync--actions">
            <button className="feishu-sync--button" type="button"
              disabled={blocked || configDirty || !configured || !!config?.autoEnabled || typeof service?.finalizeMigration !== "function"}
              onClick={() => run("核验并移出旧项目清单", () => service.finalizeMigration(), batchMessage)}>核验并移出旧项目清单</button>
          </div>
          <p className="feishu-sync--hint">逐条核验新父任务、分组与完成状态后，将已管理行动移出旧项目清单。此操作不归档清单，也不删除任务。</p>
          {config?.autoEnabled && <p className="feishu-sync--hint">请先关闭自动同步并保存，再核验旧清单关联。</p>}
        </div>}
        </details>}
        {recoveries.length > 0 && <section className="feishu-sync--resourceRecovery" aria-label="层级资源创建异常恢复">
          <h3 className="feishu-sync--subtitle">层级资源需要恢复关联</h3>
          <p className="feishu-sync--notice">以下资源创建结果待确认，已停止重复创建。{config?.autoEnabled ? "先关闭自动同步并保存，再恢复关联。" : "恢复后可继续迁移。"}</p>
          {recoveries.map(resource => <FeishuResourceRecovery key={resource.kind + ":" + (resource.key || "")}
            resource={resource} disabled={blocked || configDirty || !configured || !!config?.autoEnabled || typeof service?.recoverHierarchyResource !== "function"}
            onRecover={options => run("恢复层级资源关联", () => service.recoverHierarchyResource(options), "已校验并恢复资源关联。请继续迁移，完成后再手动开启自动同步。")} />)}
        </section>}
        {!hierarchyReady && <div className="feishu-sync--migration">
          <p className="feishu-sync--notice">{migrationState === "migrating" ? "迁移尚未完成，自动同步暂不可开启。处理下方提示后继续迁移。" : "先启用新层级；有旧记录时将进入迁移流程。迁移完成后再手动开启自动同步。"}</p>
          {hierarchy?.migration && <p className="feishu-sync--hint">旧版关联记录：{Number(hierarchy.migration.legacyProjects || 0)} 个项目，{Number(hierarchy.migration.legacyTasks || 0)} 条行动。</p>}
          {hierarchy?.migration?.message && <p className="feishu-sync--notice">{hierarchy.migration.message}</p>}
          {config?.autoEnabled && <p className="feishu-sync--notice">请先在连接设置关闭自动同步并保存，再开始或继续迁移。</p>}
          <button className="feishu-sync--button feishu-sync--primary" type="button"
            disabled={blocked || configDirty || !configured || !!config?.autoEnabled || !hierarchy || typeof service?.migrateVault !== "function"}
            onClick={migrateVault}>{migrationButton}</button>
        </div>}
      </section>
      <section className="feishu-sync--automation" aria-label="当前仓库同步状态">
        <div className="feishu-sync--taskTop">
          <h3 className="feishu-sync--subtitle">同步状态</h3>
          <span className="feishu-sync--status" role="status">{autoLabel}</span>
        </div>
        <dl className="feishu-sync--syncFacts">
          <div><dt>同步范围</dt><dd><code>{scopeLabel(config || {})}</code></dd></div>
          <div><dt>检查间隔</dt><dd>{config?.pollMinutes ?? 2} 分钟</dd></div>
          <div><dt>最近同步</dt><dd>{lastRun && !Number.isNaN(lastRun.getTime()) ? lastRun.toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" }) : "尚未同步"}</dd></div>
        </dl>
        <div className="feishu-sync--actions">
          <button className="feishu-sync--button feishu-sync--primary" type="button" disabled={blocked || configDirty || !configured || !hierarchyReady}
            onClick={syncVault}><FeishuIcon name="refresh-cw" />{autoStatus?.running || busy ? "正在同步…" : "立即同步此仓库"}</button>
          <button className="feishu-sync--button" type="button" disabled={blocked || configDirty || !service}
            onClick={previewVault}><FeishuIcon name="scan-line" />预览同步范围</button>
        </div>
        {autoStatus?.summary && <p className="feishu-sync--runSummary">上次结果：成功 {Number(autoStatus.summary.synced || 0)}，失败 {Number(autoStatus.summary.failed || 0)}，跳过 {Number(autoStatus.summary.skipped || 0)}</p>}
        {feishuGlobalSyncError(autoStatus) && syncIssues.length > 0 && <p className="feishu-sync--error" role="alert">{feishuGlobalSyncError(autoStatus)}</p>}
        <FeishuSyncIssues issues={syncIssues} loading={issuesLoading} error={issuesError} actionError={issueActionError}
          autoStatus={autoStatus} disabled={blocked || !service} conflictDisabled={configDirty || !configured}
          onView={viewIssue} onOpen={openIssueNote} onConflict={readConflict} />
        {config?.autoEnabled && !autoStatus?.available && <p className="feishu-sync--notice">请在 Obsidian 第三方插件中启用「飞书任务联动」。当前仍可点击「立即同步此仓库」。</p>}
        {scopePreview && <div className="feishu-sync--scopePreview" role="status">
          <span><strong>{Number(scopePreview.projects || 0)}</strong> 个项目</span>
          <span><strong>{Number(scopePreview.taskNotes || 0)}</strong> 篇额外笔记</span>
          <span>合计 <strong>{Number(scopePreview.tasks || 0)}</strong> 条行动</span>
          <span>其中 <strong>{Number(scopePreview.dailyTasks || 0)}</strong> 条日记行动</span>
          {scopePreview.scopeLabel && <p className="feishu-sync--hint">{scopePreview.scopeLabel}</p>}
          {(scopePreview.warnings || []).map(warning => <p className="feishu-sync--notice" key={warning}>{warning}</p>)}
        </div>}
      </section>
      </div>
      {conflict && <FeishuTaskConflict conflict={conflict} disabled={blocked || configDirty || !configured} panelRef={conflictPanelRef}
        onChoose={choice => setConflict(current => current?.preview ? { ...current, choice, error: "" } : current)}
        onReload={() => readConflict(conflict.target)} onConfirm={confirmConflict} onCancel={cancelConflict} />}
      {conflictMessage && <p className="feishu-sync--message" role="status">{conflictMessage}</p>}
      {!configured && service && section === "overview" && <p className="feishu-sync--notice">先保存连接设置，再启用层级或同步。<button className="feishu-sync--textButton" type="button" onClick={() => setSection("connection")}>填写连接设置</button></p>}
      {configDirty && <p className="feishu-sync--notice">配置有未保存的修改，请先保存再手动操作；后台仍按上次保存的配置运行。</p>}
      <div className="feishu-sync--panel" hidden={section !== "notes"}>
        <div className="feishu-sync--pageHeading"><h3>行动检查</h3><p>查看单篇笔记、核对关联并处理冲突。</p></div>
      <form className="feishu-sync--selection" onSubmit={choose}>
        <label className="feishu-sync--label" htmlFor={listId.current + "-input"}>单篇笔记检查／异常处理</label>
        <div className="feishu-sync--selectionRow">
          <input id={listId.current + "-input"} className="feishu-sync--input" type="text" list={listId.current} value={candidate} disabled={blocked}
            spellCheck={false} placeholder="搜索同步笔记的完整路径" onChange={event => setCandidate(event.target.value)} />
          <datalist id={listId.current}>{suggestions.map(file => <option key={file} value={file} />)}</datalist>
          <button className="feishu-sync--button" type="submit" disabled={blocked || !service || !candidate.trim()}>查看行动</button>
          <button className="feishu-sync--button" type="button" disabled={blocked || !path || reading} onClick={() => { setError(""); refresh(); }}>刷新本地</button>
        </div>
      </form>
      {busy && <p className="feishu-sync--hint" role="status">正在{busy}…</p>}
      {reading && <p className="feishu-sync--hint" role="status">正在读取本地行动…</p>}
      {note && <section className="feishu-sync--note" ref={noteRef} tabIndex={-1}>
        <h3 className="feishu-sync--subtitle">{path.split("/").pop().replace(/\.md$/, "")}</h3>
        <p className="feishu-sync--hint">{path}</p>
        {selectedTaskId && !tasks.some(task => (task.id || task.record?.id) === selectedTaskId) && <p className="feishu-sync--notice">该行动暂未在这篇笔记中找到。请核对行动是否已移动、改写或删除；原同步记录仍保留。</p>}
        <div className="feishu-sync--actions">
          <button className="feishu-sync--button" type="button" disabled={remoteBlocked}
            onClick={() => run("检查此笔记已关联行动", () => service.syncAll(path), batchMessage)}>同步此笔记已关联行动</button>
        </div>
        {note.isProject && <div className="feishu-sync--project">
          <div className="feishu-sync--projectMeta">
            <span>area 分组：<strong>{note.areaName || "未设置 area"}</strong></span>
            <span>独立项目状态：<strong>{projectStatusNames[note.projectStatus] || "未设置"}</strong>{note.projectStatus && <code> {note.projectStatus}</code>}</span>
          </div>
          <div className="feishu-sync--recordSummary">
            <span>项目父任务：{parentStateLabel}</span>
            {parentUrl && <a className="feishu-sync--link" href={parentUrl} target="_blank" rel="noopener noreferrer">在飞书打开父任务 ↗</a>}
            {parentRecord?.message && <p className="feishu-sync--notice">{parentRecord.message}</p>}
            {parentStatusConflict && <p className="feishu-sync--hint">先在原笔记与飞书父任务核对并统一项目状态，再点击「同步项目」。下方的冲突对比仅处理 checkbox 子任务。</p>}
          </div>
          <div className="feishu-sync--actions">
            <button className="feishu-sync--button feishu-sync--primary" type="button" disabled={remoteBlocked || !hierarchyReady || typeof service?.syncProject !== "function"}
              onClick={() => run("同步项目与子任务", () => service.syncProject(path), batchMessage)}>同步项目与 {projectActionCount} 条子任务</button>
          </div>
          <p className="feishu-sync--hint">同步项目父任务、area 分组、独立状态字段，以及本笔记所有普通 checkbox。空项目也可同步。已完成或已取消会关闭父任务，结束项目不会批量结束行动。</p>
          {note.projectStatus === "canceled" && <p className="feishu-sync--hint">已取消项目若在飞书重开会提示冲突；需要恢复时，先在 Obsidian 明确改为待办（todo）或进行中（doing）。</p>}
          <p className="feishu-sync--hint">批量同步不使用下方单条截止与提醒设置。</p>
          {legacyListGuid && <details className="feishu-sync--details">
            <summary>旧版项目清单记录</summary>
            <p className="feishu-sync--hint">旧清单 GUID：<code>{legacyListGuid}</code>。迁移由顶部入口处理；迁移完成后还需在飞书界面归档旧清单，此处仅保留关联历史。</p>
          </details>}
        </div>}
        {note.kind === "task" && <div className="feishu-sync--actions">
          <button className="feishu-sync--button feishu-sync--primary" type="button" disabled={remoteBlocked || !hierarchyReady}
            onClick={() => run("同步笔记行动", () => service.syncVault({ paths: [path] }), batchMessage)}>同步此笔记全部行动</button>
          <span className="feishu-sync--hint">行动进入当前仓库清单。</span>
        </div>}
        {note.kind === "daily" && !config?.defaultTasklistGuid && <p className="feishu-sync--notice">日记行动发送前，请先在账号配置填写默认清单 GUID。</p>}
        <details className="feishu-sync--details">
          <summary>单条首次发送：截止时间与提醒（可选）</summary>
          <fieldset className="feishu-sync--fieldset feishu-sync--schedule" disabled={blocked}>
            <label className="feishu-sync--label">截止时间（上海时间 UTC+8）
              <input className="feishu-sync--input" type="datetime-local" value={due} onChange={event => setDue(event.target.value)} />
            </label>
            <label className="feishu-sync--label">提前提醒（分钟）
              <input className="feishu-sync--input" type="number" min="1" max="40320" step="1" value={reminder}
                placeholder="留空不设置提醒" onChange={event => setReminder(event.target.value)} />
            </label>
          </fieldset>
          <p className="feishu-sync--hint">只用于下面单条发送（项目为子任务），不会修改已关联任务的截止时间。提醒需要先设置截止时间。</p>
        </details>
        <ul className="feishu-sync--tasks">{tasks.map(task => <FeishuAction key={path + ":" + task.line + ":" + (task.vaultId || "") + ":" + (task.id || "")} task={task} isProject={note.isProject}
          disabled={remoteBlocked} sendDisabled={!hierarchyReady || (note.kind === "daily" && !config?.defaultTasklistGuid)} highlighted={selectedTaskId ? selectedTaskId === (task.id || task.record?.id) : selectedLine === task.line}
          onSend={send} onSync={sync} onConflict={readConflict} onRecover={(id, guid) => run("恢复任务关联", () => service.recoverTask(id, guid), "已校验并恢复任务关联。请查看当前状态。")} />)}</ul>
        {!tasks.length && <p className="feishu-sync--empty">{note.isProject ? "此项目暂时没有 checkbox，仍可同步父任务、分组和项目状态。" : "这篇笔记没有行动，添加 checkbox 后再刷新。"}</p>}
      </section>}
      {!path && <div className="feishu-sync--empty"><FeishuIcon name="file-search" /><h4>选择一篇同步笔记</h4><p>输入笔记路径，查看行动与飞书的关联状态。</p></div>}
      </div>
      <div className="feishu-sync--panel" hidden={section !== "connection"}>
        {service && <FeishuConfig controller={configEditor} disabled={blocked} />}
      </div>
      <div className="feishu-sync--panel" hidden={section !== "transfer"}>
        {service && <FeishuTransfer service={service} saved={configEditor.saved} disabled={!!busy || configEditor.dirty || !!configEditor.busy || !!autoStatus?.running}
          onBusy={configEditor.onTransferBusy} />}
      </div>
      <div className="feishu-sync--panel" hidden={section !== "help"}>
        <div className="feishu-sync--pageHeading"><h3>使用帮助</h3><p>完成首次连接，了解同步与跨设备使用规则。</p></div>
        <FeishuHelp />
      </div>
      <footer className="feishu-sync--footer"><FeishuIcon name="hard-drive" />配置保存在本机，笔记维护标题和说明。</footer>
    </div>
  );
}

class PanelBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <div className="feishu-sync--root"><p className="feishu-sync--error" role="alert">面板加载失败，请关闭面板并重新打开；如仍失败，请重载飞书插件。</p></div>
      : this.props.children;
  }
}

export function FeishuPanel({ runtime, navigation }) {
  return <PanelBoundary><Runtime.Provider value={runtime}><App navigation={navigation} /></Runtime.Provider></PanelBoundary>;
}

function SettingsContent() {
  const { plugin } = useRuntime();
  const [running, setRunning] = useState(() => !!plugin.getAutoStatus().running);
  useEffect(() => {
    const ref = plugin.app.workspace.on('feishu-sync:auto-status', status => setRunning(!!status.running));
    return () => plugin.app.workspace.offref(ref);
  }, [plugin]);
  const controller = useFeishuConfig(plugin.service, running);
  return <div className="feishu-sync--root feishu-sync--settingsPage">
    <FeishuConfig controller={controller} disabled={running} />
    <div className="feishu-sync--actions">
      <button className="feishu-sync--button" type="button" onClick={() => plugin.openPanel(undefined, undefined, 'overview')}>打开同步概览</button>
      <button className="feishu-sync--button" type="button" onClick={() => plugin.openPanel(undefined, undefined, 'transfer')}>跨设备接入</button>
      <button className="feishu-sync--button" type="button" onClick={() => plugin.openPanel(undefined, undefined, 'help')}>使用帮助</button>
    </div>
  </div>;
}

export function FeishuSettings({ runtime }) {
  return <PanelBoundary><Runtime.Provider value={runtime}><SettingsContent /></Runtime.Provider></PanelBoundary>;
}
