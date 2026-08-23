import type { ProxyEnvironment } from './networkCause.js';

/**
 * Which proxy, if any, a request to this host must go through.
 *
 * `fetch` reads none of this by itself: Node's client ignores the proxy the editor is configured
 * with and ignores these variables too, so on a machine that needs a proxy every request simply
 * failed to arrive while the same URL opened in a browser. Reading them here is what makes those
 * machines work at all.
 *
 * The rules are the ones every command line tool follows, so a machine already set up for `curl`
 * and `git` is set up for this: `HTTPS_PROXY` for https, `HTTP_PROXY` for http, either spelling of
 * the name, and `NO_PROXY` overriding both.
 */
export function proxyForUrl(url: string, environment: ProxyEnvironment = {}): string | undefined {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }

  if (isExempt(target.hostname, environment.NO_PROXY ?? environment.no_proxy)) {
    return undefined;
  }

  const proxy =
    target.protocol === 'http:'
      ? (environment.HTTP_PROXY ?? environment.http_proxy)
      : (environment.HTTPS_PROXY ?? environment.https_proxy);

  const trimmed = proxy?.trim();
  if (!trimmed) {
    return undefined;
  }
  // A proxy written without a scheme is what people put in these variables; `ProxyAgent` needs one.
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/**
 * Whether `NO_PROXY` exempts this host.
 *
 * `*` exempts everything, a leading dot or a bare name matches the host and its subdomains, and a
 * port is ignored — the same reading `curl` gives it, because a machine configured once should not
 * need configuring again per tool.
 */
export function isExempt(hostname: string, noProxy: string | undefined): boolean {
  const rules = (noProxy ?? '')
    .split(',')
    .map((rule) => rule.trim().toLowerCase())
    .filter((rule) => rule.length > 0);
  if (rules.length === 0) {
    return false;
  }
  if (rules.includes('*')) {
    return true;
  }

  const host = hostname.toLowerCase();
  return rules.some((rule) => {
    const name = rule.replace(/^\*?\./, '').replace(/:\d+$/, '');
    return host === name || host.endsWith(`.${name}`);
  });
}
