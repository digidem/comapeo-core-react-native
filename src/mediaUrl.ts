import { requireNativeModule } from "expo";
import { Platform } from "react-native";

/**
 * Media (blob/icon) URL bridge.
 *
 * The backend's media HTTP server binds to a Unix domain socket inside the
 * app sandbox (`media.sock`) — never a TCP port — so no other app on the
 * device can read blobs or icons. Because of that, `@comapeo/core` returns
 * *relative* paths from `$blobs.getUrl()` / `$icons.getIconUrl()` (e.g.
 * `/blobs/<projectPublicId>/<driveId>/<type>/<variant>/<name>`): core has no
 * knowledge of URLs or how media is served. This module is where relative
 * paths become URLs the platform can actually load:
 *
 * - Android → `content://<applicationId>.comapeo.media<path>`, served by
 *   `MediaContentProvider`, which streams bytes from the UDS through a
 *   `ParcelFileDescriptor` pipe.
 * - iOS → `comapeo://media<path>`, intercepted by `MediaURLProtocol` (any
 *   `URLSession.shared` consumer) and `ComapeoMediaImageLoader` (React
 *   Native's `<Image>`), both streaming from the same UDS.
 *
 * Host apps (or `@comapeo/core-react`) prepend {@link getMediaBaseUrl} to the
 * relative paths on data records in the frontend — the backend never sees
 * platform URLs, and core never sees any URL at all.
 */
interface MediaUrlNativeModule {
  getMediaContentAuthority(): string;
  getShareableMediaUrl(relativePath: string): Promise<string>;
}

const nativeModule = requireNativeModule<MediaUrlNativeModule>("ComapeoCore");

/**
 * Cached Android `MediaContentProvider` authority (depends on the consuming
 * app's applicationId, so it must come from native). iOS returns "" from the
 * same Function — its scheme is fixed. Cached so URL composition on render
 * paths doesn't hop into native code repeatedly.
 */
let cachedAndroidAuthority: string | null = null;

function androidAuthority(): string {
  if (cachedAndroidAuthority === null) {
    cachedAndroidAuthority = nativeModule.getMediaContentAuthority();
  }
  return cachedAndroidAuthority;
}

/**
 * The base URL under which the backend's media (blobs and icons) is served
 * on this platform. Prepend it to the relative paths returned by
 * `$blobs.getUrl()` / `$icons.getIconUrl()`:
 *
 * ```ts
 * const url = getMediaBaseUrl() + (await project.$blobs.getUrl(blobId));
 * <Image source={{ uri: url }} />
 * ```
 *
 * Pass this (or a function returning it) to `@comapeo/core-react` so it can
 * append full URLs to data records in the frontend. The value is stable for
 * the lifetime of the process.
 *
 * These URLs work *inside this app only* (in `<Image>`, image caches, etc.).
 * To hand media to another app — the share sheet — use
 * {@link getShareableMediaUrl}.
 */
export function getMediaBaseUrl(): string {
  if (Platform.OS === "android") {
    return `content://${androidAuthority()}`;
  }
  if (Platform.OS === "ios") {
    return "comapeo://media";
  }
  throw new Error(`getMediaBaseUrl is not supported on ${Platform.OS}`);
}

/**
 * Convenience wrapper: {@link getMediaBaseUrl} + `relativePath`.
 *
 * @param relativePath A path beginning with `/`, e.g.
 *   `/blobs/<projectPublicId>/.../<name>` — pass straight from
 *   `$blobs.getUrl()` / `$icons.getIconUrl()`.
 */
export function toMediaUrl(relativePath: string): string {
  if (!relativePath.startsWith("/")) {
    throw new Error(
      `Expected a relative media path beginning with '/', got: ${relativePath}`,
    );
  }
  return getMediaBaseUrl() + relativePath;
}

/**
 * A URL for handing this media to *other apps* via the platform share sheet.
 *
 * The in-app URLs from {@link getMediaBaseUrl} can't cross the process
 * boundary: on iOS `comapeo://` is resolved by a `URLProtocol` that only
 * exists inside this process, and on Android the `content://` stream is
 * only alive while the backend runs. This call snapshots the bytes to a
 * file in the app's cache directory (with an extension derived from the
 * served Content-Type) and returns a `file://` URL — safe to pass to
 * `expo-sharing`, `react-native-share`, or a share `Intent` /
 * `UIActivityViewController` on either platform.
 *
 * The file is a copy; the OS may reclaim the cache directory, so request a
 * fresh URL at share time rather than persisting this one.
 *
 * @param url Either a relative media path (`/blobs/...`) as returned by
 *   `$blobs.getUrl()` / `$icons.getIconUrl()`, or a full in-app media URL
 *   produced by {@link toMediaUrl}.
 */
export async function getShareableMediaUrl(url: string): Promise<string> {
  let relativePath = url;
  const base = getMediaBaseUrl();
  if (relativePath.startsWith(base)) {
    relativePath = relativePath.slice(base.length);
  }
  if (!relativePath.startsWith("/")) {
    throw new Error(
      `Expected a relative media path or a ${base} URL, got: ${url}`,
    );
  }
  return nativeModule.getShareableMediaUrl(relativePath);
}
