/** Cache code only, never props or account data. A failed load can be retried;
 * a slow import may finish in the background without reopening an old view. */
export function createFeatureLoader<T>(load: () => Promise<T>, timeoutMs = 8000): () => Promise<T> {
    let module: Promise<T> | null = null;
    return async () => {
        if (!module) {
            const pending = Promise.resolve().then(load);
            module = pending;
            void pending.catch(() => { if (module === pending) module = null; });
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([module, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Feature load unavailable.')), timeoutMs); })]);
        } finally { clearTimeout(timer); }
    };
}
