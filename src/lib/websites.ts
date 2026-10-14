import { z } from 'zod';
import { db, type Tx } from './db';
import { countrySchema, EDITOR_TYPES, LANGUAGES } from './domain';
import { siteOverridesSchema } from './settings-schema';
import { slugify } from './paths';
import { AppError } from './errors';

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return /\//.test(tz) || tz === 'UTC';
  } catch {
    return false;
  }
}

/** Normalize a site URL: https default, lower-case host, no query/hash/trailing slash. */
export function normalizeSiteUrl(input: string): string {
  let raw = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http(s) URLs are allowed');
  if (url.username || url.password) throw new Error('URLs must not contain credentials');
  url.hash = '';
  url.search = '';
  url.hostname = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/** Admin URL always ends with /wp-admin/. */
export function normalizeAdminUrl(input: string | undefined | null, publicUrl: string): string {
  const base = input && input.trim() ? normalizeSiteUrl(input) : `${publicUrl}/wp-admin`;
  const withoutAdmin = base.replace(/\/wp-admin(?:\/.*)?$/i, '');
  return `${withoutAdmin}/wp-admin/`;
}

export const DEFAULT_INTERNAL_LINK_LINE: Record<string, string> = { en: 'Also read:', de: 'Das könnte Ihnen gefallen:' };

const urlField = (label: string) =>
  z
    .string()
    .trim()
    .min(4, `${label} is required`)
    .max(300)
    .transform((value, ctx) => {
      try {
        return normalizeSiteUrl(value);
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: `${label}: ${(error as Error).message || 'invalid URL'}` });
        return z.NEVER;
      }
    });

export const websiteInputSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(80),
  publicUrl: urlField('Public URL'),
  adminUrl: z.string().trim().max(300).optional().nullable(),
  language: z.enum(LANGUAGES),
  targetCountry: countrySchema,
  timezone: z.string().trim().refine(isValidTimezone, 'Use an IANA timezone such as Europe/Berlin or America/New_York'),
  internalLinkLine: z.string().trim().max(80).optional().nullable(),
  editorType: z.enum(EDITOR_TYPES).default('AUTO'),
  defaultCategoryId: z.string().max(40).optional().nullable(),
  searchConsoleProperty: z
    .string()
    .trim()
    .max(200)
    .regex(/^(sc-domain:[a-z0-9.-]+|https?:\/\/\S+)$/i, 'Use sc-domain:example.com or a URL-prefix property')
    .optional()
    .nullable()
    .or(z.literal('')),
  queueQuota: z.number().int().min(0).max(10).default(0),
  priority: z.number().int().min(-10).max(10).default(0),
  paused: z.boolean().default(false),
  active: z.boolean().default(true),
  allowLiveUpdates: z.boolean().default(false),
  notes: z.string().max(2000).optional().nullable(),
  settingsOverrides: siteOverridesSchema.optional(),
});
export type WebsiteInput = z.input<typeof websiteInputSchema>;

async function uniqueSlug(base: string, client: Tx, excludeId?: string): Promise<string> {
  const root = slugify(base, 50);
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const existing = await client.website.findUnique({ where: { slug: candidate }, select: { id: true } });
    const profile = await client.browserProfile.findUnique({ where: { profileDir: `profiles/${candidate}` }, select: { id: true } });
    if ((!existing || existing.id === excludeId) && !profile) return candidate;
  }
  throw new AppError(409, 'CONFLICT', 'Could not find a free profile name for this website.');
}

export async function createWebsite(raw: unknown, client: Tx = db) {
  const input = websiteInputSchema.parse(raw);
  const adminUrl = normalizeAdminUrl(input.adminUrl, input.publicUrl);
  const duplicate = await client.website.findFirst({ where: { publicUrl: input.publicUrl } });
  if (duplicate) throw new AppError(409, 'DUPLICATE', `A website with this URL already exists (${duplicate.name}).`, { publicUrl: ['Already configured'] });
  const slug = await uniqueSlug(input.name, client);
  const profile = await client.browserProfile.create({ data: { name: `${input.name} (WordPress)`, kind: 'WORDPRESS', profileDir: `profiles/${slug}` } });
  return client.website.create({
    data: {
      name: input.name,
      slug,
      publicUrl: input.publicUrl,
      adminUrl,
      language: input.language,
      targetCountry: input.targetCountry,
      timezone: input.timezone,
      internalLinkLine: input.internalLinkLine?.trim() || DEFAULT_INTERNAL_LINK_LINE[input.language],
      editorType: input.editorType,
      searchConsoleProperty: input.searchConsoleProperty || null,
      queueQuota: input.queueQuota,
      priority: input.priority,
      paused: input.paused,
      active: input.active,
      allowLiveUpdates: false,
      notes: input.notes ?? null,
      settingsOverrides: JSON.stringify(input.settingsOverrides ?? {}),
      wordpressProfileId: profile.id,
    },
  });
}

export async function updateWebsite(id: string, raw: unknown, client: Tx = db) {
  const existing = await client.website.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'NOT_FOUND', 'Website not found.');
  const input = websiteInputSchema.parse(raw);
  const adminUrl = normalizeAdminUrl(input.adminUrl, input.publicUrl);
  if (input.defaultCategoryId) {
    const cat = await client.category.findFirst({ where: { id: input.defaultCategoryId, websiteId: id } });
    if (!cat) throw new AppError(400, 'VALIDATION', 'Default category must be one of this site’s synchronized categories.', { defaultCategoryId: ['Not a category of this site'] });
  }
  if (input.publicUrl !== existing.publicUrl) {
    const duplicate = await client.website.findFirst({ where: { publicUrl: input.publicUrl, id: { not: id } } });
    if (duplicate) throw new AppError(409, 'DUPLICATE', `Another website already uses this URL (${duplicate.name}).`);
  }
  return client.website.update({
    where: { id },
    data: {
      name: input.name,
      publicUrl: input.publicUrl,
      adminUrl,
      language: input.language,
      targetCountry: input.targetCountry,
      timezone: input.timezone,
      internalLinkLine: input.internalLinkLine?.trim() || DEFAULT_INTERNAL_LINK_LINE[input.language],
      editorType: input.editorType,
      defaultCategoryId: input.defaultCategoryId || null,
      searchConsoleProperty: input.searchConsoleProperty || null,
      queueQuota: input.queueQuota,
      priority: input.priority,
      paused: input.paused,
      active: input.active,
      notes: input.notes ?? null,
      ...(input.settingsOverrides ? { settingsOverrides: JSON.stringify(input.settingsOverrides) } : {}),
    },
  });
}

export const PUBLISH_ACK_PHRASE = 'ALLOW PUBLISHING';
