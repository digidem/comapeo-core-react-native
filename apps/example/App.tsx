import { comapeo, toNativeMediaUrl } from "@comapeo/core-react-native";
import { Asset } from "expo-asset";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

/**
 * Test fixture for the UDS-bound media server.
 *
 * Walks through the full path that PR #44 introduces:
 *   1. Pick or create a project (so we have a `MapeoProject` to call
 *      `$blobs.create()` on).
 *   2. Resolve a bundled image to a real filesystem path that the embedded
 *      Node.js process can read. On iOS this lands inside the `.app`
 *      bundle; on Android `Asset.downloadAsync()` copies the asset out of
 *      the APK into the app's data dir on first call, then both processes
 *      (main app + `:ComapeoCore` service) share the same UID/sandbox so
 *      the backend can read it.
 *   3. `$blobs.create({ original: filepath }, { mimeType })` — round-trips
 *      bytes into the hyperdrive blob store.
 *   4. `$blobs.getUrl(blobId)` returns a relative path like
 *      `/blobs/<projectPublicId>/.../<name>` (after the @comapeo/core
 *      patch shipped in this PR).
 *   5. `toNativeMediaUrl()` rewrites that to `content://...` (Android) or
 *      `comapeo://media/...` (iOS).
 *   6. `<Image source={{ uri: nativeUrl }} />` renders it. If we see the
 *      bundled test image, the whole stack — UDS bind → ContentProvider /
 *      URLProtocol → JS bridge — works end to end.
 *
 * The two URLs (raw and rewritten) are also rendered as text so a
 * reviewer can eyeball them without DevTools.
 */
type Phase =
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      relativeUrl: string;
      nativeUrl: string;
      projectId: string;
    };

const PROJECT_NAME = "media-url-fixture";

