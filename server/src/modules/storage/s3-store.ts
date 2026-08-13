import {createHash, createHmac} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {request as httpsRequest, type RequestOptions} from 'node:https';
import {once} from 'node:events';
import type {IncomingHttpHeaders} from 'node:http';
import type {DurableStagingStore} from './staging.js';
import type {S3Credentials} from './credential-crypto.js';
import {assertS3NetworkAddress, s3ObjectKey, validateS3Endpoint, type S3EndpointOptions} from './s3-endpoint.js';
import {ProviderStorageError} from './server-volume.js';

export interface S3ProviderConfig extends S3EndpointOptions {
  credentials: S3Credentials;
}

export interface S3Request {
  method: 'PUT' | 'GET' | 'DELETE' | 'HEAD';
  key: string;
  contentLength?: number;
  sha256?: string;
  body?: AsyncIterable<Uint8Array>;
}

export interface S3Response {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: AsyncIterable<Uint8Array>;
}

export interface S3Transport {
  request(input: S3Request): Promise<S3Response>;
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodedPath(value: string): string {
  return `/${value.split('/').filter(Boolean).map(awsEncode).join('/')}`;
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

export function signS3Headers(input: {
  method: string; url: URL; region: string; credentials: S3Credentials; payloadHash: string;
  date: Date; extra: Record<string, string>;
}): Record<string, string> {
  const dateTime = input.date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = dateTime.slice(0, 8);
  const headers: Record<string, string> = {
    host: input.url.host,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': dateTime,
    ...input.extra
  };
  const names = Object.keys(headers).map(value => value.toLowerCase()).sort();
  const canonicalHeaders = names.map(name => `${name}:${headers[name]?.trim().replace(/\s+/g, ' ')}\n`).join('');
  const canonicalRequest = [input.method, input.url.pathname, '', canonicalHeaders, names.join(';'), input.payloadHash].join('\n');
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${dateTime}\n${scope}\n${createHash('sha256').update(canonicalRequest).digest('hex')}`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, date), input.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {...headers, authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`};
}

async function errorSummary(response: S3Response): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    if (size >= 8192) break;
    const buffer = Buffer.from(chunk).subarray(0, 8192 - size);
    size += buffer.length;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\s+/g, ' ').slice(0, 240);
}

export class NodeS3Transport implements S3Transport {
  private readonly config: S3ProviderConfig;

  constructor(config: S3ProviderConfig, private readonly now: () => Date = () => new Date()) {
    this.config = {...validateS3Endpoint(config), credentials: config.credentials};
  }

  async request(input: S3Request): Promise<S3Response> {
    const base = new URL(this.config.endpoint);
    const objectPath = encodedPath(input.key);
    if (this.config.forcePathStyle) {
      base.pathname = `${base.pathname.replace(/\/$/, '')}/${awsEncode(this.config.bucket)}${objectPath}`;
    } else {
      base.hostname = `${this.config.bucket}.${base.hostname}`;
      base.pathname = `${base.pathname.replace(/\/$/, '')}${objectPath}`;
    }
    const resolved = await lookup(base.hostname, {all: true, verbatim: true});
    if (!resolved.length) throw new Error('S3 endpoint did not resolve.');
    for (const address of resolved) assertS3NetworkAddress(address.address, this.config.allowPrivateNetwork);
    const selected = resolved[0] as {address: string; family: number};
    const payloadHash = input.sha256 ?? createHash('sha256').update('').digest('hex');
    const extra: Record<string, string> = {};
    if (input.contentLength !== undefined) extra['content-length'] = String(input.contentLength);
    if (input.sha256) extra['x-amz-meta-sha256'] = input.sha256;
    const headers = signS3Headers({method: input.method, url: base, region: this.config.region,
      credentials: this.config.credentials, payloadHash, date: this.now(), extra});
    const options: RequestOptions = {
      protocol: base.protocol, hostname: base.hostname, port: base.port || undefined,
      path: base.pathname, method: input.method, headers,
      lookup: ((_hostname: string, _options: unknown, callback: (error: Error | null, address: string,
        family: number) => void) => callback(null, selected.address, selected.family)) as RequestOptions['lookup']
    };
    return new Promise<S3Response>((resolve, reject) => {
      const request = httpsRequest(options, response => resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: response
      }));
      request.setTimeout(30_000, () => request.destroy(new Error('S3 request timed out.')));
      request.once('error', reject);
      void (async () => {
        try {
          if (input.body) {
            for await (const chunk of input.body) {
              if (!request.write(chunk)) await once(request, 'drain');
            }
          }
          request.end();
        } catch (error) {
          request.destroy(error as Error);
        }
      })();
    });
  }
}

