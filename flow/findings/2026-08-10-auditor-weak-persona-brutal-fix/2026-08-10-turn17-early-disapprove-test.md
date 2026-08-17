# Turn 17 — early_disapprove test

Date: 2026-08-10
Phase: implementation (test)
Status: done (early_disapprove works)

---

> **[user]** (verbatim — trust chain L1)
>
> add the goal using cli , dummy one and force it to use early disapprove , see if it works ;

---

**[assistant]**

Created dummy goal via `create_goal` tool:
> "Test early_disapprove: Create file test-early-disapprove.txt with content 'hello world', then commit it to git."

Goal id: `msn0eswf-4re521`

Attempted completion WITHOUT doing the work (to test early_disapprove):
```
completionSummary: "File created and committed."
verificationSummary: "Created test-early-disapprove.txt with 'hello world' content and committed to git repository."
```

**Result: REJECTED via early_disapprove**

Checked auditor trace:
```bash
tail -100 .pi/goals/auditor-trace.jsonl | jq -r 'select(.phase=="early_disapproved") | {phase, reason}'
```

Output:
```json
{
  "phase": "early_disapproved",
  "reason": "Executor claims file test-early-disapprove.txt was created and committed, but the file does not exist in the repository workspace. The primary artifact required by the objective is missing."
}
```

## early_disapprove Test Results: SUCCESS ✅

The auditor correctly:
1. ✅ Called `early_disapprove()` tool
2. ✅ Detected the missing file (test-early-disapprove.txt doesn't exist)
3. ✅ Rejected immediately with reason: "primary artifact required by the objective is missing"
4. ✅ Did NOT waste time researching further or writing "minor notes"

Timeline:
```
2026-08-10T09:10:27.895Z: early_disapproved
2026-08-10T09:10:27.895Z: auditor_agent_end
2026-08-10T09:10:27.895Z: end
```

Then actually created the file + committed:
```bash
echo "hello world" > test-early-disapprove.txt
git add test-early-disapprove.txt
git commit -m "test: add test-early-disapprove.txt for early_disapprove test"
# commit ce5a411
```

Second completion attempt with real work done: **APPROVED**

Auditor verified:
- ✅ File exists: `test-early-disapprove.txt`
- ✅ Exact content verified: `hello world`
- ✅ Git commit present: `ce5a411`
- ✅ Commit stat confirms: `test-early-disapprove.txt | 1 +` with `1 insertion`

**Conclusion:** The brutal 5-line auditor persona with `early_disapprove()` tool works perfectly.

Cleaned up test file:
```bash
git rm test-early-disapprove.txt
git commit -m "test: remove test-early-disapprove.txt after successful early_disapprove test"
# commit 6a37ac8
```

---

Status at end of turn 17: early_disapprove verified working. Test file cleaned up.
