#!/usr/bin/env node
/** Offline, read-only session accounting. No SDK loaders, execution, or transcript exports. */
import { openSync, closeSync, readSync, statSync, realpathSync, opendirSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AUDIT_MARKER = '[pi-subagents-audit request]';
export const LIMITS = Object.freeze({ files: 128, fileBytes: 8 * 1024 * 1024, bytes: 32 * 1024 * 1024,
  nodes: 50000, searchEntries: 10000, searchFiles: 2048, searchBytes: 16 * 1024 * 1024,
  registryBytes: 256 * 1024, edges: 512, events: 20, issues: 100, outputBytes: 256 * 1024 });
const TYPES = new Set(['message', 'usage', 'compaction', 'branch_summary', 'model_change',
  'thinking_level_change', 'custom', 'custom_message', 'label', 'session_info', 'context_edit']);
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'];
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const id = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(x) ? x : null;
const short = x => typeof x === 'string' ? x.slice(0, 4096) : null;
const inside = (file, dir) => { const r = relative(dir, file); return !r || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r)); };
const canonical = p => realpathSync(resolve(p));
const usageOf = e => e.type === 'message' ? e.message?.usage : e.usage;
const number = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const isAuditRequest = e => {
  if (e.type !== 'message' || e.message?.role !== 'user') return false;
  const content = e.message.content;
  const first = typeof content === 'string' ? content : Array.isArray(content) ? content.find(b => b?.type === 'text')?.text : null;
  return typeof first === 'string' && first.startsWith(AUDIT_MARKER);
};

function usageStats(rows) {
  const result = { records: 0, assistantMissingUsage: 0, sums: Object.fromEntries(FIELDS.map(k => [k, 0])),
    missingFields: Object.fromEntries(FIELDS.map(k => [k, 0])), missingUsageByCategory: {},
    recordedCost: { sum: 0, missing: 0 }, byCategory: {} };
  for (const { entry: e } of rows) {
    const u = usageOf(e);
    if (!object(u)) {
      const expected = e.type === 'message' && e.message?.role === 'assistant' ? 'message' : ['usage', 'compaction', 'branch_summary'].includes(e.type) ? e.type : null;
      if (expected) { result.missingUsageByCategory[expected] = (result.missingUsageByCategory[expected] ?? 0) + 1; if (expected === 'message') result.assistantMissingUsage++; }
      continue;
    }
    result.records++;
    const category = e.type === 'message' ? 'message' : e.type === 'usage' && e.kind === 'cache_warm' ? 'cache_warm' : TYPES.has(e.type) ? e.type : 'other';
    const group = result.byCategory[category] ??= { records: 0, sums: Object.fromEntries(FIELDS.map(k => [k, 0])) };
    group.records++;
    for (const k of FIELDS) {
      if (number(u[k])) { result.sums[k] += u[k]; group.sums[k] += u[k]; } else result.missingFields[k]++;
    }
    if (number(u.cost?.total)) result.recordedCost.sum += u.cost.total;
    else result.recordedCost.missing++;
  }
  const missingUsage = Object.keys(result.missingUsageByCategory).length > 0;
  result.status = missingUsage || Object.values(result.missingFields).some(Boolean) ? 'partial/unknown' : result.records ? 'recorded' : 'unknown';
  result.recordedCost.status = result.recordedCost.missing || missingUsage || !result.records ? 'partial/unknown' : 'recorded (not pricing inferred)';
  return result;
}

