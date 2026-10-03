# Spec format (atmira-docx)

One JSON object. Unknown fields are errors.

```json
{
  "kind": "general",
  "title": "Quarterly platform review",
  "subtitle": "Q3 2026",
  "author": "Platform team",
  "date": "2026-10-03",
  "classification": "Internal",
  "blocks": [
    { "type": "heading", "level": 1, "text": "Summary" },
    { "type": "paragraph", "text": "Availability was **99.95%**, above target." },
    { "type": "bullets", "items": ["First point", "Second point"] },
    { "type": "numbered", "items": ["Step one", "Step two"] },
    { "type": "table", "columns": ["Owner", "Action"], "rows": [["Ana", "Rotate keys"]] },
    { "type": "callout", "tone": "warning", "text": "Read this before the next release." }
  ]
}
```

| Field | Rules |
|---|---|
| `kind` | `"general"` or `"incident-report"` (an incident report must follow `incident-report.md`) |
| `title` | 1–90 characters |
| `subtitle` | optional, at most 120 characters |
| `author` | 1–80 characters |
| `date` | `YYYY-MM-DD` |
| `classification` | `"Public"`, `"Internal"` or `"Confidential"` |
| `blocks` | 1–120 blocks |

| Block | Fields |
|---|---|
| `heading` | `level` 1 or 2, `text` (1–120 characters) |
| `paragraph` | `text` (1–1500 characters) |
| `bullets`, `numbered` | `items`: 1–20 strings (1–400 characters each) |
| `table` | `columns`: 1–6 strings; `rows`: 1–40 rows, each with exactly one cell per column |
| `callout` | `tone`: `"info"` or `"warning"`, `text` (1–600 characters) |

Inline formatting: wrap text in `**double asterisks**` for bold. That is the only markup. Any other characters,
including `<` and `&`, are printed literally.
