export function trustedUrl(url, origin) {
  try {
    return origin !== null && new URL(url).origin === origin;
  } catch {
    return false;
  }
}

export function allowedDownload(url, origin) {
  return (
    trustedUrl(url, origin) ||
    Boolean(origin && url.startsWith(`blob:${origin}/`)) ||
    /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)
  );
}
