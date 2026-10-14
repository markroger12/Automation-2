import { route } from '@/lib/api';
import { db } from '@/lib/db';
import { getSettings, parseSiteOverrides } from '@/lib/settings';
import { getSiteImageSettings, saveSiteImageSettings, siteLogoAsset, siteTemplateAssets } from '@/images/site-templates';
import { z } from 'zod';

const assetView = (a: { id: string; role: string; width: number | null; height: number | null; notes: string | null; createdAt: Date; origin: string; taskId?: string | null }) => ({ id: a.id, role: a.role, width: a.width, height: a.height, name: a.notes ?? '', origin: a.origin, createdAt: a.createdAt });

/** A site's featured/body templates, logo + fixed-photo library, and recent photos usable for previews. */
export const GET = route({}, async ({ params }) => {
  const { site, settings } = await getSiteImageSettings(params.id);
  const [assets, logo, recent, global] = await Promise.all([
    siteTemplateAssets(site.id),
    siteLogoAsset(site.id, settings.logoAssetId),
    db.mediaAsset.findMany({ where: { websiteId: site.id, taskId: { not: null }, role: { in: ['GALLERY', 'UPLOAD'] }, status: { not: 'REJECTED' } }, orderBy: { createdAt: 'desc' }, take: 12 }),
    getSettings(),
  ]);
  const overrides = parseSiteOverrides(site.settingsOverrides);
  return {
    website: { id: site.id, name: site.name, language: site.language },
    settings,
    activeLogoId: logo?.id ?? null,
    assets: assets.map(assetView),
    previewPhotos: recent.map(assetView),
    output: { size: overrides.seo.imageOutputSize ?? global.seo.imageOutputSize, maxBytes: global.seo.imageMaxBytes },
  };
});

export const PUT = route({ body: z.object({ settings: z.unknown() }) }, async ({ params, body }) => ({ settings: await saveSiteImageSettings(params.id, body.settings) }));
