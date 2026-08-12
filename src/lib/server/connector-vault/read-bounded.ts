// One bounded-read helper, shared by every outbound response this repository reads.
//
// It exists as its own module because it was written once for `submitHandoff` (PR #398, after a review measured
// `response.text()` buffering 1.7 GB), and then the Phase 8R exchange reintroduced the same defect sixty lines away by
// calling `response.text()` before applying its ceiling. A ceiling checked after the body is buffered is not a ceiling.
//
// `Content-Length` is not trusted: it can be absent, wrong, or describe the COMPRESSED size while the decoded body is
// far larger. The stream is therefore capped as it arrives, and reading stops one byte over the limit rather than
// draining a hostile body.

/**
 * Read at most `limit` bytes of a response body, stopping as soon as the limit is exceeded.
 *
 * Returns the bytes read as UTF-8. The caller decides what an over-limit read means — this function does not throw, so
 * a caller can distinguish "too big" from "malformed" by checking the returned length against its own ceiling.
 */
export async function readBounded(response: Response, limit: number, signal?: AbortSignal): Promise<string> {
  const body = response.body;
  // No stream (an empty body, or a fetch implementation that does not expose one). There is nothing to bound.
  if (!body) return await response.text();

  const reader = body.getReader();
  // A caller's deadline must reach the READ, not just the fetch: a server that sends headers instantly and then
  // trickles the body is bounded by size but not by time unless the signal interrupts the pending `read()`.
  const abort = signal ? new Promise<never>((_r, rej) => {
    if (signal.aborted) return rej(new Error("aborted"));
    signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
  }) : null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = abort ? await Promise.race([reader.read(), abort]) : await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      // Strictly OVER the limit, not at it. `>=` looks equivalent and is not: when a chunk boundary lands exactly on
      // the limit it stops with exactly `limit` bytes, the caller's `> limit` size check cannot fire, and an over-limit
      // body has been silently truncated to a well-formed prefix. One byte past is what makes "too big" observable.
      if (total > limit) break; // do not keep reading a hostile body
    }
  } finally {
    // Releases the connection whether we finished or bailed out early.
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)), Math.min(total, limit + 1)).toString("utf8");
}
