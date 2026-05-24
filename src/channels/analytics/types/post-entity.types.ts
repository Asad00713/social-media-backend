import type { InferSelectModel } from 'drizzle-orm';
import type { posts } from '../../../drizzle/schema/posts.schema';

export type PostEntity = InferSelectModel<typeof posts>;
