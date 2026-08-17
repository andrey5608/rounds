import * as assert from 'node:assert/strict';

import { mapModelError } from '../../model/errors.js';

/** Stands in for the editor's LanguageModelError, which only exists in the host. */
class FakeLanguageModelError extends Error {
  constructor(
    override readonly name: string,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

describe('language model error mapping', () => {
  it('maps a missing consent to an actionable setup hint', () => {
    const mapped = mapModelError(
      new FakeLanguageModelError('LanguageModelError', 'Permission denied', 'NoPermissions'),
    );
    assert.equal(mapped.code, 'model.noConsent');
    assert.equal(mapped.fixCommand, 'rounds.checkSetup');
    assert.match(mapped.message, /Check Setup/);
  });

  it('maps a quota refusal to the rate limit advice', () => {
    const mapped = mapModelError(new Error('Request failed: 429 Too Many Requests'));
    assert.equal(mapped.code, 'model.quotaExceeded');
    assert.match(mapped.message, /usage limits/);
    assert.equal(mapped.fixCommand, undefined);
  });

  it('maps an unavailable model to editing the agent', () => {
    const mapped = mapModelError(
      new FakeLanguageModelError('LanguageModelError', 'The model was not found', 'NotFound'),
    );
    assert.equal(mapped.code, 'model.unavailable');
    assert.equal(mapped.fixCommand, 'rounds.editAgent');
  });

  it('passes a blocked request through with the provider wording', () => {
    const mapped = mapModelError(new Error('Blocked by content policy: unsafe input'));
    assert.equal(mapped.code, 'model.blocked');
    assert.match(mapped.message, /unsafe input/);
  });

  it('falls back to an unknown failure that points at the output channel', () => {
    const mapped = mapModelError(new Error('socket hang up'));
    assert.equal(mapped.code, 'model.unknown');
    assert.equal(mapped.fixCommand, 'rounds.showOutput');
    assert.match(mapped.message, /socket hang up/);
  });

  it('copes with values that are not errors at all', () => {
    const mapped = mapModelError('something went wrong');
    assert.equal(mapped.code, 'model.unknown');
    assert.equal(mapped.detail, 'something went wrong');
  });

  it('always keeps the original message for the log', () => {
    const mapped = mapModelError(new Error('quota exceeded for today'));
    assert.equal(mapped.detail, 'quota exceeded for today');
  });
});
