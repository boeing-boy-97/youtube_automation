import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF protection for the "import from direct URL" source path.
 *
 * Rules enforced before any outbound request:
 *  - scheme must be http(s) (https in production)
 *  - hostname is resolved and EVERY resolved address is checked against
 *    private/loopback/link-local/CGNAT/metadata ranges
 *  - literal IP hosts are checked directly
 *  - redirects are not followed automatically (see fetchWithLimits)
 *  - downloads are size-capped streaming, with an overall deadline
 */

export interface UrlPolicyResult {
  url: URL;
  resolvedIps: string[];
}

const BLOCKED_V4 = [
  [/^0\./, 'this-network'],
  [/^10\./, 'private'],
  [/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./, 'carrier-grade NAT'],
  [/^127\./, 'loopback'],
  [/^169\.254\./, 'link-local (includes cloud metadata 169.254.169.254)'],
  [/^172\.(1[6-9]|2\d|3[0-1])\./, 'private'],
  [/^192\.0\.0\./, 'IETF protocol assignments'],
  [/^192\.168\./, 'private'],
  [/^198\.(1[89])\./, 'benchmarking'],
  [/^2[2-5]\d\./, 'multicast/reserved'],
] as const;

function isBlockedIp(ip: string): string | null {
  const version = isIP(ip);
  if (version === 4) {
    for (const [pattern, label] of BLOCKED_V4) if (pattern.test(ip)) return label;
    return null;
  }
  if (version === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1') return 'loopback';
    if (normalized === '::') return 'unspecified';
    if (normalized.startsWith('fe80')) return 'link-local';
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return 'unique local';
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]!);
    return null;
  }
  return null;
}

export async function assertSafeOutboundUrl(rawUrl: string, options: { requireHttps: boolean }): Promise<UrlPolicyResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Malformed URL' });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new BadRequestException({ code: 'SSRF_BLOCKED', message: `Scheme ${url.protocol} is not allowed` });
  }
  if (options.requireHttps && url.protocol !== 'https:') {
    throw new BadRequestException({ code: 'SSRF_BLOCKED', message: 'Only HTTPS media URLs are accepted in this configuration' });
  }
  if (url.username || url.password) {
    throw new BadRequestException({ code: 'SSRF_BLOCKED', message: 'Credentials in URLs are not allowed' });
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.internal') || hostname.endsWith('.local')) {
    throw new BadRequestException({ code: 'SSRF_BLOCKED', message: `Hostname ${hostname} is not allowed` });
  }

  const literalBlock = isBlockedIp(hostname);
  if (literalBlock) {
    throw new BadRequestException({ code: 'SSRF_BLOCKED', message: `Address ${hostname} is blocked (${literalBlock})` });
  }

  if (!isIP(hostname)) {
    const addresses = await lookup(hostname, { all: true, verbatim: true }).catch(() => {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: `Cannot resolve host ${hostname}` });
    });
    for (const address of addresses) {
      const blocked = isBlockedIp(address.address);
      if (blocked) {
        throw new BadRequestException({
          code: 'SSRF_BLOCKED',
          message: `${hostname} resolves to ${address.address}, which is blocked (${blocked})`,
        });
      }
    }
    return { url, resolvedIps: addresses.map((a) => a.address) };
  }
  return { url, resolvedIps: [hostname] };
}

/**
 * Streams a remote file to disk with a hard byte cap and deadline.
 * Redirects are followed manually so each hop is re-validated.
 */
export async function downloadUrlToFile(
  rawUrl: string,
  destinationPath: string,
  options: { maxBytes: number; timeoutMs: number; maxRedirects?: number; requireHttps: boolean },
): Promise<{ sizeBytes: number; contentType: string | null; finalUrl: string }> {
  const { createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');
  const { Readable } = await import('node:stream');

  let current = rawUrl;
  let response: Response | null = null;
  const maxRedirects = options.maxRedirects ?? 3;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertSafeOutboundUrl(current, { requireHttps: options.requireHttps });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const res = await fetch(current, { redirect: 'manual', signal: controller.signal }).finally(() => clearTimeout(timer));
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Redirect without Location header' });
      current = new URL(location, current).toString();
      continue;
    }
    response = res;
    break;
  }
  if (!response) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Too many redirects' });
  if (!response.ok || !response.body) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: `Source returned HTTP ${response.status}` });
  }

  const contentType = response.headers.get('content-type');
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (declaredLength > options.maxBytes) {
    throw new BadRequestException({
      code: 'MEDIA_VALIDATION_FAILED',
      message: `Remote file declares ${declaredLength} bytes, above the limit of ${options.maxBytes}`,
    });
  }

  let written = 0;
  const nodeStream = Readable.fromWeb(response.body as never);
  nodeStream.on('data', (chunk: Buffer) => {
    written += chunk.byteLength;
    if (written > options.maxBytes) {
      nodeStream.destroy(new Error(`Download exceeded the maximum of ${options.maxBytes} bytes`));
    }
  });

  try {
    await pipeline(nodeStream, createWriteStream(destinationPath));
  } catch (error) {
    throw new BadRequestException({ code: 'MEDIA_VALIDATION_FAILED', message: (error as Error).message });
  }
  return { sizeBytes: written, contentType, finalUrl: current };
}
