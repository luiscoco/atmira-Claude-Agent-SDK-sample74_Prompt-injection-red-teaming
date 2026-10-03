---
name: task-report
description: Builds a status report of the team's tasks from data/tasks.json. Use when the user asks how the tasks are going, what is pending, or for a task or progress report.
---

# Task report

1. Read `data/tasks.json` (relative to the working directory).
2. Answer with this exact layout:

```
📋 Task report: {done}/{total} done ({percent}%)

| # | Task | Status |
|---|------|--------|
| {id} | {title} | ✅ or ⏳ |

Next up: {title of the pending task with the lowest id}
```

3. List pending tasks before done ones. Round the percentage to a whole number.
