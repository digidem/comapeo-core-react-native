import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Platform, StyleSheet, Text, View } from 'react-native';

import { AttachmentThumbs } from '@/components/AttachmentThumbs';
import { DangerButton } from '@/components/DangerButton';
import { FormField } from '@/components/FormField';
import { HeaderButton } from '@/components/HeaderButton';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Row } from '@/components/Row';
import { Screen } from '@/components/Screen';
import { Section } from '@/components/Section';
import { ShortId } from '@/components/ShortId';
import { fmtDateTime, shortId } from '@/lib/format';
import { T } from '@/lib/theme';
import { useProjectId } from '@/lib/useProjectId';
import {
  useDeleteDocument,
  useSingleDocByDocId,
  useUpdateDocument,
} from '@comapeo/core-react';

export default function ObservationDetail() {
  const router = useRouter();
  const projectId = useProjectId();
  const { docId } = useLocalSearchParams<{ docId: string }>();
  const { data: o } = useSingleDocByDocId({ projectId, docType: 'observation', docId });

  const update = useUpdateDocument({ projectId, docType: 'observation' });
  const remove = useDeleteDocument({ projectId, docType: 'observation' });

  // Track tag edits as a string-keyed dict (we don't expose nested editing).
  const initialTags = useMemo(
    () => Object.fromEntries(Object.entries(o.tags ?? {}).map(([k, v]) => [k, String(v)])),
    [o.tags],
  );
  const [tags, setTags] = useState<Record<string, string>>(initialTags);

  const isPending = update.status === 'pending';
  const presetName = (tags['category'] as string) || 'observation';

  const save = () => {
    update.mutate({
      versionId: o.versionId,
      value: {
        lat: o.lat,
        lon: o.lon,
        tags,
        attachments: o.attachments,
        metadata: o.metadata ?? {},
      },
    });
  };

  const onDelete = () => {
    Alert.alert(
      'Delete observation?',
      'This marks the observation as deleted in the project history.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () =>
            remove.mutate({ docId }, { onSuccess: () => router.back() }),
        },
      ],
    );
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: presetName,
          headerRight: () =>
            Platform.OS === 'ios' ? (
              <HeaderButton label={isPending ? 'Saving…' : 'Save'} onPress={save} />
            ) : undefined,
        }}
      />
      <Screen>
        <Section header="Location">
          <FormField label="lat" value={o.lat?.toFixed(6) ?? '—'} readOnly />
          <FormField label="lon" value={o.lon?.toFixed(6) ?? '—'} readOnly isLast />
        </Section>

        <Section header={`Tags (${Object.keys(tags).length})`}>
          {Object.entries(tags).map(([k, v], i, arr) => (
            <FormField
              key={k}
              label={k}
              value={v}
              onChangeText={(next) => setTags((prev) => ({ ...prev, [k]: next }))}
              isLast={i === arr.length - 1}
            />
          ))}
          {Object.keys(tags).length === 0 ? (
            <Row title="No tags" />
          ) : null}
        </Section>

        {o.attachments?.length > 0 ? (
          <Section header={`Attachments (${o.attachments.length})`}>
            <View style={styles.thumbs}>
              <AttachmentThumbs attachments={o.attachments} />
            </View>
          </Section>
        ) : null}

        <Section header="Common (read-only)">
          <FormField
            label="docId"
            value={shortId(o.docId)}
            readOnly
            right={<ShortId id={o.docId} label="docId" size="xs" />}
          />
          <FormField
            label="versionId"
            value={shortId(o.versionId)}
            readOnly
            right={<ShortId id={o.versionId} label="versionId" size="xs" />}
          />
          <FormField
            label="originalVersionId"
            value={shortId(o.originalVersionId)}
            readOnly
            right={<ShortId id={o.originalVersionId} label="originalVersionId" size="xs" />}
          />
          <FormField label="schemaName" value={o.schemaName} readOnly />
          <FormField label="createdAt" value={fmtDateTime(o.createdAt)} readOnly />
          <FormField label="updatedAt" value={fmtDateTime(o.updatedAt)} readOnly />
          <FormField label="deleted" value={String(o.deleted)} readOnly isLast />
        </Section>

        <View style={styles.actions}>
          {Platform.OS !== 'ios' ? (
            <PrimaryButton onPress={save} disabled={isPending}>
              {isPending ? 'Saving…' : 'Save changes'}
            </PrimaryButton>
          ) : null}
          <DangerButton onPress={onDelete} disabled={remove.status === 'pending'}>
            {remove.status === 'pending' ? 'Deleting…' : 'Delete observation'}
          </DangerButton>
        </View>

        {update.error ? (
          <Text style={styles.errorText}>{update.error.message}</Text>
        ) : null}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  thumbs: { padding: 12 },
  actions: { paddingHorizontal: 16, paddingTop: 16, gap: 12 },
  errorText: { color: T.danger, paddingHorizontal: 16, paddingTop: 8, fontSize: 13 },
});
