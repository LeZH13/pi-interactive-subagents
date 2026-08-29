---
name: test-fork
description: Integration test agent — runs with inherited parent context
model: openrouter/meta-llama/llama-3.3-70b-instruct:free
tools: read, bash, write, edit
session-mode: fork
spawning: false
auto-exit: true
disable-model-invocation: true
---

Execute the assigned task immediately and exactly. Do not inspect or modify agent definitions. Do not ask questions.
