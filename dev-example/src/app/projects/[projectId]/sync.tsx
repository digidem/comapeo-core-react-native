import { Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { DangerButton } from '@/components/DangerButton';
import { FormField } from '@/components/FormField';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { Section } from '@/components/Section';
import { T } from '@/lib/theme';
import { useProjectId } from '@/lib/useProjectId';
import {
  useDataSyncProgress,
  useStartSync,
  useStopSync,
  useSyncState,
} from '@comapeo/core-react';

export default function SyncScreen() {
  const projectId = useProjectId();
  const sync = useSyncState({ projectId });
  const progress = useDataSyncProgress({ projectId });
  const start = useStartSync({ projectId });
  const stop = useStopSync({ projectId });

  const pct = progress == null ? 0 : Math.round(progress * 100);

  return (
    <>
      <Stack.Screen options={{ title: 'Sync' }} />
      <Screen>
        <Section header="Data sync">
          <View style={styles.block}>
            <View style={styles.row}>
              <Text style={styles.label}>Progress</Text>
              <Text style={styles.pct}>{pct}%</Text>
            </View>
            <View style={styles.barTrack}>
              <View style={[styles.barFill, { width: `${pct}%` }]} />
            </View>
            <Text style={styles.hint}>useDataSyncProgress() → {(progress ?? 0).toFixed(2)}</Text>
          </View>
        </Section>
        {sync ? (
          <Section header="Peers">
            <FormField
              label="remote devices"
              value={Object.keys(sync.remoteDeviceSyncState ?? {}).length}
              readOnly
            />
            <FormField
              label="initial sync enabled"
              value={String(sync.initial?.isSyncEnabled ?? false)}
              readOnly
            />
            <FormField
              label="data sync enabled"
              value={String(sync.data?.isSyncEnabled ?? false)}
              readOnly
              isLast
            />
          </Section>
        ) : null}
        <View style={styles.actions}>
          <PrimaryButton
            style={{ flex: 1 }}
            onPress={() => start.mutate(undefined)}
            disabled={start.status === 'pending'}
          >
            Start sync
          </PrimaryButton>
          <DangerButton
            style={{ flex: 1 }}
            onPress={() => stop.mutate()}
            disabled={stop.status === 'pending'}
          >
            Stop
          </DangerButton>
        </View>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  block: { padding: 16, gap: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  label: { fontSize: 14, color: T.textMuted, fontFamily: T.font },
  pct: {
    fontSize: 22,
    fontWeight: '500',
    color: T.primary,
    fontFamily: T.mono,
  },
  barTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(60,60,67,0.15)',
    overflow: 'hidden',
  },
  barFill: { height: '100%', backgroundColor: T.primary },
  hint: { fontSize: 12, color: T.textMuted, fontFamily: T.mono, marginTop: 4 },
  actions: {
    paddingHorizontal: 16,
    paddingTop: 16,
    flexDirection: 'row',
    gap: 12,
  },
});
