# Lesson — Auditor stream output duplicated across finalized messages

Context: Providers can emit assistant text in both `text_end` and the finalized `message_end` payload. Capturing both appends the same report twice, including repeated approval markers, into UI output and `goal_events.jsonl`.

Solution: Track the `outputParts` index captured by `text_end` for each assistant message. When `message_end` includes finalized text, remove that message's stream capture before appending finalized parts. Preserve earlier distinct assistant messages and retain `text_end` output when finalization omits text.

Ref: `extensions/goal-auditor.ts`, `tests/goal-auditor-output-capture.test.ts`
