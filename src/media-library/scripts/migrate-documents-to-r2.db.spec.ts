import { randomUUID } from 'crypto';
import type { Client, PoolClient } from 'pg';
import {
  describeLibraryDb,
  seedMediaItem,
  seedPost,
  seedWorkspace,
  withLibraryDb,
} from '../testing/library-db';
import {
  bytesMatchType,
  documentContentType,
  parseCloudinaryUrl,
  runMigrateDocumentsToR2,
  type CloudinaryDocumentRef,
  type DocumentSource,
  type DocumentTarget,
} from './migrate-documents-to-r2';

const LOCAL_URL = 'postgres://user:pw@localhost:5432/test';
const PDF = Buffer.from('%PDF-1.7 test file');
const DOCX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
const R2_BASE = 'https://r2.example.test';

/**
 * Hands the rollback harness connection to the script. The script runs its
 * own BEGIN / COMMIT / ROLLBACK per file; inside the harness transaction they
 * become a savepoint, so a spec still rolls everything back at the end.
 * `failOn` makes one statement throw, to test the rollback path.
 */
function harnessConnect(client: PoolClient, failOn?: RegExp) {
  const wrapped = {
    query: (text: string, params?: unknown[]) => {
      if (text === 'BEGIN') return client.query('SAVEPOINT migrate_doc');
      if (text === 'COMMIT')
        return client.query('RELEASE SAVEPOINT migrate_doc');
      if (text === 'ROLLBACK') {
        return client.query('ROLLBACK TO SAVEPOINT migrate_doc');
      }
      if (failOn?.test(text)) return Promise.reject(new Error('db down'));
      return client.query(text, params);
    },
    end: () => Promise.resolve(),
  } as unknown as Client;
  return () => Promise.resolve(wrapped);
}

/** A Cloudinary source whose files exist and download as `bytes`. */
function makeSource(bytes: Buffer = PDF) {
  return {
    probe: jest.fn((ref: CloudinaryDocumentRef) =>
      Promise.resolve(
        ref.publicId.includes('missing')
          ? { exists: false }
          : { exists: true, bytes: bytes.length },
      ),
    ),
    download: jest.fn((ref: CloudinaryDocumentRef) =>
      ref.publicId.includes('missing')
        ? Promise.reject(new Error('Cloudinary download answered HTTP 404'))
        : Promise.resolve(bytes),
    ),
  } satisfies DocumentSource;
}

/** An R2 target that keys the way CloudflareR2Service.uploadBuffer does. */
function makeTarget() {
  let n = 0;
  return {
    upload: jest.fn(({ workspaceId }: { workspaceId: string }) => {
      n += 1;
      const key = `composer/documents/${workspaceId}/system/1700000000000-${String(n).padStart(24, '0')}.pdf`;
      return Promise.resolve({ key, publicUrl: `${R2_BASE}/${key}` });
    }),
    remove: jest.fn(() => Promise.resolve()),
  } satisfies DocumentTarget;
}

