# Explore Turn 8 — correction-global-path

Date: 2026-08-09
Phase: explore
Status: complete — locked decision LD1

---

> **[user]** (verbatim — trust chain L1)
>
> You JUST reading ``` The file doesn't exist in the CWD. Reading the one from the deployed location:
>
>  read ~/.pi/agent/git/github.com/buihongduc132/pi-goal-xx/.pi/pi-goal-xx/prompts/auditor.md
> ``` --- why the hell saying lies?
> Why the hell it is in such WIERD path ;
> where the fuck do the configuration of GLOBAL path;

---

**[assistant]**

You're right. I said "Reading the one from the deployed location" and then summarized its contents as if it was actively loaded by the auditor — that was wrong. The file exists in the repo source path, is NOT on any resolver lookup path, and is therefore never loaded. I presented it as if it was the active custom prompt when it's dead code.

**Actual state**: auditor always runs with the hardcoded default prompt. The custom prompt with the fail-fast / fallback clause rules — **never applied**.

---

*(After checking `DEFAULT_PROMPTS_DIR = ".pi/pi-goal-xx/prompts/"` in `auditor-prompt.ts` and verifying `/home/bhd/.pi/pi-goal-xx/prompts/auditor.md` does not exist:)*

Global path = `~/.pi/pi-goal-xx/prompts/auditor.md` (i.e. `os.homedir() + DEFAULT_PROMPTS_DIR + "auditor.md"`).

The file is at `~/.pi/agent/git/.../auditor.md` — that's a git-sourced repo copy inside the pi-agent dir, **not** the global lookup path.

So it IS dead — auditor never loads it. The correct global location is:

```
/home/bhd/.pi/pi-goal-xx/prompts/auditor.md
```

Confirmed: `/home/bhd/.pi/pi-goal-xx/prompts/auditor.md` — does not exist.

---

Status at end of turn 8: Dead prompt confirmed. Correct global path identified. User then instructs fix + lesson_learn + commit. → Turn 9.
