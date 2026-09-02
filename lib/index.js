import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
//#region src/store.ts
/**
* dsh-hippocampus storage layer: layered project/user record stores over
* per-record JSON files with atomic writes.
*
* Layout:
*   project layer: <workspace>/.dsh/hippocampus/records/<uuid>.json
*   user layer:    ~/.dsh/hippocampus/records/<uuid>.json
*
* The user layer is capped (maxUserRecords, default 200) with LRU eviction by
* lastAccessedAt; the project layer is uncapped and follows the workspace.
*/
/** Resolve both storage roots from a workspace path and optional config override. */
function resolveRoots(workspace, memoryRoot) {
	const userRoot = resolve(memoryRoot ?? join(homedir(), ".dsh", "hippocampus"));
	return {
		projectRoot: workspace === void 0 ? userRoot : resolve(workspace, ".dsh", "hippocampus"),
		userRoot
	};
}
/** The records directory for one scope. */
function recordsDir(roots, scope) {
	return join(scope === "project" ? roots.projectRoot : roots.userRoot, "records");
}
/** The on-disk path for one record. */
function recordPath(dir, id) {
	return join(dir, `${id}.json`);
}
/** The recall log directory (project layer; follows the workspace). */
function recallsDir(roots) {
	return join(roots.projectRoot, "recalls");
}
/** The recall log file for one session. */
function recallLogPath(roots, sessionId) {
	return join(recallsDir(roots), `${sessionId}.jsonl`);
}
/** Read and validate one record file; `undefined` when missing or malformed. */
async function readRecordFile(path) {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw);
		if (typeof parsed.id !== "string" || typeof parsed.text !== "string" || parsed.scope !== "project" && parsed.scope !== "user") return;
		return parsed;
	} catch {
		return;
	}
}
/** MemoryStore: layered CRUD, recall, dedupe, and user-layer LRU eviction. */
var MemoryStore = class {
	maxUserRecords;
	roots;
	ranker;
	constructor(maxUserRecords, memoryRoot) {
		this.maxUserRecords = maxUserRecords;
		this.roots = resolveRoots(void 0, memoryRoot);
	}
	/** Install a pluggable relevance ranker; the keyword ranker is the default. */
	setRanker(ranker) {
		this.ranker = ranker;
	}
	/**
	* Resolve the roots for one operation: the project layer follows the
	* caller's workspace, the user layer is fixed.
	*/
	rootsFor(workspace) {
		return workspace === void 0 || workspace === this.roots.projectRoot ? this.roots : {
			...this.roots,
			projectRoot: resolve(workspace, ".dsh", "hippocampus")
		};
	}
	/** Ensure both records directories exist for one workspace. */
	async ensure(workspace) {
		const roots = this.rootsFor(workspace);
		await mkdir(recordsDir(roots, "project"), { recursive: true });
		await mkdir(recordsDir(roots, "user"), { recursive: true });
	}
	/** List every record in one scope, newest first. */
	async list(scope, workspace) {
		const dir = recordsDir(this.rootsFor(workspace), scope);
		let files;
		try {
			files = await readdir(dir);
		} catch {
			return [];
		}
		const records = [];
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			const record = await readRecordFile(recordPath(dir, file.slice(0, -5)));
			if (record !== void 0 && record.scope === scope) records.push(record);
		}
		records.sort((a, b) => b.createdAt - a.createdAt);
		return records;
	}
	/** Read one record by id across both scopes. */
	async get(id, workspace) {
		const roots = this.rootsFor(workspace);
		for (const scope of ["project", "user"]) {
			const record = await readRecordFile(recordPath(recordsDir(roots, scope), id));
			if (record !== void 0) return record;
		}
	}
	/** Store one record with an atomic write (temp file + rename). */
	async writeAtomic(roots, scope, record) {
		const dir = recordsDir(roots, scope);
		await mkdir(dir, { recursive: true });
		const target = recordPath(dir, record.id);
		const temp = `${target}.tmp-${randomUUID()}`;
		await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
		await rename(temp, target);
	}
	/** Create one record; a same-scope duplicate by normalized text refreshes instead. */
	async create(scope, input, source, workspace) {
		const roots = this.rootsFor(workspace);
		const now = Date.now();
		const text = input.text.trim();
		const existing = (await this.list(scope, workspace)).find((record) => record.text.toLowerCase() === text.toLowerCase());
		if (existing !== void 0) {
			const refreshed = {
				...existing,
				updatedAt: now
			};
			await this.writeAtomic(roots, scope, refreshed);
			return refreshed;
		}
		const record = {
			id: randomUUID(),
			text,
			scope,
			tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0))],
			source,
			createdAt: now,
			updatedAt: now,
			accessCount: 0
		};
		await this.writeAtomic(roots, scope, record);
		await this.evictUserIfOverCap(workspace);
		return record;
	}
	/**
	* Create one record under an explicit id (used by audit-driven restore so
	* the deleted record keeps its original identity). Skips deduplication and
	* refreshes nothing; throws when a record with that id already exists.
	*/
	async createWithId(id, scope, input, workspace) {
		const roots = this.rootsFor(workspace);
		const now = Date.now();
		const text = input.text.trim();
		if (text.length === 0) throw new Error("memory record text must not be empty");
		const record = {
			id,
			text,
			scope,
			tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0))],
			source: { kind: "explicit" },
			createdAt: now,
			updatedAt: now,
			accessCount: 0
		};
		await this.writeAtomic(roots, scope, record);
		await this.evictUserIfOverCap(workspace);
		return record;
	}
	/** Delete one record across both scopes; resolves true when it existed. */
	async delete(id, workspace) {
		const roots = this.rootsFor(workspace);
		for (const scope of ["project", "user"]) {
			const path = recordPath(recordsDir(roots, scope), id);
			try {
				await rm(path);
				return true;
			} catch {}
		}
		return false;
	}
	/**
	* Delete one record across the user layer and every known workspace root.
	* Used when the executing session's workspace cannot be resolved: a record
	* must never be "unknown" merely because it lives in a different project.
	* @param id - the record id.
	* @param workspaces - registered workspace paths to scan besides the user layer.
	* @returns true when the record was found and removed anywhere.
	*/
	async deleteAnywhere(id, workspaces = []) {
		if (await this.delete(id, void 0)) return true;
		for (const workspace of workspaces) if (await this.delete(id, workspace)) return true;
		return false;
	}
	/** Bump access statistics for one record; used by recall and ranking. */
	async touch(record, workspace) {
		const roots = this.rootsFor(workspace);
		const now = Date.now();
		const updated = {
			...record,
			accessCount: record.accessCount + 1,
			lastAccessedAt: now
		};
		await this.writeAtomic(roots, record.scope, updated);
	}
	/** User-layer LRU eviction: drop the least-recently-accessed records over the cap. */
	async evictUserIfOverCap(workspace) {
		const userRecords = await this.list("user", workspace);
		if (userRecords.length <= this.maxUserRecords) return;
		const excess = [...userRecords].sort((a, b) => (a.lastAccessedAt ?? a.createdAt) - (b.lastAccessedAt ?? b.createdAt)).slice(0, userRecords.length - this.maxUserRecords);
		for (const record of excess) await this.delete(record.id, workspace);
	}
	/** Keyword recall across scopes: project first, then user as fallback. */
	async recall(query, options = {}) {
		const limit = options.limit ?? 5;
		const normalized = query.trim().toLowerCase();
		const scopes = options.scope !== void 0 ? [options.scope] : ["project", "user"];
		let hits = [];
		let projectZero = [];
		const ranker = this.ranker ?? { score: keywordScore };
		for (const scope of scopes) {
			const records = await this.list(scope, options.workspace);
			for (const record of records) {
				const score = normalized.length === 0 ? 1 : ranker.score(record, normalized);
				if (scope === "project" && score === 0 && options.includeProjectFallback === true) projectZero.push({
					record,
					score
				});
				else if (score > 0 || normalized.length === 0) hits.push({
					record,
					score
				});
			}
		}
		if (hits.length === 0 && projectZero.length > 0) hits.push(...projectZero);
		if (ranker.refine !== void 0 && hits.length > 0) {
			const shortlist = hits.slice(0, Math.min(hits.length, limit * 2));
			const refined = await Promise.all(shortlist.map(async (hit) => ({
				record: hit.record,
				score: await ranker.refine(hit.record, normalized)
			})));
			hits.splice(0, shortlist.length, ...refined);
			hits = hits.filter((hit) => hit.score > 0);
		}
		hits.sort((a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt);
		const selected = hits.slice(0, limit);
		for (const hit of selected) await this.touch(hit.record, options.workspace).catch(() => {});
		return selected;
	}
	/**
	* Append one recall entry to a session's recall log (project layer).
	*
	* The log lives next to the records under `<workspace>/.dsh/hippocampus/
	* recalls/<sessionId>.jsonl`, one JSON object per line, append-only — so
	* "recent recalls" is a tail read, and aggregation by record id counts
	* repeat recalls naturally.
	*
	* @param sessionId - the session whose recall log receives the entry.
	* @param recordId - the recalled record id.
	* @param workspace - project-layer root; falls back to the store default.
	* @param query - optional trimmed query that produced the hit.
	*/
	async recordRecall(sessionId, recordId, workspace, query) {
		if (sessionId.length === 0) return;
		const roots = this.rootsFor(workspace);
		const entry = {
			recordId,
			time: Date.now(),
			...query !== void 0 && query.trim().length > 0 ? { query: query.trim() } : {}
		};
		try {
			await mkdir(recallsDir(roots), { recursive: true });
			await appendFile(recallLogPath(roots, sessionId), `${JSON.stringify(entry)}\n`, "utf8");
		} catch {}
	}
	/**
	* Read one session's recall log, aggregated by record id.
	*
	* Entries are consumed newest-first; a record appears once with its total
	* recall count and the timestamp of its most recent recall. Records that
	* were deleted since the recall are dropped from the result.
	*
	* @param sessionId - the session whose recall log is read.
	* @param limit - maximum aggregated records to return (defaults to 20).
	* @param workspace - project-layer root; falls back to the store default.
	* @returns aggregated recalls newest-first, each with the live record.
	*/
	async recallsFor(sessionId, workspace, limit = 20) {
		if (sessionId.length === 0 || limit <= 0) return [];
		const roots = this.rootsFor(workspace);
		let raw;
		try {
			raw = await readFile(recallLogPath(roots, sessionId), "utf8");
		} catch {
			return [];
		}
		const aggregates = /* @__PURE__ */ new Map();
		const lines = raw.split("\n");
		const keep = new Array(lines.length).fill(true);
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index] ?? "";
			if (line.trim() === "") continue;
			let entry;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof entry.recordId !== "string" || typeof entry.time !== "number") continue;
			const record = await this.get(entry.recordId, workspace);
			if (record === void 0) {
				keep[index] = false;
				continue;
			}
			const existing = aggregates.get(entry.recordId);
			if (existing !== void 0) aggregates.set(entry.recordId, {
				record: existing.record,
				count: existing.count + 1,
				lastAt: Math.max(existing.lastAt, entry.time)
			});
			else aggregates.set(entry.recordId, {
				record,
				count: 1,
				lastAt: entry.time
			});
		}
		if (keep.some((value) => !value)) {
			const kept = lines.filter((_, index) => keep[index] ?? true).join("\n");
			try {
				await writeFile(recallLogPath(roots, sessionId), kept, "utf8");
			} catch {}
		}
		return [...aggregates.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, limit);
	}
};
/** Keyword relevance: token overlap over lower-cased text and tags. */
function keywordScore(record, query) {
	const clean = (value) => value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
	const tokens = clean(query).split(/\s+/).filter((token) => token.length > 0);
	if (tokens.length === 0) return 0;
	const haystack = clean(`${record.text} ${record.tags.join(" ")}`);
	let hits = 0;
	for (const token of tokens) if (haystack.includes(token)) hits += 1;
	return hits / tokens.length;
}
/** Milliseconds in one day. */
const DAY_MS = 864e5;
/** The audit log path (user-layer root so it follows the host, not a project). */
function auditLogPath(memoryRoot) {
	const root = resolve(memoryRoot ?? join(homedir(), ".dsh", "hippocampus"));
	return join(root, "audit.log");
}
/** Record one manual deletion in the audit trail (settings delete / forget). */
async function auditManualDelete(record, workspace, memoryRoot) {
	await appendAudit({
		time: Date.now(),
		layer: "manual",
		reason: "user requested deletion",
		removed: [{
			id: record.id,
			scope: record.scope,
			...workspace === void 0 ? {} : { workspace },
			text: record.text.slice(0, 120),
			...record.tags.length === 0 ? {} : { tags: [...record.tags] }
		}]
	}, memoryRoot);
}
/** Append one audit entry (best-effort; never throws). Trims the log to the
* newest {@link AUDIT_MAX_ENTRIES} lines so it cannot grow without bound. */
async function appendAudit(entry, memoryRoot) {
	try {
		const path = auditLogPath(memoryRoot);
		await mkdir(resolve(path, ".."), { recursive: true });
		await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
		await trimAudit(path);
	} catch {}
}
/** Keep only the newest {@link AUDIT_MAX_ENTRIES} lines of the audit log. */
async function trimAudit(path) {
	const { readFile, writeFile } = await import("node:fs/promises");
	try {
		const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.trim() !== "");
		if (lines.length <= 50) return;
		await writeFile(path, `${lines.slice(-50).join("\n")}\n`, "utf8");
	} catch {}
}
/** Read every audit entry, oldest first. */
async function readAudit(memoryRoot) {
	const { readFile } = await import("node:fs/promises");
	try {
		const raw = await readFile(auditLogPath(memoryRoot), "utf8");
		const entries = [];
		for (const line of raw.split("\n")) {
			if (line.trim() === "") continue;
			try {
				const parsed = JSON.parse(line);
				if (typeof parsed.time === "number" && Array.isArray(parsed.removed)) entries.push(parsed);
			} catch {}
		}
		return entries;
	} catch {
		return [];
	}
}
/**
* Remove one restored record id from every audit entry. An entry whose
* removed list becomes empty is dropped entirely. Best-effort.
*/
async function removeAuditRecord(id, memoryRoot) {
	const { readFile, writeFile } = await import("node:fs/promises");
	try {
		const path = auditLogPath(memoryRoot);
		const raw = await readFile(path, "utf8");
		const kept = [];
		for (const line of raw.split("\n")) {
			if (line.trim() === "") continue;
			try {
				const entry = JSON.parse(line);
				if (!Array.isArray(entry.removed)) {
					kept.push(line);
					continue;
				}
				const remaining = entry.removed.filter((item) => item.id !== id);
				if (remaining.length === 0) continue;
				kept.push(JSON.stringify({
					...entry,
					removed: remaining
				}));
			} catch {
				kept.push(line);
			}
		}
		await writeFile(path, `${kept.join("\n")}\n`, "utf8");
	} catch {}
}
/** Whether a record is auto-extracted (safe to maintain automatically). */
function isAutoExtracted(record) {
	return record.source.kind === "session" || record.source.kind === "auto";
}
/**
* Restore one deleted record from an audit entry. Creates a fresh record in
* the same scope (and workspace, for project-layer records) with the audited
* text and tags, keeping the original id so the audit trail stays accurate.
* A record that already exists is left untouched.
*
* A project-scope record WITHOUT a workspace path cannot be restored — its
* original home is unknown — and returns undefined.
* @returns the restored record id, or undefined when restoration failed.
*/
async function restoreFromAudit(item, store) {
	const workspace = item.workspace;
	if (item.scope === "project" && workspace === void 0) return void 0;
	if ((workspace !== void 0 ? await store.list("project", workspace) : await store.list("user", void 0)).some((record) => record.id === item.id)) return void 0;
	try {
		await store.createWithId(item.id, item.scope, {
			text: item.text,
			...item.tags === void 0 || item.tags.length === 0 ? {} : { tags: item.tags }
		}, workspace);
		return item.id;
	} catch {
		return;
	}
}
/**
* Rule-layer sweep over one scope's records: remove auto-extracted records
* that were never recalled within STALE_DAYS. User-explicit records are
* never touched. Returns the removed records (for auditing).
*/
async function sweepStale(store, scope, workspace, now = Date.now()) {
	const records = await store.list(scope, workspace);
	const removed = [];
	const cutoff = now - 30 * DAY_MS;
	for (const record of records) {
		if (!isAutoExtracted(record)) continue;
		if (record.accessCount > 0) continue;
		if (record.createdAt > cutoff) continue;
		if (await store.delete(record.id, workspace)) removed.push(record);
	}
	return removed;
}
/**
* Run the rule-layer sweep across the user layer and every workspace's
* project layer. Appends one audit entry when anything was removed.
* @returns the total number of removed records.
*/
async function runRuleSweep(store, workspaces, memoryRoot, now = Date.now()) {
	const removed = [];
	for (const record of await sweepStale(store, "user", void 0, now)) removed.push({
		id: record.id,
		scope: record.scope,
		text: record.text.slice(0, 120)
	});
	for (const workspace of workspaces) for (const record of await sweepStale(store, "project", workspace.path, now)) removed.push({
		id: record.id,
		scope: record.scope,
		workspace: workspace.path,
		text: record.text.slice(0, 120)
	});
	if (removed.length > 0) await appendAudit({
		time: now,
		layer: "rules",
		reason: `auto-extracted records never recalled within 30 days`,
		removed
	}, memoryRoot);
	return removed.length;
}
/** Collect every auto-extracted record (user + project layers). */
async function collectAutoExtracted(store, workspaces) {
	const candidates = [];
	for (const record of await store.list("user", void 0)) if (isAutoExtracted(record)) candidates.push({
		record,
		workspace: void 0
	});
	for (const workspace of workspaces) for (const record of await store.list("project", workspace.path)) if (isAutoExtracted(record)) candidates.push({
		record,
		workspace: workspace.path
	});
	return candidates;
}
/** Parse the model's JSON verdict: an array of record ids to delete. */
function parseReviewVerdict(text) {
	const body = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text;
	const match = /\[[\s\S]*\]/.exec(body);
	if (match === null) return [];
	try {
		const parsed = JSON.parse(match[0]);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((id) => typeof id === "string" && id.length > 0);
	} catch {
		return [];
	}
}
/** The review directive given to the model. */
const REVIEW_INSTRUCTION = [
	"You are a memory curator for an AI coding assistant. Below are AUTO-EXTRACTED memory records (id: text) — they were extracted automatically from past conversations, so deleting them is safe and expected when they are not worth keeping.",
	"",
	"DELETE records matching ANY of these categories:",
	"- Transient/one-off: \"the build showed 3 warnings\", \"pressed Ctrl+S at 14:32\", \"checked node version with node -v\" — task state, timestamps, one-time events",
	"- Resolved/obsolete: a fix or decision that is already implemented, a superseded plan",
	"- Trivial/vague: fragments that carry no durable meaning on their own",
	"- Duplicates: the same fact restated; keep the most complete version, delete the rest",
	"",
	"KEEP records that capture durable facts: user preferences, project decisions, conventions, architecture, stable identifiers, API/commands worth remembering.",
	"",
	"Respond with ONLY a JSON array of ids to DELETE, e.g. [\"id-1\",\"id-2\"]. Respond [] when nothing qualifies.",
	""
].join("\n");
/**
* LLM review layer: ask the routed model which auto-extracted records are
* duplicates/stale/trivial, delete them, and append an audit entry.
* @returns the deleted records (id, scope, text) for auditing.
*/
async function runLlmReview(ctx, store, workspaces, memoryRoot, signal) {
	const candidates = await collectAutoExtracted(store, workspaces);
	if (candidates.length === 0) return [];
	const apiCtx = ctx;
	const selection = apiCtx.agentDefaultModel?.currentSelection();
	if (selection === void 0 || selection.provider.length === 0 || selection.model.length === 0) return [];
	const llm = apiCtx.llm;
	if (llm === void 0) return [];
	const listing = candidates.map((candidate) => `${candidate.record.id}: ${candidate.record.text}`).join("\n");
	const messages = [{
		role: "user",
		content: [{
			type: "text",
			text: `${REVIEW_INSTRUCTION}\n\n${listing}`
		}],
		source: {
			kind: "plugin",
			plugin: "dsh-hippocampus"
		}
	}];
	const options = {
		provider: selection.provider,
		model: selection.model,
		messages,
		maxTokens: 2048,
		...signal === void 0 ? {} : { signal }
	};
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, 3e4);
	const fused = signal !== void 0 ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	let text = "";
	try {
		const assembler = new BlockAssembler();
		for await (const chunk of llm.stream({
			...options,
			signal: fused
		})) assembler.push(chunk);
		text = assembler.blocks().filter((block) => block.type === "text").map((block) => block.text).join("");
	} catch {
		return [];
	} finally {
		clearTimeout(timer);
	}
	const deleteIds = new Set(parseReviewVerdict(text));
	if (deleteIds.size === 0) return [];
	const removed = [];
	for (const candidate of candidates) {
		if (!deleteIds.has(candidate.record.id)) continue;
		if (await store.delete(candidate.record.id, candidate.workspace)) removed.push({
			id: candidate.record.id,
			scope: candidate.record.scope,
			...candidate.workspace === void 0 ? {} : { workspace: candidate.workspace },
			text: candidate.record.text.slice(0, 120)
		});
	}
	if (removed.length > 0) await appendAudit({
		time: Date.now(),
		layer: "llm",
		reason: "model review: duplicates, transient, or trivial auto-extracted records",
		removed
	}, memoryRoot);
	return removed;
}
//#endregion
//#region src/tools.ts
/**
* Resolve the workspace root for one executing agent's session, with the same
* robustness as the API layer: the live session header first, then the
* session store's copy of the header (covers runtime sessions whose header
* object is absent from `exec.agent`), then a scan of every registered
* workspace when the session cannot be resolved at all.
*/
async function workspaceOf$2(ctx, exec) {
	const session = exec.agent?.session;
	if (session !== void 0 && "header" in session) {
		const header = session.header;
		if (header?.cwd !== void 0) return header.cwd;
	}
	const agentId = exec.agent?.id;
	if (agentId !== void 0) {
		const stored = ctx.sessions.get(agentId);
		if (stored?.header?.cwd !== void 0) return stored.header.cwd;
	}
	const workspaces = (ctx.get?.("workspaceRegistry"))?.list() ?? [];
	if (workspaces.length === 1) return workspaces[0]?.path;
}
/** Parse a scope argument; invalid values throw so the model can retry. */
function parseScope$1(value) {
	if (value === void 0) return void 0;
	if (value === "project" || value === "user") return value;
	throw new Error(`invalid memory scope: ${String(value)}`);
}
/** Compact record view returned to the model. */
function recordView(record) {
	return {
		id: record.id,
		text: record.text,
		scope: record.scope,
		...record.tags.length === 0 ? {} : { tags: [...record.tags] },
		source: record.source.kind,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt
	};
}
const MEMORY_OUTPUT = {
	schema: {
		type: "object",
		additionalProperties: false,
		properties: { records: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					text: {
						type: "string",
						required: true
					},
					scope: {
						type: "string",
						required: true,
						enum: ["project", "user"]
					},
					tags: {
						type: "array",
						items: { type: "string" }
					},
					source: {
						type: "string",
						required: true
					},
					createdAt: {
						type: "number",
						required: true
					},
					updatedAt: {
						type: "number",
						required: true
					},
					score: { type: "number" }
				}
			}
		} }
	},
	render: (_args, value) => [{
		type: "text",
		text: JSON.stringify(value)
	}]
};
const PROMPT_TEXT = "Use remember to store facts the user asks you to keep, and recall to retrieve relevant remembered facts before answering. Memory is durable across sessions and restarts and layered: project facts live with the workspace, user facts follow the user. Prefer recall over guessing when a remembered preference or decision could matter. Use forget only when the user explicitly asks to remove a fact.";
/** Register the three memory tools and their guidance section. */
function registerMemoryTools(ctx, store, memoryRoot) {
	ctx.systemPrompt.section({
		name: "tool:memory",
		order: 2350,
		text: PROMPT_TEXT
	});
	ctx.tools.register(defineTool({
		name: "remember",
		description: "Store one fact in durable cross-session memory when the user asks you to remember it, or when a preference, decision, or project fact is likely to matter in future sessions.",
		parameters: {
			text: {
				type: "string",
				required: true,
				description: "The fact to remember, one sentence or a short paragraph."
			},
			scope: {
				type: "string",
				enum: ["project", "user"],
				description: "project is workspace-local (default); user is host-global."
			},
			tags: {
				type: "array",
				items: { type: "string" },
				description: "Optional free-form tags for retrieval."
			}
		},
		output: MEMORY_OUTPUT,
		async execute(args, exec) {
			const scope = parseScope$1(args.scope) ?? "project";
			const workspace = await workspaceOf$2(ctx, exec);
			return { records: [recordView(await store.create(scope, {
				text: args.text,
				tags: args.tags
			}, { kind: "explicit" }, workspace))] };
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Remember fact",
			kind: "other",
			rawInput: args.text
		})
	}));
	ctx.tools.register(defineTool({
		name: "recall",
		description: "Search durable cross-session memory for facts relevant to the current task. Project facts are searched first, then user facts.",
		parameters: {
			query: {
				type: "string",
				required: true,
				description: "Free-form search query; leave empty to list all memory."
			},
			scope: {
				type: "string",
				enum: ["project", "user"],
				description: "Restrict to one scope; both are searched when omitted."
			},
			limit: {
				type: "number",
				description: "Maximum hits (default 5)."
			}
		},
		output: MEMORY_OUTPUT,
		async execute(args, exec) {
			return { records: (await store.recall(args.query, {
				...args.scope === void 0 ? {} : { scope: parseScope$1(args.scope) },
				...args.limit === void 0 ? {} : { limit: args.limit },
				workspace: await workspaceOf$2(ctx, exec)
			})).map((hit) => ({
				...recordView(hit.record),
				score: hit.score
			})) };
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Recall memory",
			kind: "read",
			rawInput: args.query
		})
	}));
	ctx.tools.register(defineTool({
		name: "forget",
		description: "Delete one memory record by id. Call this only when the user explicitly asks to forget or correct a previously remembered fact.",
		parameters: { id: {
			type: "string",
			required: true,
			description: "Exact record id returned by recall or remember."
		} },
		output: MEMORY_OUTPUT,
		async execute(args, exec) {
			const workspace = await workspaceOf$2(ctx, exec);
			const registry = ctx.get?.("workspaceRegistry");
			let targetWorkspace = workspace;
			let record = targetWorkspace === void 0 ? void 0 : await store.get(args.id, targetWorkspace);
			if (record === void 0) {
				record = await store.get(args.id, void 0);
				targetWorkspace = void 0;
				if (record === void 0) for (const candidate of registry?.list().map((entry) => entry.path) ?? []) {
					const found = await store.get(args.id, candidate);
					if (found !== void 0) {
						record = found;
						targetWorkspace = candidate;
						break;
					}
				}
			}
			if (!(record === void 0 ? false : await store.delete(args.id, targetWorkspace))) throw new Error(`memory record "${args.id}" is unknown or already deleted`);
			if (record !== void 0) await auditManualDelete(record, targetWorkspace, memoryRoot);
			return { records: [] };
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Forget memory",
			kind: "other",
			rawInput: args.id
		})
	}));
}
//#endregion
//#region src/extract.ts
/** Extraction frame tags; the model answers between these markers. */
const FACTS_OPEN_TAG = "<memory-facts>";
const FACTS_CLOSE_TAG = "</memory-facts>";
/** Parse the model's text output into extracted facts with scope labels. */
function parseExtractedFacts(text) {
	const open = text.indexOf(FACTS_OPEN_TAG);
	const close = text.indexOf(FACTS_CLOSE_TAG);
	if (open < 0 || close < 0 || close <= open) return [];
	const body = text.slice(open + 14, close);
	const facts = [];
	for (const line of body.split("\n")) {
		const content = /^\s*-\s+(.+)$/.exec(line)?.[1]?.trim();
		if (content === void 0 || content.length === 0) continue;
		const scopeMatch = /^\[(project|user)\]\s+(.+)$/.exec(content);
		if (scopeMatch !== null) facts.push({
			text: scopeMatch[2].trim(),
			scope: scopeMatch[1]
		});
		else facts.push({ text: content });
	}
	return facts;
}
/** Map a terminal finish reason to its fail-closed error. */
function finishError(finish) {
	switch (finish.kind) {
		case "error":
		case "aborted": {
			const error = new Error(finish.failure.message);
			error.code = finish.failure.code;
			return error;
		}
		case "max-tokens": {
			const error = /* @__PURE__ */ new Error("memory extraction truncated at the token cap");
			error.code = "MAX_TOKENS";
			return error;
		}
		default: return;
	}
}
/** Extract facts from one turn's messages through the routed LLM. */
async function extractFactsWithLlm(ctx, config, messages, session, signal) {
	const latest = session.requestHeader?.()?.config;
	const target = (config.provider !== void 0 && config.provider.length > 0 ? {
		provider: config.provider,
		model: config.model ?? ""
	} : void 0) ?? latest;
	if (target === void 0 || target.model.length === 0) throw new Error("hippocampus: no provider/model available for extraction; configure extractionProvider/Model or route a request first");
	const requestMessages = [...messages, {
		role: "user",
		content: [{
			type: "text",
			text: EXTRACTION_INSTRUCTION
		}],
		source: {
			kind: "plugin",
			plugin: "dsh-hippocampus"
		}
	}];
	const options = {
		provider: target.provider,
		model: target.model,
		messages: requestMessages,
		maxTokens: config.maxTokens,
		...signal === void 0 ? {} : { signal }
	};
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, config.timeoutMs);
	const fused = signal !== void 0 ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	try {
		const assembler = new BlockAssembler();
		for await (const chunk of ctx.llm.stream({
			...options,
			signal: fused
		})) assembler.push(chunk);
		const error = finishError(assembler.finish);
		if (error !== void 0) throw error;
		return parseExtractedFacts(assembler.blocks().filter((block) => block.type === "text").map((block) => block.text).join(""));
	} finally {
		clearTimeout(timer);
	}
}
/** The extraction directive: distills durable facts with scope labels. */
const EXTRACTION_INSTRUCTION = [
	"You are a memory curator for an AI coding assistant. From the conversation above, extract facts worth remembering across future sessions.",
	"",
	"Include only durable, generalizable facts: user preferences, project decisions, conventions, constraints, and stable identifiers.",
	"Exclude: transient task state, answers to one-off questions, content already present in the conversation transcript, and anything the user explicitly asked to forget.",
	"",
	"Each fact must be labeled with its scope:",
	"- [project] — related to the current repository/project: tech stack, architecture decisions, code conventions, project-specific APIs or commands.",
	"- [user] — about the user personally and true across projects: coding habits, tool preferences, environment setup, communication preferences.",
	"",
	`Output EXACTLY the following structure, between ${FACTS_OPEN_TAG} and ${FACTS_CLOSE_TAG}:`,
	"",
	`${FACTS_OPEN_TAG}`,
	"- [project] <one-sentence fact>",
	"- [user] <one-sentence fact>",
	`${FACTS_CLOSE_TAG}`,
	"",
	"Rules:",
	"- One fact per line, each prefixed with \"- \" and a [project]/[user] label.",
	"- Write concise English or the user's language; preserve exact identifiers and values.",
	"- If nothing is worth remembering, output the empty frame:",
	`${FACTS_OPEN_TAG}`,
	`${FACTS_CLOSE_TAG}`,
	"- Do not mention this curation request. Output only the frame."
].join("\n");
/** Merge extracted facts into the store with deduplication. */
async function mergeFacts(store, facts, sessionId, turn, maxFacts, workspace) {
	let merged = 0;
	for (const fact of facts) {
		if (merged >= maxFacts) break;
		const scope = fact.scope ?? "project";
		await store.create(scope, {
			text: fact.text,
			tags: fact.tags
		}, {
			kind: "session",
			sessionId,
			turn
		}, workspace);
		merged += 1;
	}
}
/** Register the automatic extraction listener. */
function registerAutoExtract(ctx, store, config) {
	const states = /* @__PURE__ */ new WeakMap();
	ctx.on("session/event", (session, event) => {
		if (event.type !== "turn/end" || event.data.reason.kind !== "completed") return;
		const turn = event.data.turn;
		const state = states.get(session) ?? {
			lastTurn: 0,
			tail: Promise.resolve()
		};
		if (turn <= state.lastTurn) return;
		const controller = new AbortController();
		const run = state.tail.then(async () => {
			const events = session.events;
			let startIndex = -1;
			for (let i = events.length - 1; i >= 0; i -= 1) {
				const event = events[i];
				if (event?.type === "turn/start" && event.data.turn === turn) {
					startIndex = i;
					break;
				}
			}
			if (startIndex < 0) return;
			const messages = events.slice(startIndex).map((event) => session.deriveEventMessage?.(event) ?? null).filter((message) => message !== null);
			if (messages.length === 0) return;
			const facts = await extractFactsWithLlm(ctx, config, messages, session, controller.signal);
			const workspace = session.header?.cwd;
			await mergeFacts(store, facts, session.id, turn, config.maxFactsPerTurn, workspace);
		}).catch((error) => {
			if (!controller.signal.aborted) ctx.logger?.warn?.("hippocampus extraction failed: %o", error);
		});
		states.set(session, {
			lastTurn: turn,
			tail: run
		});
	});
}
//#endregion
//#region src/inject.ts
/** Max injected memory bytes per step; keeps token cost bounded. */
const MAX_INJECT_BYTES = 2e3;
/** Per-session injected-query digests, so the same query is not re-injected. */
const injectedQueries = /* @__PURE__ */ new WeakMap();
/** Simple digest of the normalized query. */
function digest(query) {
	let hash = 0;
	for (let i = 0; i < query.length; i += 1) hash = (hash << 5) - hash + query.charCodeAt(i) | 0;
	return String(hash);
}
/** Extract searchable user text from the step's claimed messages. */
function userText(messages) {
	const parts = [];
	for (const message of messages) {
		if (message.source.kind !== "user") continue;
		for (const block of message.content) {
			if (block.type !== "text") continue;
			const text = block.text.trim();
			if (text.length > 0) parts.push(text);
		}
	}
	return parts.length === 0 ? void 0 : parts.join(" ");
}
/** Render one recall hit for injection. */
function renderHit(hit) {
	const { record } = hit;
	return `[${record.scope === "user" ? "user" : "project"}] ${record.text}`;
}
/** Resolve the workspace from an agent's session header. */
function workspaceOf$1(agent) {
	return agent.session.header?.cwd;
}
/** Register the pre-step memory injection hook. */
function registerAutoInject(ctx, store, options) {
	ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || signal.aborted) return decision;
		const query = userText(messages);
		if (query === void 0 || query.length === 0) return decision;
		const session = agent.session;
		const seen = injectedQueries.get(session);
		const key = digest(query);
		if (seen !== void 0 && seen.has(key)) return decision;
		if (seen === void 0) injectedQueries.set(session, /* @__PURE__ */ new Set());
		try {
			const hits = await store.recall(query, {
				limit: options.limit,
				workspace: workspaceOf$1(agent),
				includeProjectFallback: true
			});
			if (hits.length === 0) return decision;
			injectedQueries.get(session)?.add(key);
			for (const hit of hits) await store.recordRecall(session.id, hit.record.id, workspaceOf$1(agent), query).catch(() => {});
			const text = hits.map(renderHit).join("\n");
			if (text.length > MAX_INJECT_BYTES) {
				const truncated = [];
				let bytes = 0;
				for (const hit of hits) {
					const line = renderHit(hit);
					if (bytes + line.length > MAX_INJECT_BYTES) break;
					truncated.push(line);
					bytes += line.length;
				}
				if (truncated.length === 0) return decision;
				return appendMemorySnapshot(decision, truncated.join("\n"));
			}
			return appendMemorySnapshot(decision, text);
		} catch {
			return decision;
		}
	});
}
/** Append the memory snapshot as a plugin-sourced user message. */
function appendMemorySnapshot(decision, text) {
	const snapshot = createUserMessage({
		content: [{
			type: "text",
			text: [
				"<system-reminder>",
				"Relevant memory from previous sessions:",
				text,
				"Use these facts when they apply; do not treat them as the user's current message.",
				"</system-reminder>"
			].join("\n")
		}],
		source: {
			kind: "plugin",
			plugin: "dsh-hippocampus",
			form: "snapshot"
		}
	});
	return {
		...decision,
		messages: [...decision.messages, snapshot]
	};
}
/** Lazy model loader: builds the embedder on first call, then caches it. */
var LazyEmbedder = class {
	modelId;
	instance;
	loading;
	constructor(modelId) {
		this.modelId = modelId;
	}
	/** Load (once) and return the embedder; never throws — returns a failing embedder on error. */
	async load() {
		if (this.instance !== void 0) return this.instance;
		if (this.loading === void 0) this.loading = this.build().catch(() => new FailingEmbedder());
		this.instance = await this.loading;
		return this.instance;
	}
	async build() {
		const { pipeline } = await import("@xenova/transformers");
		const extractor = await pipeline("feature-extraction", this.modelId, { dtype: "q8" });
		return { async embed(text) {
			const out = await extractor(text, {
				pooling: "mean",
				normalize: true
			});
			return Array.from(out.data);
		} };
	}
	async embed(text) {
		return (await this.load()).embed(text);
	}
};
/** Embedder that always fails; used when the model cannot load. */
var FailingEmbedder = class {
	async embed() {
		throw new Error("embedding model unavailable");
	}
};
/** Cosine similarity between two equal-length vectors in [0, 1]. */
function cosineSimilarity(a, b) {
	if (a.length === 0 || a.length !== b.length) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i += 1) {
		const ai = a[i] ?? 0;
		const bi = b[i] ?? 0;
		dot += ai * bi;
		na += ai * ai;
		nb += bi * bi;
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom === 0 ? 0 : dot / denom;
}
/** Hybrid keyword + semantic ranker implementing MemoryRanker. */
var SemanticRanker = class {
	keywordHitWeight;
	keywordMissWeight;
	semanticThreshold;
	enabled;
	embedder;
	/** Record id -> cached embedding vector. */
	vectorCache = /* @__PURE__ */ new Map();
	/** Query vector cache (per normalized query). */
	queryCache = /* @__PURE__ */ new Map();
	constructor(options = {}) {
		this.keywordHitWeight = options.keywordWeight ?? .7;
		this.keywordMissWeight = options.keywordMissWeight ?? .4;
		this.semanticThreshold = options.semanticThreshold ?? .45;
		this.enabled = options.enabled ?? true;
		this.embedder = options.embedder ?? new LazyEmbedder(options.modelId ?? "Xenova/bge-small-zh-v1.5");
	}
	/** Hybrid score with adaptive weights and a semantic floor. */
	hybrid(keyword, semantic) {
		if (keyword > 0) return this.keywordHitWeight * keyword + (1 - this.keywordHitWeight) * semantic;
		if (semantic < this.semanticThreshold) return 0;
		return (1 - this.keywordMissWeight) * semantic;
	}
	/** Semantic score for one record, using its cached vector or computing on demand. */
	async semanticScore(record, query) {
		if (!this.enabled) return 0;
		try {
			let recordVec = this.vectorCache.get(record.id);
			if (recordVec === void 0) {
				recordVec = await this.embedder.embed(record.text);
				this.vectorCache.set(record.id, recordVec);
			}
			let queryVec = this.queryCache.get(query);
			if (queryVec === void 0) {
				queryVec = await this.embedder.embed(query);
				this.queryCache.set(query, queryVec);
			}
			return cosineSimilarity(recordVec, queryVec);
		} catch {
			return 0;
		}
	}
	/**
	* Synchronous MemoryRanker.score: keyword score immediately, then add the
	* semantic score when its cached vector is available. The async semantic
	* refinement happens in `recall` via {@link refineScores}.
	*/
	score(record, query) {
		const keyword = keywordScore(record, query);
		if (!this.enabled) return keyword;
		const cached = this.vectorCache.get(record.id);
		if (cached === void 0) return keyword;
		const queryVec = this.queryCache.get(query);
		if (queryVec === void 0) return keyword;
		const semantic = cosineSimilarity(cached, queryVec);
		return this.hybrid(keyword, semantic);
	}
	/**
	* Async refinement: compute the semantic score for one record+query pair
	* and return the hybrid score. Used by recall after the synchronous pass.
	*/
	async refine(record, query) {
		if (!this.enabled) return keywordScore(record, query);
		const keyword = keywordScore(record, query);
		const semantic = await this.semanticScore(record, query);
		return this.hybrid(keyword, semantic);
	}
};
//#endregion
//#region src/api.ts
/** Body size bound of one JSON request. */
const MAX_BODY_BYTES = 1 << 20;
/** One API failure with its wire code and HTTP status. */
var MemoryApiError = class extends Error {
	code;
	status;
	constructor(code, message, status = 400) {
		super(message);
		this.code = code;
		this.status = status;
	}
};
/** Read and parse the JSON request body (bounded; malformed → bad-request). */
async function readJsonBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES) throw new MemoryApiError("bad-request", "request body too large");
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim() === "") return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new MemoryApiError("bad-request", "request body is not valid JSON");
	}
}
/** Write a JSON response. */
function writeJson(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, { "content-type": "application/json" });
	res.end(body);
}
/** Write a success envelope. */
function writeOk(res, value) {
	writeJson(res, 200, value);
}
/** Write the shared error envelope. */
function writeError(res, error) {
	if (error instanceof MemoryApiError) {
		writeJson(res, error.status, {
			ok: false,
			code: error.code,
			message: error.message
		});
		return;
	}
	writeJson(res, 500, {
		ok: false,
		code: "internal",
		message: error instanceof Error ? error.message : String(error)
	});
}
/** Browser-trust fence: loopback host or a configured trusted authority. */
function isTrustedRequest(req, trustedHosts) {
	const authority = req.headers.host;
	if (typeof authority !== "string" || authority.length === 0) return false;
	let url;
	try {
		url = new URL(`http://${authority}`);
	} catch {
		return false;
	}
	const hostname = url.hostname;
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	if (parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return true;
	return trustedHosts.some((entry) => {
		try {
			return new URL(`http://${entry}`).hostname === hostname;
		} catch {
			return false;
		}
	});
}
/** Parse a scope argument; undefined when absent or invalid. */
function parseScope(value) {
	return value === "project" || value === "user" ? value : void 0;
}
/**
* Resolve the workspace for one request: an explicit `workspace` path wins
* (the settings panel knows its current workspace directly); otherwise a
* sessionId is resolved through the workspace registry's authoritative
* accounting (canonical path) first, then the live session header, then the
* session persistence store (covers subagent children and restored sessions
* the registry never accounted).
*/
async function workspaceOf(ctx, sessionId, explicitWorkspace) {
	if (explicitWorkspace !== void 0 && explicitWorkspace.length > 0) return explicitWorkspace;
	if (sessionId === "") return void 0;
	const workspace = ctx.workspaceRegistry?.list().find((entry) => entry.sessionIds.includes(sessionId));
	if (workspace !== void 0 && workspace.path.length > 0) return workspace.path;
	const session = ctx.sessions.get(sessionId);
	if (session?.header?.cwd !== void 0) return session.header.cwd;
	if (ctx.sessionPersistence !== void 0) try {
		const header = (await ctx.sessionPersistence.list()).find((entry) => entry.id === sessionId);
		if (header?.cwd !== void 0) return header.cwd;
	} catch {}
}
/** Register the /memory JSON API route on the webserver. */
function registerMemoryApi(ctx, store, memoryRoot) {
	const trustedHosts = () => ctx.webRuntime.trustedHosts;
	ctx.webServer.register({
		kind: "prefix",
		path: "/memory/api",
		handler: async (req, res) => {
			const method = new URL(req.url ?? "/", "http://localhost").pathname.slice(12);
			try {
				if (!isTrustedRequest(req, trustedHosts())) throw new MemoryApiError("forbidden", "request rejected by the memory trust fence", 403);
				const body = await readJsonBody(req);
				const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
				const workspace = await workspaceOf(ctx, sessionId, typeof body.workspace === "string" ? body.workspace : void 0);
				switch (method) {
					case "list": {
						const scope = parseScope(body.scope);
						writeOk(res, { records: (await store.list(scope ?? "project", workspace)).map(view) });
						return;
					}
					case "search": {
						const query = typeof body.query === "string" ? body.query : "";
						const scope = parseScope(body.scope);
						const limit = typeof body.limit === "number" ? body.limit : 20;
						writeOk(res, { hits: (await store.recall(query, {
							...scope === void 0 ? {} : { scope },
							limit,
							workspace
						})).map((hit) => ({
							...view(hit.record),
							score: hit.score
						})) });
						return;
					}
					case "delete": {
						const id = typeof body.id === "string" ? body.id : "";
						if (id === "") throw new MemoryApiError("bad-request", "id is required");
						const workspaces = (ctx.workspaceRegistry?.list() ?? []).map((entry) => entry.path);
						let targetWorkspace = workspace;
						let record = targetWorkspace === void 0 ? void 0 : await store.get(id, targetWorkspace);
						if (record === void 0) {
							record = await store.get(id, void 0);
							targetWorkspace = void 0;
							if (record === void 0) for (const candidate of workspaces) {
								const found = await store.get(id, candidate);
								if (found !== void 0) {
									record = found;
									targetWorkspace = candidate;
									break;
								}
							}
						}
						const deleted = record === void 0 ? false : await store.delete(id, targetWorkspace);
						if (deleted && record !== void 0) await auditManualDelete(record, targetWorkspace, memoryRoot);
						writeOk(res, { deleted });
						return;
					}
					case "restore": {
						const target = (await readAudit(memoryRoot)).flatMap((entry) => entry.removed.map((item) => ({
							entry,
							item
						}))).find(({ item }) => item.id === (typeof body.id === "string" ? body.id : ""));
						if (target === void 0) {
							writeOk(res, {
								restored: false,
								reason: "not-found"
							});
							return;
						}
						if (target.item.scope === "project") {
							if (target.item.workspace === void 0) {
								writeOk(res, {
									restored: false,
									reason: "workspace-unknown"
								});
								return;
							}
							if (!(ctx.workspaceRegistry?.list() ?? []).some((entry) => entry.path === target.item.workspace)) {
								writeOk(res, {
									restored: false,
									reason: "workspace-gone"
								});
								return;
							}
						}
						const restoredId = await restoreFromAudit(target.item, store);
						if (restoredId !== void 0) await removeAuditRecord(restoredId, memoryRoot);
						writeOk(res, {
							restored: restoredId !== void 0,
							id: restoredId
						});
						return;
					}
					case "groups": {
						const user = await store.list("user", workspace);
						const workspaces = [];
						const registry = ctx.workspaceRegistry?.list() ?? [];
						for (const entry of registry) {
							const records = await store.list("project", entry.path);
							if (records.length === 0) continue;
							workspaces.push({
								path: entry.path,
								title: entry.title,
								records: records.map(view)
							});
						}
						writeOk(res, {
							user: user.map(view),
							workspaces
						});
						return;
					}
					case "stats": {
						const project = await store.list("project", workspace);
						const user = await store.list("user", workspace);
						writeOk(res, {
							projectCount: project.length,
							userCount: user.length,
							totalCount: project.length + user.length
						});
						return;
					}
					case "recalls": {
						const limit = typeof body.limit === "number" ? body.limit : 20;
						writeOk(res, { items: (await store.recallsFor(sessionId, workspace, limit)).map((item) => ({
							...view(item.record),
							recallCount: item.count,
							lastRecalledAt: item.lastAt
						})) });
						return;
					}
					case "maintain": {
						const registry = ctx.workspaceRegistry?.list() ?? [];
						const ruleRemoved = await runRuleSweep(store, registry, memoryRoot);
						const llmRemoved = await runLlmReview(ctx, store, registry, memoryRoot);
						const audit = await readAudit(memoryRoot);
						writeOk(res, {
							removed: ruleRemoved + llmRemoved.length,
							audit: audit.slice(-50)
						});
						return;
					}
					case "audit":
						writeOk(res, { audit: (await readAudit(memoryRoot)).slice(-100) });
						return;
					default: throw new MemoryApiError("not-found", `unknown method "${method}"`, 404);
				}
			} catch (error) {
				writeError(res, error);
			}
		}
	});
}
/** Compact record view for the browser. */
function view(record) {
	return {
		id: record.id,
		text: record.text,
		scope: record.scope,
		tags: record.tags,
		source: record.source.kind,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		accessCount: record.accessCount,
		lastAccessedAt: record.lastAccessedAt
	};
}
//#endregion
//#region src/index.ts
/** Stable Cordis plugin name; must match the cordis.patch.yml row id. */
const name = "dsh-hippocampus";
/** Services required before mounting. */
const inject = [
	"sessions",
	"tools",
	"systemPrompt",
	"llm"
];
const DEFAULT_MAX_USER_RECORDS = 200;
const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_TIMEOUT_MS = 3e4;
const DEFAULT_MAX_FACTS_PER_TURN = 5;
/** Resolve and validate plugin configuration. */
function resolveConfig(config = {}) {
	const maxUserRecords = config.maxUserRecords ?? DEFAULT_MAX_USER_RECORDS;
	const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
	const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const keywordWeight = config.keywordWeight ?? .4;
	if (keywordWeight < 0 || keywordWeight > 1 || !Number.isFinite(keywordWeight)) throw new TypeError("hippocampus: keywordWeight must be in [0, 1]");
	if (!Number.isSafeInteger(maxUserRecords) || maxUserRecords < 1) throw new TypeError("hippocampus: maxUserRecords must be a positive safe integer");
	if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new TypeError("hippocampus: maxTokens must be a positive safe integer");
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("hippocampus: timeoutMs must be a positive safe integer");
	return {
		autoExtract: config.autoExtract ?? true,
		autoInject: config.autoInject ?? true,
		semanticRanking: config.semanticRanking ?? true,
		keywordWeight,
		embeddingModel: config.embeddingModel ?? "Xenova/bge-small-zh-v1.5",
		maxUserRecords,
		maxTokens,
		timeoutMs,
		maxFactsPerTurn: DEFAULT_MAX_FACTS_PER_TURN,
		...config.extractionProvider === void 0 ? {} : { extractionProvider: config.extractionProvider },
		...config.extractionModel === void 0 ? {} : { extractionModel: config.extractionModel }
	};
}
/** Register the hippocampus plugin. */
function apply(ctx, config = {}) {
	const resolved = resolveConfig(config);
	const pluginCtx = ctx;
	const store = new MemoryStore(resolved.maxUserRecords, config.memoryRoot);
	store.ensure().catch((error) => {
		ctx.logger?.warn?.("hippocampus: store init failed: %o", error);
	});
	if (resolved.semanticRanking) store.setRanker(new SemanticRanker({
		keywordWeight: resolved.keywordWeight,
		modelId: resolved.embeddingModel
	}));
	registerMemoryTools(pluginCtx, store, config.memoryRoot);
	if (resolved.autoExtract) registerAutoExtract(ctx, store, {
		maxTokens: resolved.maxTokens,
		timeoutMs: resolved.timeoutMs,
		maxFactsPerTurn: resolved.maxFactsPerTurn,
		...resolved.extractionProvider === void 0 ? {} : { provider: resolved.extractionProvider },
		...resolved.extractionModel === void 0 ? {} : { model: resolved.extractionModel }
	});
	if (resolved.autoInject) registerAutoInject(ctx, store, { limit: 3 });
	ctx.inject([
		"webServer",
		"webRuntime",
		"workspaceRegistry",
		"sessionPersistence",
		"agentDefaultModel",
		"llm"
	], (apiCtx) => {
		registerMemoryApi(apiCtx, store, config.memoryRoot);
	});
	const timer = ctx.get?.("timer");
	if (timer !== void 0) {
		const sweep = async () => {
			const workspaces = (ctx.get?.("workspaceRegistry"))?.list() ?? [];
			await runRuleSweep(store, workspaces, config.memoryRoot);
		};
		const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		(async () => {
			await delay(5e3);
			await sweep();
		})();
		timer.interval(() => {
			sweep();
		}, 3e5);
	}
}
//#endregion
export { apply, inject, name, resolveConfig };
