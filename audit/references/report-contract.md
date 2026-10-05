# Audit report contract

Follow the caller's requested format. Otherwise return:

1. **Scope and coverage** — resolved session roots or profiles, descendants, branch/range and cutoff, missing evidence, and what was actually verified.
2. **Measurements** — a compact row per session (or capability row per profile); label parent/child attribution, shared-tree overlap, estimates, and unavailable values. Do not report aggregate usage until double-counting is excluded.
3. **Findings** — ranked by impact, with exact path/entry/line evidence, observed trigger, supported cause or hypothesis, and consequence. State when no supported defect was found.
4. **Recommendations** — distinguish prompt, configuration, and extension-code changes. Give expected tradeoffs, confidence, and a targeted validation or regression scenario.
5. **Cross-session patterns** — only for multiple inputs; include recurring and contradictory evidence, confounders, and whether baseline/treatment attribution is established.

For each finding distinguish **observed**, **reproduced**, **hypothesized**, or **unknown**; do not use numeric savings unless measurements support them. Avoid findings quotas and speculative infrastructure.

Aim for 500 words for one audit, or a concise comparison table plus up to 300 words of cross-session analysis for multiple inputs; expand for material evidence only. Final reports must stand alone. Store larger evidence only when the user authorizes a local output path; never publish transcripts or commit private session data.
