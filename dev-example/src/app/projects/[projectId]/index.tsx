import { Stack, useRouter } from "expo-router";
import { Platform, StyleSheet, Text, View } from "react-native";

import { Glyph } from "@/components/Glyph";
import { HeaderButton } from "@/components/HeaderButton";
import { Row } from "@/components/Row";
import { Screen } from "@/components/Screen";
import { Section } from "@/components/Section";
import { ShortId } from "@/components/ShortId";
import { StatusChip } from "@/components/StatusChip";
import { T } from "@/lib/theme";
import { useProjectId } from "@/lib/useProjectId";
import {
  useManyDocs,
  useProjectSettings,
  useSyncState,
} from "@comapeo/core-react";

export default function ProjectHome() {
  const router = useRouter();
  const projectId = useProjectId();
  const { data: settings } = useProjectSettings({ projectId });
  const { data: observations } = useManyDocs({
    projectId,
    docType: "observation",
  });
  const { data: tracks } = useManyDocs({ projectId, docType: "track" });
  const { data: presets } = useManyDocs({ projectId, docType: "preset" });
  const { data: fields } = useManyDocs({ projectId, docType: "field" });
  const sync = useSyncState({ projectId });

  return (
    <>
      <Stack.Screen
        options={{
          title: settings.name ?? "Project",
          headerRight: () =>
            Platform.OS === "ios" ? (
              <HeaderButton
                label="Settings"
                onPress={() => router.push(`/projects/${projectId}/settings`)}
              />
            ) : undefined,
        }}
      />
      <Screen>
        <View style={styles.idRow}>
          <ShortId id={projectId} size="md" />
        </View>

        <Section header="Documents">
          <Row
            leading={<Glyph bg="#0E6B52" ch="○" size={30} radius={7} />}
            title="Observations"
            right={<Count n={observations.length} />}
            onPress={() => router.push(`/projects/${projectId}/observations`)}
          />
          <Row
            leading={<Glyph bg="#0369A1" ch="~" size={30} radius={7} />}
            title="Tracks"
            right={<Count n={tracks.length} />}
            onPress={() => router.push(`/projects/${projectId}/tracks`)}
          />
          <Row
            leading={<Glyph bg="#A16207" ch="◆" size={30} radius={7} />}
            title="Presets"
            right={<Count n={presets.length} />}
            onPress={() => router.push(`/projects/${projectId}/presets`)}
          />
          <Row
            isLast
            leading={<Glyph bg="#7E22CE" ch="▤" size={30} radius={7} />}
            title="Fields"
            right={<Count n={fields.length} />}
            onPress={() => router.push(`/projects/${projectId}/fields`)}
          />
        </Section>

        <Section header="Collaboration">
          <Row
            leading={<Glyph bg="#0891B2" ch="M" size={30} radius={7} />}
            title="Members"
            subtitle="Invite and manage people in this project"
            onPress={() => router.push(`/projects/${projectId}/members`)}
          />
          <Row
            isLast
            leading={<Glyph bg="#0E6B52" ch="⇌" size={30} radius={7} />}
            title="Sync"
            right={
              sync ? (
                <StatusChip
                  label={`${peerCount(sync)} peers`}
                  tone={peerCount(sync) > 0 ? "success" : "neutral"}
                />
              ) : undefined
            }
            onPress={() => router.push(`/projects/${projectId}/sync`)}
          />
        </Section>

        <Section header="Maps & export">
          <Row
            isLast
            leading={<Glyph bg="#475569" ch="▦" size={30} radius={7} />}
            title="Map shares"
            onPress={() => router.push(`/projects/${projectId}/map-shares`)}
          />
        </Section>

        <Section header="Project">
          <Row
            title="Settings"
            onPress={() => router.push(`/projects/${projectId}/settings`)}
          />
          <Row
            isLast
            title={
              <Text style={{ color: T.danger, fontSize: 16 }}>
                Leave project
              </Text>
            }
            onPress={() => router.push(`/projects/${projectId}/leave`)}
          />
        </Section>
      </Screen>
    </>
  );
}

function Count({ n }: { n: number }) {
  return <Text style={styles.count}>{n.toLocaleString()}</Text>;
}

function peerCount(
  sync: { remoteDeviceSyncState?: Record<string, unknown> } | null,
): number {
  if (!sync || !sync.remoteDeviceSyncState) return 0;
  return Object.keys(sync.remoteDeviceSyncState).length;
}

const styles = StyleSheet.create({
  idRow: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  count: {
    fontSize: 15,
    color: T.textMuted,
    fontVariant: ["tabular-nums"],
  },
});