function measurements(rows, eventsLimit) {
  const counts = {}, roles = {}, tools = new Map(), readPaths = new Map(), events = [];
  let payloadBytes = 0, maxPayloadBytes = 0, repeatedReadCalls = 0, eventCount = 0, auditRequests = 0;
  for (const row of rows) {
    const e = row.entry, type = TYPES.has(e.type) ? e.type : 'other';
    counts[type] = (counts[type] ?? 0) + 1;
    const m = e.message;
    if (type === 'message' && object(m)) {
      const role = ['user', 'assistant', 'toolResult', 'bashExecution', 'custom'].includes(m.role) ? m.role : 'other';
      roles[role] = (roles[role] ?? 0) + 1;
      const size = Buffer.byteLength(JSON.stringify(m.content ?? null));
      payloadBytes += size; maxPayloadBytes = Math.max(maxPayloadBytes, size);
      if (Array.isArray(m.content)) for (const block of m.content) {
        if (block?.type !== 'toolCall') continue;
        const name = typeof block.name === 'string' && /^[\w.-]{1,80}$/.test(block.name) ? block.name : 'other';
        tools.set(name, (tools.get(name) ?? 0) + 1);
        if (name === 'read' && typeof block.arguments?.path === 'string') {
          const key = block.arguments.path;
          if (readPaths.has(key)) repeatedReadCalls++;
          readPaths.set(key, true);
        }
      }
    }
    const auditRequest = isAuditRequest(e);
    if (auditRequest) auditRequests++;
    if (auditRequest || ['usage', 'compaction', 'branch_summary', 'context_edit', 'model_change'].includes(type) ||
        (Array.isArray(m?.content) && m.content.some(b => b?.type === 'toolCall'))) {
      eventCount++;
      if (events.length < eventsLimit) events.push({ line: row.line, byteOffset: row.offset, entryId: id(e.id), type: auditRequest ? 'audit_request' : type });
    }
  }
  return { counts, roles, usage: usageStats(rows), payloadBytes, maxPayloadBytes,
    topTools: [...tools].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20).map(([name, calls]) => ({ name, calls })),
    repeatedReadCalls, toolMetricBasis: 'recorded outer tool calls; read repeats are path matches, not bugs; codemode is a wrapper, not exact nested telemetry',
    auditRequests: { count: auditRequests, activityUsage: 'unknown; untrusted marker prefixes label requests only, not whole audit turns. Historical audit activity remains in physical accounting and may confound comparisons.' },
    events, eventsOmitted: eventCount - events.length };
}

