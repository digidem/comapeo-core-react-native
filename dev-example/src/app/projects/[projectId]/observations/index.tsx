import { Stack, useRouter } from 'expo-router';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { AttachmentThumbs } from '@/components/AttachmentThumbs';
import { EmptyState } from '@/components/EmptyState';
import { FAB } from '@/components/FAB';
import { HeaderButton } from '@/components/HeaderButton';
import { PresetIcon } from '@/components/PresetIcon';
import { Screen } from '@/components/Screen';
import { Section } from '@/components/Section';
import { ShortId } from '@/components/ShortId';
import { StatusChip } from '@/components/StatusChip';
import { fmtCoord, relTime } from '@/lib/format';
import { T } from '@/lib/theme';
import { useProjectId } from '@/lib/useProjectId';
import { useManyDocs } from '@comapeo/core-react';

export default function ObservationList() {
  const router = useRouter();
  const projectId = useProjectId();
  const { data: observations } = useManyDocs({ projectId, docType: 'observation' });

  const goNew = () => router.push(`/projects/${projectId}/observations/new`);

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Observations',
          headerRight: () =>
            Platform.OS === 'ios' ? <HeaderButton label="＋" onPress={goNew} /> : undefined,
        }}
      />
      <Screen>
        {observations.length === 0 ? (
          <EmptyState title="No observations yet" />
        ) : (
          <Section>
            {observations.map((o, i) => {
              const isLast = i === observations.length - 1;
              const presetName = (o.tags?.['category'] as string) ?? o.schemaName;
              return (
                <Pressable
                  key={o.docId}
                  android_ripple={{ color: 'rgba(0,0,0,0.06)' }}
                  style={[
                    styles.row,
                    !isLast && {
                      borderBottomColor: T.separator,
                      borderBottomWidth: T.separatorWidth,
                    },
                  ]}
                  onPress={() =>
                    router.push(`/projects/${projectId}/observations/${o.docId}`)
                  }
                >
                  <PresetIcon name={presetName} size={Platform.OS === 'ios' ? 36 : 40} />
                  <View style={styles.body}>
                    <View style={styles.titleRow}>
                      <Text style={styles.title}>{presetName}</Text>
                      {o.deleted ? <StatusChip label="deleted" tone="danger" /> : null}
                    </View>
                    {o.lat != null && o.lon != null ? (
                      <Text style={styles.coord}>
                        {fmtCoord(o.lat, 'lat')} · {fmtCoord(o.lon, 'lon')}
                      </Text>
                    ) : null}
                    <View style={styles.meta}>
                      <ShortId id={o.docId} label="docId" size="xs" />
                      <Text style={styles.metaText}>{relTime(o.updatedAt)}</Text>
                      <View style={{ flex: 1 }} />
                      <AttachmentThumbs attachments={o.attachments} />
                    </View>
                  </View>
                </Pressable>
              );
            })}
          </Section>
        )}
      </Screen>
      <FAB label="New observation" onPress={goNew} />
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: Platform.select({ ios: 10, default: 12 }),
  },
  body: { flex: 1, minWidth: 0 },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 2,
  },
  title: {
    fontSize: 16,
    fontWeight: Platform.select({ ios: '500', default: '400' }),
    color: T.text,
    fontFamily: T.font,
  },
  coord: {
    fontSize: 13,
    color: T.textMuted,
    fontFamily: T.mono,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
  },
  metaText: { fontSize: 11, color: T.textMuted, fontFamily: T.font },
});
