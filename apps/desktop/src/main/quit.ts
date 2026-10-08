/** Repeated quit requests must wait for the same runner bookkeeping, including update installation. */
export class QuitLifecycle {
  #started = false;
  #ready = false;

  get ready(): boolean { return this.#ready; }
  get started(): boolean { return this.#started; }

  async start(cleanup: () => Promise<void>, finish: () => void, failed: (error: unknown) => void): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    try {
      await cleanup();
    } catch (error) {
      failed(error);
    } finally {
      this.#ready = true;
      finish();
    }
  }
}
