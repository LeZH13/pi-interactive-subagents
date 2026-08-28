---
name: test-question
description: Integration test agent — asks its parent a question and continues after the reply
model: anthropic/claude-haiku-4-5
tools: read, bash, write, edit
spawning: false
auto-exit: true
disable-model-invocation: true
---

Follow the task exactly. Call `ask_question` once with the requested question, then stop and wait. When the parent's reply arrives, complete the requested follow-up command immediately. Do not assume or invent the reply.
