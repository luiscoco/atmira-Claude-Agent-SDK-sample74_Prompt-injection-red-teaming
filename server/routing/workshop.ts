import { z } from "zod";

/**
 * Lesson 59's pure part: the models and their prices, a graded task set, two routers (rules and an LLM classifier's
 * schema), the cascade's cheap verifier and an offline cost projection. Nothing here starts Claude Code; the route in
 * concepts/59-model-routing.ts runs the live strategies and reports what modelUsage really billed.
 */

// Explicit IDs, not aliases: with SDK 0.3.281 the alias "sonnet" resolved to claude-sonnet-5, not claude-sonnet-5-5.
export const tiers = ["light", "standard", "deep"] as const;
export type Tier = typeof tiers[number];
export const models = {
  light: { id: "claude-haiku-4-5", label: "Haiku 4.5", inputPerMTok: 1, outputPerMTok: 5 },
  standard: { id: "claude-sonnet-5-5", label: "Sonnet 5.5", inputPerMTok: 2, outputPerMTok: 10 },
  deep: { id: "claude-opus-5-5", label: "Opus 5.5", inputPerMTok: 4, outputPerMTok: 20 },
} as const satisfies Record<Tier, { id: string; label: string; inputPerMTok: number; outputPerMTok: number }>;
export const modelIds = Object.values(models).map((model) => model.id);

export type Task = {
  id: string; tier: Tier; prompt: string;
  /** Accepted answers, compared after normalize(). */
  accept: string[];
  /** The cascade's cheap check: does the answer even have the right shape? It is NOT the grader. */
  format: RegExp;
  /** Why the label is what it is. */
  note: string;
};

/** Ten tasks with one checkable answer each. The tier is the label a human gave; routers try to predict it. */
export const tasks: Task[] = [
  { id: "invoice-id", tier: "light", accept: ["inv-2042"], format: /^INV-\d{4}$/i, note: "Extraction: copy one token.",
    prompt: "Extract the invoice ID from this message: \"Hi, I was charged twice for INV-2042 on 3 May, order 7781.\"" },
  { id: "sentiment", tier: "light", accept: ["negative"], format: /^(positive|negative|neutral)$/i, note: "Classification into three labels.",
    prompt: "Classify the sentiment as positive, negative or neutral: \"The parcel arrived broken and nobody answers the phone.\"" },
  { id: "cents", tier: "light", accept: ["4900"], format: /^\d+$/, note: "Unit conversion.",
    prompt: "Convert 49.00 EUR to an integer number of cents." },
  { id: "vowels", tier: "light", accept: ["3"], format: /^\d+$/, note: "Easy, but it starts with \"How many\", which the rules treat as a hard counting task.",
    prompt: "How many vowels are in the word \"routing\"?" },
  { id: "timezone", tier: "standard", accept: ["09:30", "9:30"], format: /^\d{1,2}:\d{2}$/, note: "Two-step arithmetic with offsets.",
    prompt: "A call is at 15:30 in Madrid (UTC+2). What time is it in New York (UTC-4)? Answer as HH:MM in 24-hour time." },
  { id: "js-sort", tier: "standard", accept: ["1,10,9"], format: /^[\d,\s]+$/, note: "Looks trivial; the default sort compares strings.",
    prompt: "What does this JavaScript print? console.log([10, 9, 1].sort().join(\",\"))" },
  { id: "weekday", tier: "standard", accept: ["thursday"], format: /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i, note: "Calendar reasoning across a leap day.",
    prompt: "Which day of the week was 29 February 2024?" },
  { id: "lineup", tier: "deep", accept: ["cai,ana,ben,eli,dee"], format: /^\s*\w+(\s*,\s*\w+){4}\s*$/, note: "Constraint puzzle with exactly one solution (checked by brute force in the tests).",
    prompt: "Ana, Ben, Cai, Dee and Eli stand in a line, positions 1 to 5 from the left. Ana is in position 2 or 4. Ben stands next to Ana. Ben is somewhere left of Eli and is not in position 1. Eli is at neither end. Dee is somewhere right of Ana. Cai and Dee are not next to each other. Give the names from left to right, separated by commas." },
  { id: "divisible", tier: "deep", accept: ["401"], format: /^\d+$/, note: "Inclusion-exclusion; the \"but not by 15\" step is easy to miss.",
    prompt: "How many integers from 1 to 1000 are divisible by 3 or by 5, but not by 15?" },
  { id: "increasing", tier: "deep", accept: ["126"], format: /^\d+$/, note: "Combinatorics: choose 4 of the digits 1-9.",
    prompt: "How many four-digit numbers have digits that strictly increase from left to right (for example 1359)?" },
  { id: "digit-sum", tier: "deep", accept: ["282"], format: /^\d+$/, note: "Stars and bars with an upper bound: forgetting the digit cap gives 286.",
    prompt: "How many integers from 1 to 10000 have digits that add up to exactly 10?" },
  { id: "power-mod", tier: "deep", accept: ["49"], format: /^\d+$/, note: "Modular exponentiation with no calculator.",
    prompt: "What are the last three digits of 7^222? Give the number formed by those digits, without leading zeros." },
  { id: "multiply", tier: "deep", accept: ["452637167"], format: /^[\d,]+$/, note: "Long multiplication; one dropped carry is wrong.",
    prompt: "Compute 48271 × 9377 exactly." },
];
export const taskById = (id: string) => tasks.find((task) => task.id === id);

