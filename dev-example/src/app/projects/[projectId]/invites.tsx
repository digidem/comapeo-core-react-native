import { Stack } from 'expo-router';
import { useState } from 'react';
import { Platform, View } from 'react-native';

import { ErrorBanner } from '@/components/ErrorBanner';
import { FormField } from '@/components/FormField';
import { HeaderButton } from '@/components/HeaderButton';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { Section } from '@/components/Section';
import { useProjectId } from '@/lib/useProjectId';
import { useSendInvite } from '@comapeo/core-react';

const ROLES = [
  { id: 'f7c150f5a3a9a855', label: 'Coordinator' },
  { id: '012fd2d431c0bf60', label: 'Member' },
] as const;

type RoleId = (typeof ROLES)[number]['id'];

export default function ProjectInvitesScreen() {
  const projectId = useProjectId();
  const send = useSendInvite({ projectId });

  const [deviceId, setDeviceId] = useState('');
  const [roleId, setRoleId] = useState<RoleId>('012fd2d431c0bf60');
  const [roleDescription, setRoleDescription] = useState('');

  const isPending = send.status === 'pending';
  const errorMessage = send.error?.message;

  const submit = () => {
    if (!deviceId.trim()) return;
    send.mutate({
      deviceId: deviceId.trim(),
      roleId,
      roleDescription: roleDescription.trim() || undefined,
    });
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Invite to project',
          headerRight: () =>
            Platform.OS === 'ios' ? (
              <HeaderButton label={isPending ? 'Sending…' : 'Send'} onPress={submit} />
            ) : undefined,
        }}
      />
      <Screen>
        {errorMessage ? <ErrorBanner message={errorMessage} /> : null}
        <Section header="Recipient">
          <FormField
            label="deviceId"
            value={deviceId}
            onChangeText={setDeviceId}
            placeholder="Hex device ID (paste from other device)"
            autoCapitalize="none"
            isLast
          />
        </Section>
        <Section header="Role">
          {ROLES.map((r, i, arr) => (
            <FormField
              key={r.id}
              label={r.label}
              value={roleId === r.id ? '✓ selected' : 'tap to select'}
              readOnly
              isLast={i === arr.length - 1}
              right={
                <PrimaryButton
                  style={{ minHeight: 32, paddingVertical: 6 }}
                  onPress={() => setRoleId(r.id)}
                >
                  {roleId === r.id ? 'Selected' : 'Select'}
                </PrimaryButton>
              }
            />
          ))}
        </Section>
        <Section header="Optional">
          <FormField
            label="roleDescription"
            value={roleDescription}
            onChangeText={setRoleDescription}
            placeholder="Reason or notes"
            multiline
            isLast
          />
        </Section>
        {Platform.OS !== 'ios' ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
            <PrimaryButton onPress={submit} disabled={isPending}>
              {isPending ? 'Sending…' : 'Send invite'}
            </PrimaryButton>
          </View>
        ) : null}
      </Screen>
    </>
  );
}
