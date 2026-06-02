const DEFAULT_APP_NAME = "Fenix";

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

let appBrand: AppBrand = createBrand(DEFAULT_APP_NAME, null);

function createBrand(name: string, logoUrl: string | null): AppBrand {
  const normalizedName = name.trim() || DEFAULT_APP_NAME;
  return {
    name: normalizedName,
    logoUrl,
    monogram: normalizedName.charAt(0).toUpperCase() || DEFAULT_APP_NAME.charAt(0),
  };
}

function buildMonogramIconDataUrl(monogram: string): string {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#6366f1" />
          <stop offset="100%" stop-color="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="url(#bg)" />
      <text
        x="50%"
        y="50%"
        fill="#ffffff"
        font-family="ui-sans-serif, system-ui, sans-serif"
        font-size="30"
        font-weight="700"
        text-anchor="middle"
        dominant-baseline="central"
      >${monogram}</text>
    </svg>
  `;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
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
    appBrand = createBrand(DEFAULT_APP_NAME, null);
  }
}

/**
 * Applies the current brand metadata to the current document.
 */
export function applyAppBrandToDocument(): void {
  if (typeof document === "undefined") return;

  const brand = getAppBrand();
  document.title = brand.name;
  const faviconUrl = brand.logoUrl ?? buildMonogramIconDataUrl(brand.monogram);

  for (const rel of ["icon", "shortcut icon"]) {
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
