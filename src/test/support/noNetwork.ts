/**
 * Makes a real network call impossible in unit tests.
 *
 * Every connector takes its `fetch` as an option, so a test that reaches the global one has
 * a wiring mistake — and a test suite that quietly talks to a live host is both slow and a
 * liar. Replacing the global with a throwing stub turns that mistake into a failure.
 */
const forbidden = (): never => {
  throw new Error(
    'A unit test tried to perform a real network request. Inject a fetch implementation instead.',
  );
};

globalThis.fetch = forbidden as unknown as typeof globalThis.fetch;
