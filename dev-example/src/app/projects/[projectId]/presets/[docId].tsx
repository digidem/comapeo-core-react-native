import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { FormField } from '@/components/FormField';
import { PresetIcon } from '@/components/PresetIcon';
import { Row } from '@/components/Row';
import { Screen } from '@/components/Screen';
import { Section } from '@/components/Section';
import { ShortId } from '@/components/ShortId';
import { fmtDateTime, shortId } from '@/lib/format';
import { useProjectId } from '@/lib/useProjectId';
import { useSingleDocByDocId } from '@comapeo/core-react';

export default function PresetDetail() {
  const router = useRouter();
  const projectId = useProjectId();
  const { docId } = useLocalSearchParams<{ docId: string }>();
  const { data: preset } = useSingleDocByDocId({ projectId, docType: 'preset', docId });

  return (
    <>
      <Stack.Screen options={{ title: 'Preset' }} />
      <Screen>
        <Section>
          <View style={styles.header}>
            <PresetIcon name={preset.name} color={preset.color} size={48} />
            <View style={{ flex: 1 }}>
              <FormField label="name" value={preset.name} readOnly />
            </View>
          </View>
        </Section>
        <Section header="Basics">
          <FormField label="geometry" value={preset.geometry.join(', ')} readOnly />
          <FormField
            label="color"
            value={preset.color ?? '—'}
            readOnly
            right={
              preset.color ? (
                <View
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 11,
                    backgroundColor: preset.color,
                  }}
                />
              ) : undefined
            }
          />
          <FormField label="terms" value={preset.terms.join(', ') || '—'} readOnly isLast />
        </Section>
        <Section header="Tags">
          {Object.entries(preset.tags ?? {}).map(([k, v], i, arr) => (
            <FormField key={k} label={k} value={String(v)} readOnly isLast={i === arr.length - 1} />
          ))}
        </Section>
        <Section header={`Field refs (${preset.fieldRefs.length})`}>
          {preset.fieldRefs.map((f, i, arr) => (
            <Row
              key={f.versionId}
              isLast={i === arr.length - 1}
              title={shortId(f.docId)}
              right={<ShortId id={f.docId} label="docId" size="xs" />}
              onPress={() => router.push(`/projects/${projectId}/fields/${f.docId}`)}
            />
          ))}
        </Section>
        <Section header="Common (read-only)">
          <FormField
            label="docId"
            value={shortId(preset.docId)}
            readOnly
            right={<ShortId id={preset.docId} label="docId" size="xs" />}
          />
          <FormField
            label="versionId"
            value={shortId(preset.versionId)}
            readOnly
            right={<ShortId id={preset.versionId} label="versionId" size="xs" />}
          />
          <FormField label="schemaName" value={preset.schemaName} readOnly />
          <FormField label="createdAt" value={fmtDateTime(preset.createdAt)} readOnly isLast />
        </Section>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
  },
});
