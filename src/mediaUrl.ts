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
 * A URL for handing this media to *other apps* via the platform share
 * sheet. Rejects if the media doesn't exist, so a bad path fails here
 * rather than opaquely inside the receiving app.
 *
 * **Android** → the same streaming `content://` URI the app renders with
 * (equal to {@link toMediaUrl}). No bytes are copied to disk — nothing for
 * low-storage devices to evict — and the stream is served by the
 * `:ComapeoCore` foreground service, which keeps running across app
 * switches. The provider answers receivers' MIME/display-name lookups from
 * the served HTTP headers. Your share `Intent` must carry
 * `FLAG_GRANT_READ_URI_PERMISSION` with the URI in `setClipData` (libraries
 * like `react-native-share` do this; `expo-sharing` does NOT support
 * `content://` URIs). Caveats: a receiver that defers reading until after
 * the backend stops will fail, as will the rare receiver that requires a
 * *seekable* file descriptor (some video players).
 *
 * **iOS** → a `file://` snapshot (extension derived from the served
 * Content-Type) in Application Support, safe for
 * `UIActivityViewController` / `expo-sharing`. A copy is unavoidable on
 * iOS: share extensions run out-of-process and the `comapeo://` protocol
 * only exists inside this app. Snapshots are pruned after 24h — request a
 * fresh URL at share time rather than persisting one.
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
