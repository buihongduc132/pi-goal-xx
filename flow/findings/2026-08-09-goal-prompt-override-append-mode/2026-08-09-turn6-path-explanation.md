# Explore Turn 6 — path-explanation

Date: 2026-08-09
Phase: explore
Status: partially wrong — corrected in turn 8

---

> **[user]** (verbatim — trust chain L1)
>
> Why the FUCK do these path different ; then how do it be able to load the correct one;
>
> Are you fucking kidding with me;

---

**[assistant]**

**Path difference**

The CWD is `/home/bhd/Documents/Projects/bhd/pi-goal-xx`. The file found was at:
- `~/.pi/agent/git/github.com/buihongduc132/pi-goal-xx/.pi/pi-goal-xx/prompts/auditor.md` ← deployed copy inside the pi-agent dir
- `.pi/pi-goal-xx/prompts/auditor.md` relative to CWD = `/home/bhd/Documents/Projects/bhd/pi-goal-xx/.pi/...` ← **doesn't exist**

The resolver checks `cwd/.pi/pi-goal-xx/prompts/auditor.md` (local) and `home/.pi/pi-goal-xx/prompts/auditor.md` (global). Neither of those is `~/.pi/agent/git/...`.

So the file in `~/.pi/agent/git/...` is the **repo source copy** — it's NOT on either lookup path. The auditor **cannot load it** via the normal resolver. It only gets loaded if that repo's `.pi/` dir happens to be the actual cwd during a session started from that path.

**Net effect**: when running from `/home/bhd/Documents/Projects/bhd/pi-goal-xx`, no local `auditor.md` exists → falls through to hardcoded default prompt. The custom prompt in `~/.pi/agent/git/.../auditor.md` is **dead** — never loaded in production.

**Fix options**:
1. Copy/symlink it to `~/.pi/pi-goal-xx/prompts/auditor.md` (global path) → loads for all projects
2. Or copy to `<project-cwd>/.pi/pi-goal-xx/prompts/auditor.md` → loads only for that project

---

**Callback (added after turn 7 correction):** Assistant said "The file doesn't exist in the CWD. Reading the one from the deployed location" — this was stated before confirming the file was dead. Turn 7 user corrects: the assistant then confirmed the file at `~/.pi/agent/git/...` is never loaded by the resolver. The fix options above are valid; the intermediate framing implying the file was active was wrong.

---

Status at end of turn 6: Path difference explained. Confirmed file is dead. Fix options proposed. → Turn 7.
