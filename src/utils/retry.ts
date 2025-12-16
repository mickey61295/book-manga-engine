export interface RetryOptions {
	retries: number;
	baseDelayMs: number;
}

export async function retryWithBackoff<T>(
	fn: () => Promise<T>,
	opts: RetryOptions
): Promise<T> {
	let attempt = 0;
	let lastErr: unknown;

	while (attempt <= opts.retries) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (attempt >= opts.retries) break;
			const delay = opts.baseDelayMs * Math.pow(2, attempt);
			await sleep(delay);
			attempt += 1;
		}
	}

	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