export class S3CompatibleStore {
  constructor(readonly config: S3ProviderConfig, private readonly transport: S3Transport,
    readonly maxFileBytes: number) {}

  keyForBlob(blobId: string): string {
    return s3ObjectKey(this.config.prefix, blobId);
  }

  async commitFromStaging(input: {blobId: string; staging: DurableStagingStore; stagingKey: string;
    expectedSizeBytes: number; expectedSha256: string}): Promise<{storageKey: string; sizeBytes: number; sha256: string}> {
    if (!Number.isSafeInteger(input.expectedSizeBytes) || input.expectedSizeBytes < 0
      || input.expectedSizeBytes > this.maxFileBytes || !/^[a-f0-9]{64}$/.test(input.expectedSha256)) {
      throw new ProviderStorageError('S3_INPUT_INVALID', 'VALIDATION_FAILED', 'S3 provider input is invalid.');
    }
    const storageKey = this.keyForBlob(input.blobId);
    try {
      await input.staging.verify(input.stagingKey, input.expectedSizeBytes, input.expectedSha256);
      const response = await this.transport.request({method: 'PUT', key: storageKey,
        contentLength: input.expectedSizeBytes, sha256: input.expectedSha256,
        body: input.staging.read(input.stagingKey, input.expectedSizeBytes, input.expectedSha256)});
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`S3 PUT failed with ${response.statusCode}: ${await errorSummary(response)}`);
      }
      const verified = await this.verify(storageKey, input.expectedSizeBytes, input.expectedSha256);
      return {storageKey, ...verified};
    } catch (error) {
      if (error instanceof ProviderStorageError) throw error;
      throw new ProviderStorageError('S3_WRITE_FAILED', 'SERVICE_NOT_READY', 'S3 storage is unavailable.', error);
    }
  }

  async verify(storageKey: string, expectedSizeBytes: number, expectedSha256: string): Promise<{
    sizeBytes: number; sha256: string;
  }> {
    try {
      const response = await this.transport.request({method: 'GET', key: storageKey});
      if (response.statusCode !== 200) throw new Error(`S3 GET failed with ${response.statusCode}.`);
      const hash = createHash('sha256');
      let sizeBytes = 0;
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        sizeBytes += buffer.length;
        if (sizeBytes > this.maxFileBytes || sizeBytes > expectedSizeBytes) {
          throw new ProviderStorageError('S3_INTEGRITY_MISMATCH', 'SERVICE_NOT_READY',
            'S3 content failed verification.');
        }
        hash.update(buffer);
      }
      const sha256 = hash.digest('hex');
      if (sizeBytes !== expectedSizeBytes || sha256 !== expectedSha256) {
        throw new ProviderStorageError('S3_INTEGRITY_MISMATCH', 'SERVICE_NOT_READY',
          'S3 content failed verification.');
      }
      return {sizeBytes, sha256};
    } catch (error) {
      if (error instanceof ProviderStorageError) throw error;
      throw new ProviderStorageError('S3_READ_FAILED', 'SERVICE_NOT_READY', 'S3 content is unavailable.', error);
    }
  }

  async *read(storageKey: string, expectedSizeBytes: number, expectedSha256: string): AsyncGenerator<Buffer> {
    await this.verify(storageKey, expectedSizeBytes, expectedSha256);
    const response = await this.transport.request({method: 'GET', key: storageKey});
    if (response.statusCode !== 200) {
      throw new ProviderStorageError('S3_READ_FAILED', 'SERVICE_NOT_READY', 'S3 content is unavailable.');
    }
    for await (const chunk of response.body) yield Buffer.from(chunk);
  }

  async delete(storageKey: string): Promise<void> {
    const response = await this.transport.request({method: 'DELETE', key: storageKey});
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new ProviderStorageError('S3_DELETE_FAILED', 'SERVICE_NOT_READY', 'S3 content could not be deleted.');
    }
  }
}