/** Lowercase, drop spaces, surrounding quotes and a trailing period: "Cai, Ana, Ben, Eli, Dee." -> "cai,ana,ben,eli,dee". */
export const normalize = (answer: string) => answer.trim().toLowerCase().replace(/^["'`]+|["'`.]+$/g, "").replace(/\s+/g, "");
export const grade = (task: Task, answer: string) => task.accept.includes(normalize(answer));

// ---------------------------------------------------------------------------------------------
// Router 1: rules. Free, instant, transparent, and wrong whenever the wording misleads.
// ---------------------------------------------------------------------------------------------
export const rules: { tier: Tier; pattern: RegExp; why: string }[] = [
  { tier: "deep", pattern: /\b(how many|puzzle|prove|positions?|constraint)\b/i, why: "counting / puzzle words" },
  { tier: "light", pattern: /\b(extract|classify|convert|translate|format)\b/i, why: "extract / classify / convert verbs" },
];
export function ruleRoute(prompt: string): { tier: Tier; why: string } {
  const rule = rules.find((row) => row.pattern.test(prompt));
  return rule ? { tier: rule.tier, why: rule.why } : { tier: "standard", why: "no rule matched: default to the middle tier" };
}

// ---------------------------------------------------------------------------------------------
// Router 2: an LLM classifier (live). Its schema and prompt live here so the tests can check them.
// ---------------------------------------------------------------------------------------------
export const classifierPrompt = [
  "You route tasks to a model tier. Do not solve the task.",
  "light: copy, extract, classify or convert; one obvious step.",
  "standard: a few steps of arithmetic, dates or code reading, or a known trap.",
  "deep: multi-constraint puzzles or combinatorics where one slip gives a wrong answer.",
].join("\n");
export const classifierSchema = {
  type: "object", additionalProperties: false, required: ["tier", "reason"],
  properties: { tier: { type: "string", enum: [...tiers] }, reason: { type: "string" } },
} as const;
export const answerSchema = {
  type: "object", additionalProperties: false, required: ["answer", "confidence"],
  properties: {
    answer: { type: "string", description: "Only the final answer, with no working, units or explanation." },
    confidence: { type: "string", enum: ["high", "low"], description: "low if you are not sure the answer is right." },
  },
} as const;
export const solverPrompt = "Solve the task. Put only the final answer in the structured output's answer field, and set confidence honestly.";

/** The cascade escalates when the cheap model is unsure OR its answer has the wrong shape. Neither looks at the key. */
export function needsEscalation(task: Task, output: { answer?: unknown; confidence?: unknown } | undefined) {
  if (!output || typeof output.answer !== "string") return { escalate: true, why: "no structured answer" };
  if (output.confidence === "low") return { escalate: true, why: "the model reported low confidence" };
  if (!task.format.test(output.answer.trim())) return { escalate: true, why: `the answer does not match ${task.format}` };
  return { escalate: false, why: "confident and well-formed" };
}

// ---------------------------------------------------------------------------------------------
// Strategies and the offline projection.
// ---------------------------------------------------------------------------------------------
export const strategies = ["haiku", "sonnet", "opus", "opus-low", "rules", "classifier", "cascade", "review"] as const;
export type Strategy = typeof strategies[number];
export const strategySchema = z.enum(strategies);
export const strategyInfo: Record<Strategy, string> = {
  haiku: "Every task on Haiku 4.5.",
  sonnet: "Every task on Sonnet 5.5.",
  opus: "Every task on Opus 5.5 (default effort).",
  "opus-low": "Every task on Opus 5.5 with effort: \"low\". The one-model alternative to measure before building a router.",
  rules: "The rule router picks the tier, then query({ model }) runs it.",
  classifier: "Haiku classifies the tier (structured output), then query({ model }) runs it. The classifier call is billed too.",
  cascade: "Haiku answers first. If it is unsure or the answer is malformed, setModel(Opus) in the same session and ask again.",
  review: "Haiku drafts, then setModel(Opus) ALWAYS checks the draft in the same session. Draft-then-verify: the escalation path on every task.",
};

/** Assumed tokens per call, from the probes in this lesson: about 1,100 input (2 turns with the structured output tool). */
export const assumptions = { inputTokens: 1_100, outputTokens: { light: 150, standard: 250, deep: 500 } as Record<Tier, number>, classifierOutput: 40 };
export const callCost = (tier: Tier, outputTokens: number, inputTokens = assumptions.inputTokens) =>
  (inputTokens * models[tier].inputPerMTok + outputTokens * models[tier].outputPerMTok) / 1_000_000;

/** Which tier each strategy would pick for a task, offline. The classifier and cascade are approximated (see notes). */
export function plannedTier(strategy: Strategy, task: Task): Tier[] {
  switch (strategy) {
    case "haiku": return ["light"];
    case "sonnet": return ["standard"];
    case "opus": case "opus-low": return ["deep"];
    case "rules": return [ruleRoute(task.prompt).tier];
    case "classifier": return [task.tier]; // assumes a perfect classifier: the best case for this strategy
    case "cascade": return task.tier === "deep" ? ["light", "deep"] : ["light"]; // assumes Haiku flags exactly the deep tasks
    case "review": return ["light", "deep"];
  }
}
export function project(strategy: Strategy) {
  const rows = tasks.map((task) => {
    const route = plannedTier(strategy, task);
    // A call's output size follows the task's difficulty, whichever model runs it.
    let cost = route.reduce((sum, tier) => sum + callCost(tier, assumptions.outputTokens[task.tier]), 0);
    if (strategy === "classifier") cost += callCost("light", assumptions.classifierOutput);
    return { task: task.id, label: task.tier, route, cost, misrouted: strategy === "rules" && route[0] !== task.tier };
  });
  return { strategy, rows, totalUsd: rows.reduce((sum, row) => sum + row.cost, 0), misrouted: rows.filter((row) => row.misrouted).length };
}
