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

export default function FieldList() {
  const router = useRouter();
  const projectId = useProjectId();
  const { data: fields } = useManyDocs({ projectId, docType: "field" });

  return (
    <>
      <Stack.Screen options={{ title: "Fields" }} />
      <Screen>
        {fields.length === 0 ? (
          <EmptyState title="No fields" />
        ) : (
          <Section>
            {fields.map((f, i) => (
              <Row
                key={f.docId}
                isLast={i === fields.length - 1}
                leading={
                  <Glyph
                    bg="#7E22CE"
                    ch={(f.type ?? "?")[0]?.toUpperCase() ?? "?"}
                    size={32}
                    radius={6}
                  />
                }
                title={f.label}
                subtitle={
                  <Text style={{ color: T.textMuted, fontSize: 13 }}>
                    {f.type} · {f.tagKey}
                  </Text>
                }
                right={<ShortId id={f.docId} size="xs" />}
                onPress={() =>
                  router.push(`/projects/${projectId}/fields/${f.docId}`)
                }
              />
            ))}
          </Section>
        )}
      </Screen>
    </>
  );
}
