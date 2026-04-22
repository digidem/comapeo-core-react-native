import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { DangerButton } from '@/components/DangerButton';
import { ErrorBanner } from '@/components/ErrorBanner';
import { FormField } from '@/components/FormField';
import { Glyph } from '@/components/Glyph';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Row } from '@/components/Row';
import { Screen } from '@/components/Screen';
import { Section } from '@/components/Section';
import { ShortId } from '@/components/ShortId';
import { relTime, shortId } from '@/lib/format';
import { T } from '@/lib/theme';
import { useAcceptInvite, useRejectInvite, useSingleInvite } from '@comapeo/core-react';

export default function InviteDetail() {
  const router = useRouter();
  const { inviteId } = useLocalSearchParams<{ inviteId: string }>();
  const { data: invite } = useSingleInvite({ inviteId });
  const accept = useAcceptInvite();
  const reject = useRejectInvite();

  const isCoordinator = invite.roleName?.toLowerCase() === 'coordinator';
  const busy = accept.status === 'pending' || reject.status === 'pending';

  const onAccept = () =>
    accept.mutate({ inviteId }, { onSuccess: () => router.replace('/') });
  const onReject = () =>
    reject.mutate({ inviteId }, { onSuccess: () => router.back() });

  return (
    <>
      <Stack.Screen options={{ title: 'Invite' }} />
      <Screen>
        <View style={styles.hero}>
          <View style={styles.heroIcon}>
            <Text style={styles.heroIconText}>
              {invite.projectName[0]?.toUpperCase() ?? '?'}
            </Text>
          </View>
          <Text style={styles.heroTitle}>{invite.projectName || '(unnamed project)'}</Text>
          <Text style={styles.heroBody}>
            <Text style={styles.strong}>{invite.invitorName}</Text>
            {' invited you to join as a '}
            <Text style={styles.strong}>{invite.roleName ?? 'member'}</Text>.
          </Text>
        </View>

        <Section header="What you'll get">
          <Row
            leading={<Glyph bg="#0E6B52" ch="○" size={30} radius={7} />}
            title="Observations"
            subtitle={isCoordinator ? 'Create, edit, and delete' : 'Create and edit your own'}
            showChevron={false}
          />
          <Row
            leading={<Glyph bg={isCoordinator ? '#0891B2' : '#6B7280'} ch="M" size={30} radius={7} />}
            title="Members"
            subtitle={isCoordinator ? 'Invite and manage' : 'View only'}
            showChevron={false}
          />
          <Row
            isLast
            leading={<Glyph bg={isCoordinator ? '#A16207' : '#6B7280'} ch="⚙" size={30} radius={7} />}
            title="Project settings"
            subtitle={isCoordinator ? 'Edit name, color, description' : 'View only'}
            showChevron={false}
          />
        </Section>

        <Section header="Invite">
          <FormField
            label="inviteId"
            value={shortId(invite.inviteId)}
            readOnly
            right={<ShortId id={invite.inviteId} label="inviteId" size="xs" />}
          />
          <FormField
            label="projectInviteId"
            value={shortId(invite.projectInviteId)}
            readOnly
            right={<ShortId id={invite.projectInviteId} label="projectInviteId" size="xs" />}
          />
          <FormField label="roleName" value={invite.roleName ?? '—'} readOnly />
          <FormField label="from" value={invite.invitorName} readOnly />
          <FormField
            label="received"
            value={invite.receivedAt ? relTime(invite.receivedAt) : '—'}
            readOnly
            isLast
          />
        </Section>

        {accept.error ? <ErrorBanner message={accept.error.message} /> : null}
        {reject.error ? <ErrorBanner message={reject.error.message} /> : null}

        <View style={styles.actions}>
          <PrimaryButton onPress={onAccept} disabled={busy}>
            {accept.status === 'pending' ? 'Accepting…' : 'Accept invite'}
          </PrimaryButton>
          <DangerButton onPress={onReject} disabled={busy}>
            {reject.status === 'pending' ? 'Rejecting…' : 'Reject'}
          </DangerButton>
        </View>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  hero: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 4,
    paddingBottom: 20,
    gap: 12,
  },
  heroIcon: {
    width: 72,
    height: 72,
    borderRadius: 16,
    backgroundColor: T.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroIconText: { color: '#fff', fontSize: 30, fontWeight: '600' },
  heroTitle: { fontSize: 22, fontWeight: '600', color: T.text, fontFamily: T.font },
  heroBody: {
    fontSize: 15,
    lineHeight: 22,
    color: T.textMuted,
    textAlign: 'center',
    maxWidth: 320,
    fontFamily: T.font,
  },
  strong: { color: T.text, fontWeight: '500' },
  actions: {
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 12,
  },
});
