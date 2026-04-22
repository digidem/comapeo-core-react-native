import { Stack, useLocalSearchParams } from "expo-router";

import { FormField } from "@/components/FormField";
import { Screen } from "@/components/Screen";
import { Section } from "@/components/Section";
import { ShortId } from "@/components/ShortId";
import { fmtDateTime, shortId } from "@/lib/format";
import { useProjectId } from "@/lib/useProjectId";
import { useSingleDocByDocId } from "@comapeo/core-react";

export default function TrackDetail() {
  const projectId = useProjectId();
  const { docId } = useLocalSearchParams<{ docId: string }>();
  const { data: t } = useSingleDocByDocId({
    projectId,
    docType: "track",
    docId,
  });

  return (
    <>
      <Stack.Screen options={{ title: "Track" }} />
      <Screen>
        <Section header="Tags">
          {Object.entries(t.tags ?? {}).map(([k, v], i, arr) => (
            <FormField
              key={k}
              label={k}
              value={String(v)}
              readOnly
              isLast={i === arr.length - 1}
            />
          ))}
        </Section>
        <Section header={`Locations (${t.locations.length})`}>
          <FormField label="count" value={t.locations.length} readOnly isLast />
        </Section>
        <Section header={`Observation refs (${t.observationRefs.length})`}>
          {t.observationRefs.map((ref, i, arr) => (
            <FormField
              key={ref.versionId}
              label={`ref ${i + 1}`}
              value={shortId(ref.docId)}
              readOnly
              right={<ShortId id={ref.docId} size="xs" />}
              isLast={i === arr.length - 1}
            />
          ))}
        </Section>
        <Section header="Common (read-only)">
          <FormField
            label="docId"
            value={shortId(t.docId)}
            readOnly
            right={<ShortId id={t.docId} size="xs" />}
          />
          <FormField
            label="versionId"
            value={shortId(t.versionId)}
            readOnly
            right={<ShortId id={t.versionId} size="xs" />}
          />
          <FormField label="schemaName" value={t.schemaName} readOnly />
          <FormField
            label="createdAt"
            value={fmtDateTime(t.createdAt)}
            readOnly
          />
          <FormField
            label="updatedAt"
            value={fmtDateTime(t.updatedAt)}
            readOnly
            isLast
          />
        </Section>
      </Screen>
    </>
  );
}
