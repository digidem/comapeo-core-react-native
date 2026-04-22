import { Stack } from 'expo-router';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { EmptyState } from '@/components/EmptyState';
import { Glyph } from '@/components/Glyph';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Row } from '@/components/Row';
import { Screen } from '@/components/Screen';
import { Section } from '@/components/Section';
import { ShortId } from '@/components/ShortId';
import { StatusChip } from '@/components/StatusChip';
import { relTime } from '@/lib/format';
import { T } from '@/lib/theme';
import { useAcceptInvite, useManyInvites, useRejectInvite } from '@comapeo/core-react';

export default function InvitesScreen() {
  const { data: invites } = useManyInvites();
  const accept = useAcceptInvite();
  const reject = useRejectInvite();

  return (
    <>
      <Stack.Screen options={{ title: 'Invites' }} />
      <Screen>
        <Section header="Received">
          {invites.length === 0 ? (
            <EmptyState title="No pending invites" />
          ) : (
            invites.map((inv, i) => (
              <View key={inv.inviteId}>
                <Row
                  isLast={i === invites.length - 1}
                  leading={
                    <Glyph
                      bg={T.primary}
                      ch="✉"
                      size={Platform.OS === 'ios' ? 34 : 40}
                      radius={Platform.OS === 'ios' ? 8 : 20}
                    />
                  }
                  title={inv.projectName || '(unnamed project)'}
                  subtitle={
                    <View style={styles.subtitle}>
                      <ShortId id={inv.inviteId} label="inviteId" size="xs" />
                      {inv.invitorName ? (
                        <Text style={{ color: T.textMuted, fontSize: 13 }}>
                          {' '}from {inv.invitorName}
                          {inv.roleName ? ` · ${inv.roleName}` : ''}
                        </Text>
                      ) : null}
                    </View>
                  }
                  right={<StatusChip label={inv.state} tone={inv.state === 'pending' ? 'warning' : 'neutral'} />}
                />
                <View style={styles.actions}>
                  <PrimaryButton
                    onPress={() => accept.mutate({ inviteId: inv.inviteId })}
                    disabled={accept.status === 'pending'}
                    style={{ flex: 1 }}
                  >
                    Accept
                  </PrimaryButton>
                  <PrimaryButton
                    onPress={() => reject.mutate({ inviteId: inv.inviteId })}
                    disabled={reject.status === 'pending'}
                    style={{ flex: 1, backgroundColor: T.textMuted }}
                  >
                    Reject
                  </PrimaryButton>
                </View>
              </View>
            ))
          )}
        </Section>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  subtitle: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  actions: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
});
