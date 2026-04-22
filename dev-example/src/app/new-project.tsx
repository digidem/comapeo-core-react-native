import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Platform, View } from 'react-native';

import { ErrorBanner } from '@/components/ErrorBanner';
import { FormField } from '@/components/FormField';
import { HeaderButton } from '@/components/HeaderButton';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Screen } from '@/components/Screen';
import { Section } from '@/components/Section';
import { useCreateProject } from '@comapeo/core-react';

export default function NewProject() {
  const router = useRouter();
  const create = useCreateProject();
  const [name, setName] = useState('');
  const [projectDescription, setDescription] = useState('');
  const [projectColor, setColor] = useState('#0E6B52');

  const isPending = create.status === 'pending';
  const errorMessage = create.error?.message;

  const submit = () => {
    if (!name.trim()) {
      Alert.alert('Name required', 'Project name cannot be empty.');
      return;
    }
    create.mutate(
      { name: name.trim(), projectDescription: projectDescription.trim(), projectColor },
      {
        onSuccess: (projectId) => router.replace(`/projects/${projectId}`),
      },
    );
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: 'New project',
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
        <Section header="Project">
          <FormField label="name" value={name} onChangeText={setName} placeholder="Project name" />
          <FormField
            label="projectDescription"
            value={projectDescription}
            onChangeText={setDescription}
            placeholder="Optional description"
            multiline
          />
          <FormField label="projectColor" value={projectColor} onChangeText={setColor} isLast />
        </Section>
        {Platform.OS !== 'ios' ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
            <PrimaryButton onPress={submit} disabled={isPending}>
              {isPending ? 'Saving…' : 'Create project'}
            </PrimaryButton>
          </View>
        ) : null}
      </Screen>
    </>
  );
}