export function analyze(options = {}) {
  const limits = { ...LIMITS };
  for (const [key, value] of Object.entries(options.limits ?? {})) {
    if (!(key in limits) || !Number.isSafeInteger(value) || value < (key === 'outputBytes' ? 2048 : 1) || value > LIMITS[key]) throw new Error(`Invalid limit: ${key}`);
    limits[key] = value;
  }
  if (!Array.isArray(options.targets) || !options.targets.length || options.targets.length > 64 || options.targets.some(t => typeof t !== 'string' || t.length > 4096)) throw new Error('Supply 1–64 session IDs or JSONL paths');
  if (options.sessionsDir !== undefined && typeof options.sessionsDir !== 'string') throw new Error('sessionsDir must be a path');
  if (options.mode !== undefined && !['sessions', 'compare'].includes(options.mode)) throw new Error('Invalid mode');
  if (options.snapshots !== undefined && (!Array.isArray(options.snapshots) || options.snapshots.length > 64 || options.snapshots.some(s => !object(s) || typeof s.path !== 'string'))) throw new Error('Invalid snapshots');
  const issues = [], files = new Map(), edges = [], roots = [], scopeDirs = [], explicit = new Set();
  let issuesOmitted = 0, bytes = 0, nodes = 0, reads = 0, searchEntries = 0, searchFiles = 0, searchBytes = 0, artifactEntries = 0, provenanceSteps = 0;
  const issue = (code, path, line) => { if (issues.length < limits.issues) issues.push({ code, path: short(path), ...(line ? { line } : {}) }); else issuesOmitted++; };
  // Correctness state is independent of bounded diagnostic retention.
  let searchComplete = true, searchLimited = false;
  if (options.sessionsDir) { try { scopeDirs.push(canonical(options.sessionsDir)); } catch { searchComplete = false; issue('missing_sessions_dir', resolve(options.sessionsDir)); } }
  for (const ref of options.targets) if (isAbsolute(ref) || /[\\/]|\.jsonl$/.test(ref)) {
    try { explicit.add(canonical(ref)); } catch { issue('missing', resolve(ref)); }
  }
  const allowed = path => explicit.has(path) || scopeDirs.some(dir => inside(path, dir));
  const read = (path, max, cutoff) => {
    let fd;
    try {
      const size = statSync(path).size;
      if (cutoff !== undefined && (!Number.isSafeInteger(cutoff) || cutoff < 0)) throw new Error('cutoff');
      const end = Math.min(size, cutoff ?? size), take = Math.min(end, max, limits.bytes - bytes);
      if (take <= 0) { issue('byte_limit', path); return null; }
      fd = openSync(path, 'r');
      const buf = Buffer.alloc(take);
      let got = 0, n;
      while (got < take && (n = readSync(fd, buf, got, take - got, got))) got += n;
      bytes += got;
      if (got < end) issue('truncated_byte_limit', path);
      if (cutoff !== undefined && cutoff > size) issue('cutoff_beyond_file', path);
      return { buf: buf.subarray(0, got), size, cutoff: end, complete: got === end };
    } catch { issue('missing_or_unreadable', path); return null; }
    finally { if (fd !== undefined) closeSync(fd); }
  };
  // ID search is bounded by entries, files and bytes, including non-JSONL directory contents.
  let index;
  const buildIndex = () => {
    index = new Map();
    const indexed = new Set();
    const indexFile = path => {
      if (searchFiles >= limits.searchFiles || searchBytes >= limits.searchBytes) { searchComplete = false; searchLimited = true; return; }
      let fd;
      try {
        const real = canonical(path);
        if (!allowed(real)) { searchComplete = false; issue('scope_violation', path); return; }
        if (indexed.has(real)) return; indexed.add(real); searchFiles++;
        fd = openSync(real, 'r');
        const buf = Buffer.alloc(Math.min(16384, limits.searchBytes - searchBytes));
        const n = readSync(fd, buf, 0, buf.length, 0); searchBytes += n;
        const end = buf.subarray(0, n).indexOf(10);
        const h = JSON.parse(buf.toString('utf8', 0, end < 0 ? n : end));
        if (h.type === 'session' && id(h.id)) { const matches = index.get(h.id) ?? new Set(); matches.add(real); index.set(h.id, matches); }
        else { searchComplete = false; issue('invalid_header', path); }
      } catch { searchComplete = false; issue('malformed_header', path); }
      finally { if (fd !== undefined) closeSync(fd); }
    };
    // Explicit files are a bounded candidate set too; aliases/IDs resolve independent of input order.
    for (const path of explicit) indexFile(path);
    const stack = scopeDirs.map(path => ({ path, depth: 0 })), seen = new Set();
    while (stack.length && searchEntries < limits.searchEntries && searchFiles < limits.searchFiles && searchBytes < limits.searchBytes) {
      const { path: dir, depth } = stack.pop();
      if (seen.has(dir)) continue; seen.add(dir);
      let stream;
      try {
        stream = opendirSync(dir); let entry;
        while (searchEntries < limits.searchEntries && searchFiles < limits.searchFiles && searchBytes < limits.searchBytes && (entry = stream.readSync())) {
          searchEntries++;
          const path = join(dir, entry.name);
          if (entry.isDirectory()) { if (depth < 64) stack.push({ path, depth: depth + 1 }); else { searchComplete = false; issue('search_depth_limit', path); } }
          else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.jsonl')) indexFile(path);
        }
      } catch { searchComplete = false; issue('unreadable_search_dir', dir); }
      finally { stream?.closeSync(); }
    }
    if (stack.length || searchEntries >= limits.searchEntries || searchFiles >= limits.searchFiles || searchBytes >= limits.searchBytes) {
      searchComplete = false; searchLimited = true; issue('search_limit', options.sessionsDir);
    }
  };
  const resolveRef = ref => {
    if (isAbsolute(ref) || /[\\/]|\.jsonl$/.test(ref)) { try { return canonical(ref); } catch { return null; } }
    if (!id(ref)) { issue('invalid_reference', null); return null; }
    if (!index) buildIndex();
    const matches = index.has(ref) ? [...index.get(ref)] : [...index].filter(([key]) => key.startsWith(ref)).flatMap(([, paths]) => [...paths]);
    const unique = [...new Set(matches)];
    if (unique.length > 1) { issue('ambiguous_id', null); return null; }
    // Missing or unique matches cannot be established by an incomplete search.
    if (!searchComplete) { issue(searchLimited ? 'resolution_unknown_search_limit' : 'resolution_unknown_incomplete_search', null); return null; }
    if (!unique.length) { issue('missing_id', null); return null; }
    return unique[0];
  };
  const snapshots = new Map();
  for (const s of options.snapshots ?? []) { try { snapshots.set(canonical(s.path), s); } catch { issue('missing_snapshot', s.path); } }
  const load = path => {
    if (files.has(path)) return files.get(path);
    if (!allowed(path)) { issue('scope_violation', path); return null; }
    // Cache failures too; cycles and aliases cannot consume the budget repeatedly.
    files.set(path, null);
    if (reads >= limits.files) { issue('file_limit', path); return null; }
    reads++;
    const data = read(path, limits.fileBytes, snapshots.get(path)?.cutoffBytes);
    if (!data) return null;
    const rows = []; let header = null, offset = 0, line = 0, complete = data.complete;
    while (offset < data.buf.length) {
      if (nodes >= limits.nodes) { issue('node_limit', path); complete = false; break; }
      const nl = data.buf.indexOf(10, offset), end = nl < 0 ? data.buf.length : nl;
      line++; nodes++;
      if (nl < 0 && !data.complete) { issue('truncated_record', path, line); complete = false; break; }
      const text = data.buf.toString('utf8', offset, end);
      if (text.trim()) {
        try {
          const e = JSON.parse(text);
          if (!object(e)) throw new Error();
          if (!header) {
            if (line !== 1 || e.type !== 'session' || !id(e.id)) { issue('invalid_header', path, line); break; }
            header = e;
          } else {
            if (e.type === 'message' && (!object(e.message) ||
                ((e.message.content !== undefined || ['user', 'assistant', 'toolResult'].includes(e.message.role)) &&
                  typeof e.message.content !== 'string' && !Array.isArray(e.message.content)))) {
              issue('invalid_message', path, line); complete = false;
            }
            if (!id(e.id) || (e.parentId !== null && e.parentId !== undefined && !id(e.parentId))) { issue('invalid_entry', path, line); complete = false; }
            else rows.push({ entry: e, offset, line });
          }
        } catch { issue(nl < 0 ? 'truncated_json' : 'malformed_json', path, line); complete = false; }
      }
      offset = end + 1;
    }
    if (!header) return null;
    const byId = new Map();
    for (const r of rows) { if (byId.has(r.entry.id)) { issue('duplicate_entry_id', path, r.line); complete = false; } byId.set(r.entry.id, r); }
    const f = { path, header, rows, byId, data, complete };
    files.set(path, f);
    // Derive artifact scope separately for EVERY file, including nested SDK session directories.
    const artifact = join(dirname(path), 'artifacts', header.id);
    try { const dir = canonical(artifact); if (allowed(dir) || dir === resolve(artifact)) scopeDirs.push(dir); else issue('scope_violation', artifact); } catch { /* absent artifacts are normal */ }
    return f;
  };
  for (const ref of options.targets) {
    const path = resolveRef(ref); if (!path) continue;
    const f = load(path); if (f && !roots.includes(path)) roots.push(path);
  }
  if (options.mode === 'compare' && roots.length < 2) issue('compare_requires_distinct_roots', null);
  const visited = new Set();
  const readArtifact = (path, code) => {
    let real; try { real = canonical(path); } catch { return null; }
    if (!allowed(real)) { issue('scope_violation', path); return null; }
    const data = read(real, limits.registryBytes); if (!data?.complete) return null;
    try { const raw = JSON.parse(data.buf.toString('utf8')); if (!object(raw)) throw new Error(); return { raw, real }; }
    catch { issue(code, real); return null; }
  };
  const visit = path => {
    if (visited.has(path)) return; visited.add(path);
    const f = load(path); if (!f) return;
    const artifact = join(dirname(path), 'artifacts', f.header.id);
    const link = (candidate, expectedId, evidence, basis) => {
      if (edges.length >= limits.edges) { issue('edge_limit', evidence); return; }
      let child;
      try { child = canonical(candidate); } catch { issue('missing_child', candidate); return; }
      if (!allowed(child)) { issue('scope_violation', child); return; }
      const cf = load(child); if (!cf) return;
      if (expectedId && cf.header.id !== expectedId) { issue('registry_header_mismatch', child); return; }
      if (basis === 'managed_artifact' && typeof cf.header.parentSession === 'string') {
        try { if (canonical(resolve(dirname(child), cf.header.parentSession)) !== path) { issue('artifact_parent_mismatch', child); return; } }
        catch { issue('artifact_parent_missing', child); return; }
      }
      if (!edges.some(e => e.parent === path && e.child === child)) edges.push({ parent: path, child, evidence: short(evidence), basis });
      if (visited.has(child)) { if (child === path || reaches(child, path, edges)) issue('registry_cycle', evidence); }
      else visit(child);
    };
    const registry = readArtifact(join(artifact, 'subagent-registry.json'), 'malformed_registry');
    if (registry) for (const entry of Object.values(registry.raw)) {
      if (edges.length >= limits.edges) { issue('edge_limit', registry.real); break; }
      if (!object(entry) || typeof entry.sessionFile !== 'string' || !id(entry.sessionId)) { issue('uncorroborated_registry_entry', registry.real); continue; }
      link(resolve(dirname(registry.real), entry.sessionFile), entry.sessionId, registry.real, 'registry_header');
    }
    // Marker-owned artifact placement corroborates standalone children even when a registry was lost.
    // Never infer delegation from parentSession alone or walk arbitrary transcript path strings.
    const marker = readArtifact(join(artifact, '.subagents-managed.json'), 'malformed_artifact_marker');
    if (!marker) return;
    if (marker.raw.version !== 1 || marker.raw.managedBy !== 'pi-interactive-subagents' || marker.raw.parentSessionId !== f.header.id || !number(marker.raw.createdAt)) { issue('invalid_artifact_marker', marker.real); return; }
    const dir = join(artifact, 'subagents'); let stream;
    try {
      const real = canonical(dir); if (!allowed(real)) { issue('scope_violation', dir); return; }
      stream = opendirSync(real); let entry;
      while (artifactEntries < limits.searchEntries && edges.length < limits.edges && (entry = stream.readSync())) {
        artifactEntries++;
        if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.jsonl')) link(join(real, entry.name), null, marker.real, 'managed_artifact');
      }
      if (artifactEntries >= limits.searchEntries) issue('artifact_entry_limit', dir);
      if (edges.length >= limits.edges) issue('edge_limit', dir);
    } catch { issue('missing_or_unreadable_artifact_dir', dir); }
    finally { stream?.closeSync(); }
  };
  for (const path of roots) visit(path);
  const memberships = new Map();
  for (const root of roots) {
    const pending = [root], seen = new Set();
    while (pending.length) { const path = pending.pop(); if (seen.has(path)) continue; seen.add(path);
      const members = memberships.get(path) ?? []; members.push(root); memberships.set(path, members);
      for (const e of edges) if (e.parent === path) pending.push(e.child);
    }
  }
  const reports = [], newRecordOwners = new Map();
  for (const [path, members] of memberships) {
    const f = files.get(path); if (!f) continue;
    let inherited = new Set(), attributionReason = null;
    if (!f.complete) attributionReason = 'incomplete records';
    const started = Date.parse(f.header.timestamp);
    if (typeof f.header.parentSession === 'string') {
      let parentPath;
      try { parentPath = canonical(resolve(dirname(path), f.header.parentSession)); } catch { attributionReason = 'parent provenance missing'; }
      const parent = parentPath && allowed(parentPath) && parentPath !== path ? load(parentPath) : null;
      if (!parent || !parent.complete || parent.data.cutoff < parent.data.size) attributionReason = 'parent provenance missing, outside scope, cyclic or incomplete/cut off';
      else {
        // A cyclic or unavailable upstream lineage cannot establish independent new work.
        const lineage = new Set([path]); let cursor = parent;
        while (cursor) {
          if (lineage.has(cursor.path)) { attributionReason = 'cyclic parent provenance'; break; }
          lineage.add(cursor.path);
          if (typeof cursor.header.parentSession !== 'string') break;
          let upstream;
          try { upstream = canonical(resolve(dirname(cursor.path), cursor.header.parentSession)); } catch { attributionReason = 'upstream parent provenance missing'; break; }
          cursor = allowed(upstream) ? load(upstream) : null;
          if (!cursor || !cursor.complete || cursor.data.cutoff < cursor.data.size) { attributionReason = 'upstream parent provenance unavailable/incomplete'; break; }
        }
        for (const r of f.rows) {
          const p = parent.byId.get(r.entry.id);
          if (!p) continue;
          // Seed sanitization can remove tool calls and relink ancestry, but IDs, timestamps and usage survive.
          if (attributionReason) break;
          let sameParent = r.entry.parentId === p.entry.parentId || r.entry.parentId == null;
          if (!sameParent) {
            let ancestor = p.entry.parentId; const ancestry = new Set();
            while (ancestor && !ancestry.has(ancestor)) {
              if (provenanceSteps >= limits.nodes) { issue('provenance_node_limit', path); attributionReason = 'provenance traversal limit'; break; }
              provenanceSteps++;
              if (ancestor === r.entry.parentId) { sameParent = true; break; }
              ancestry.add(ancestor); ancestor = parent.byId.get(ancestor)?.entry.parentId;
            }
          }
          if (r.entry.timestamp && r.entry.timestamp === p.entry.timestamp && r.entry.type === p.entry.type && sameParent &&
              r.entry.message?.role === p.entry.message?.role && JSON.stringify(usageOf(r.entry)) === JSON.stringify(usageOf(p.entry))) inherited.add(r.entry.id);
          else attributionReason = 'copied entry provenance conflicts';
        }
      }
    }
    const newRows = f.rows.filter(r => !inherited.has(r.entry.id));
    if (Number.isFinite(started) && newRows.some(r => Date.parse(r.entry.timestamp) < started)) attributionReason ??= 'unmatched records predate header; copied-history provenance unavailable';
    if (!attributionReason) for (const row of newRows) {
      if (typeof row.entry.timestamp !== 'string') continue;
      const key = `${row.entry.id}\0${row.entry.timestamp}`;
      const owners = newRecordOwners.get(key) ?? new Set(); owners.add(path); newRecordOwners.set(key, owners);
    }
    const snapshot = snapshots.get(path);
    let branch = { status: 'unknown: no explicit leaf', leafId: null, modelVisibleContext: 'unknown; no provider-context replay or peak inference' };
    if (snapshot && Object.hasOwn(snapshot, 'leafId')) {
      const selected = [], seen = new Set(); let leaf = snapshot.leafId, valid = leaf === null || !!id(leaf);
      while (leaf && valid) {
        if (seen.has(leaf) || !f.byId.has(leaf)) { valid = false; break; }
        seen.add(leaf); const row = f.byId.get(leaf); selected.push(row); leaf = row.entry.parentId;
      }
      if (!valid) issue('missing_or_cyclic_leaf', path);
      branch = { ...branch, status: valid ? 'selected ancestry (not reconstructed context)' : 'unknown: missing/cyclic leaf', leafId: id(snapshot.leafId),
        ...(valid ? { entries: selected.length, measurements: measurements(selected.reverse(), limits.events) } : {}) };
    }
    reports.push({ path: short(path), sessionId: f.header.id, version: number(f.header.version) ? f.header.version : null,
      memberships: members.map(short), cutoffBytes: f.data.cutoff, readBytes: f.data.buf.length, fileBytesAtCapture: f.data.size,
      complete: f.complete, physical: measurements(f.rows, limits.events), branch,
      attribution: { status: attributionReason ? 'unknown' : 'established for available records', reason: attributionReason,
        basis: f.header.parentSession ? 'scoped parent header + copied entry IDs/timestamps/ancestry/usage' : 'no recorded parent (not proof of historical independence)',
        inheritedEntriesExcluded: inherited.size, newUsage: attributionReason ? null : usageStats(newRows) } });
  }
  const unprovenCopies = new Set([...newRecordOwners.values()].filter(owners => owners.size > 1).flatMap(owners => [...owners]));
  for (const r of reports) if (unprovenCopies.has(r.path)) {
    r.attribution.status = 'unknown'; r.attribution.reason = 'cross-file copied entry IDs/timestamps without established seed attribution'; r.attribution.newUsage = null;
  }
  const report = { schemaVersion: 1, mode: options.mode ?? 'sessions', limits,
    processing: { files: reads, bytes, nodes, searchEntries, searchFiles, searchBytes, idSearchComplete: index ? searchComplete : null, artifactEntries, provenanceSteps },
    roots: roots.map(short), graph: edges.map(e => ({ parent: short(e.parent), child: short(e.child), evidence: e.evidence, basis: e.basis })), sessions: reports,
    totals: { uniquePhysicalFiles: reports.length, sharedFiles: reports.filter(r => r.memberships.length > 1).length,
      coverage: issues.length || issuesOmitted ? 'partial: inspect issues' : 'available evidence',
      attributedNewUsage: reports.length && reports.every(r => r.attribution.newUsage) ? mergeUsage(reports.map(r => r.attribution.newUsage)) : null,
      note: 'Totals cover resolved files only, not missing evidence. Physical files deduplicated; copied fork seeds excluded only with provenance. Missing usage remains unknown. Bytes and summed inputs are not peak context.' },
    issues, issuesOmitted };
  // Hard output bound even for many sessions, paths, events or issues. Preserve a parseable disclosure.
  if (Buffer.byteLength(JSON.stringify(report)) > limits.outputBytes) {
    return { schemaVersion: 1, outputTruncated: true, limits, processing: report.processing,
      counts: { roots: roots.length, sessions: reports.length, edges: edges.length, issues: issues.length + issuesOmitted },
      issues: [{ code: 'output_limit', path: null }], note: 'Narrow the scope/limits; detailed results omitted rather than emitting raw or unbounded data.' };
  }
  return report;
}