describe('migrate-documents-to-r2 helpers', () => {
  it('parses a PDF stored as an image: the extension is the format', () => {
    expect(
      parseCloudinaryUrl(
        'https://res.cloudinary.com/cloud/image/upload/v17/library/ws/abc.pdf',
        'cloud',
      ),
    ).toEqual({
      publicId: 'library/ws/abc',
      resourceType: 'image',
      deliveryType: 'upload',
      format: 'pdf',
    });
  });

  it('parses a raw file: the public id keeps its extension', () => {
    expect(
      parseCloudinaryUrl(
        'https://res.cloudinary.com/cloud/raw/upload/v1/library/ws/abc.docx',
        'cloud',
      ),
    ).toEqual({
      publicId: 'library/ws/abc.docx',
      resourceType: 'raw',
      deliveryType: 'upload',
      format: '',
    });
  });

  it.each([
    'https://res.cloudinary.com/other/image/upload/v1/a.pdf',
    'https://res.cloudinary.com/cloud/video/upload/v1/a.mp4',
    'https://res.cloudinary.com/cloud/image/upload/pg_1,w_200/a.pdf',
    'https://evil.test/cloud/image/upload/a.pdf',
    'not a url',
  ])('refuses %s', (url) => {
    expect(parseCloudinaryUrl(url, 'cloud')).toBeNull();
  });

  it('types a document by its mime type, else its extension; others are null', () => {
    expect(documentContentType('https://x/a', 'application/pdf')).toBe(
      'application/pdf',
    );
    expect(documentContentType('https://x/a.PPTX', null)).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    expect(documentContentType('https://x/a.xlsx', null)).toBeNull();
    expect(
      documentContentType('https://x/a.zip', 'application/zip'),
    ).toBeNull();
  });

  it('checks the bytes against the type', () => {
    expect(bytesMatchType(PDF, 'application/pdf')).toBe(true);
    expect(bytesMatchType(DOCX, 'application/pdf')).toBe(false);
    expect(
      bytesMatchType(
        DOCX,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe(true);
    expect(bytesMatchType(Buffer.alloc(0), 'application/msword')).toBe(false);
  });
});

describe('runMigrateDocumentsToR2 guards', () => {
  it('refuses a .railway.internal host without the production flag, before connecting', async () => {
    const connect = jest.fn();
    await expect(
      runMigrateDocumentsToR2({
        databaseUrl: 'postgres://u:p@db.railway.internal:5432/railway',
        confirmedProduction: false,
        apply: true,
        cloudName: 'c',
        source: makeSource(),
        target: makeTarget(),
        connect,
      }),
    ).rejects.toThrow(/--i-know-this-is-production/);
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuses a public host without the flag', async () => {
    const connect = jest.fn();
    await expect(
      runMigrateDocumentsToR2({
        databaseUrl: 'postgres://u:p@prod.example.com:5432/db',
        confirmedProduction: false,
        apply: false,
        cloudName: 'c',
        source: makeSource(),
        connect,
      }),
    ).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuses --apply without an R2 target', async () => {
    const connect = jest.fn();
    await expect(
      runMigrateDocumentsToR2({
        databaseUrl: LOCAL_URL,
        confirmedProduction: false,
        apply: true,
        cloudName: 'c',
        source: makeSource(),
        connect,
      }),
    ).rejects.toThrow(/R2 target/);
    expect(connect).not.toHaveBeenCalled();
  });
});

describeLibraryDb('runMigrateDocumentsToR2', () => {
  /**
   * A cloud name of its own, so documents already in the developer's local
   * database never match: only what a spec seeds is a candidate.
   */
  function fixture() {
    const cloud = `test-${randomUUID().slice(0, 8)}`;
    const base = `https://res.cloudinary.com/${cloud}`;
    return { cloud, base };
  }

  async function seedDocs(client: PoolClient, base: string) {
    const a = await seedWorkspace(client);
    const b = await seedWorkspace(client);
    const pdfId = `library/${a.workspaceId}/${randomUUID()}`;
    const pdfUrl = `${base}/image/upload/v1/${pdfId}.pdf`;
    const pdfItem = await seedMediaItem(client, {
      workspaceId: a.workspaceId,
      uploadedById: a.ownerId,
      type: 'document',
      name: 'Pitch deck',
      fileUrl: pdfUrl,
      cloudinaryPublicId: pdfId,
      mimeType: 'application/pdf',
      fileSize: 5,
    });
    // A binned copy of the same file in the same workspace moves with it.
    const binnedTwin = await seedMediaItem(client, {
      workspaceId: a.workspaceId,
      uploadedById: a.ownerId,
      type: 'document',
      fileUrl: pdfUrl,
      cloudinaryPublicId: pdfId,
      isDeleted: true,
      deletedAt: new Date(),
    });
    const xlsxItem = await seedMediaItem(client, {
      workspaceId: a.workspaceId,
      uploadedById: a.ownerId,
      type: 'document',
      fileUrl: `${base}/raw/upload/v1/library/${a.workspaceId}/${randomUUID()}.xlsx`,
    });
    const imageItem = await seedMediaItem(client, {
      workspaceId: a.workspaceId,
      uploadedById: a.ownerId,
      fileUrl: `${base}/image/upload/v1/library/${a.workspaceId}/pic.png`,
    });
    const r2Key = `composer/documents/${a.workspaceId}/u/1-${'a'.repeat(24)}.pdf`;
    const r2Item = await seedMediaItem(client, {
      workspaceId: a.workspaceId,
      uploadedById: a.ownerId,
      type: 'document',
      fileUrl: `${R2_BASE}/${r2Key}`,
      storageProvider: 'r2',
    });

    const doc = { url: pdfUrl, type: 'document', libraryItemId: pdfItem };
    const postA = await seedPost(client, {
      workspaceId: a.workspaceId,
      createdById: a.ownerId,
      mediaItems: [doc],
      platformContent: {
        linkedin: {
          mediaItems: [doc],
          metadata: { note: `${pdfUrl}?keep-me` },
        },
      },
      targets: [
        {
          channelId: '1',
          platform: 'linkedin',
          status: 'draft',
          contentOverride: { mediaItems: [doc] },
        },
      ],
    });
    // Another workspace's post holding the same URL, with no Library row:
    // it gets its own copy under ITS workspace's prefix.
    const postB = await seedPost(client, {
      workspaceId: b.workspaceId,
      createdById: b.ownerId,
      mediaItems: [{ url: pdfUrl, type: 'document' }],
    });
    // A document only a post uses (no Library row).
    const orphanUrl = `${base}/raw/upload/v1/old/${randomUUID()}.docx`;
    const postOrphan = await seedPost(client, {
      workspaceId: a.workspaceId,
      createdById: a.ownerId,
      mediaItems: [{ url: orphanUrl, type: 'document' }],
    });
    return {
      a,
      b,
      pdfId,
      pdfUrl,
      pdfItem,
      binnedTwin,
      xlsxItem,
      imageItem,
      r2Item,
      postA,
      postB,
      postOrphan,
      orphanUrl,
    };
  }

  async function row(client: PoolClient, id: string) {
    const r = await client.query<{
      file_url: string;
      storage_provider: string;
      cloudinary_public_id: string | null;
      file_size: number | null;
      mime_type: string | null;
    }>(
      `SELECT file_url, storage_provider, cloudinary_public_id,
              file_size::int AS file_size, mime_type
         FROM media_items WHERE id = $1`,
      [id],
    );
    return r.rows[0];
  }

  async function post(client: PoolClient, id: string) {
    const r = await client.query<{
      media_items: { url: string }[];
      platform_content: Record<
        string,
        { mediaItems: { url: string }[]; metadata?: { note?: string } }
      >;
      targets: { contentOverride?: { mediaItems: { url: string }[] } }[];
    }>(
      'SELECT media_items, platform_content, targets FROM posts WHERE id = $1',
      [id],
    );
    return r.rows[0];
  }

  it('dry run: reports what it would move and writes nothing', async () => {
    await withLibraryDb(async (_db, client) => {
      const { cloud, base } = fixture();
      const s = await seedDocs(client, base);
      const source = makeSource();
      const target = makeTarget();

      const res = await runMigrateDocumentsToR2({
        databaseUrl: LOCAL_URL,
        confirmedProduction: false,
        apply: false,
        cloudName: cloud,
        source,
        target,
        connect: harnessConnect(client),
        log: () => undefined,
      });

      expect(res).toMatchObject({
        dryRun: true,
        // a: pdf (2 rows), xlsx row, the post-only docx; b: the pdf its post uses.
        candidates: 4,
        libraryRows: 3,
        postOnlyUrls: 2,
        migrated: 3,
        refsRewritten: 0,
        ledger: [],
      });
      expect(res.skipped.map((x) => x.reason)).toEqual([
        'not a PDF, PPT, PPTX, DOC or DOCX; R2 does not take it',
      ]);
      expect(source.probe).toHaveBeenCalledWith({
        publicId: s.pdfId,
        resourceType: 'image',
        deliveryType: 'upload',
        format: 'pdf',
      });
      expect(source.download).not.toHaveBeenCalled();
      expect(target.upload).not.toHaveBeenCalled();
      expect((await row(client, s.pdfItem)).file_url).toBe(s.pdfUrl);
      expect((await post(client, s.postA)).media_items[0].url).toBe(s.pdfUrl);
    });
  });

  it("apply: moves the rows to R2, rewrites the workspace's posts, leaves the rest", async () => {
    await withLibraryDb(async (_db, client) => {
      const { cloud, base } = fixture();
      const s = await seedDocs(client, base);
      const source = makeSource();
      const target = makeTarget();

      const res = await runMigrateDocumentsToR2({
        databaseUrl: LOCAL_URL,
        confirmedProduction: false,
        apply: true,
        cloudName: cloud,
        source: {
          ...source,
          // The post-only file is a DOCX.
          download: jest.fn((ref: CloudinaryDocumentRef) =>
            Promise.resolve(ref.resourceType === 'raw' ? DOCX : PDF),
          ),
        },
        target,
        connect: harnessConnect(client),
        log: () => undefined,
      });

      expect(res.migrated).toBe(3);
      expect(res.failed).toEqual([]);
      expect(res.ledger).toHaveLength(3);
      const pdfEntry = res.ledger.find(
        (l) => l.oldUrl === s.pdfUrl && l.workspaceId === s.a.workspaceId,
      )!;
      expect(pdfEntry).toMatchObject({
        workspaceId: s.a.workspaceId,
        cloudinaryPublicId: s.pdfId,
        cloudinaryResourceType: 'image',
        bytes: PDF.length,
        // postA's media_items, platform_content and targets are one row.
        refsRewritten: 1,
      });
      expect([...pdfEntry.itemIds].sort()).toEqual(
        [s.pdfItem, s.binnedTwin].sort(),
      );
      expect(target.upload).toHaveBeenCalledWith({
        workspaceId: s.a.workspaceId,
        buffer: PDF,
        contentType: 'application/pdf',
        filename: 'Pitch deck.pdf',
      });

      for (const id of [s.pdfItem, s.binnedTwin]) {
        expect(await row(client, id)).toMatchObject({
          file_url: pdfEntry.newUrl,
          storage_provider: 'r2',
          cloudinary_public_id: null,
          file_size: PDF.length,
        });
      }
      expect((await row(client, s.pdfItem)).mime_type).toBe('application/pdf');
      const moved = await post(client, s.postA);
      expect(moved.media_items[0].url).toBe(pdfEntry.newUrl);
      expect(moved.platform_content.linkedin.mediaItems[0].url).toBe(
        pdfEntry.newUrl,
      );
      expect(moved.targets[0].contentOverride?.mediaItems[0].url).toBe(
        pdfEntry.newUrl,
      );
      // A string that merely CONTAINS the URL is not the URL.
      expect(moved.platform_content.linkedin.metadata?.note).toBe(
        `${s.pdfUrl}?keep-me`,
      );
      // The other workspace got its own copy, keyed under its own prefix.
      const bEntry = res.ledger.find((l) => l.workspaceId === s.b.workspaceId)!;
      expect(bEntry.r2Key).toContain(`composer/documents/${s.b.workspaceId}/`);
      expect(bEntry.newUrl).not.toBe(pdfEntry.newUrl);
      expect((await post(client, s.postB)).media_items[0].url).toBe(
        bEntry.newUrl,
      );

      const orphanEntry = res.ledger.find((l) => l.oldUrl === s.orphanUrl)!;
      expect(orphanEntry.itemIds).toEqual([]);
      expect(orphanEntry.cloudinaryResourceType).toBe('raw');
      expect((await post(client, s.postOrphan)).media_items[0].url).toBe(
        orphanEntry.newUrl,
      );

      // Untouched: the spreadsheet, the image and the row already on R2.
      expect((await row(client, s.xlsxItem)).storage_provider).toBe(
        'cloudinary',
      );
      expect((await row(client, s.imageItem)).storage_provider).toBe(
        'cloudinary',
      );
      expect((await row(client, s.r2Item)).storage_provider).toBe('r2');

      // Idempotent: a second run finds only the spreadsheet it cannot move.
      const again = await runMigrateDocumentsToR2({
        databaseUrl: LOCAL_URL,
        confirmedProduction: false,
        apply: true,
        cloudName: cloud,
        source: makeSource(),
        target: makeTarget(),
        connect: harnessConnect(client),
        log: () => undefined,
      });
      expect(again).toMatchObject({ candidates: 1, migrated: 0, ledger: [] });
    });
  });

  it('bytes that are not the type: skipped, nothing uploaded', async () => {
    await withLibraryDb(async (_db, client) => {
      const { cloud, base } = fixture();
      const s = await seedDocs(client, base);
      const target = makeTarget();
      const res = await runMigrateDocumentsToR2({
        databaseUrl: LOCAL_URL,
        confirmedProduction: false,
        apply: true,
        cloudName: cloud,
        source: makeSource(Buffer.from('<html>error</html>')),
        target,
        connect: harnessConnect(client),
        log: () => undefined,
      });
      expect(res.migrated).toBe(0);
      expect(target.upload).not.toHaveBeenCalled();
      expect((await row(client, s.pdfItem)).file_url).toBe(s.pdfUrl);
    });
  });

  it('a failing database write rolls back and deletes the R2 copy', async () => {
    await withLibraryDb(async (_db, client) => {
      const { cloud, base } = fixture();
      const s = await seedDocs(client, base);
      const target = makeTarget();
      const res = await runMigrateDocumentsToR2({
        databaseUrl: LOCAL_URL,
        confirmedProduction: false,
        apply: true,
        cloudName: cloud,
        source: makeSource(),
        target,
        connect: harnessConnect(client, /UPDATE posts/),
        log: () => undefined,
      });
      expect(res.failed.length).toBeGreaterThan(0);
      expect(res.ledger).toEqual([]);
      expect(target.remove).toHaveBeenCalledTimes(
        target.upload.mock.calls.length,
      );
      // The Library row update ran before the failing statement: rolled back.
      expect(await row(client, s.pdfItem)).toMatchObject({
        file_url: s.pdfUrl,
        storage_provider: 'cloudinary',
      });
    });
  });

  it('a key outside the workspace layout is removed and nothing is written', async () => {
    await withLibraryDb(async (_db, client) => {
      const { cloud, base } = fixture();
      const s = await seedDocs(client, base);
      const target = {
        upload: jest.fn(() =>
          Promise.resolve({
            key: 'elsewhere/x.pdf',
            publicUrl: `${R2_BASE}/elsewhere/x.pdf`,
          }),
        ),
        remove: jest.fn(() => Promise.resolve()),
      };
      const res = await runMigrateDocumentsToR2({
        databaseUrl: LOCAL_URL,
        confirmedProduction: false,
        apply: true,
        cloudName: cloud,
        source: makeSource(),
        target,
        connect: harnessConnect(client),
        log: () => undefined,
        limit: 1,
      });
      expect(res.migrated).toBe(0);
      expect(target.remove).toHaveBeenCalledWith('elsewhere/x.pdf');
      expect((await row(client, s.pdfItem)).file_url).toBe(s.pdfUrl);
    });
  });

  it('a missing file is skipped in a dry run and reported as failed on apply', async () => {
    await withLibraryDb(async (_db, client) => {
      const { cloud, base } = fixture();
      const { workspaceId, ownerId } = await seedWorkspace(client);
      await seedMediaItem(client, {
        workspaceId,
        uploadedById: ownerId,
        type: 'document',
        fileUrl: `${base}/image/upload/v1/library/${workspaceId}/missing.pdf`,
      });
      const dry = await runMigrateDocumentsToR2({
        databaseUrl: LOCAL_URL,
        confirmedProduction: false,
        apply: false,
        cloudName: cloud,
        source: makeSource(),
        connect: harnessConnect(client),
        log: () => undefined,
      });
      expect(dry.skipped.map((x) => x.reason)).toEqual([
        'missing on Cloudinary',
      ]);
      const applied = await runMigrateDocumentsToR2({
        databaseUrl: LOCAL_URL,
        confirmedProduction: false,
        apply: true,
        cloudName: cloud,
        source: makeSource(),
        target: makeTarget(),
        connect: harnessConnect(client),
        log: () => undefined,
      });
      expect(applied.failed).toHaveLength(1);
      expect(applied.migrated).toBe(0);
    });
  });
});
