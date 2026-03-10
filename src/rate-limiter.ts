function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export class RateLimiter {
	private readonly minIntervalMs: number;
	private lastCallAt = 0;

	constructor(requestsPerSecond = 4) {
		this.minIntervalMs = 1000 / requestsPerSecond;
	}

	async throttle(): Promise<void> {
		const now = Date.now();
		const waitMs = this.lastCallAt + this.minIntervalMs - now;
		if (waitMs > 0) {
			await sleep(waitMs);
		}
		this.lastCallAt = Date.now();
	}
}

export const MAX_RETRIES = 3;
export const BASE_RETRY_DELAY_MS = 2000;

/**
 * Wraps a fetch function with exponential-backoff retry on HTTP 429 (rate-limited).
 * Returns the response once it is not 429, or rethrows after exhausting retries.
 */
export async function withRetryOn429<T extends { status: number }>(
	fn: () => Promise<T>,
): Promise<T> {
	let delay = BASE_RETRY_DELAY_MS;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		const response = await fn();
		if (response.status !== 429) {
			return response;
		}
		if (attempt === MAX_RETRIES) {
			return response; // Return the 429 response; caller decides how to handle
		}
		await sleep(delay);
		delay *= 2;
	}
	// Unreachable, but satisfies TypeScript
	return fn();
}
