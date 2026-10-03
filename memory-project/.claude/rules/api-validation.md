---
paths:
  - "api/**/*.js"
---

# API validation rule

- Marker: 🟧 PATH-RULE (.claude/rules/api-validation.md, loaded only when a file matching api/**/*.js is read)
- Every API handler must validate its input with assertOrder() before using it.
