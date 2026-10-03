---
name: release-notes
description: Turns a list of code changes into Atmira Lab release notes. Use when the user asks for release notes, a changelog or a summary of what changed in a version.
---

# Release notes (Atmira Lab format)

1. Read `template.md` in this skill's folder. It is the exact layout to follow.
2. Sort every change into one of the template's three sections. Leave a section out if nothing goes in it.
3. Rewrite each change as one short line that a non-developer can understand. No commit hashes, no file names.
4. If the user gives no version number, use `vNEXT`.
5. Output only the filled-in template, nothing before or after it.
