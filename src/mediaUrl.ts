import { Platform } from "react-native";
import { requireNativeModule } from "expo";

interface MediaUrlNativeModule {
  getMediaContentAuthority(): string;
}

const nativeModule = requireNativeModule<MediaUrlNativeModule>("ComapeoCore");

/**
 * Lazily-resolved authority of the Android `MediaContentProvider`. iOS
 * returns "" from the same Function — the iOS scheme is fixed
 * (`comapeo://media/...`) and does not depend on the consuming app's
 * applicationId. Cached on first read so we don't hop into native code on
 * every <Image> render.
 */
let cachedAndroidAuthority: string | null = null;

function androidAuthority(): string {
  if (cachedAndroidAuthority === null) {
    cachedAndroidAuthority = nativeModule.getMediaContentAuthority();
  }
  return cachedAndroidAuthority;
}

/**
 * Translates a relative media path returned by the backend (e.g. the result
 * of `BlobApi.getUrl()` / `IconApi.getIconUrl()`, post-`@comapeo/core` patch)
 * into a platform-native URL that React Native's `<Image>` can fetch
 * directly without exposing an HTTP endpoint to other apps on the device.
 *
 * Android → `content://<applicationId>.comapeo.media/<path>`, served by
 * `MediaContentProvider` which streams bytes from the backend's UDS-bound
 * Fastify server through a `ParcelFileDescriptor` pipe.
 *
 * iOS → `comapeo://media/<path>`, intercepted by `MediaURLProtocol`
 * (registered globally on first `AppLifecycleDelegate` instantiation) which
 * connects the same UDS and streams the response into the URL loader.
 *
 * @param relativePath A path beginning with `/`, e.g. `/blobs/<projectPublicId>/.../filename.jpg`.
 *                     Pass straight from the backend RPC result.
 */
export function toNativeMediaUrl(relativePath: string): string {
  if (!relativePath.startsWith("/")) {
    throw new Error(
      `Expected relative media path beginning with '/', got: ${relativePath}`,
    );
  }

  if (Platform.OS === "android") {
    return `content://${androidAuthority()}${relativePath}`;
  }
  if (Platform.OS === "ios") {
    return `comapeo://media${relativePath}`;
  }
  throw new Error(`toNativeMediaUrl is not supported on ${Platform.OS}`);
}
