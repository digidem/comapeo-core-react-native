import { Stack, useRouter } from 'expo-router';
import { Platform, Text, View } from 'react-native';

import { EmptyState } from '@/components/EmptyState';
import { FAB } from '@/components/FAB';
import { Glyph } from '@/components/Glyph';
import { HeaderButton } from '@/components/HeaderButton';
import { Row } from '@/components/Row';
import { Screen } from '@/components/Screen';
import { Section } from '@/components/Section';
import { ShortId } from '@/components/ShortId';
import { StatusChip } from '@/components/StatusChip';
import { colorFromString } from '@/lib/colors';
import { useManyProjects, useOwnDeviceInfo, useManyInvites } from '@comapeo/core-react';

export default function ProjectsHome() {
  const router = useRouter();
  const { data: projects } = useManyProjects();
  const { data: device } = useOwnDeviceInfo();
  const { data: invites } = useManyInvites();

  const goNew = () => router.push('/new-project');

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Projects',
          headerRight: () =>
            Platform.OS === 'ios' ? <HeaderButton label="＋" onPress={goNew} /> : undefined,
        }}
      />
      <Screen>
        <Section header="Your projects">
          {projects.length === 0 ? (
            <EmptyState title="No projects yet" />
          ) : (
            projects.map((proj, i) => (
              <Row
                key={proj.projectId}
                isLast={i === projects.length - 1}
                onPress={() => router.push(`/projects/${proj.projectId}`)}
                leading={
                  <Glyph
                    bg={proj.projectColor || colorFromString(proj.projectId)}
                    ch={(proj.name ?? '?')[0]?.toUpperCase() ?? '?'}
                    size={Platform.OS === 'ios' ? 36 : 40}
                    radius={Platform.OS === 'ios' ? 8 : 20}
                  />
                }
                title={proj.name ?? '(untitled project)'}
                subtitle={
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <ShortId id={proj.projectId} label="projectId" size="xs" />
                  </View>
                }
              />
            ))
          )}
        </Section>

        <Section header="Device">
          <Row
            title="Device info"
            subtitle={device.name}
            right={<ShortId id={device.deviceId} label="deviceId" size="xs" />}
            onPress={() => router.push('/device')}
          />
          <Row
            isLast
            title="Invites"
            subtitle={`${invites.length} received`}
            right={
              invites.length > 0 ? (
                <StatusChip label={`${invites.length}`} tone="info" />
              ) : undefined
            }
            onPress={() => router.push('/invites')}
          />
        </Section>
      </Screen>
      <FAB label="New project" onPress={goNew} />
    </>
  );
}
