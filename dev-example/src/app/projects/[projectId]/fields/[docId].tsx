import { Stack, useLocalSearchParams } from "expo-router";
import { Text } from "react-native";

import { FormField } from "@/components/FormField";
import { Row } from "@/components/Row";
import { Screen } from "@/components/Screen";
import { Section } from "@/components/Section";
import { ShortId } from "@/components/ShortId";
import { StatusChip } from "@/components/StatusChip";
import { fmtDateTime, shortId } from "@/lib/format";
import { useProjectId } from "@/lib/useProjectId";
import { useSingleDocByDocId } from "@comapeo/core-react";

export default function FieldDetail() {
  const projectId = useProjectId();
  const { docId } = useLocalSearchParams<{ docId: string }>();
  const { data: f } = useSingleDocByDocId({
    projectId,
    docType: "field",
    docId,
  });

  return (
    <>
      <Stack.Screen options={{ title: "Field" }} />
      <Screen>
        <Section>
          <FormField label="label" value={f.label} readOnly />
          <FormField label="tagKey" value={f.tagKey} readOnly />
          <FormField
            label="type"
            value={f.type}
            readOnly
            right={<StatusChip label={f.type} tone="info" />}
          />
          <FormField
            label="universal"
            value={String(f.universal ?? false)}
            readOnly
            isLast
          />
        </Section>
        {f.options && f.options.length > 0 ? (
          <Section header={`Options (${f.options.length})`}>
            {f.options.map((o, i, arr) => (
              <Row
                key={i}
                isLast={i === arr.length - 1}
                title={o.label}
                right={
                  <Text
                    style={{
                      fontFamily: "monospace",
                      fontSize: 13,
                      color: "#666",
                    }}
                  >
                    {JSON.stringify(o.value)}
                  </Text>
                }
              />
            ))}
          </Section>
        ) : null}
        <Section header="Common (read-only)">
          <FormField
            label="docId"
            value={shortId(f.docId)}
            readOnly
            right={<ShortId id={f.docId} size="xs" />}
          />
          <FormField label="schemaName" value={f.schemaName} readOnly />
          <FormField
            label="createdAt"
            value={fmtDateTime(f.createdAt)}
            readOnly
            isLast
          />
        </Section>
      </Screen>
    </>
  );
}