export default function App() {
  const [phase, setPhase] = useState<Phase>({
    kind: "loading",
    message: "Booting backend…",
  });
  const [renderTick, setRenderTick] = useState(0);

  const run = useCallback(async () => {
    setPhase({ kind: "loading", message: "Boot backend + list projects" });

    try {
      const projects = await comapeo.listProjects();
      let projectId = projects.find((p) => p.name === PROJECT_NAME)?.projectId;
      if (!projectId) {
        setPhase({ kind: "loading", message: "Creating fixture project…" });
        projectId = await comapeo.createProject({ name: PROJECT_NAME });
      }

      setPhase({ kind: "loading", message: "Materialising bundled asset…" });
      // require() is the canonical way to ship a bundled asset in
      // React Native. expo-asset's `downloadAsync()` resolves to a
      // localUri the backend can stat() and fopen().
      const asset = Asset.fromModule(require("./assets/icon.png"));
      await asset.downloadAsync();
      if (!asset.localUri) {
        throw new Error("Asset.downloadAsync produced no localUri");
      }
      // Strip the `file://` scheme — `BlobApi.create` wants a plain path.
      const filepath = asset.localUri.replace(/^file:\/\//, "");

      setPhase({ kind: "loading", message: "Saving blob into project…" });
      const project = await comapeo.getProject(projectId);
      const created = await project.$blobs.create(
        { original: filepath },
        { mimeType: "image/png" },
      );

      setPhase({ kind: "loading", message: "Fetching blob URL…" });
      const relativeUrl = await project.$blobs.getUrl({
        driveId: created.driveId,
        type: created.type,
        variant: "original",
        name: created.name,
      });

      const nativeUrl = toNativeMediaUrl(relativeUrl);

      setPhase({
        kind: "ready",
        projectId,
        relativeUrl,
        nativeUrl,
      });
    } catch (e) {
      setPhase({
        kind: "error",
        message: e instanceof Error ? `${e.message}\n${e.stack}` : String(e),
      });
    }
  }, []);

  useEffect(() => {
    run();
  }, [run]);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.contentContainer}
        style={styles.container}
      >
        <Text style={styles.header} testID="header">
          Media URL test fixture
        </Text>
        <Text style={styles.platform}>Platform: {Platform.OS}</Text>

        <PhaseSection
          phase={phase}
          renderTick={renderTick}
          onReload={() => setRenderTick((n) => n + 1)}
          onRetry={run}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

function PhaseSection({
  phase,
  renderTick,
  onReload,
  onRetry,
}: {
  phase: Phase;
  renderTick: number;
  onReload: () => void;
  onRetry: () => void;
}) {
  if (phase.kind === "loading") {
    return (
      <View style={styles.group}>
        <ActivityIndicator />
        <Text style={styles.body}>{phase.message}</Text>
      </View>
    );
  }
  if (phase.kind === "error") {
    return (
      <View style={[styles.group, styles.errorGroup]}>
        <Text style={styles.groupHeader}>Error</Text>
        <Text style={styles.body} selectable>
          {phase.message}
        </Text>
        <PressableButton label="Retry" onPress={onRetry} />
      </View>
    );
  }
  return (
    <ReadyView
      phase={phase}
      renderTick={renderTick}
      onReload={onReload}
      onRetry={onRetry}
    />
  );
}

function ReadyView({
  phase,
  renderTick,
  onReload,
  onRetry,
}: {
  phase: Extract<Phase, { kind: "ready" }>;
  renderTick: number;
  onReload: () => void;
  onRetry: () => void;
}) {
  const imageSource = useMemo(
    () => ({ uri: phase.nativeUrl }),
    // `renderTick` lets the user force-remount the <Image> via the Reload
    // button to confirm the URL is fetched (and not just served from a
    // memory cache from a prior boot of the screen).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [phase.nativeUrl, renderTick],
  );

  return (
    <View>
      <View style={styles.group}>
        <Text style={styles.groupHeader}>Project</Text>
        <Text style={styles.mono} selectable>
          {phase.projectId}
        </Text>
      </View>

      <View style={styles.group}>
        <Text style={styles.groupHeader}>Relative URL (from backend)</Text>
        <Text style={styles.mono} selectable>
          {phase.relativeUrl}
        </Text>
      </View>

      <View style={styles.group}>
        <Text style={styles.groupHeader}>Native URL (after toNativeMediaUrl)</Text>
        <Text style={styles.mono} selectable>
          {phase.nativeUrl}
        </Text>
      </View>

      <View style={styles.group}>
        <Text style={styles.groupHeader}>
          Rendered &lt;Image&gt; (#{renderTick + 1})
        </Text>
        <Image
          // `key` plus `imageSource` rebuild ensure the loader actually
          // re-fetches; otherwise RN would dedupe on URI alone.
          key={renderTick}
          source={imageSource}
          style={styles.image}
          onError={(e) => {
            // Surfaces in dev menu / logcat / Console.app — invaluable
            // when the URLProtocol or ContentProvider misbehaves.
            // eslint-disable-next-line no-console
            console.warn("Image load failed", e.nativeEvent);
          }}
        />
        <View style={styles.buttonRow}>
          <PressableButton label="Reload <Image>" onPress={onReload} />
          <PressableButton label="Re-create blob" onPress={onRetry} />
        </View>
      </View>
    </View>
  );
}

function PressableButton({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.button} onPress={onPress}>
      <Text style={styles.buttonLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = {
  header: {
    fontSize: 26,
    margin: 16,
    fontWeight: "600" as const,
  },
  platform: {
    fontSize: 14,
    marginHorizontal: 16,
    marginBottom: 8,
    color: "#444",
  },
  group: {
    margin: 12,
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 16,
  },
  errorGroup: {
    backgroundColor: "#ffe4e4",
  },
  groupHeader: {
    fontSize: 16,
    fontWeight: "600" as const,
    marginBottom: 8,
  },
  body: {
    fontSize: 14,
  },
  mono: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
    fontSize: 12,
  },
  image: {
    width: 256,
    height: 256,
    backgroundColor: "#eee",
    borderRadius: 8,
  },
  buttonRow: {
    flexDirection: "row" as const,
    flexWrap: "wrap" as const,
    gap: 8,
    marginTop: 12,
  },
  button: {
    backgroundColor: "#0a84ff",
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  buttonLabel: {
    color: "#fff",
    fontWeight: "600" as const,
  },
  container: {
    flex: 1,
    backgroundColor: "#eee",
  },
  contentContainer: {
    paddingBottom: 40,
  },
};