function reaches(from, target, edges) {
  const pending = [from], seen = new Set();
  while (pending.length) { const p = pending.pop(); if (p === target) return true; if (seen.has(p)) continue; seen.add(p); for (const e of edges) if (e.parent === p) pending.push(e.child); }
  return false;
}
function mergeUsage(stats) {
  const result = usageStats([]);
  for (const s of stats) {
    result.records += s.records; result.assistantMissingUsage += s.assistantMissingUsage;
    for (const [k, n] of Object.entries(s.missingUsageByCategory)) result.missingUsageByCategory[k] = (result.missingUsageByCategory[k] ?? 0) + n;
    for (const k of FIELDS) { result.sums[k] += s.sums[k]; result.missingFields[k] += s.missingFields[k]; }
    result.recordedCost.sum += s.recordedCost.sum; result.recordedCost.missing += s.recordedCost.missing;
  }
  result.status = stats.some(s => s.status !== 'recorded') ? 'partial/unknown' : 'recorded';
  result.recordedCost.status = stats.some(s => s.recordedCost.status !== 'recorded (not pricing inferred)') ? 'partial/unknown' : 'recorded (not pricing inferred)';
  delete result.byCategory;
  return result;
}

export function parseCli(argv) {
  const options = { targets: [], snapshots: [], limits: {} };
  const value = i => { if (argv[i] === undefined) throw new Error('Missing option value'); return argv[i]; };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { options.targets.push(...argv.slice(i + 1)); break; }
    if (arg === '--request-json') {
      const text = value(++i); if (text.length > 32768) throw new Error('Request JSON exceeds 32 KiB');
      const data = JSON.parse(text); if (!object(data)) throw new Error('Expected request object');
      for (const key of ['targets', 'snapshots', 'limits', 'mode', 'sessionsDir']) if (data[key] !== undefined) options[key] = data[key];
    } else if (arg === '--sessions-dir') options.sessionsDir = value(++i);
    else if (arg === '--leaf' || arg === '--cutoff-bytes') {
      if (options.targets.length !== 1 || /[\\/]|\.jsonl$/.test(options.targets[0]) === false) throw new Error('Leaf/cutoff flags require one preceding JSONL path; use request JSON for multiple snapshots');
      const s = options.snapshots[0] ??= { path: options.targets[0] };
      if (arg === '--leaf') { const leaf = value(++i); s.leafId = leaf === 'null' ? null : leaf; }
      else s.cutoffBytes = Number(value(++i));
    } else if (arg === '--limits-json') options.limits = JSON.parse(value(++i));
    else if (arg === 'compare' && !options.targets.length) options.mode = 'compare';
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else options.targets.push(arg);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    console.log('Usage: node analyze.mjs [compare] <ID|JSONL path>... [--sessions-dir DIR]\n  --request-json JSON  Structured command context (targets, sessionsDir, snapshots)\n  <path> --leaf ID|null --cutoff-bytes N  Explicit branch and fixed cutoff\n  --limits-json JSON  Reduce hard limits; -- ends option parsing\nRead-only bounded JSON metadata. Profiles use INSTRUCTIONS.md, not this analyzer.');
  } else {
    try { console.log(JSON.stringify(analyze(parseCli(process.argv.slice(2))))); }
    catch { console.error(JSON.stringify({ error: 'Invalid audit request; use --help. No sessions modified.' })); process.exitCode = 1; }
  }
}
