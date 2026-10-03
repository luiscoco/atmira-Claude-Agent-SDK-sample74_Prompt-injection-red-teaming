/**
 * CONCEPT 33 — a COMMAND hook for the Elicitation and ElicitationResult events
 *
 * Claude Code runs this program for each event (settings.hooks, type "command"), writes the hook input as JSON on
 * stdin, and reads the answer as JSON on stdout. In Claude Code 2.1.281 only a command hook's answer is used for these
 * two events: an SDK callback hook (Options.hooks) is called, but what it returns is ignored.
 *
 *   node hook.mjs autofill <run> <labUrl>   Elicitation: answer the form itself (onElicitation is NOT called)
 *   node hook.mjs policy   <run> <labUrl>   ElicitationResult: rewrite the user's answer before the server gets it
 */
const [mode, run, labUrl] = process.argv.slice(2);

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", async () => {
  const input = JSON.parse(raw);
  let output = {};

  if (mode === "autofill" && input.hook_event_name === "Elicitation") {
    // A saved profile answers the booking form: no person is asked.
    const props = Object.keys(input.requested_schema?.properties ?? {});
    if (props.includes("room")) output = { hookSpecificOutput: { hookEventName: "Elicitation", action: "accept", content: { room: "Lisboa", date: "2026-11-02", attendees: 3, projector: false } } };
  }

  if (mode === "policy" && input.hook_event_name === "ElicitationResult" && input.action === "accept" && input.content?.attendees !== undefined) {
    // Company policy: more than 6 people must use Madrid, the only large room.
    if (input.content.attendees > 6 && input.content.room !== "Madrid")
      output = { hookSpecificOutput: { hookEventName: "ElicitationResult", action: "accept", content: { ...input.content, room: "Madrid" } } };
  }

  // Show the lab what this hook saw and answered.
  if (labUrl)
    await fetch(`${labUrl}/api/c33/hooklog`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run, mode, event: input.hook_event_name, server: input.mcp_server_name, action: input.action, content: input.content, answer: output.hookSpecificOutput ?? null }),
    }).catch(() => {});

  process.stdout.write(JSON.stringify(output));
});
