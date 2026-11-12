import { db, type Tx } from '../db';
import { getValue, setValue } from '../settings';

/**
 * WordPress posts of articles the owner deleted from this app (owner request: an article deleted here must not show up
 * as a duplicate when it is written again). The post itself is never touched; it only stops counting as “already
 * published” in the duplicate checks. It stays in the internal-link index while it is on the website.
 */
export const DELETED_POSTS_KEY = 'deleted-article-posts';
const MAX_REMEMBERED = 5000;

interface DeletedPost {
  websiteId: string;
  wpPostId: number;
  keyword: string;
  at: string;
}

export async function rememberDeletedPost(post: { websiteId: string; wpPostId: number; keyword: string }, client: Tx = db): Promise<void> {
  const list = await getValue<DeletedPost[]>(DELETED_POSTS_KEY, [], client);
  const next = [...list.filter((p) => !(p.websiteId === post.websiteId && p.wpPostId === post.wpPostId)), { ...post, at: new Date().toISOString() }].slice(-MAX_REMEMBERED);
  await setValue(DELETED_POSTS_KEY, next, client);
  // The index named the post after the deleted article's keyword; it keeps only its WordPress title now.
  await client.linkTarget.updateMany({ where: { websiteId: post.websiteId, wpPostId: post.wpPostId }, data: { keyword: null } });
}

/** “websiteId:wpPostId” of posts whose article was deleted here. */
export async function deletedPostKeys(client: Tx = db): Promise<Set<string>> {
  return new Set((await getValue<DeletedPost[]>(DELETED_POSTS_KEY, [], client)).map((p) => `${p.websiteId}:${p.wpPostId}`));
}
