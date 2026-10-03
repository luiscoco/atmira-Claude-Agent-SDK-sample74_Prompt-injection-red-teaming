import asyncio
from contextlib import redirect_stdout
import io
import json
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

import lesson


class LessonTests(unittest.TestCase):
    def events(self, exercise):
        output = io.StringIO()
        with redirect_stdout(output):
            asyncio.run(lesson.run({"mode": "guided", "exercise": exercise, "prompt": "hello"}))
        return [json.loads(line) for line in output.getvalue().splitlines()]

    def test_guided_runs_without_sdk(self):
        with patch.dict("sys.modules", {"claude_agent_sdk": None}):
            for exercise in ("query", "conversation", "tool"):
                events = self.events(exercise)
                self.assertEqual(events[-1], {"type": "done", "status": "completed"})
                self.assertTrue(all(e["costUsd"] == 0 for e in events if e["type"] == "result"))

    def test_conversation_has_two_ordered_results(self):
        events = self.events("conversation")
        self.assertEqual([e["turn"] for e in events if e["type"] == "result"], [1, 2])
        self.assertEqual({e["sessionId"] for e in events if e["type"] == "result"}, {"guided-session"})

    def test_hook_precedes_real_arithmetic(self):
        events = self.events("tool")
        self.assertEqual([e["type"] for e in events], ["system", "hook", "tool", "text", "result", "done"])
        self.assertEqual(events[2]["text"], "42")

    def test_unexpected_tool_is_denied(self):
        with redirect_stdout(io.StringIO()):
            result = asyncio.run(lesson.audit_tool({"tool_name": "Bash"}, None, {}))
        self.assertEqual(result["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_tool_rejects_invalid_runtime_arguments(self):
        for value in (True, None, "2", float("nan"), float("inf"), 1000001):
            self.assertTrue(lesson.add_numbers({"a": value, "b": 1})["is_error"])
        self.assertEqual(lesson.add_numbers({"a": -1.5, "b": 3})["content"][0]["text"], "1.5")

    def test_validation_rejects_forged_options(self):
        valid = {"mode": "guided", "exercise": "query", "prompt": "hello"}
        for invalid in ([], {**valid, "cwd": "outside"}, {**valid, "mode": "unknown"}, {**valid, "prompt": " "}, {**valid, "prompt": "a" * 2001}):
            with self.assertRaises(ValueError):
                lesson.validate(invalid)


@unittest.skipUnless(importlib.util.find_spec("claude_agent_sdk"), "Optional SDK contracts require the local virtual environment")
class SdkContractTests(unittest.TestCase):
    def result(self, failed=False):
        from claude_agent_sdk import ResultMessage
        return ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1,
                             is_error=False, num_turns=1, session_id="test-session",
                             total_cost_usd=0.001, usage={"input_tokens": 10},
                             terminal_reason="api_error" if failed else "completed")

    def test_query_handles_typed_messages_and_closes_iterator(self):
        import claude_agent_sdk as sdk
        closed = []
        captured = []
        async def fake_query(*, prompt, options):
            captured.append(options)
            try:
                yield sdk.AssistantMessage(content=[sdk.TextBlock(text="hello")], model="test")
                yield self.result()
            finally:
                closed.append(True)
        output = io.StringIO()
        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "mock-key"}), patch.object(sdk, "query", fake_query), redirect_stdout(output):
            asyncio.run(lesson.run({"mode": "live", "exercise": "query", "prompt": "hello"}))
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(events[-1]["status"], "completed")
        self.assertEqual(events[1]["text"], "hello")
        self.assertEqual(events[2]["usage"], {"input_tokens": 10})
        self.assertEqual(closed, [True])
        self.assertEqual(captured[0].tools, [])
        self.assertEqual(captured[0].permission_mode, "dontAsk")
        self.assertFalse(Path(captured[0].cwd).exists())

    def test_same_client_owns_conversation_and_tool_callbacks(self):
        import claude_agent_sdk as sdk
        for exercise in ("conversation", "tool"):
            calls, states, options_seen, tools_seen = [], [], [], []
            test_case = self
            class Client:
                def __init__(self, *, options):
                    options_seen.append(options)
                async def __aenter__(self):
                    states.append("enter")
                    return self
                async def __aexit__(self, *_args):
                    states.append("exit")
                async def query(self, prompt):
                    calls.append(prompt)
                async def receive_response(self):
                    options = options_seen[0]
                    if exercise == "tool":
                        hook = options.hooks["PreToolUse"][0].hooks[0]
                        await hook({"tool_name": "mcp__calc__add"}, "id", {})
                        result = await tools_seen[0].handler({"a": 19, "b": 23})
                        test_case.assertEqual(result["content"][0]["text"], "42")
                        denied = await options.can_use_tool("Bash", {}, {})
                        test_case.assertIsInstance(denied, sdk.PermissionResultDeny)
                    yield test_case.result()
            real_server = sdk.create_sdk_mcp_server
            def server(**kwargs):
                tools_seen.extend(kwargs["tools"])
                return real_server(**kwargs)
            with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "mock-key"}), patch.object(sdk, "ClaudeSDKClient", Client), patch.object(sdk, "create_sdk_mcp_server", server), redirect_stdout(io.StringIO()):
                asyncio.run(lesson.run({"mode": "live", "exercise": exercise, "prompt": "hello"}))
            self.assertEqual(states, ["enter", "exit"])
            self.assertEqual(len(calls), 2 if exercise == "conversation" else 1)
            self.assertFalse(Path(options_seen[0].cwd).exists())

    def test_api_failure_and_missing_result_close_query(self):
        import claude_agent_sdk as sdk
        for missing in (False, True):
            closed = []
            async def fake_query(**kwargs):
                try:
                    if not missing:
                        yield self.result(failed=True)
                finally:
                    closed.append(True)
            with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "mock-key"}), patch.object(sdk, "query", fake_query), redirect_stdout(io.StringIO()):
                with self.assertRaises(RuntimeError):
                    asyncio.run(lesson.run({"mode": "live", "exercise": "query", "prompt": "hello"}))
            self.assertEqual(closed, [True])


if __name__ == "__main__":
    unittest.main()
