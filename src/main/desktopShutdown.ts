/** Desktop quit is an asynchronous persistence boundary, not an agent workflow. */
export function registerDesktopShutdown(app: {
  on(event: "before-quit", listener: (event: { preventDefault(): void }) => void): unknown;
}, options: {
  settle(): Promise<void>;
  exit(): void;
  onFailure(error: unknown): Promise<void> | void;
}): void {
  let pending: Promise<void> | undefined;
  app.on("before-quit", event => {
    event.preventDefault();
    if (pending) return;
    pending = Promise.resolve().then(options.settle).then(options.exit).catch(async error => {
      try { await options.onFailure(error); }
      catch (reportError) {
        console.error("[shutdown] Exit remains cancelled; failure reporting also failed",
          new AggregateError([error, reportError], "Desktop shutdown and failure reporting failed."));
      }
      finally { pending = undefined; }
    });
  });
}
