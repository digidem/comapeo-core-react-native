import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';

import { FormField } from '@/components/FormField';
import { HeaderButton } from '@/components/HeaderButton';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { Section } from '@/components/Section';
import { ShortId } from '@/components/ShortId';
import { shortId } from '@/lib/format';
import { useProjectId } from '@/lib/useProjectId';
import { useProjectSettings, useUpdateProjectSettings } from '@comapeo/core-react';

export default function ProjectSettings() {
  const projectId = useProjectId();
  const { data: settings } = useProjectSettings({ projectId });
  const update = useUpdateProjectSettings({ projectId });

  const [name, setName] = useState(settings.name ?? '');
  const [projectDescription, setDescription] = useState(settings.projectDescription ?? '');
  const [projectColor, setColor] = useState(settings.projectColor ?? '#0E6B52');

  useEffect(() => {
    setName(settings.name ?? '');
    setDescription(settings.projectDescription ?? '');
    setColor(settings.projectColor ?? '#0E6B52');
  }, [settings]);

  const isPending = update.status === 'pending';

  const save = () => {
    update.mutate({ name, projectDescription, projectColor });
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Project settings',
          headerRight: () =>
            Platform.OS === 'ios' ? (
              <HeaderButton label={isPending ? 'Saving…' : 'Save'} onPress={save} />
            ) : undefined,
        }}
      />
      <Screen>
        <Section header="Project">
          <FormField label="name" value={name} onChangeText={setName} />
          <FormField
            label="projectDescription"
            value={projectDescription}
            onChangeText={setDescription}
            multiline
          />
          <FormField
            label="projectColor"
            value={projectColor}
            onChangeText={setColor}
            right={
              <View
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  backgroundColor: projectColor,
                }}
              />
            }
            isLast
          />
        </Section>
        <Section header="Common (read-only)">
          <FormField
            label="projectId"
            value={shortId(projectId)}
            readOnly
            right={<ShortId id={projectId} label="projectId" size="xs" />}
          />
          <FormField label="schemaName" value="projectSettings" readOnly isLast />
        </Section>
        {Platform.OS !== 'ios' ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
            <PrimaryButton onPress={save} disabled={isPending}>
              {isPending ? 'Saving…' : 'Save settings'}
            </PrimaryButton>
          </View>
        ) : null}
      </Screen>
    </>
  );
}
