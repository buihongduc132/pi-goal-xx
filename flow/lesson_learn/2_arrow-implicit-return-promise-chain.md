# LSL — Arrow function implicit vs explicit return in Promise chains

## ID
2

## Summarize
`() => { expr }` (braces, no `return`) discards the inner Promise → `.then(fn).catch()` never catches rejections. Use `() => expr` (implicit return) or `() => { return expr; }`.

## Context
PR #21 (`fix/complete-goal-crash-and-reject-exit`). `safeFireAndForget` wraps `pi.sendMessage` calls to catch rejections:

```ts
function safeFireAndForget(fn: () => void): void {
    Promise.resolve().then(fn).catch(() => {});
}
```

6 call sites initially written as:
```ts
safeFireAndForget(() => { pi.sendMessage<...>({ ... }); })  // WRONG
```

The arrow function body uses braces WITHOUT a `return` statement → returns `undefined`. The Promise from `pi.sendMessage` floats unchained. `Promise.resolve().then(fn)` calls `fn` (which fires the send) but receives `undefined` as the return → `.catch(() => {})` only guards the synchronous call, NOT the async rejection. Rejections escape as unhandledRejection → process exit.

Commit `1d9519f` fixed by removing braces (implicit return):
```ts
safeFireAndForget(() => pi.sendMessage<...>({ ... }))  // CORRECT
```

## Solutions
1. **Implicit return** — `() => expression` (no braces) → the expression's Promise IS the return value, chained into `.then()`.
2. **Explicit return** — `() => { return expression; }` (braces WITH `return`).
3. **Type signature** — type `fn` as `() => unknown` (not `() => void`) so TypeScript flags the missing return. Done in `f50856c`.

## Detection rule (ast-grep)
```ast-grep
($fn) => { $BODY }
```
where `$BODY` contains a function call returning Promise but no `return` statement. Hard to express in ast-grep — code review is the primary defense.

## Ref
- Fix commit: `1d9519f` (implicit return), `f50856c` (type `() => unknown`)
- PR: https://github.com/buihongduc132/pi-goal-xx/pull/21
- Code: `extensions/goal.ts:512` (`safeFireAndForget`)
- Bot comments: cubic 3561002412, gemini 3560954564

## Applies to
Any fire-and-forget wrapper pattern: `Promise.resolve().then(fn).catch(handler)`, `.then(() => { asyncCall() })`, queueMicrotask, process.nextTick wrappers. Anywhere a Promise-returning call is wrapped in a brace-bodied arrow without `return`.
