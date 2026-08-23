import * as assert from 'node:assert/strict';

import { isExempt, proxyForUrl } from '../../connectors/proxy.js';

describe('the proxy a request goes through', () => {
  it('uses HTTPS_PROXY for an https host', () => {
    assert.equal(
      proxyForUrl('https://tracker.invalid/rest/api/2/search', {
        HTTPS_PROXY: 'http://proxy.example:3128',
      }),
      'http://proxy.example:3128',
    );
  });

  it('uses HTTP_PROXY for an http host, and not the other way round', () => {
    const environment = { HTTP_PROXY: 'http://plain.example:3128', HTTPS_PROXY: 'http://tls.example:3128' };

    assert.equal(proxyForUrl('http://tracker.invalid/x', environment), 'http://plain.example:3128');
    assert.equal(proxyForUrl('https://tracker.invalid/x', environment), 'http://tls.example:3128');
  });

  it('reads either spelling, because both are what machines actually have', () => {
    assert.equal(
      proxyForUrl('https://tracker.invalid/x', { https_proxy: 'http://proxy.example:3128' }),
      'http://proxy.example:3128',
    );
  });

  it('adds the scheme people leave out', () => {
    // `HTTPS_PROXY=proxy.example:3128` is what half the machines in the world have in them.
    assert.equal(
      proxyForUrl('https://tracker.invalid/x', { HTTPS_PROXY: 'proxy.example:3128' }),
      'http://proxy.example:3128',
    );
  });

  it('goes direct when nothing is configured', () => {
    assert.equal(proxyForUrl('https://tracker.invalid/x', {}), undefined);
    assert.equal(proxyForUrl('https://tracker.invalid/x', { HTTPS_PROXY: '   ' }), undefined);
  });

  it('honours NO_PROXY, which is how an internal host is reached at all', () => {
    const environment = { HTTPS_PROXY: 'http://proxy.example:3128', NO_PROXY: 'tracker.invalid' };
    assert.equal(proxyForUrl('https://tracker.invalid/x', environment), undefined);
    assert.equal(
      proxyForUrl('https://elsewhere.invalid/x', environment),
      'http://proxy.example:3128',
    );
  });

  it('reads NO_PROXY the way every other tool reads it', () => {
    assert.equal(isExempt('jira.company.internal', 'company.internal'), true, 'a parent domain');
    assert.equal(isExempt('jira.company.internal', '.company.internal'), true, 'a leading dot');
    assert.equal(isExempt('jira.company.internal', '*.company.internal'), true, 'a star');
    assert.equal(isExempt('jira.company.internal', 'jira.company.internal:443'), true, 'a port');
    assert.equal(isExempt('JIRA.Company.Internal', 'company.internal'), true, 'either case');
    assert.equal(isExempt('anything.invalid', '*'), true, 'everything');

    assert.equal(isExempt('jira.company.invalid', 'company.internal'), false);
    assert.equal(isExempt('notcompany.internal', 'company.internal'), false, 'not a suffix match');
    assert.equal(isExempt('jira.company.internal', ''), false);
  });

  it('says nothing about a URL that is not one', () => {
    assert.equal(proxyForUrl('not a url', { HTTPS_PROXY: 'http://proxy.example:3128' }), undefined);
  });
});
