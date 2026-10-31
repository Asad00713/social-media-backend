import { Writable } from 'stream';
import {
  BadRequestException,
  HttpStatus,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Response } from 'express';
import type { DbType } from '../../drizzle/db';
import { CategoryZipService } from './category-zip.service';
import type { StorageObjectService } from './storage-object.service';

const WS = '11111111-1111-4111-8111-111111111111';
const FOLDER = '22222222-2222-4222-8222-222222222222';
const OWN = 'https://res.cloudinary.com/demo/';

/** Each awaited `db.select()…` chain resolves to the next queued result. */
function fakeDb(results: unknown[][]): DbType {
  const queue = [...results];
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'orderBy']) {
    chain[m] = jest.fn(() => chain);
  }
  chain.then = (
    resolve: (v: unknown) => unknown,
    reject: (e: unknown) => unknown,
  ) => Promise.resolve(queue.shift() ?? []).then(resolve, reject);
  return { select: jest.fn(() => chain) } as unknown as DbType;
}

class CollectingResponse extends Writable {
  readonly chunks: Buffer[] = [];
  readonly headers: Record<string, string> = {};
  setHeader(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.chunks.push(chunk);
    cb();
  }
  get body(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

const storageObjects = {
  isOwnStorageUrl: jest.fn((url: string) => url.startsWith(OWN)),
} as unknown as StorageObjectService;

const folderRow = (type = 'media', name = 'Launch') => [
  { id: FOLDER, name, type },
];
const bytesRow = (bytes: string | null) => [{ bytes }];

let fetchMock: jest.SpyInstance;

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  fetchMock = jest
    .spyOn(global, 'fetch')
    .mockImplementation((input) =>
      Promise.resolve(
        new Response(Buffer.from(`bytes-of:${String(input as string)}`)),
      ),
    );
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function zipOf(rows: unknown[][]) {
  const svc = new CategoryZipService(fakeDb(rows), storageObjects);
  const res = new CollectingResponse();
  await svc.streamZip(WS, FOLDER, res as unknown as Response);
  return res;
}

describe('CategoryZipService', () => {
  it('streams a zip of the live items in the folder', async () => {
    const res = await zipOf([
      folderRow(),
      bytesRow('20'),
      [
        { name: 'Hero', mimeType: 'image/png', fileUrl: `${OWN}hero.png` },
        { name: 'Clip', mimeType: 'video/mp4', fileUrl: `${OWN}clip.mp4` },
      ],
    ]);
    expect(res.body.subarray(0, 4)).toEqual(
      Buffer.from('PK\x03\x04', 'latin1'),
    );
    expect(res.body.includes('Hero.png')).toBe(true);
    expect(res.body.includes('Clip.mp4')).toBe(true);
    expect(res.body.includes(`bytes-of:${OWN}hero.png`)).toBe(true);
    expect(res.body.includes('_skipped.txt')).toBe(false);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="Launch.zip"',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `${OWN}hero.png`,
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('never fetches a file outside our storage and lists it in _skipped.txt', async () => {
    const res = await zipOf([
      folderRow(),
      bytesRow('10'),
      [
        { name: 'Hero', mimeType: 'image/png', fileUrl: `${OWN}hero.png` },
        {
          name: 'Foreign',
          mimeType: 'image/png',
          fileUrl: 'https://evil.example/x.png',
        },
      ],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${OWN}hero.png`, expect.anything());
    const body = res.body.toString('latin1');
    const skippedAt = body.indexOf('_skipped.txt');
    expect(skippedAt).toBeGreaterThan(-1);
    expect(body.indexOf('Foreign.png', skippedAt)).toBeGreaterThan(skippedAt);
  });

  it('lists a file whose download fails in _skipped.txt and keeps going', async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        String(input as string).endsWith('broken.png')
          ? new Response('gone', { status: 404 })
          : new Response(Buffer.from('ok-bytes')),
      ),
    );
    const res = await zipOf([
      folderRow(),
      bytesRow('10'),
      [
        { name: 'Broken', mimeType: 'image/png', fileUrl: `${OWN}broken.png` },
        { name: 'Fine', mimeType: 'image/png', fileUrl: `${OWN}fine.png` },
      ],
    ]);
    const body = res.body.toString('latin1');
    expect(body).toContain('ok-bytes');
    expect(body).not.toContain('gone');
    const skippedAt = body.indexOf('_skipped.txt');
    expect(body.indexOf('Broken.png', skippedAt)).toBeGreaterThan(skippedAt);
  });

  it('has at most one download open at a time', async () => {
    let finishFirst: () => void = () => undefined;
    fetchMock.mockImplementation((input) => {
      if (String(input as string).endsWith('first.png')) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('first-bytes'));
            finishFirst = () => controller.close();
          },
        });
        return Promise.resolve(new Response(body));
      }
      return Promise.resolve(new Response(Buffer.from('second-bytes')));
    });
    const svc = new CategoryZipService(
      fakeDb([
        folderRow(),
        bytesRow('10'),
        [
          { name: 'First', mimeType: 'image/png', fileUrl: `${OWN}first.png` },
          {
            name: 'Second',
            mimeType: 'image/png',
            fileUrl: `${OWN}second.png`,
          },
        ],
      ]),
      storageObjects,
    );
    const res = new CollectingResponse();
    const done = svc.streamZip(WS, FOLDER, res as unknown as Response);
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finishFirst();
    await done;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.body.includes('second-bytes')).toBe(true);
  });

  it('413s a folder over 2 GB before writing anything', async () => {
    const svc = new CategoryZipService(
      fakeDb([folderRow(), bytesRow('2147483649')]),
      storageObjects,
    );
    const res = new CollectingResponse();
    const err: unknown = await svc
      .streamZip(WS, FOLDER, res as unknown as Response)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(PayloadTooLargeException);
    const http = err as PayloadTooLargeException;
    expect(http.getStatus()).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(http.getResponse()).toEqual({
      code: 'ZIP_TOO_LARGE',
      message: 'This folder is over 2 GB. Download fewer files at a time.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers).toEqual({});
    expect(res.chunks).toHaveLength(0);
  });

  it('allows exactly 2 GB', async () => {
    const svc = new CategoryZipService(
      fakeDb([folderRow(), bytesRow('2147483648')]),
      storageObjects,
    );
    await expect(svc.assertZippable(WS, FOLDER)).resolves.toBeUndefined();
  });

  it('400s a folder that is not a media folder', async () => {
    const svc = new CategoryZipService(
      fakeDb([folderRow('template')]),
      storageObjects,
    );
    await expect(svc.assertZippable(WS, FOLDER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('404s a folder outside the workspace', async () => {
    const svc = new CategoryZipService(fakeDb([[]]), storageObjects);
    await expect(svc.assertZippable(WS, FOLDER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('sanitises the folder name in the header and keeps a UTF-8 name too', async () => {
    const res = await zipOf([
      folderRow('media', 'Q4 "launch": café'),
      bytesRow(null),
      [],
    ]);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="Q4 _launch__ caf_.zip"; filename*=UTF-8''Q4%20_launch__%20caf%C3%A9.zip`,
    );
    expect(res.body.subarray(0, 4)).toEqual(
      Buffer.from('PK\x05\x06', 'latin1'),
    );
  });
});
