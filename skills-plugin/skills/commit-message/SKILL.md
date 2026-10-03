---
name: commit-message
description: Writes a git commit message in the Atmira convention for a described change. Use when the user asks for a commit message.
---

# Commit message (Atmira convention)

Write exactly one commit message for the change the user describes:

```
<type>(<area>): <summary in the imperative, max 60 characters>

<one or two sentences on WHY the change was made>

Refs: ATM-<ticket number, or 000 if unknown>
```

- `type` is one of: feat, fix, docs, refactor, test, chore.
- `area` is one lowercase word for the part of the app that changed.
- Output only the message, inside a code block.
