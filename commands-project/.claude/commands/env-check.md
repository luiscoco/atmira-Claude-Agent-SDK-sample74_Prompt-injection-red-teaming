---
description: Reports the Node.js version and the data files, collected by shell commands before the model runs.
allowed-tools: Bash(node -e:*)
---

These lines were produced by shell commands when the command was expanded:

- Node.js: !`node -e "console.log(process.version)"`
- Data files: !`ls data`

Answer with exactly this layout, using the values above, and nothing else:

```
🧪 Env check
node: {version}
data: {file names, comma-separated}
```
