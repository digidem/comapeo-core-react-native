import { Stack, useRouter } from 'expo-router';
import { View } from 'react-native';

import { DangerButton } from '@/components/DangerButton';
import { FormField } from '@/components/FormField';
import { Screen } from '@/components/Screen';
import { Section } from '@/components/Section';
import { ShortId } from '@/components/ShortId';
import { shortId } from '@/lib/format';
import { useProjectId } from '@/lib/useProjectId';
import { useLeaveProject, useProjectSettings } from '@comapeo/core-react';

export default function LeaveProject() {
  const router = useRouter();
  const projectId = useProjectId();
  const { data: settings } = useProjectSettings({ projectId });
  const leave = useLeaveProject();

  const onLeave = () => {
    leave.mutate(
      { projectId },
      {
        onSuccess: () => router.replace('/'),
      },
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Leave project', presentation: 'modal' }} />
      <Screen>
        <Section header="Leave">
          <FormField label="name" value={settings.name} readOnly />
          <FormField
            label="projectId"
            value={shortId(projectId)}
            readOnly
            right={<ShortId id={projectId} label="projectId" size="xs" />}
            isLast
          />
        </Section>
        <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
          <DangerButton onPress={onLeave} disabled={leave.status === 'pending'}>
            {leave.status === 'pending' ? 'Leaving…' : 'Leave project'}
          </DangerButton>
        </View>
      </Screen>
    </>
  );
}
