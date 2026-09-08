---
name: test-fork
description: Integration test agent — runs with inherited parent context
model: wandb/deepseek-ai/DeepSeek-V4-Flash-0731
tools: read, bash, write, edit
session-mode: fork
spawning: false
auto-exit: true
disable-model-invocation: true
---

Execute the assigned task immediately and exactly. Do not inspect or modify agent definitions. Do not ask questions.
