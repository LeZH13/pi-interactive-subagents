# Profile and capability audit

## Establish effective configuration

Resolve the requested agents directory, preserving symlinks. For an unspecified global directory, honor `PI_CODING_AGENT_DIR` before the usual `~/.pi/agent` default. Include relevant project definitions, persisted per-agent overrides, inherited restrictions, tool descriptors, and loaded global/project instructions. Exclude backup files that are not discovered profiles.

For historical sessions, prefer their recorded loadouts and prompt/tool changes. Current profile files describe new launches, not necessarily existing/resumed agents.

## Inspect each role

- Does its prompt add role-specific policy, or repeat available tool mechanics and base instructions?
- Do stale prose inventories conflict with effective tools, spawnable agents, concurrency, or session mode?
- Are exploration/research depth and output size proportional to the task?
- Are read-only boundaries, evidence standards, file ownership, and verification preserved?
- Does fork mode copy history that this role genuinely needs? Does resume preserve useful continuity or mostly carry irrelevant context?
- Are source retrievals bounded, material failures visible, and uncertainty explicit?

Compare tool grants with actual activation and model-visible schemas, not just frontmatter length. For web access, inspect installed loader behavior: auto activation can be model-dependent; permission, registration, activation, and prompt exposure are different states.

## Inspect the delegation graph

List direct tools and allowed child profiles separately. Check effective parent restrictions and automatically managed control/spawn tools. Never infer that a child inherits the parent's read-only boundary or tool ceiling.

Keep routine investigations shallow and bounded. Add a capability or nested role only for a recurring task that justifies startup/schema/handoff costs. Direct small lookups can be cheaper than forced delegation; multi-source research can justify a separate context.

Native bash and filtered shell tools are not complete network/filesystem sandboxes. Culling web tools changes routing, not necessarily internet reachability. Avoid write-capable descendants in audit roles unless separately authorized by design.

## Recommend selectively

Rank actual behavioral risks ahead of cosmetic word reductions. Quantify prompt text separately from total model context and billed usage; moving duplicated text to another always-loaded file does not inherently save tokens.

Preserve useful guardrails and output evidence. Suggest tool/prompt changes as candidates when their efficacy is unmeasured; do not claim savings from static inspection alone.
