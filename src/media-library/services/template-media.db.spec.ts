import { randomUUID } from 'crypto';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  describeLibraryDb,
  withLibraryDb,
  seedWorkspace,
} from '../testing/library-db';
import { TemplateService } from './template.service';
import { CreateTemplateDto, UpdateTemplateDto } from '../dto/media-library.dto';

/** The app's global pipe (main.ts), so the body is read as the route reads it. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

function asBody<T>(metatype: new () => T, value: unknown): Promise<T> {
  return pipe.transform(value, { type: 'body', metatype }) as Promise<T>;
}

const media = (libraryItemId?: unknown) => ({
  id: 'att-1',
  type: 'image',
  url: 'https://res.cloudinary.com/test-cloud/image/upload/v1/a.png',
  ...(libraryItemId !== undefined ? { libraryItemId } : {}),
});

describeLibraryDb('template media carries libraryItemId (T)', () => {
  it('save as template keeps libraryItemId on content.media[] through create and read', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const itemId = randomUUID();
      const dto = await asBody(CreateTemplateDto, {
        name: 'Launch',
        templateType: 'post',
        content: { text: 'Hi', media: [media(itemId), media()] },
      });
      const svc = new TemplateService(db);

      const created = await svc.create(workspaceId, ownerId, dto);
      const read = await svc.findOne(workspaceId, created.id);

      expect(read.content.media?.[0]).toMatchObject({ libraryItemId: itemId });
      expect(read.content.media?.[1]).not.toHaveProperty('libraryItemId');
    });
  });

  it('an update keeps it too', async () => {
    await withLibraryDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const svc = new TemplateService(db);
      const created = await svc.create(
        workspaceId,
        ownerId,
        await asBody(CreateTemplateDto, {
          name: 'T',
          templateType: 'post',
          content: { text: 'Hi' },
        }),
      );
      const itemId = randomUUID();

      await svc.update(
        workspaceId,
        created.id,
        await asBody(UpdateTemplateDto, {
          content: { text: 'Hi', media: [media(itemId)] },
        }),
      );
      const read = await svc.findOne(workspaceId, created.id);

      expect(read.content.media?.[0]).toMatchObject({ libraryItemId: itemId });
    });
  });

  it('a libraryItemId that is not a uuid is a 400', async () => {
    await expect(
      asBody(CreateTemplateDto, {
        name: 'T',
        templateType: 'post',
        content: { text: 'Hi', media: [media('not-a-uuid')] },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
