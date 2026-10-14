import { createHash, randomUUID } from 'node:crypto';
import { load } from 'cheerio';
import { NeedsReviewError, TransientError, UncertainSideEffectError } from '@/lib/pipeline-errors';
import { normalizeText, stripTags } from '@/lib/content/text';
import { htmlForClassic, htmlToBlocks } from './blocks';
import { WpApiError, type WpClient, type WpPost } from './client';

/**
 * Safe WordPress draft creation, transactional at the application level:
 *
 *  1. Reconcile first: a stored post ID is reopened (never a second post);
 *     an in-flight create without an acknowledgement is looked up by its
 *     title/slug/time before anything is created again. Ambiguous evidence
 *     pauses for review instead of creating a duplicate.
 *  2. A create attempt is recorded BEFORE it is sent, and the post ID is
 *     persisted as soon as WordPress returns it.
 *  3. The saved post is read back and verified (status, title, content,
 *     category, slug) — the returned post status is trusted, not button state.
 *  4. Content edited in WordPress after the app's last save is never
 *     overwritten silently.
 */

export type EditorKind = 'GUTENBERG' | 'CLASSIC';

export interface DraftInput {
  title: string;
  html: string;
  slug: string | null;
  categoryExternalId: number | null;
  tagNames: string[];
  featuredMediaId?: number | null;
  editor: EditorKind;
  existing: {
    wpPostId: number | null;
    wpCreateMarker: string | null;
    wpModifiedGmt: string | null;
    wpContentHash: string | null;
  };
  options: {
    createMissingTags: boolean;
    /** Owner chose to replace edits made in WordPress with the app version. */
    overwriteRemoteEdits?: boolean;
    /** Owner confirmed a candidate post found during reconciliation. */
    adoptPostId?: number | null;
    /** Owner confirmed that a missing/trashed draft should be created again. */
    recreate?: boolean;
    timeoutMs?: number;
  };
}

export interface TaskWpUpdate {
  wpPostId?: number | null;
  wpEditUrl?: string | null;
  wpPostStatus?: string | null;
  wpModifiedGmt?: string | null;
  wpContentHash?: string | null;
  wpSlug?: string | null;
  wpCreateMarker?: string | null;
  wpDraftAt?: Date | null;
}

export interface DraftOutcome {
  postId: number;
  editUrl: string;
  status: string;
  slug: string;
  link: string;
  modifiedGmt: string;
  contentHash: string;
  action: 'created' | 'updated' | 'unchanged' | 'adopted';
  warnings: string[];
  verification: Record<string, unknown>;
}

interface CreateMarker {
  id: string;
  at: string;
  title: string;
  slug: string | null;
}

export function editorContent(html: string, editor: EditorKind): string {
  return editor === 'CLASSIC' ? htmlForClassic(html) : htmlToBlocks(html);
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content.replace(/\s+/g, ' ').trim()).digest('hex');
}

/** Compare what WordPress stored with what was sent: same words, headings and links. */
export function sameArticle(sent: string, stored: string): boolean {
  if (contentHash(sent) === contentHash(stored)) return true;
  const sig = (html: string) => {
    const $ = load(`<body>${html.replace(/<!--[\s\S]*?-->/g, '')}</body>`);
    return JSON.stringify({
      text: normalizeText(stripTags($('body').html() ?? '')),
      headings: $('h2,h3,h4').toArray().map((h) => normalizeText($(h).text())),
      links: $('a[href]').toArray().map((a) => $(a).attr('href')),
    });
  };
  return sig(sent) === sig(stored);
}

const BLOCKED_REMOTE = ['publish', 'future', 'private'];

const hasBlockMarkup = (html: string) => /<!--\s*wp:/.test(html);

