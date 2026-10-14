import { route } from '@/lib/api';
import { retireTemplateAsset } from '@/images/site-templates';

/** Remove a logo/fixed photo from the template library (the file is kept; history is never deleted). */
export const DELETE = route({}, async ({ params }) => retireTemplateAsset(params.id, params.assetId));
