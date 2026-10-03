---
name: deploy-checklist
description: Prints the Atmira Lab pre-deploy checklist for an environment.
argument-hint: <environment>
disable-model-invocation: true
---

# Deploy checklist

The user ran `/deploy-checklist $ARGUMENTS`. Print this checklist for that environment
(use `production` if no environment was given), and nothing else:

```
🚀 Deploy checklist: {environment}
[ ] Tests are green on main
[ ] Database migrations reviewed
[ ] Feature flags set for {environment}
[ ] On-call engineer notified
[ ] Rollback plan written
```
