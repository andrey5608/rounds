import * as assert from 'node:assert/strict';

import { diagnoseNetworkError } from '../../connectors/networkCause.js';

/** A failure shaped the way Node's fetch reports one: a bland outer error over the real reason. */
function fetchFailure(cause: { message: string; code?: string }): Error {
  const inner = new Error(cause.message);
  if (cause.code) {
    (inner as Error & { code?: string }).code = cause.code;
  }
  return new TypeError('fetch failed', { cause: inner });
}

describe('what "fetch failed" was hiding', () => {
  it('keeps the whole chain, not just the sentence on top', () => {
    // The reported case: a run failed with "TypeError: fetch failed" and nothing else, which is
    // the same message for a typo in a URL, a closed port and an untrusted certificate.
    const diagnosis = diagnoseNetworkError(
      fetchFailure({ message: 'getaddrinfo ENOTFOUND tracker.invalid', code: 'ENOTFOUND' }),
    );

    assert.match(diagnosis.detail, /TypeError: fetch failed/);
    assert.match(diagnosis.detail, /getaddrinfo ENOTFOUND tracker\.invalid \(ENOTFOUND\)/);
  });

  it('says a name did not resolve', () => {
    const diagnosis = diagnoseNetworkError(
      fetchFailure({ message: 'getaddrinfo ENOTFOUND tracker.invalid', code: 'ENOTFOUND' }),
    );

    assert.match(diagnosis.advice ?? '', /host name could not be resolved/);
    assert.match(diagnosis.advice ?? '', /VPN/);
  });

  it('says nothing was listening', () => {
    const diagnosis = diagnoseNetworkError(
      fetchFailure({ message: 'connect ECONNREFUSED 127.0.0.1:7990', code: 'ECONNREFUSED' }),
    );
    assert.match(diagnosis.advice ?? '', /Nothing accepted the connection/);
  });

  it('recognises a certificate this machine does not trust', () => {
    // The common one on a self-hosted installation behind a company proxy, and the one where
    // "could not be reached" is the least useful thing to say.
    const diagnosis = diagnoseNetworkError(
      fetchFailure({
        message: 'unable to verify the first certificate',
        code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      }),
    );

    assert.match(diagnosis.advice ?? '', /not signed by an authority this machine trusts/);
    assert.match(diagnosis.advice ?? '', /NODE_EXTRA_CA_CERTS/);
  });

  it('recognises a timeout and names what looks like one', () => {
    const diagnosis = diagnoseNetworkError(
      fetchFailure({ message: 'Connect Timeout Error', code: 'UND_ERR_CONNECT_TIMEOUT' }),
    );
    assert.match(diagnosis.advice ?? '', /timed out/);
  });

  it('says the proxy is not used, when there is one and the failure looks like it', () => {
    // Requests use Node's own client, which reads neither the editor's proxy setting nor these
    // variables. On such a machine the request simply never arrives, while the URL opens fine in
    // a browser — which is the most confusing way for this to fail.
    const diagnosis = diagnoseNetworkError(
      fetchFailure({ message: 'getaddrinfo ENOTFOUND tracker.internal', code: 'ENOTFOUND' }),
      { HTTPS_PROXY: 'http://proxy.example:3128' },
    );

    assert.match(diagnosis.advice ?? '', /do not go through it/);
    assert.match(diagnosis.advice ?? '', /http:\/\/proxy\.example:3128/);
  });

  it('leaves the proxy out of a failure that has nothing to do with one', () => {
    const diagnosis = diagnoseNetworkError(
      fetchFailure({ message: 'certificate has expired', code: 'CERT_HAS_EXPIRED' }),
      { HTTPS_PROXY: 'http://proxy.example:3128' },
    );

    assert.match(diagnosis.advice ?? '', /certificate has expired/i);
    assert.ok(!/proxy/i.test(diagnosis.advice ?? ''));
  });

  it('offers no advice rather than a guess when the cause is unfamiliar', () => {
    const diagnosis = diagnoseNetworkError(new Error('something else entirely'));

    assert.equal(diagnosis.advice, undefined);
    assert.match(diagnosis.detail, /something else entirely/);
  });

  it('survives an error that is not an Error', () => {
    assert.match(diagnoseNetworkError('a string').detail, /a string/);
    assert.match(diagnoseNetworkError(undefined).detail, /undefined/);
  });

  it('follows a chain more than one link deep', () => {
    const socket = new Error('read ECONNRESET');
    (socket as Error & { code?: string }).code = 'ECONNRESET';
    const middle = new Error('client error', { cause: socket });
    const outer = new TypeError('fetch failed', { cause: middle });

    assert.match(diagnoseNetworkError(outer).detail, /fetch failed.*client error.*ECONNRESET/s);
  });
});
