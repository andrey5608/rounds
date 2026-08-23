/**
 * What actually went wrong behind `TypeError: fetch failed`.
 *
 * Node's `fetch` reports every connection problem with that one sentence and puts the real reason
 * in `cause`, sometimes a chain of them. Printing the outer error — which is what this extension
 * did — turns a DNS typo, a refused port and an untrusted certificate into the same useless line.
 */

interface CauseChainEntry {
  message: string;
  code?: string;
}

export interface NetworkDiagnosis {
  /** One sentence saying what to do about it, or nothing when the cause is unrecognised. */
  advice?: string;
  /** The chain as text, for the log and the run record. */
  detail: string;
}

/** Environment values that say a proxy is expected. Injected so a test does not read the machine. */
export interface ProxyEnvironment {
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
  http_proxy?: string;
  https_proxy?: string;
  NO_PROXY?: string;
  no_proxy?: string;
}

const ADVICE: { match: RegExp; advice: string }[] = [
  {
    match: /ENOTFOUND|EAI_AGAIN/,
    advice:
      'The host name could not be resolved. Check the base URL for a typo, and whether this machine needs a VPN to see that host.',
  },
  {
    match: /ECONNREFUSED/,
    advice: 'Nothing accepted the connection there. Check the port in the base URL.',
  },
  {
    match: /EHOSTUNREACH|ENETUNREACH/,
    advice: 'There is no route to that host from this machine, which usually means a VPN is off.',
  },
  {
    match: /ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/,
    advice:
      'The connection timed out. A firewall or a proxy that silently drops the request looks exactly like this.',
  },
  {
    match: /CERT_HAS_EXPIRED/,
    advice: "The host's certificate has expired.",
  },
  {
    match:
      /SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|unable to verify/i,
    advice:
      'The certificate was not signed by an authority this machine trusts, which is what a company proxy or a self-hosted installation with its own certificate looks like. Point NODE_EXTRA_CA_CERTS at the certificate and restart the editor.',
  },
  {
    match: /ERR_TLS_CERT_ALTNAME_INVALID/,
    advice: "The certificate is for a different host name than the base URL asks for.",
  },
];

/**
 * Reads the `cause` chain and says what it means.
 *
 * The chain is followed rather than only its first link: undici nests the socket error inside the
 * fetch error, and sometimes another inside that.
 */
export function diagnoseNetworkError(
  error: unknown,
  environment: ProxyEnvironment = {},
): NetworkDiagnosis {
  const chain = causeChain(error);
  const detail = chain
    .map((entry) => (entry.code ? `${entry.message} (${entry.code})` : entry.message))
    .join(' <- ');
  const haystack = chain.map((entry) => `${entry.code ?? ''} ${entry.message}`).join(' ');

  const matched = ADVICE.find((candidate) => candidate.match.test(haystack));
  const proxy = proxyNote(environment, haystack);

  const advice = [matched?.advice, proxy].filter(Boolean).join(' ');
  return advice ? { advice, detail } : { detail };
}

/**
 * The proxy sentence, when a proxy is in play and the failure looks like the proxy's.
 *
 * Requests do go through it now, which changes what is worth saying: the address that could not be
 * reached may be the proxy's rather than the host's, and somebody reading "the host could not be
 * reached" would otherwise check the wrong machine.
 */
function proxyNote(environment: ProxyEnvironment, haystack: string): string | undefined {
  const configured =
    environment.HTTPS_PROXY ?? environment.https_proxy ?? environment.HTTP_PROXY ?? environment.http_proxy;
  if (!configured) {
    return undefined;
  }
  if (!/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|UND_ERR|EHOSTUNREACH|ENETUNREACH/.test(haystack)) {
    return undefined;
  }
  return `Requests go through the proxy this machine is configured with (${configured}), so this may be the proxy refusing or timing out rather than the host itself. NO_PROXY exempts a host from it.`;
}

/**
 * Says what a thrown non-Error was.
 *
 * `String` on a plain object gives "[object Object]", which is worse than saying nothing at all,
 * so anything that is not a string is described as JSON.
 */
function describeUnknown(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value) ?? 'a value that cannot be described';
  } catch {
    return 'a value that cannot be described';
  }
}

function causeChain(error: unknown): CauseChainEntry[] {
  const chain: CauseChainEntry[] = [];
  let current: unknown = error;

  // A chain longer than this is a loop or a library being strange; either way the first few links
  // are the ones that say anything.
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      const code = (current as Error & { code?: unknown }).code;
      chain.push({
        message: `${current.name}: ${current.message}`,
        code: typeof code === 'string' ? code : undefined,
      });
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }
    // Not an Error: a string, a number, or an object some library threw. `String` on a plain
    // object says "[object Object]", which is worse than nothing, so JSON says what it can.
    chain.push({ message: describeUnknown(current) });
    break;
  }

  return chain.length > 0 ? chain : [{ message: describeUnknown(error) }];
}
