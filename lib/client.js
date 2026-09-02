window.__ModuleLoader__.load({
	id: "dsh-hippocampus",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region src/client/react.ts
		const React = require("react");
		const h = React.createElement;
		const useState = React.useState;
		const useEffect = React.useEffect;
		React.useMemo;
		const useCallback = React.useCallback;
		React.useRef;
		//#endregion
		//#region src/client/locales.ts
		/** Locale dictionaries for the hippocampus memory panels. */
		const NS = "hippocampus";
		/** Simplified Chinese dictionary (key-set source of truth). */
		const zh = {
			"view.memory": "记忆",
			"session.empty": "当前会话暂无相关记忆",
			"session.emptyAll": "还没有任何记忆，让模型记住一些事实后会显示在这里",
			"session.noRecalls": "本会话尚未召回任何记忆",
			"session.recent": "最近召回",
			"session.project": "项目记忆",
			"session.user": "全局记忆",
			"session.loading": "加载中…",
			"session.error": "加载失败",
			"session.recalled": "召回了 {count} 次",
			"settings.title": "记忆管理",
			"settings.globalMemory": "全局记忆",
			"settings.projectMemory": "项目记忆",
			"settings.searchPlaceholder": "搜索记忆…",
			"settings.delete": "删除",
			"settings.deleted": "已删除",
			"settings.empty": "暂无记忆，让模型记住一些事实后会显示在这里",
			"settings.confirmDelete": "确定删除这条记忆？",
			"settings.deleteFailed": "删除失败，记忆可能已被移除或不存在",
			"settings.maintain": "整理记忆",
			"settings.maintaining": "整理中…",
			"settings.maintainFailed": "整理失败",
			"settings.showAudit": "清理记录",
			"settings.hideAudit": "收起清理记录",
			"settings.auditEmpty": "暂无清理记录",
			"settings.restore": "恢复",
			"settings.restoreFailed": "恢复失败，记录可能已存在或项目已移除",
			"common.scopeProject": "项目",
			"common.scopeUser": "全局"
		};
		/** English dictionary. */
		const en = {
			"view.memory": "Memory",
			"session.empty": "No relevant memory for this session",
			"session.emptyAll": "No memory yet; ask the agent to remember facts and they will appear here",
			"session.noRecalls": "No memory recalled in this session yet",
			"session.recent": "Recently recalled",
			"session.project": "Project memory",
			"session.user": "User memory",
			"session.loading": "Loading…",
			"session.error": "Failed to load",
			"session.recalled": "Recalled {count}",
			"settings.title": "Memory management",
			"settings.globalMemory": "Global memory",
			"settings.projectMemory": "Project memory",
			"settings.searchPlaceholder": "Search memory…",
			"settings.delete": "Delete",
			"settings.deleted": "Deleted",
			"settings.empty": "No memory yet; ask the agent to remember facts and they will appear here",
			"settings.confirmDelete": "Delete this memory record?",
			"settings.deleteFailed": "Delete failed; the memory may have been removed already",
			"settings.maintain": "Tidy memory",
			"settings.maintaining": "Tidying…",
			"settings.maintainFailed": "Tidy failed",
			"settings.showAudit": "Cleanup log",
			"settings.hideAudit": "Hide cleanup log",
			"settings.auditEmpty": "No cleanup records yet",
			"settings.restore": "Restore",
			"settings.restoreFailed": "Restore failed; the record may already exist or its project was removed",
			"common.scopeProject": "Project",
			"common.scopeUser": "User"
		};
		//#endregion
		//#region src/client/api.ts
		/** Error envelope thrown on a non-ok response. */
		var MemoryApiClientError = class extends Error {
			code;
			constructor(code, message) {
				super(message);
				this.code = code;
			}
		};
		/** POST one /memory/api/<method> call with a JSON body. */
		async function call(method, body) {
			let res;
			try {
				res = await fetch(`/memory/api/${method}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body)
				});
			} catch (error) {
				throw new MemoryApiClientError("network", `memory api unreachable: ${String(error)}`);
			}
			const record = await res.json().catch(() => null) ?? {};
			if (!res.ok || record["ok"] === false) throw new MemoryApiClientError(String(record["code"] ?? "error"), String(record["message"] ?? `memory api failed (${res.status})`));
			return record;
		}
		/** List records in one scope for one session's workspace. */
		function listRecords(sessionId, scope, workspace) {
			return call("list", {
				sessionId,
				scope,
				...workspace === void 0 ? {} : { workspace }
			});
		}
		/** Search memory across scopes for one session's workspace. */
		function searchMemory(sessionId, query, limit = 20, workspace) {
			return call("search", {
				sessionId,
				query,
				limit,
				...workspace === void 0 ? {} : { workspace }
			});
		}
		/** Recent recalls for one session (aggregated by record, newest first). */
		function fetchRecalls(sessionId, limit = 20, workspace) {
			return call("recalls", {
				sessionId,
				limit,
				...workspace === void 0 ? {} : { workspace }
			});
		}
		/** Delete one record by id. */
		function deleteRecord(sessionId, id, workspace) {
			return call("delete", {
				sessionId,
				id,
				...workspace === void 0 ? {} : { workspace }
			});
		}
		/** Grouped memory for the settings panel (user-global + per-workspace + ungrouped). */
		function fetchGroups(sessionId) {
			return call("groups", { sessionId });
		}
		/** Run maintenance manually (settings button); returns removed count + audit. */
		function runMaintenance(sessionId) {
			return call("maintain", { sessionId });
		}
		/** Read the maintenance audit trail. */
		function fetchAudit(sessionId) {
			return call("audit", { sessionId });
		}
		/** Restore one deleted record from the audit trail. */
		function restoreRecord(sessionId, id) {
			return call("restore", {
				sessionId,
				id
			});
		}
		//#endregion
		//#region \0dsh-css:/Users/vinsonruan/Documents/workspace/deepseek/dsh-projects/dsh-hippocampus/src/client/hippocampus.module.css.mjs
		const css = ".PENlZa_root{color:var(--dsw-alias-label-primary,currentColor);box-sizing:border-box;background:var(--dsw-alias-bg-layer-1,#1e1e1e);flex-direction:column;flex:auto;height:100%;min-height:0;padding:12px;font-size:13px;line-height:1.5;display:flex;overflow-y:auto}[data-conversation-scroll]:has([data-hippocampus-view])>[data-composer-seat]{display:none}.PENlZa_section{flex-shrink:0;margin-bottom:16px}.PENlZa_sectionTitle{letter-spacing:.02em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#999);align-items:center;gap:8px;margin-bottom:8px;font-size:12px;font-weight:600;display:flex}.PENlZa_sectionCount{color:var(--dsw-alias-label-tertiary,#777);background:var(--dsw-alias-fill-subtle,#7f7f7f14);border-radius:999px;padding:0 7px;font-size:11px;font-weight:500;line-height:1.6}.PENlZa_recallList{flex-direction:column;padding-right:4px;display:flex}.PENlZa_projectList{flex-direction:column;display:flex}.PENlZa_legend{gap:16px;margin-bottom:12px;padding-left:2px;display:flex}.PENlZa_legendItem{color:var(--dsw-alias-label-tertiary,#999);align-items:center;gap:6px;font-size:11px;display:inline-flex}.PENlZa_legendSwatch{border-radius:2px;width:9px;height:9px;display:inline-block}.PENlZa_legendRecall{background:var(--dsw-alias-state-info-primary,#4da3ff)}.PENlZa_legendProject{background:var(--dsw-alias-state-success-primary,#4caf7d)}.PENlZa_recordRow{border-left:3px solid #0000;border-bottom:1px solid var(--dsw-alias-border-subtle,#7f7f7f1f);background:0 0;border-radius:6px;align-items:flex-start;padding:0;transition:background .12s;display:flex;overflow:hidden}.PENlZa_recordRow:last-child{border-bottom:none}.PENlZa_recordRow:hover{background:var(--dsw-alias-fill-subtle,#7f7f7f14)}.PENlZa_barRecall{border-left-color:var(--dsw-alias-state-info-primary,#4da3ff)}.PENlZa_barProject{border-left-color:var(--dsw-alias-state-success-primary,#4caf7d)}.PENlZa_recordBody{flex:1;min-width:0;padding:10px 12px}.PENlZa_recordHead{align-items:flex-start;gap:8px;min-width:0;display:flex}.PENlZa_recordText{color:var(--dsw-alias-label-primary,currentColor);text-overflow:ellipsis;overflow-wrap:anywhere;word-break:break-word;-webkit-line-clamp:2;-webkit-box-orient:vertical;min-width:0;font-size:13px;display:-webkit-box;overflow:hidden}.PENlZa_recordMeta{color:var(--dsw-alias-label-tertiary,#777);align-items:center;gap:8px;margin-top:4px;font-size:11px;display:flex}.PENlZa_metaTime{color:var(--dsw-alias-label-tertiary,#777);font-variant-numeric:tabular-nums}.PENlZa_emptyHint{color:var(--dsw-alias-label-tertiary,#777);padding:6px 2px;font-size:12px}.PENlZa_emptyState{text-align:center;color:var(--dsw-alias-label-tertiary,#777);margin-top:24px;font-size:13px}.PENlZa_settingsRoot{max-width:720px;color:var(--dsw-alias-label-primary,currentColor);padding:20px 24px}.PENlZa_settingsTitle{color:var(--dsw-alias-label-primary,currentColor);margin:0 0 4px;font-size:18px;font-weight:600}.PENlZa_settingsHeader{justify-content:space-between;align-items:center;gap:16px;margin-bottom:12px;display:flex}.PENlZa_settingsActions{flex-shrink:0;gap:8px;display:flex}.PENlZa_maintainBtn,.PENlZa_auditBtn{border:1px solid var(--dsw-alias-border-subtle,#7f7f7f2e);color:var(--dsw-alias-label-secondary,#999);cursor:pointer;background:0 0;border-radius:6px;padding:5px 12px;font-size:12px;transition:color .12s,border-color .12s,background .12s}.PENlZa_maintainBtn:hover:not(:disabled),.PENlZa_auditBtn:hover{color:var(--dsw-alias-label-primary,currentColor);border-color:var(--dsw-alias-state-info-primary,#4da3ff)}.PENlZa_maintainBtn:disabled{opacity:.6;cursor:default}.PENlZa_settingsGroups{flex-direction:column;gap:10px;display:flex}.PENlZa_settingsGroup{border:1px solid var(--dsw-alias-border-subtle,#7f7f7f26);border-radius:10px;overflow:hidden}.PENlZa_settingsGroupHead{background:var(--dsw-alias-fill-subtle,#7f7f7f0f);cursor:pointer;text-align:left;box-sizing:border-box;border:none;align-items:center;gap:10px;width:100%;padding:10px 14px;font-family:inherit;transition:background .12s;display:flex}.PENlZa_settingsGroupHead:hover{background:var(--dsw-alias-fill-subtle,#7f7f7f1a)}.PENlZa_chevron{color:var(--dsw-alias-label-tertiary,#777);flex:none;font-size:10px;transition:transform .15s;display:inline-block;transform:rotate(0)}.PENlZa_chevronOpen{transform:rotate(90deg)}.PENlZa_settingsGroupTitle{min-width:0;color:var(--dsw-alias-label-primary,currentColor);flex:1;font-size:13px;font-weight:600}.PENlZa_settingsGroupCount{color:var(--dsw-alias-label-tertiary,#777);flex:none;font-size:12px;font-weight:500}.PENlZa_settingsGroupBody{padding:4px 0}.PENlZa_searchBox{box-sizing:border-box;width:100%;color:var(--dsw-alias-label-primary,currentColor);background:var(--dsw-alias-bg-layer-2,#7f7f7f0a);border:1px solid var(--dsw-alias-border-subtle,#7f7f7f2e);border-radius:8px;outline:none;margin-bottom:16px;padding:7px 12px;font-size:13px;transition:border-color .12s,box-shadow .12s}.PENlZa_searchBox::placeholder{color:var(--dsw-alias-label-tertiary,#777)}.PENlZa_searchBox:focus{border-color:var(--dsw-alias-state-info-primary,#4da3ff);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-info-primary,#4da3ff) 18%, transparent)}.PENlZa_settingsRow{border-left:3px solid #0000;border-bottom:1px solid var(--dsw-alias-border-subtle,#7f7f7f1f);background:0 0;border-radius:0;align-items:flex-start;padding:0;transition:background .12s;display:flex;position:relative}.PENlZa_settingsRow:last-child{border-bottom:none}.PENlZa_settingsRow:hover{background:var(--dsw-alias-fill-subtle,#7f7f7f0f)}.PENlZa_settingsRow:hover .PENlZa_deleteBtn{opacity:1}.PENlZa_settingsRowProject{border-left-color:var(--dsw-alias-state-info-primary,#4da3ff)}.PENlZa_settingsRowUser{border-left-color:var(--dsw-alias-state-success-primary,#4caf7d)}.PENlZa_settingsRowBody{flex:1;min-width:0;padding:10px 12px}.PENlZa_settingsRowText{min-width:0;color:var(--dsw-alias-label-primary,currentColor);text-overflow:ellipsis;overflow-wrap:anywhere;word-break:break-word;-webkit-line-clamp:2;-webkit-box-orient:vertical;flex:1;font-size:13px;line-height:1.45;display:-webkit-box;overflow:hidden}.PENlZa_deleteBtn{border:1px solid var(--dsw-alias-border-subtle,#7f7f7f2e);color:var(--dsw-alias-label-secondary,#999);cursor:pointer;opacity:0;background:0 0;border-radius:6px;flex:none;align-self:center;margin-right:10px;padding:4px 10px;font-size:12px;transition:opacity .12s,color .12s,border-color .12s,background .12s}.PENlZa_deleteBtn:hover{color:var(--dsw-alias-state-danger-primary,#e5484d);border-color:color-mix(in srgb, var(--dsw-alias-state-danger-primary,#e5484d) 40%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-danger-primary,#e5484d) 10%, transparent)}.PENlZa_settingsError{color:var(--dsw-alias-state-danger-primary,#e5484d);margin-bottom:10px;font-size:13px}.PENlZa_settingsHint{color:var(--dsw-alias-label-tertiary,#777);padding:12px 2px;font-size:13px}.PENlZa_auditPanel{border:1px solid var(--dsw-alias-border-subtle,#7f7f7f2e);background:var(--dsw-alias-bg-layer-2,#7f7f7f0a);border-radius:8px;max-height:260px;margin-bottom:16px;padding:10px 12px;overflow-y:auto}.PENlZa_auditEntry{border-bottom:1px solid var(--dsw-alias-border-subtle,#7f7f7f1a);padding:6px 0}.PENlZa_auditEntry:last-child{border-bottom:none}.PENlZa_auditEntryHead{align-items:center;gap:8px;display:flex}.PENlZa_auditTime{color:var(--dsw-alias-label-tertiary,#777);font-size:11px}.PENlZa_auditLayer{background:var(--dsw-specific-sidebar-nav-item-hover,#f0f1f2);color:var(--dsw-alias-label-secondary,#999);border-radius:4px;padding:1px 6px;font-size:10px;font-weight:600}.PENlZa_auditReason{color:var(--dsw-alias-label-secondary,#999);margin-top:2px;font-size:12px}.PENlZa_auditRemoved{color:var(--dsw-alias-label-primary,currentColor);flex-direction:column;gap:4px;margin:4px 0 0;font-size:12px;display:flex}.PENlZa_auditRemovedItem{background:var(--dsw-alias-bg-layer-2,#7f7f7f0a);border-left:2px solid var(--dsw-alias-state-info-primary,#4da3ff);border-radius:4px;align-items:flex-start;gap:8px;padding:4px 8px;display:flex}.PENlZa_auditRemovedText{word-break:break-word;flex:1;min-width:0;line-height:1.5}.PENlZa_restoreBtn{border:1px solid var(--dsw-alias-border-subtle,#7f7f7f2e);color:var(--dsw-alias-state-info-primary,#4da3ff);cursor:pointer;background:0 0;border-radius:4px;flex:none;padding:2px 8px;font-size:11px;transition:color .12s,border-color .12s,background .12s}.PENlZa_restoreBtn:hover{background:color-mix(in srgb, var(--dsw-alias-state-info-primary,#4da3ff) 10%, transparent);border-color:var(--dsw-alias-state-info-primary,#4da3ff)}";
		const tagId = "dsh-hippocampus/hippocampus.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-hippocampus";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var hippocampus_module_css_default = {
			"auditBtn": "PENlZa_auditBtn",
			"auditEntry": "PENlZa_auditEntry",
			"auditEntryHead": "PENlZa_auditEntryHead",
			"auditLayer": "PENlZa_auditLayer",
			"auditPanel": "PENlZa_auditPanel",
			"auditReason": "PENlZa_auditReason",
			"auditRemoved": "PENlZa_auditRemoved",
			"auditRemovedItem": "PENlZa_auditRemovedItem",
			"auditRemovedText": "PENlZa_auditRemovedText",
			"auditTime": "PENlZa_auditTime",
			"barProject": "PENlZa_barProject",
			"barRecall": "PENlZa_barRecall",
			"chevron": "PENlZa_chevron",
			"chevronOpen": "PENlZa_chevronOpen",
			"deleteBtn": "PENlZa_deleteBtn",
			"emptyHint": "PENlZa_emptyHint",
			"emptyState": "PENlZa_emptyState",
			"legend": "PENlZa_legend",
			"legendItem": "PENlZa_legendItem",
			"legendProject": "PENlZa_legendProject",
			"legendRecall": "PENlZa_legendRecall",
			"legendSwatch": "PENlZa_legendSwatch",
			"maintainBtn": "PENlZa_maintainBtn",
			"metaTime": "PENlZa_metaTime",
			"projectList": "PENlZa_projectList",
			"recallList": "PENlZa_recallList",
			"recordBody": "PENlZa_recordBody",
			"recordHead": "PENlZa_recordHead",
			"recordMeta": "PENlZa_recordMeta",
			"recordRow": "PENlZa_recordRow",
			"recordText": "PENlZa_recordText",
			"restoreBtn": "PENlZa_restoreBtn",
			"root": "PENlZa_root",
			"searchBox": "PENlZa_searchBox",
			"section": "PENlZa_section",
			"sectionCount": "PENlZa_sectionCount",
			"sectionTitle": "PENlZa_sectionTitle",
			"settingsActions": "PENlZa_settingsActions",
			"settingsError": "PENlZa_settingsError",
			"settingsGroup": "PENlZa_settingsGroup",
			"settingsGroupBody": "PENlZa_settingsGroupBody",
			"settingsGroupCount": "PENlZa_settingsGroupCount",
			"settingsGroupHead": "PENlZa_settingsGroupHead",
			"settingsGroupTitle": "PENlZa_settingsGroupTitle",
			"settingsGroups": "PENlZa_settingsGroups",
			"settingsHeader": "PENlZa_settingsHeader",
			"settingsHint": "PENlZa_settingsHint",
			"settingsRoot": "PENlZa_settingsRoot",
			"settingsRow": "PENlZa_settingsRow",
			"settingsRowBody": "PENlZa_settingsRowBody",
			"settingsRowProject": "PENlZa_settingsRowProject",
			"settingsRowText": "PENlZa_settingsRowText",
			"settingsRowUser": "PENlZa_settingsRowUser",
			"settingsTitle": "PENlZa_settingsTitle"
		};
		//#endregion
		//#region src/client/SessionPanel.ts
		/**
		* Session memory panel: the current session's project memory plus the
		* records the model actually recalled (injected) in this session.
		*
		* "Recent recalls" is a scrollable list capped at 20 aggregated records,
		* so scrolling through it never pushes the project-memory section off the
		* panel. Global (user-scope) memory is managed in the Settings page and only
		* surfaces here when it was actually recalled by the model.
		*/
		/** Compact relative-time label ("3 min ago" / "2 d ago"); falls back to empty. */
		function relativeTime(ts, now) {
			const diff = Math.max(0, now - ts);
			const min = Math.floor(diff / 6e4);
			if (min < 1) return "";
			if (min < 60) return `${min} min`;
			const hour = Math.floor(min / 60);
			if (hour < 24) return `${hour} h`;
			return `${Math.floor(hour / 24)} d`;
		}
		/** One record row: a left color bar (type) + text with optional recall meta. */
		function RecordRow$1({ record, t, meta, bar }) {
			const now = Date.now();
			const timeLabel = meta === void 0 ? "" : relativeTime(meta.lastAt, now);
			return h("div", { className: `${hippocampus_module_css_default.recordRow} ${bar === "recall" ? hippocampus_module_css_default.barRecall : hippocampus_module_css_default.barProject}` }, h("div", { className: hippocampus_module_css_default.recordBody }, h("span", { className: hippocampus_module_css_default.recordText }, record.text), meta !== void 0 && h("div", { className: hippocampus_module_css_default.recordMeta }, h("span", null, `${t("session.recalled", { count: meta.count })}`), timeLabel !== "" && h("span", { className: hippocampus_module_css_default.metaTime }, timeLabel))));
		}
		/** The session memory panel body. */
		function SessionPanel({ sessionId, t }) {
			const [project, setProject] = useState(null);
			const [recalls, setRecalls] = useState(null);
			const [error, setError] = useState(null);
			useEffect(() => {
				let cancelled = false;
				setError(null);
				Promise.all([listRecords(sessionId, "project").catch(() => ({ records: [] })), fetchRecalls(sessionId, 20).catch(() => ({ items: [] }))]).then(([p, r]) => {
					if (cancelled) return;
					setProject(p.records);
					setRecalls(r.items);
				}).catch(() => {
					if (!cancelled) setError(t("session.error"));
				});
				return () => {
					cancelled = true;
				};
			}, [sessionId]);
			const root = {
				className: hippocampus_module_css_default.root,
				"data-hippocampus-view": "",
				"data-conversation-composer-overlay": ""
			};
			if (error !== null) return h("div", {
				...root,
				style: { color: "#c00" }
			}, error);
			if (project === null || recalls === null) return h("div", {
				...root,
				style: { color: "#888" }
			}, t("session.loading"));
			const empty = project.length === 0 && recalls.length === 0;
			const totalRecallCount = recalls.reduce((sum, item) => sum + item.recallCount, 0);
			return h("div", { ...root }, h("div", { className: hippocampus_module_css_default.legend }, h("span", { className: hippocampus_module_css_default.legendItem }, h("i", { className: `${hippocampus_module_css_default.legendSwatch} ${hippocampus_module_css_default.legendRecall}` }), t("session.recent")), h("span", { className: hippocampus_module_css_default.legendItem }, h("i", { className: `${hippocampus_module_css_default.legendSwatch} ${hippocampus_module_css_default.legendProject}` }), t("session.project"))), h("div", { className: hippocampus_module_css_default.section }, h("div", { className: hippocampus_module_css_default.sectionTitle }, t("session.recent"), totalRecallCount > 0 && h("span", { className: hippocampus_module_css_default.sectionCount }, String(totalRecallCount))), recalls.length === 0 ? h("div", { className: hippocampus_module_css_default.emptyHint }, t("session.noRecalls")) : h("div", { className: hippocampus_module_css_default.recallList }, recalls.map((item) => h(RecordRow$1, {
				key: item.id,
				record: item,
				t,
				bar: "recall",
				meta: {
					count: item.recallCount,
					lastAt: item.lastRecalledAt
				}
			})))), h("div", { className: hippocampus_module_css_default.section }, h("div", { className: hippocampus_module_css_default.sectionTitle }, t("session.project"), project.length > 0 && h("span", { className: hippocampus_module_css_default.sectionCount }, String(project.length))), project.length === 0 ? h("div", { className: hippocampus_module_css_default.emptyHint }, t("session.empty")) : h("div", { className: hippocampus_module_css_default.projectList }, project.map((record) => h(RecordRow$1, {
				key: record.id,
				record,
				t,
				bar: "project"
			})))), empty && h("div", { className: hippocampus_module_css_default.emptyState }, t("session.emptyAll")));
		}
		//#endregion
		//#region src/client/SettingsSection.ts
		/**
		* Settings memory-management section: user-global memory first, then one
		* block per workspace's project memory. Search, delete, and counts included.
		* Rendered as a `settings.section` page by the client plugin.
		*/
		/** One record row with a left color bar and a hover-only delete button. */
		function RecordRow({ record, onDelete, t }) {
			return h("div", { className: `${hippocampus_module_css_default.settingsRow} ${record.scope === "user" ? hippocampus_module_css_default.settingsRowUser : hippocampus_module_css_default.settingsRowProject}` }, h("div", { className: hippocampus_module_css_default.settingsRowBody }, h("div", { className: hippocampus_module_css_default.settingsRowText }, record.text)), h("button", {
				type: "button",
				className: hippocampus_module_css_default.deleteBtn,
				onClick: () => {
					const confirm = globalThis.confirm;
					if (confirm?.(t("settings.confirmDelete"))) onDelete(record.id);
				}
			}, t("settings.delete")));
		}
		/** One group block: a collapsible heading (count pill) plus its record rows. */
		function GroupBlock({ title, countLabel, records, onDelete, t, defaultOpen }) {
			const [open, setOpen] = useState(defaultOpen);
			if (records.length === 0) return null;
			return h("div", { className: hippocampus_module_css_default.settingsGroup }, h("button", {
				type: "button",
				className: hippocampus_module_css_default.settingsGroupHead,
				onClick: () => setOpen((value) => !value),
				"aria-expanded": open ? "true" : "false"
			}, h("span", { className: `${hippocampus_module_css_default.chevron} ${open ? hippocampus_module_css_default.chevronOpen : ""}` }, "▸"), h("span", { className: hippocampus_module_css_default.settingsGroupTitle }, title), countLabel !== void 0 ? h("span", { className: hippocampus_module_css_default.settingsGroupCount }, countLabel) : h("span", { className: hippocampus_module_css_default.settingsGroupCount }, String(records.length))), open && h("div", { className: hippocampus_module_css_default.settingsGroupBody }, ...records.map((record) => h(RecordRow, {
				key: record.id,
				record,
				onDelete,
				t
			}))));
		}
		/** The settings memory-management section body. */
		function SettingsSection({ sessionId, workspace, t }) {
			const [groups, setGroups] = useState(null);
			const [query, setQuery] = useState("");
			const [searchResults, setSearchResults] = useState(null);
			const [error, setError] = useState(null);
			const [maintaining, setMaintaining] = useState(false);
			const [showAudit, setShowAudit] = useState(false);
			const [audit, setAudit] = useState(null);
			const loadAudit = useCallback(async () => {
				try {
					const result = await fetchAudit(sessionId);
					setAudit(result.audit);
				} catch {}
			}, [sessionId]);
			const load = useCallback(async (search) => {
				setError(null);
				try {
					if (search.trim() === "") {
						const g = await fetchGroups(sessionId);
						setGroups(g);
						setSearchResults(null);
					} else {
						const hits = await searchMemory(sessionId, search, 50, workspace);
						setSearchResults(hits.hits);
					}
				} catch (e) {
					setError(e instanceof Error ? e.message : t("session.error"));
				}
			}, [
				sessionId,
				workspace,
				t
			]);
			useEffect(() => {
				load("");
			}, [load]);
			const onMaintain = useCallback(async () => {
				if (maintaining) return;
				setMaintaining(true);
				setError(null);
				try {
					const result = await runMaintenance(sessionId);
					setAudit(result.audit);
					await load("");
				} catch (e) {
					setError(e instanceof Error ? e.message : t("settings.maintainFailed"));
				} finally {
					setMaintaining(false);
				}
			}, [
				maintaining,
				sessionId,
				load,
				t
			]);
			const onRestore = useCallback(async (id) => {
				setError(null);
				try {
					if (!(await restoreRecord(sessionId, id)).restored) {
						setError(t("settings.restoreFailed"));
						return;
					}
					await loadAudit();
					await load(query);
				} catch (e) {
					setError(e instanceof Error ? e.message : t("settings.restoreFailed"));
				}
			}, [
				sessionId,
				query,
				load,
				loadAudit,
				t
			]);
			const onDelete = useCallback(async (id) => {
				try {
					if (!(await deleteRecord(sessionId, id, workspace)).deleted) {
						setError(t("settings.deleteFailed"));
						return;
					}
				} catch (e) {
					setError(e instanceof Error ? e.message : t("settings.deleteFailed"));
					return;
				}
				load(query);
				if (showAudit) loadAudit();
			}, [
				sessionId,
				workspace,
				query,
				load,
				loadAudit,
				showAudit,
				t
			]);
			const total = groups === null ? 0 : groups.workspaces.reduce((sum, group) => sum + group.records.length, 0) + groups.user.length;
			return h("div", { className: hippocampus_module_css_default.settingsRoot }, h("div", { className: hippocampus_module_css_default.settingsHeader }, h("h3", { className: hippocampus_module_css_default.settingsTitle }, t("settings.title")), h("div", { className: hippocampus_module_css_default.settingsActions }, h("button", {
				type: "button",
				className: hippocampus_module_css_default.maintainBtn,
				disabled: maintaining,
				onClick: () => {
					onMaintain();
				}
			}, maintaining ? t("settings.maintaining") : t("settings.maintain")), h("button", {
				type: "button",
				className: hippocampus_module_css_default.auditBtn,
				onClick: () => {
					const next = !showAudit;
					setShowAudit(next);
					if (next) loadAudit();
				}
			}, showAudit ? t("settings.hideAudit") : t("settings.showAudit")))), showAudit && audit !== null && h("div", { className: hippocampus_module_css_default.auditPanel }, audit.length === 0 ? h("div", { className: hippocampus_module_css_default.settingsHint }, t("settings.auditEmpty")) : h("div", null, ...audit.map((entry, index) => h("div", {
				key: index,
				className: hippocampus_module_css_default.auditEntry
			}, h("div", { className: hippocampus_module_css_default.auditEntryHead }, h("span", { className: hippocampus_module_css_default.auditTime }, new Date(entry.time).toLocaleString()), h("span", { className: hippocampus_module_css_default.auditLayer }, entry.layer)), h("div", { className: hippocampus_module_css_default.auditReason }, entry.reason), entry.removed.length > 0 && h("div", { className: hippocampus_module_css_default.auditRemoved }, ...entry.removed.map((item) => h("div", {
				key: item.id,
				className: hippocampus_module_css_default.auditRemovedItem
			}, h("span", { className: hippocampus_module_css_default.auditRemovedText }, item.text), h("button", {
				type: "button",
				className: hippocampus_module_css_default.restoreBtn,
				onClick: () => {
					onRestore(item.id);
				}
			}, t("settings.restore"))))))))), h("input", {
				type: "text",
				className: hippocampus_module_css_default.searchBox,
				value: query,
				placeholder: t("settings.searchPlaceholder"),
				onChange: (e) => {
					const value = e.target.value;
					setQuery(value);
					load(value);
				}
			}), error !== null && h("div", { className: hippocampus_module_css_default.settingsError }, error), searchResults !== null ? searchResults.length === 0 ? h("div", { className: hippocampus_module_css_default.settingsHint }, t("settings.empty")) : h("div", { className: hippocampus_module_css_default.settingsGroupBody }, ...searchResults.map((record) => h(RecordRow, {
				key: record.id,
				record,
				onDelete,
				t
			}))) : groups === null ? h("div", { className: hippocampus_module_css_default.settingsHint }, t("session.loading")) : total === 0 ? h("div", { className: hippocampus_module_css_default.settingsHint }, t("settings.empty")) : h("div", { className: hippocampus_module_css_default.settingsGroups }, h(GroupBlock, {
				title: t("settings.globalMemory"),
				records: groups.user,
				onDelete,
				t,
				defaultOpen: true
			}), ...groups.workspaces.map((group) => h(GroupBlock, {
				key: group.path,
				title: t("settings.projectMemory") + " · " + group.title,
				countLabel: String(group.records.length),
				records: group.records,
				onDelete,
				t,
				defaultOpen: false
			}))));
		}
		//#endregion
		//#region src/client/settings-nav-icon.ts
		/**
		* dsh-hippocampus settings-nav icon upgrade (zero upstream modification).
		*
		* The settings shell (ui-settings-general) renders every unknown settings
		* section with a gear glyph (`navIcon`'s fallback) and exposes no slot or
		* option for a plugin to override it. This module patches the rendered DOM
		* instead: when the settings dialog appears, find the nav cell whose label
		* matches the memory section's localized text and swap its gear SVG for the
		* think/brain glyph.
		*
		* The DOM shape relied on is the shell's stable public structure
		* (role=dialog → nav → cells), not its CSS-module class names. A
		* MutationObserver keeps the swap applied across re-renders; a marker
		* attribute makes each cell upgraded exactly once.
		*/
		/** Localized labels the memory section can wear (zh/en dictionaries). */
		const LABELS = ["记忆", "Memory"];
		/** Marker proving one cell was already upgraded (idempotent re-scans). */
		const SWAPPED = "data-hippocampus-nav-swapped";
		/** The ic_ds_think_outline_16 glyph paths (from ui-primitives, stable data). */
		const THINK_PATHS = ["M8.00192 6.64454C8.75026 6.64454 9.35732 7.25169 9.35739 8.00001C9.35739 8.74838 8.7503 9.35548 8.00192 9.35548C7.25367 9.35533 6.64743 8.74829 6.64743 8.00001C6.6475 7.25178 7.25371 6.64468 8.00192 6.64454Z", "M9.97165 1.29981C11.5853 0.718916 13.271 0.642197 14.3144 1.68555C15.3577 2.72902 15.2811 4.41466 14.7002 6.02833C14.4707 6.66561 14.1504 7.32937 13.75 8.00001C14.1504 8.67062 14.4707 9.33444 14.7002 9.97169C15.2811 11.5854 15.3578 13.271 14.3144 14.3145C13.271 15.3579 11.5854 15.2811 9.97165 14.7002C9.3344 14.4708 8.67059 14.1505 7.99997 13.75C7.32933 14.1505 6.66558 14.4708 6.02829 14.7002C4.41461 15.2811 2.72899 15.3578 1.68552 14.3145C0.642155 13.271 0.71887 11.5854 1.29977 9.97169C1.52915 9.33454 1.84865 8.67049 2.24899 8.00001C2.24866 7.32953 1.52915 6.66544 1.29977 6.02833C0.718852 4.41459 0.64207 2.729 1.68552 1.68555C2.72897 0.642112 4.41456 0.718887 6.02829 1.29981C6.66541 1.52918 7.32949 1.8487 7.99997 2.24903C8.67045 1.84869 9.33451 1.52919 9.97165 1.29981ZM12.9404 9.2129C12.4391 9.893 11.8616 10.5681 11.2148 11.2149C10.568 11.8616 9.89296 12.4391 9.21286 12.9404C9.62532 13.1579 10.0271 13.338 10.4121 13.4766C11.9146 14.0174 12.9172 13.8738 13.3955 13.3955C13.8737 12.9173 14.0174 11.9146 13.4765 10.4121C13.3379 10.0271 13.1578 9.62535 12.9404 9.2129ZM3.05856 9.2129C2.84121 9.62523 2.66197 10.0272 2.52341 10.4121C1.98252 11.9146 2.12627 12.9172 2.60446 13.3955C3.08278 13.8737 4.08544 14.0174 5.58786 13.4766C5.97264 13.338 6.37389 13.1577 6.7861 12.9404C6.10624 12.4393 5.43168 11.8614 4.78513 11.2149C4.13823 10.5679 3.55992 9.89313 3.05856 9.2129ZM7.99899 3.792C7.23179 4.31419 6.45306 4.95512 5.70407 5.70411C4.95509 6.45309 4.31415 7.23184 3.79196 7.99903C4.3143 8.76666 4.95471 9.54653 5.70407 10.2959C6.45309 11.0449 7.23271 11.6848 7.99997 12.207C8.76725 11.6848 9.54683 11.0449 10.2959 10.2959C11.0449 9.54686 11.6848 8.76729 12.207 8.00001C11.6848 7.23275 11.0449 6.45312 10.2959 5.70411C9.5465 4.95475 8.76662 4.31434 7.99899 3.792ZM5.58786 2.52344C4.08533 1.98255 3.08272 2.12625 2.60446 2.6045C2.12621 3.08275 1.98252 4.08536 2.52341 5.5879C2.66189 5.97253 2.8414 6.37409 3.05856 6.78614C3.55983 6.10611 4.1384 5.43189 4.78513 4.78516C5.43186 4.13843 6.10606 3.55987 6.7861 3.0586C6.37405 2.84144 5.97249 2.66192 5.58786 2.52344ZM13.3955 2.6045C12.9172 2.12631 11.9146 1.98257 10.4121 2.52344C10.0272 2.66201 9.62519 2.84125 9.21286 3.0586C9.8931 3.55996 10.5679 4.13827 11.2148 4.78516C11.8614 5.43172 12.4392 6.10627 12.9404 6.78614C13.1577 6.37393 13.338 5.97267 13.4765 5.5879C14.0174 4.08549 13.8736 3.08281 13.3955 2.6045Z"];
		/** Whether the nav cell's visible text matches the memory section label. */
		function isMemoryCell(cell) {
			const text = (cell.textContent ?? "").trim();
			return LABELS.some((label) => text === label || text.endsWith(label));
		}
		/** Swap the first svg child of one nav cell with the think glyph. */
		function swapIcon(cell) {
			const svg = cell.querySelector("svg");
			if (svg === null) return;
			const ns = "http://www.w3.org/2000/svg";
			const next = document.createElementNS(ns, "svg");
			next.setAttribute("viewBox", "0 0 16 16");
			next.setAttribute("fill", "none");
			next.setAttribute("xmlns", ns);
			for (const attr of svg.attributes) {
				if (attr.name === "viewBox" || attr.name === "fill" || attr.name === "xmlns") continue;
				next.setAttribute(attr.name, attr.value);
			}
			for (const d of THINK_PATHS) {
				const path = document.createElementNS(ns, "path");
				path.setAttribute("d", d);
				path.setAttribute("fill", "currentColor");
				next.appendChild(path);
			}
			svg.replaceWith(next);
		}
		/** Scan the settings dialog's nav cells and upgrade the memory section. */
		function scanDialog() {
			const dialog = document.querySelector("[role=\"dialog\"]");
			if (dialog === null) return;
			for (const cell of dialog.querySelectorAll("button")) {
				if (cell.hasAttribute(SWAPPED) || !isMemoryCell(cell)) continue;
				cell.setAttribute(SWAPPED, "1");
				swapIcon(cell);
			}
		}
		/** Register the settings-nav icon upgrade (idempotent). */
		function registerSettingsNavIcon() {
			scanDialog();
			if (typeof MutationObserver === "undefined") return;
			new MutationObserver(() => scanDialog()).observe(document.body, {
				childList: true,
				subtree: true
			});
		}
		//#endregion
		//#region src/client/current-workspace.ts
		/**
		* Resolve the current workspace path: the current session's workspace first,
		* then the most recently listed workspace. `undefined` when neither the
		* services nor any workspace are available.
		*/
		function resolveCurrentWorkspace(sessions, workspaces) {
			const items = workspaces?.list.getSnapshot()?.items;
			if (items === void 0 || items.length === 0) return void 0;
			const current = sessions?.list.getSnapshot()?.current;
			if (current !== void 0) {
				const owned = items.find((item) => item.sessionIds.includes(current));
				if (owned !== void 0) return owned.path;
			}
			return items[0]?.path;
		}
		//#endregion
		//#region src/client/index.ts
		/** Required services: the slot system and the locale service. */
		const inject = ["slots", "locale"];
		/** Client plugin body: register the memory panel and settings section. */
		function apply(rawCtx) {
			const ctx = rawCtx;
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-hippocampus: dictionaries");
			const t = ctx.locale.bind(NS);
			registerSettingsNavIcon();
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "hippocampus",
				order: 40,
				locale: NS,
				label: () => t("view.memory"),
				inject: (sessionId) => ({
					sessionId,
					t
				})
			}, (props) => h(SessionPanel, props)));
			const currentWorkspace = () => resolveCurrentWorkspace(ctx.get("sessions"), ctx.get("workspaces"));
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "hippocampus-memory",
				order: 50,
				locale: NS,
				label: () => t("view.memory"),
				inject: (sessionId) => ({
					sessionId,
					workspace: currentWorkspace(),
					t
				})
			}, (props) => h(SettingsSection, props)));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map