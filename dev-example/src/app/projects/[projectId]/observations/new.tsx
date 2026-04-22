import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Platform, View } from 'react-native';

import { ErrorBanner } from '@/components/ErrorBanner';
import { FormField } from '@/components/FormField';
import { HeaderButton } from '@/components/HeaderButton';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Row } from '@/components/Row';
import { Screen } from '@/components/Screen';
import { Section } from '@/components/Section';
import { useProjectId } from '@/lib/useProjectId';
import { useCreateDocument, usePresetsSelection } from '@comapeo/core-react';

export default function NewObservation() {
  const router = useRouter();
  const projectId = useProjectId();
  const presets = usePresetsSelection({ projectId, dataType: 'observation' });
  const create = useCreateDocument({ projectId, docType: 'observation' });

  const [presetIdx, setPresetIdx] = useState<number | null>(null);
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [notes, setNotes] = useState('');

  const isPending = create.status === 'pending';
  const errorMessage = create.error?.message;

  const submit = () => {
    const preset = presetIdx == null ? null : presets[presetIdx];
    const tags: Record<string, string> = { ...(preset?.tags as Record<string, string> ?? {}) };
    if (notes.trim()) tags.notes = notes.trim();
    create.mutate(
      {
        value: {
          lat: lat ? Number(lat) : undefined,
          lon: lon ? Number(lon) : undefined,
          tags,
          attachments: [],
          metadata: {},
        },
      },
      { onSuccess: () => router.back() },
    );
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: 'New observation',
          presentation: 'modal',
          headerLeft: () => <HeaderButton label="Cancel" onPress={() => router.back()} />,
          headerRight: () =>
            Platform.OS === 'ios' ? (
              <HeaderButton label={isPending ? 'Saving…' : 'Save'} onPress={submit} />
            ) : undefined,
        }}
      />
      <Screen>
        {errorMessage ? <ErrorBanner message={errorMessage} /> : null}
        <Section header={`Preset (${presets.length})`}>
          {presets.length === 0 ? (
            <Row title="No presets — observation will be saved with no category" />
          ) : (
            presets.map((p, i) => (
              <Row
                key={p.docId}
                isLast={i === presets.length - 1}
                title={p.name}
                onPress={() => setPresetIdx(i)}
                right={presetIdx === i ? <Row title="✓" /> : undefined}
              />
            ))
          )}
        </Section>
        <Section header="Location">
          <FormField
            label="lat"
            value={lat}
            onChangeText={setLat}
            placeholder="-0.4812"
            keyboardType="numbers-and-punctuation"
          />
          <FormField
            label="lon"
            value={lon}
            onChangeText={setLon}
            placeholder="-76.9835"
            keyboardType="numbers-and-punctuation"
            isLast
          />
        </Section>
        <Section header="Notes">
          <FormField
            label="notes"
            value={notes}
            onChangeText={setNotes}
            placeholder="Optional"
            multiline
            isLast
          />
        </Section>
        {Platform.OS !== 'ios' ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
            <PrimaryButton onPress={submit} disabled={isPending}>
              {isPending ? 'Saving…' : 'Create observation'}
            </PrimaryButton>
          </View>
        ) : null}
      </Screen>
    </>
  );
}
