import { Stack, useRouter } from 'expo-router';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { EmptyState } from '@/components/EmptyState';
import { Glyph } from '@/components/Glyph';
import { Row } from '@/components/Row';
import { Screen } from '@/components/Screen';
import { Section } from '@/components/Section';
import { ShortId } from '@/components/ShortId';
import { StatusChip } from '@/components/StatusChip';
import { T } from '@/lib/theme';
import { useManyInvites } from '@comapeo/core-react';

export default function InvitesScreen() {
  const router = useRouter();
  const { data: invites } = useManyInvites();
  const pending = invites.filter((i) => i.state === 'pending');

  return (
    <>
      <Stack.Screen options={{ title: 'Invites' }} />
      <Screen>
        <View style={styles.intro}>
          <Text style={styles.introText}>
            Invitations to join projects on other devices. Tap one to view
            details.
          </Text>
        </View>

        <Section header="Pending" footer="useManyInvites() · received on this device">
          {pending.length === 0 ? (
            <EmptyState title="No pending invites" />
          ) : (
            pending.map((inv, i) => (
              <Row
                key={inv.inviteId}
                isLast={i === pending.length - 1}
                onPress={() => router.push(`/invites/${inv.inviteId}`)}
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
                right={<StatusChip label={inv.state} tone="warning" />}
              />
            ))
          )}
        </Section>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  intro: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  introText: { fontSize: 13, color: T.textMuted, lineHeight: 19, fontFamily: T.font },
  subtitle: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
});
