/**
 * SerializedSender — a single-threaded send mutex for pi IPC calls
 * (sendMessage / sendUserMessage) that must not race on the host session's
 * `isStreaming` flag.
 *
 * G7 fix (memory): the original `messageSendChain` closure appended a new
 * `.then()` on every send for the entire lifetime of the goal extension.
 * In a long-running session with hundreds of sends, that produced an
 * unbounded linked list of settled promise continuations held alive by the
 * chain head. This class resets the chain to a fresh `Promise.resolve()`
 * once every queued send has drained, bounding memory growth to the current
 * burst instead of the whole session.
 *
 * Contract:
 *  - serializedSend(fn) runs `fn` only after all previously queued sends settle.
 *  - A failed send never poisons the chain (rejections are swallowed on the
 *    chain itself; the caller still observes the real rejection from `run`).
 *  - When the queue fully drains (pendingCount === 0), the internal chain is
 *    replaced with a fresh resolved promise so old continuations are GC-able.
 */
export class SerializedSender {
	private chain: Promise<void> = Promise.resolve();
	private pending = 0;

	serializedSend<T>(fn: () => T | Promise<T>): Promise<T> {
		this.pending++;
		const run = this.chain.then(fn);
		// Swallow rejections on the chain spine so one bad send doesn't break
		// subsequent sends; the caller still sees the real rejection via `run`.
		this.chain = run.then(
			() => { this.drain(); },
			() => { this.drain(); },
		);
		return run;
	}

	private drain(): void {
		this.pending--;
		if (this.pending <= 0) {
			// G7: reset to a fresh resolved promise. No new sends are queued,
			// so any future serializedSend chains off a clean head and the old
			// (possibly long) spine becomes eligible for garbage collection.
			this.pending = 0;
			this.chain = Promise.resolve();
		}
	}

	/** Number of sends still queued (not yet fully settled). */
	pendingCount(): number {
		return this.pending;
	}

	/** True when no sends are queued and the chain has been reset to idle. */
	isIdle(): boolean {
		return this.pending === 0;
	}
}
