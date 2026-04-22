import { Stack, useRouter } from "expo-router";
import { Text } from "react-native";

import { EmptyState } from "@/components/EmptyState";
import { PresetIcon } from "@/components/PresetIcon";
import { Row } from "@/components/Row";
import { Screen } from "@/components/Screen";
import { Section } from "@/components/Section";
import { ShortId } from "@/components/ShortId";
import { T } from "@/lib/theme";
import { useProjectId } from "@/lib/useProjectId";
import { useManyDocs } from "@comapeo/core-react";

export default function PresetList() {
  const router = useRouter();
  const projectId = useProjectId();
  const { data: presets } = useManyDocs({ projectId, docType: "preset" });

  return (
    <>
      <Stack.Screen options={{ title: "Presets" }} />
      <Screen>
        {presets.length === 0 ? (
          <EmptyState title="No presets" />
        ) : (
          <Section>
            {presets.map((p, i) => (
              <Row
                key={p.docId}
                isLast={i === presets.length - 1}
                leading={<PresetIcon name={p.name} color={p.color} size={36} />}
                title={p.name}
                subtitle={
                  <Text style={{ color: T.textMuted, fontSize: 13 }}>
                    {p.geometry.join(", ")} · {p.fieldRefs.length} fields
                  </Text>
                }
                right={<ShortId id={p.docId} size="xs" />}
                onPress={() =>
                  router.push(`/projects/${projectId}/presets/${p.docId}`)
                }
              />
            ))}
          </Section>
        )}
      </Screen>
    </>
  );
}
