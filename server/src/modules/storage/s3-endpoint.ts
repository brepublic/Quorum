import {isIP} from 'node:net';
import {AppError} from '../../http/errors.js';

export interface S3EndpointOptions {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
  allowPrivateNetwork: boolean;
}

function privateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  const [a, b] = octets as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && [0, 2, 168].includes(b))
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0);
}

function privateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] as string;
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')
    || normalized.startsWith('ff') || normalized.startsWith('::ffff:') || normalized.startsWith('2002:')
    || /^fe[89ab]/.test(normalized) || normalized.startsWith('2001:db8:') || normalized.startsWith('2001:0:')) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  return Boolean(mapped && privateIpv4(mapped[1] as string));
}

export function assertS3NetworkAddress(address: string, allowPrivateNetwork: boolean): void {
  const family = isIP(address);
  if (!family || (!allowPrivateNetwork && (family === 4 ? privateIpv4(address) : privateIpv6(address)))) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'S3 endpoint resolves to a disallowed network address.'});
  }
}

export function validateS3Endpoint(input: S3EndpointOptions): S3EndpointOptions {
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'S3 endpoint is invalid.'});
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !endpoint.hostname || endpoint.pathname.includes('..')) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'S3 endpoint must be an HTTPS URL without credentials, query, or fragment.'});
  }
  const hostname = endpoint.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'S3 endpoint hostname is not allowed.'});
  }
  if (isIP(hostname)) assertS3NetworkAddress(hostname, input.allowPrivateNetwork);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)
    || input.bucket.includes('..') || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.bucket.replaceAll('.', '-'))) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'S3 bucket is invalid.'});
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.region)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'S3 region is invalid.'});
  }
  if (input.prefix && (!/^[a-z0-9](?:[a-z0-9/_-]*[a-z0-9_-])?$/.test(input.prefix)
    || input.prefix.startsWith('/') || input.prefix.endsWith('/') || input.prefix.split('/').includes('..'))) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'S3 key prefix is invalid.'});
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '');
  return {...input, endpoint: endpoint.toString().replace(/\/$/, '')};
}

export function s3ObjectKey(prefix: string, blobId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(blobId)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Blob ID is invalid.'});
  }
  const compact = blobId.replaceAll('-', '').toLowerCase();
  return [prefix, 'blobs', compact.slice(0, 2), compact].filter(Boolean).join('/');
}