function slugAccepted(expected: string | null, actual: string): { ok: boolean; warning?: string } {
  if (!expected) return { ok: true };
  if (actual === expected) return { ok: true };
  if (new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`).test(actual)) {
    return { ok: true, warning: `WordPress saved the slug as “${actual}” because another post already uses “${expected}” — check for a duplicate article.` };
  }
  return { ok: false };
}

export async function saveDraft(client: WpClient, input: DraftInput, persist: (data: TaskWpUpdate) => Promise<void>): Promise<DraftOutcome> {
  const warnings: string[] = [];
  const content = editorContent(input.html, input.editor);
  const hash = contentHash(content);
  if (!input.categoryExternalId) throw new NeedsReviewError('No category is set for this article.', ['Category missing'], 'Choose a category on the Overview tab, then Retry.');
  const fields = {
    title: input.title,
    content,
    ...(input.slug ? { slug: input.slug } : {}),
    categories: [input.categoryExternalId],
    tags: await resolveTags(client, input.tagNames, input.options.createMissingTags, warnings),
    ...(input.featuredMediaId ? { featured_media: input.featuredMediaId } : {}),
  };

  // ---- 1. reconcile
  let post: WpPost | null = null;
  let action: DraftOutcome['action'] = 'updated';
  let postId = input.options.adoptPostId ?? input.existing.wpPostId;
  if (input.options.adoptPostId) action = 'adopted';
  if (postId) {
    post = await client.getPost(postId);
    if (!post || post.status === 'trash') {
      if (!input.options.recreate) {
        throw new NeedsReviewError(
          post ? `WordPress draft #${postId} is in the trash.` : `WordPress post #${postId} no longer exists.`,
          [post ? `Draft #${postId} was moved to the trash in WordPress.` : `Draft #${postId} was deleted in WordPress.`],
          'Restore it in WordPress and Retry, or use “Create a new draft” to save the article again.',
        );
      }
      warnings.push(post ? `Draft #${postId} was in the trash; a new draft was created at the owner's request.` : `Draft #${postId} no longer existed; a new draft was created at the owner's request.`);
      post = null;
      postId = null;
    }
  } else if (input.existing.wpCreateMarker) {
    const marker = safeMarker(input.existing.wpCreateMarker);
    if (marker) {
      const found = await findCreated(client, marker);
      if (found.length === 1) {
        post = found[0];
        postId = post.id;
        action = 'adopted';
        warnings.push(`Recovered draft #${post.id} from an earlier save whose confirmation was lost (no second post created).`);
        await persist({ wpPostId: post.id, wpEditUrl: client.editUrl(post.id), wpPostStatus: post.status, wpCreateMarker: null });
      } else if (found.length > 1) {
        throw new UncertainSideEffectError(`An earlier save may have created a draft, and ${found.length} matching posts exist (#${found.map((p) => p.id).join(', #')}). Not creating another one.`, {
          candidates: found.map((p) => ({ id: p.id, status: p.status, slug: p.slug, modified: p.modified_gmt, editUrl: client.editUrl(p.id) })),
        });
      }
    }
  }

  // ---- 2. create or update
  if (!post) {
    const marker: CreateMarker = { id: randomUUID(), at: new Date().toISOString(), title: input.title, slug: input.slug };
    await persist({ wpCreateMarker: JSON.stringify(marker) });
    await warnAboutSameTitle(client, input.title, warnings);
    let created: WpPost;
    try {
      created = await client.createDraft(fields, input.options.timeoutMs);
    } catch (error) {
      if (error instanceof WpApiError) throw mapApiError(error);
      // Timeout / connection lost: the post may exist. The marker stays; the retry reconciles.
      throw new TransientError(`Saving the draft did not confirm (${(error as Error).message}). The next attempt checks WordPress before saving again.`);
    }
    await persist({ wpPostId: created.id, wpEditUrl: client.editUrl(created.id), wpPostStatus: created.status, wpCreateMarker: null });
    post = created;
    postId = created.id;
    action = 'created';
  } else {
    if (BLOCKED_REMOTE.includes(post.status)) {
      throw new NeedsReviewError(
        `WordPress post #${post.id} is already “${post.status}”. The app does not change live or scheduled posts in this step.`,
        [`Post #${post.id} is ${post.status}; content was not overwritten.`],
        'Edit the live post in WordPress yourself, or create a new draft.',
      );
    }
    const remoteContent = post.content.raw ?? '';
    const remoteChanged =
      Boolean(input.existing.wpContentHash) && contentHash(remoteContent) !== input.existing.wpContentHash && !sameArticle(content, remoteContent) && action !== 'adopted';
    if (remoteChanged && !input.options.overwriteRemoteEdits) {
      throw new NeedsReviewError(
        `Draft #${post.id} was edited in WordPress after the app saved it (modified ${post.modified_gmt} UTC). The app did not overwrite those edits.`,
        [`Draft #${post.id} has edits made in WordPress.`],
        'Compare the versions. Keep the WordPress version, or use “Overwrite WordPress draft” to save the app version.',
      );
    }
    const needsUpdate =
      !sameArticle(content, remoteContent) ||
      hasBlockMarkup(content) !== hasBlockMarkup(remoteContent) ||
      (post.title.raw ?? '') !== input.title ||
      (input.slug && !slugAccepted(input.slug, post.slug).ok) ||
      JSON.stringify([...post.categories].sort()) !== JSON.stringify([input.categoryExternalId]) ||
      fields.tags.some((t) => !post!.tags.includes(t)) ||
      (input.featuredMediaId && post.featured_media !== input.featuredMediaId);
    if (needsUpdate) {
      try {
        post = await client.updatePost(post.id, fields, input.options.timeoutMs);
      } catch (error) {
        if (error instanceof WpApiError) throw mapApiError(error);
        throw new TransientError(`Updating draft #${post.id} did not confirm (${(error as Error).message}). It will be checked and retried.`);
      }
    } else if (action !== 'adopted') action = 'unchanged';
  }

  // ---- 3. verify by reading back
  const saved = await client.getPost(postId!);
  if (!saved) throw new TransientError(`Draft #${postId} could not be read back after saving.`);
  const problems: string[] = [];
  if (BLOCKED_REMOTE.includes(saved.status)) problems.push(`status is “${saved.status}”, expected draft`);
  if (!['draft', 'pending', 'auto-draft'].includes(saved.status) && !BLOCKED_REMOTE.includes(saved.status)) problems.push(`unexpected status “${saved.status}”`);
  if ((saved.title.raw ?? '').trim() !== input.title.trim()) problems.push('title differs');
  const storedContent = saved.content.raw ?? '';
  if (!sameArticle(content, storedContent)) problems.push('content differs from the article (a plugin may filter post content)');
  else if (contentHash(storedContent) !== hash) warnings.push('WordPress normalized the HTML formatting; text, headings and links are unchanged.');
  const cats = [...saved.categories].sort((a, b) => a - b);
  if (cats.length !== 1 || cats[0] !== input.categoryExternalId) problems.push(`categories are [${cats.join(', ')}], expected [${input.categoryExternalId}]`);
  const slug = slugAccepted(input.slug, saved.slug);
  if (!slug.ok) problems.push(`slug is “${saved.slug}”, expected “${input.slug}”`);
  if (slug.warning) warnings.push(slug.warning);
  const missingTags = fields.tags.filter((t) => !saved.tags.includes(t));
  if (missingTags.length) warnings.push(`${missingTags.length} tag(s) were not kept by WordPress.`);
  const verification = { status: saved.status, title: saved.title.raw, slug: saved.slug, categories: saved.categories, tags: saved.tags, modified: saved.modified_gmt, problems };
  if (problems.length) {
    await persist({ wpPostStatus: saved.status, wpModifiedGmt: saved.modified_gmt, wpSlug: saved.slug, wpContentHash: contentHash(storedContent) });
    throw new NeedsReviewError(`Draft #${saved.id} was saved but did not verify: ${problems.join('; ')}.`, problems.map((p) => `WordPress draft #${saved.id}: ${p}`), 'Open the draft in WordPress to check, then Retry the WordPress step.');
  }
  const outcome: DraftOutcome = {
    postId: saved.id,
    editUrl: client.editUrl(saved.id),
    status: saved.status,
    slug: saved.slug,
    link: saved.link,
    modifiedGmt: saved.modified_gmt,
    contentHash: contentHash(storedContent),
    action,
    warnings,
    verification,
  };
  await persist({
    wpPostId: saved.id,
    wpEditUrl: outcome.editUrl,
    wpPostStatus: saved.status,
    wpModifiedGmt: saved.modified_gmt,
    wpContentHash: outcome.contentHash,
    wpSlug: saved.slug,
    wpCreateMarker: null,
    wpDraftAt: new Date(),
  });
  return outcome;
}

