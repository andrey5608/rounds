/**
 * A minimal event emitter.
 *
 * The state layer stays free of editor API imports so it can be unit tested outside the
 * extension host, which rules out `vscode.EventEmitter`. This covers the little that is
 * needed: subscribe, unsubscribe, fire.
 */

export interface Disposable {
  dispose(): void;
}

export type Listener<T> = (value: T) => void;

export class Emitter<T> {
  private listeners = new Set<Listener<T>>();

  /** Subscribes and returns the handle that removes the subscription again. */
  event(listener: Listener<T>): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** Notifies every listener. A throwing listener never blocks the others. */
  fire(value: T, onError?: (error: unknown) => void): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (error) {
        onError?.(error);
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }

  dispose(): void {
    this.listeners.clear();
  }
}
