# Explore Turn 10 — fix-applied

Date: 2026-08-09
Phase: action
Status: complete — locked decision LD2

---

> **[user]** (verbatim — trust chain L1)
>
> Fucker , fix it ; Then add the flow/lessons_learn/ for me ; then commit it ;

---

**[assistant]**

Actions taken:

1. **Global path fixed** — copied auditor.md to correct global resolver path:
   - Source: `~/.pi/agent/git/github.com/buihongduc132/pi-goal-xx/.pi/pi-goal-xx/prompts/auditor.md`
   - Destination: `/home/bhd/.pi/pi-goal-xx/prompts/auditor.md` ✓

2. **Local CWD path created**:
   - `/home/bhd/Documents/Projects/bhd/pi-goal-xx/.pi/pi-goal-xx/prompts/auditor.md` ✓
   - (gitignored — `.pi/` in `.gitignore`)

3. **Lesson learn written**:
   - `flow/lesson_learn/2026-08-auditor-custom-prompt-dead-path.md` ✓

4. **Committed**:
```
[main 08dcda4] docs: add lesson_learn — auditor custom prompt dead path
 1 file changed, 20 insertions(+)
 create mode 100644 flow/lesson_learn/2026-08-auditor-custom-prompt-dead-path.md
```

Callout: `.pi/` is gitignored so the local prompt won't be tracked. Only the global one persists across machines. If this needs to be version-controlled, move it out of `.pi/` or add a deploy script.

---

Status at end of turn 10: Fix applied. Lesson_learn committed. CA raised about gitignore. → Turn 11.
