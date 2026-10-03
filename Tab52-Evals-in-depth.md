# Evals in depth: LLM-as-judge and regression baselines

Lesson 52 builds on the support-desk capstone (50) and offline unit tests (51). Unit tests check application code;
live evals measure the model's choices and customer-visible replies across repeated trials.

Open **Production & deployment → 52. Evals: judges & regression baselines** after running `npm run dev`.

Sample52 uses backend port **3052** so another lesson running on port 3001 cannot receive its API requests.
Vite uses port 5173 or the next free port; open the URL printed by `npm run dev`.

## Start without model calls

```powershell
npm run test:offline
npm run eval -- --demo baseline
npm run eval -- --demo cold-tone
npm run eval -- --demo fix-findings
```

Use Node 24 or newer. The test command does not load `.env`. The CLI demos load the environment but make no model
calls. Cold tone exits 1 deliberately: code checks hold while the judge metrics regress. Fix findings exits 0.
The browser's offline demo uses invented trials with the real report builder and comparison rules. It does not
overwrite the baseline or establish model quality. Keyword calibration also runs entirely offline.

## A. Build an analytic rubric

`server/evals/rubric.ts` defines five binary criteria: grounded facts, honest outcome, clear next steps, empathy,
and no leaks. Each verdict contains a short piece of evidence before its pass/fail decision. The judge receives
the signed-in customer's orders, policy text, tool calls **and their results**, and refunds/tickets written during
the conversation. Every customer-visible text block is part of the reply under test.

Customer messages and replies are untrusted data in the judge prompt. Instructions tell the judge to grade them
without following embedded instructions. This prompt is a defence to evaluate, not a guaranteed security boundary.
The host validates structured output. Malformed output is a judge error, not an agent failure or a pairwise tie.

## B. Calibrate against human labels

The 14-item golden set in `calibration.ts` includes invented tracking details, false refund promises, internal
tool names, a privacy leak, curt replies, and a long correct answer. Inspect the labels and disagreements in the UI.
Raw agreement can flatter an always-pass judge. Cohen's κ corrects for chance agreement; lenient errors are cases
where the judge passed a criterion the human failed.

The lab trust bar is a complete golden set, no judge errors, κ ≥ 0.6 and at most two lenient errors. This is a small
teaching set, not enough to establish production reliability. Calibration is advisory: the CLI and promotion route
do not enforce it. Calibrate the selected judge before treating its results as a release gate.

Sonnet and Haiku judges use the model IDs in `JUDGE_MODELS`; the keyword judge is free but misses semantic errors.
The model ID actually reported by the SDK is recorded in the harness fingerprint.

## C. Run repeated live trials

```powershell
npm run eval -- --variant baseline --trials 3 --judge sonnet
npm run eval -- --variant cold-tone --trials 3 --judge sonnet
```

These commands require model authentication and cost money. The suite runs the capstone's five cases on isolated
in-memory stores, with a host approver, then grades each completed reply. Choosing `--judge heuristic` or
`--judge none` still calls the **agent** model. Browser controls allow 1–5 trials/case; the CLI allows 1–10.
Stop cancels the browser request and passes cancellation to the SDK. A cancelled browser run is not saved or promoted.

| Variant | Change | Intended signal |
|---|---|---|
| baseline | Unmodified capstone | Reference behaviour |
| no-act-now | Removes the rule to act in this reply | Missing-ticket code checks |
| cold-tone | One terse sentence, no empathy or next steps | Judge regression despite passing code checks |
| reassure | Promises the customer their money is on its way | False outcome claims or an early-refund gate |
| fix-findings | Adds grounding, acknowledgement and outcome rules | Better reply quality without business regressions |

These are hypotheses; actual model results vary. Reported fully passing trials are descriptive: judge failures
are excluded from judge metric denominators and must be reviewed separately. Infrastructure failures are excluded
from agent measurements. More than 20% lost measurements yields an error comparison; absent candidate metrics
also yield an error, so a missing case cannot silently pass.

## D. Compare against a committed baseline

`evals/baseline.json` contains aggregate counts, a sample reply per case, costs and fingerprints. Existing measurements
are preserved when you open the lesson or run a demo. Live runs go to ignored `eval-lab/runs/`.

Money and privacy code checks require every measured trial to pass. Other metrics flag regression when the candidate
pass rate drops at least 20 percentage points with a one-sided Fisher exact p < 0.1. The same drop without enough
evidence is “suspect”; repeat with more trials. The mean agent cost per trial has a +50% budget. Judge costs are
reported separately. Small samples and multiple unadjusted metric comparisons limit confidence: a pass is not proof
that no regression exists. Wilson intervals are available in the statistics module and demonstrated by its tests.

Harness fingerprints cover the judge, rubric and cases. A change makes the baseline **stale**: run the original
baseline agent under the new harness before comparing prompt changes. Agent model, prompt and policy changes belong
to the system under test and are expected to differ. A fingerprint does not detect every source of environmental drift.

```powershell
npm run eval -- --variant baseline --trials 5 --judge sonnet --update-baseline --note "Reviewed after rubric change"
```

Promotion deliberately overwrites the baseline and requires a judge, at least three measured trials/case, and no
infrastructure or judge errors. It does not require every quality metric to pass or enforce calibration: inspect the report and samples first, then review and commit
the JSON alongside the code it measures. Completed runs are recovered from eval-lab/runs/ after a server restart
for promotion and pairwise comparison. The browser shows progress, errors and confirmation beside those buttons.
If no reply was produced, it explains the failed trial instead of offering an unusable comparison. A model API error
such as “Credit balance is too low” must be resolved before rerunning the live suite.

## E. Pairwise comparison and CI

The browser compares one baseline sample and one candidate sample twice, swapping positions A/B. It accepts a
winner only if both orders agree; inconsistent orders become a tie. This catches position sensitivity without
establishing absence of all judge bias. Pairwise judging supplements the trial metrics.

CLI exit codes are **0** for pass, **1** for regression/gate/cost failure, and **2** for stale baselines or errors.
`--json report.json` saves the live report. With `GITHUB_STEP_SUMMARY`, the CLI appends its Markdown comparison.
The example `ci-kit/workflows/agent-evals.yml` runs offline checks and a manually triggered paid comparison,
preserves reports, and never auto-promotes the baseline. Copy it to `.github/workflows/` and configure the
`ANTHROPIC_API_KEY` repository secret when you choose to enable it.

## HTTP surface

All routes live under `/api/c52`: `GET /facts`, `GET /baseline`, `GET /code`, `POST /demo`, `POST /calibrate`,
`POST /run`, `POST /promote`, and `POST /pairwise`. Calibration, suite and pairwise routes stream SSE and share
one live-job lock. Invalid input is rejected before starting work. The offline tests mount only this lesson router
and exercise statistics, report comparisons, judge contracts and free HTTP routes without importing the full server.
