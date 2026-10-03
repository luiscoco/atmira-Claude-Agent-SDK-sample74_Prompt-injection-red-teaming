# Post-incident review (kind: "incident-report")

Set `"kind": "incident-report"`. The build fails unless these level-1 headings appear in this order
(other headings may sit between them):

1. **Summary**: two or three sentences: what broke, for how long, and who was affected.
2. **Impact**: bullets with measured numbers from the source (duration, error rate, affected orders or users).
3. **Timeline**: a table with the columns `Time (UTC)` and `Event`, one row per event, in order.
4. **Root cause**: what failed and why. Blameless: describe systems and decisions, never blame a person.
5. **Action items**: a table whose columns include `Owner` and `Due`. Every action has an owner and a due date.

Start the document with a `callout` (tone `info`) that states the severity and the current status, for example
"Severity 2 · Resolved".

Use only facts from the source material. If the source disagrees with itself, say so instead of choosing silently.