function safeMarker(raw: string): CreateMarker | null {
  try {
    const m = JSON.parse(raw) as CreateMarker;
    return m && typeof m.at === 'string' && typeof m.title === 'string' ? m : null;
  } catch {
    return null;
  }
}

/** Posts that an unacknowledged create could have produced: same title, matching slug, created after the attempt. */
async function findCreated(client: WpClient, marker: CreateMarker): Promise<WpPost[]> {
  const since = new Date(new Date(marker.at).getTime() - 5 * 60_000);
  const posts = await client.findPosts({ search: marker.title.slice(0, 100), perPage: 50 });
  return posts.filter((p) => {
    if ((p.title.raw ?? '').trim() !== marker.title.trim()) return false;
    const created = p.date_gmt ? new Date(`${p.date_gmt}Z`) : new Date(`${p.modified_gmt}Z`);
    if (created < since) return false;
    if (marker.slug) {
      const candidates = [p.slug, p.generated_slug].filter(Boolean) as string[];
      if (!candidates.some((s) => slugAccepted(marker.slug, s).ok)) return false;
    }
    return p.status !== 'trash';
  });
}

async function warnAboutSameTitle(client: WpClient, title: string, warnings: string[]) {
  try {
    const same = (await client.findPosts({ search: title.slice(0, 100), perPage: 10 })).filter((p) => (p.title.raw ?? '').trim().toLowerCase() === title.trim().toLowerCase());
    if (same.length) warnings.push(`Another post already has this exact title: ${same.map((p) => `#${p.id} (${p.status})`).join(', ')}.`);
  } catch {
    /* a failed look-up must not block saving */
  }
}

async function resolveTags(client: WpClient, names: string[], create: boolean, warnings: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const name of Array.from(new Set(names.map((n) => n.trim()).filter(Boolean))).slice(0, 10)) {
    const r = await client.ensureTag(name, create);
    if (r.id) ids.push(r.id);
    else if (r.error) warnings.push(r.error);
  }
  return Array.from(new Set(ids));
}

function mapApiError(error: WpApiError): Error {
  if (error.code === 'rest_invalid_param' || error.code === 'rest_invalid_term') {
    return new NeedsReviewError(`WordPress rejected the draft: ${error.message}`, [`WordPress rejected a field (${error.code}). The category or a tag may no longer exist.`], 'Sync categories on the website page, choose the category again, then Retry.');
  }
  if (error.status === 403 || error.code === 'rest_cannot_create' || error.code === 'rest_cannot_edit') {
    return new NeedsReviewError(`The logged-in WordPress user may not create or edit this post (${error.code ?? error.status}).`, ['WordPress user lacks permission to save drafts.'], 'Log in with a user that can edit posts (Editor or Administrator), then Retry.');
  }
  return new TransientError(error.message);
}
