/** Parsed, length-clamped client metadata (WordPress plugin, heartbeat). */

export type TenantMetadataInput = {
  site_name: string | null;
  plugin_version: string | null;
  wp_version: string | null;
  wc_version: string | null;
};

const MAX_SITE_NAME = 512;
const MAX_VERSION = 64;

function clip(s: unknown, max: number): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

export function parseTenantMetadata(body: Record<string, unknown>): TenantMetadataInput {
  return {
    site_name: clip(body.site_name, MAX_SITE_NAME),
    plugin_version: clip(body.plugin_version, MAX_VERSION),
    wp_version: clip(body.wp_version, MAX_VERSION),
    wc_version: clip(body.wc_version, MAX_VERSION),
  };
}
