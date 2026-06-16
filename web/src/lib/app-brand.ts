const DEFAULT_APP_NAME = "Fenix Agent";
const DEFAULT_LOGO_PATH = "/ctrl/brand/fenix-agent-logo-mark.png";

interface BrandingResponse {
  success: true;
  data: {
    brandName: string;
    logoUrl: string | null;
  };
}

interface AppBrand {
  name: string;
  logoUrl: string | null;
  monogram: string;
}

let appBrand: AppBrand = createBrand(DEFAULT_APP_NAME, DEFAULT_LOGO_PATH);

function createBrand(name: string, logoUrl: string | null): AppBrand {
  const normalizedName = name.trim() || DEFAULT_APP_NAME;
  return {
    name: normalizedName,
    logoUrl,
    monogram: normalizedName.charAt(0).toUpperCase() || DEFAULT_APP_NAME.charAt(0),
  };
}

/**
 * Returns the currently resolved app brand.
 */
export function getAppBrand(): AppBrand {
  return appBrand;
}

/**
 * Loads the public brand configuration from the backend and falls back silently on failure.
 */
export async function loadAppBrand(): Promise<void> {
  try {
    const response = await fetch("/web/branding");
    if (!response.ok) return;
    const payload = (await response.json()) as BrandingResponse;
    appBrand = createBrand(payload.data.brandName, payload.data.logoUrl);
  } catch {
    appBrand = createBrand(DEFAULT_APP_NAME, DEFAULT_LOGO_PATH);
  }
}

/**
 * Applies the current brand metadata to the current document.
 */
export function applyAppBrandToDocument(): void {
  if (typeof document === "undefined") return;

  const brand = getAppBrand();
  document.title = brand.name;
  const faviconUrl = brand.logoUrl ?? DEFAULT_LOGO_PATH;

  for (const rel of ["icon", "apple-touch-icon"]) {
    const selector = `link[rel='${rel}']`;
    const existing = document.head.querySelector<HTMLLinkElement>(selector);
    const link = existing ?? document.createElement("link");
    link.rel = rel;
    link.href = faviconUrl;
    if (!existing) {
      document.head.appendChild(link);
    }
  }
}
