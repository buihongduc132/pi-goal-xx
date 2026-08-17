# Explore Turn 15 — Pi TUI Source Investigation: undefined vs {consume:true}

> Date: 2026-08-10
> Phase: investigate (pi TUI contract)
> Status: complete — found exact contract in pi-tui source

## [user]

Search pi doc to see what is the diff between return undefined vs current approach ;

(verbatim — trust chain L1)

## [assistant]

```
$ find /home/bhd/.local/share/mise/installs/node/22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/docs -name "*.md" | xargs grep -l "consume\|onTerminalInput\|terminalInput" 2>/dev/null
$ find /home/bhd/.local/share/mise/installs/node/22.22.2/lib/node_modules/@earendil-works/pi-coding-agent -name "*.md" | xargs grep -l "consume.*true\|consume.*false\|onTerminalInput" 2>/dev/null | head -10
$ grep -n -B5 -A20 "onTerminalInput\|consume" /home/bhd/.local/share/mise/installs/node/22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md | head -80
$ grep -n -B2 -A15 "TerminalInput\|consume:" /home/bhd/.local/share/mise/installs/node/22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md | head -60
$ grep -rn "consume" /home/bhd/.local/share/mise/installs/node/22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/ | head -20
$ find /home/bhd/.local/share/mise/installs/node/22.22.2/lib/node_modules/@earendil-works/pi-coding-agent -name "*.d.ts" -o -name "*.d.mts" | xargs grep -l "onTerminalInput\|TerminalInput" 2>/dev/null | head -5
$ grep -n -B3 -A15 "onTerminalInput\|TerminalInputResult\|consume" /home/bhd/.local/share/mise/installs/node/22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts | head -60
$ grep -rn -B2 -A15 "consume\|terminalInput\|onTerminalInput" /home/bhd/.local/share/mise/installs/node/22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/ 2>/dev/null | grep -v ".map" | head -60
$ grep -n -B3 -A25 "addExtensionTerminalInputListener\|handleExtensionTerminalInput\|processExtensionTerminal" /home/bhd/.local/share/mise/installs/node/22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js | head -70
$ grep -n -B3 -A20 "addInputListener\|inputListeners\|handleInput\|consume" /home/bhd/.local/share/mise/installs/node/22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/tui.js 2>/dev/null | grep -B3 -A15 "consume" | head -60
```

**Found the exact contract in pi's TUI source** (`pi-tui/dist/tui.js:549-571`):

```javascript
handleTerminalInput(data) {
    if (this.inputListeners.size > 0) {
        let current = data;
        for (const listener of this.inputListeners) {
            const result = listener(current);
            if (result?.consume) {
                return;  // ← STOP — input swallowed, pi never sees it
            }
            if (result?.data !== undefined) {
                current = result.data;  // ← Transform data
            }
        }
        if (current.length === 0) return;
        data = current;
    }
    // ... pi's built-in handlers (Esc→abort, editor input, etc.)
}
```

**Return value semantics:**

| Return | Effect |
|---|---|
| `undefined` | Pi continues processing (next listener → built-in handlers) |
| `{ consume: true }` | **Input swallowed** — pi's handlers never see it |
| `{ data: "..." }` | Transform input data before next listener |
| `{ consume: false }` | Same as `undefined` (pi continues) |

**What this means for Esc:**

- `return undefined` → Esc passes to pi → pi aborts running turn/tool execution (native behavior)
- `return { consume: true }` → Esc is swallowed → pi never sees it → running turn continues uninterrupted

**Why the original fork used `{ consume: true }`:**

The comment explains it was a workaround to prevent the abort-pause cascade:
```
// Must return { consume: true } so the TUI doesn't also process the key
// and abort the running tool execution, which would cascade into pausing
// the entire goal (agent_end sees ctx.signal?.aborted and calls pauseActiveGoal).
```

**Now that we removed the abort-pause path** (commit `d9c915a`), the cascade no longer exists. So `{ consume: true }` is obsolete — we could safely return `undefined` for both `escape=true` and `escape=false`.

**Current behavior (after my fix `d7fd46a`):**
- `escape=false`: return `undefined` → pi handles Esc → stops session ✅
- `escape=true`: return `{ consume: true }` → goal pauses, Esc swallowed, session continues

**Want me to align `escape=true` with upstream** (return `undefined` so Esc both pauses goal AND stops session)?

---

Status at end of turn 15: Found exact pi TUI contract. `{consume:true}` swallows input, `undefined` passes to pi. Abort-pause cascade removed, so `{consume:true}` obsolete. Open question: align `escape=true` with upstream? Next: findings documentation (this file).
