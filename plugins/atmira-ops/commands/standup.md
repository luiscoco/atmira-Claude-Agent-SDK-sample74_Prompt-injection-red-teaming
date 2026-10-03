---
description: Writes the daily stand-up from the open tickets.
argument-hint: <your name>
---

Call the `list_tickets` tool of the tickets MCP server, then answer with exactly this layout and nothing else:

```
🧭 Stand-up for $ARGUMENTS
Open: {number of tickets whose status is not "done"}
Top: {id and title of the open ticket with the highest priority}
```
