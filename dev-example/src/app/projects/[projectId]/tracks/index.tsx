import { Stack, useRouter } from "expo-router";
import { Text } from "react-native";

import { EmptyState } from "@/components/EmptyState";
import { Glyph } from "@/components/Glyph";
import { Row } from "@/components/Row";
import { Screen } from "@/components/Screen";
import { Section } from "@/components/Section";
import { ShortId } from "@/components/ShortId";
import { T } from "@/lib/theme";
import { useProjectId } from "@/lib/useProjectId";
import { useManyDocs } from "@comapeo/core-react";

export default function TrackList() {
  const router = useRouter();
  const projectId = useProjectId();
  const { data: tracks } = useManyDocs({ projectId, docType: "track" });

  return (
    <>
      <Stack.Screen options={{ title: "Tracks" }} />
      <Screen>
        {tracks.length === 0 ? (
          <EmptyState title="No tracks yet" />
        ) : (
          <Section>
            {tracks.map((t, i) => (
              <Row
                key={t.docId}
                isLast={i === tracks.length - 1}
                leading={<Glyph bg="#0369A1" ch="~" size={36} radius={8} />}
                title={(t.tags?.["name"] as string) ?? "(untitled track)"}
                subtitle={
                  <Text style={{ color: T.textMuted, fontSize: 13 }}>
                    {t.locations.length} pts · {t.observationRefs.length} refs
                  </Text>
                }
                right={<ShortId id={t.docId} size="xs" />}
                onPress={() =>
                  router.push(`/projects/${projectId}/tracks/${t.docId}`)
                }
              />
            ))}
          </Section>
        )}
      </Screen>
    </>
  );
}
