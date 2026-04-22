import { Stack, useRouter } from "expo-router";
import { Platform, Text } from "react-native";

import { EmptyState } from "@/components/EmptyState";
import { FAB } from "@/components/FAB";
import { Glyph } from "@/components/Glyph";
import { HeaderButton } from "@/components/HeaderButton";
import { Row } from "@/components/Row";
import { Screen } from "@/components/Screen";
import { Section } from "@/components/Section";
import { ShortId } from "@/components/ShortId";
import { StatusChip } from "@/components/StatusChip";
import { relTime } from "@/lib/format";
import { T } from "@/lib/theme";
import { useProjectId } from "@/lib/useProjectId";
import { useManyMembers } from "@comapeo/core-react";

const ROLE_NAME: Record<string, string> = {
  f7c150f5a3a9a855: "coordinator",
  "012fd2d431c0bf60": "member",
  "9e6d29263cba36c9": "blocked",
  "8ced989b1904606b": "left",
  "08e4251e36f6e7ed": "no role",
  a12a6702b93bd7ff: "creator",
};

function tone(roleId: string) {
  if (roleId === "f7c150f5a3a9a855" || roleId === "a12a6702b93bd7ff")
    return "info" as const;
  if (roleId === "9e6d29263cba36c9") return "danger" as const;
  return "neutral" as const;
}

export default function MembersScreen() {
  const router = useRouter();
  const projectId = useProjectId();
  const { data: members } = useManyMembers({ projectId });

  const goInvite = () => router.push(`/projects/${projectId}/invite`);

  return (
    <>
      <Stack.Screen
        options={{
          title: "Members",
          headerRight: () =>
            Platform.OS === "ios" ? (
              <HeaderButton label="Invite" onPress={goInvite} />
            ) : undefined,
        }}
      />
      <Screen>
        {Platform.OS === "ios" ? (
          <Section>
            <Row
              isLast
              onPress={goInvite}
              leading={
                <Glyph bg="rgba(14,107,82,0.12)" ch="＋" size={32} radius={7} />
              }
              title={
                <Text style={{ color: T.primary, fontWeight: "500" }}>
                  Invite a member
                </Text>
              }
              subtitle="Scan their QR to send an invite"
            />
          </Section>
        ) : null}

        <Section header={`In this project (${members.length})`}>
          {members.length === 0 ? (
            <EmptyState title="No members yet" />
          ) : (
            members.map((m, i) => {
              const roleName =
                ROLE_NAME[m.role.roleId] ?? m.role.name ?? "member";
              const initial = (m.name ?? "?")[0]?.toUpperCase() ?? "?";
              return (
                <Row
                  key={m.deviceId}
                  isLast={i === members.length - 1}
                  leading={
                    <Glyph
                      bg={T.primary}
                      ch={initial}
                      size={Platform.OS === "ios" ? 32 : 40}
                    />
                  }
                  title={m.name ?? "(unnamed device)"}
                  subtitle={
                    <Text style={{ color: T.textMuted, fontSize: 13 }}>
                      <ShortId id={m.deviceId} size="xs" />
                      {m.joinedAt ? `  joined ${relTime(m.joinedAt)}` : ""}
                    </Text>
                  }
                  right={
                    <StatusChip label={roleName} tone={tone(m.role.roleId)} />
                  }
                />
              );
            })
          )}
        </Section>
      </Screen>
      <FAB label="Invite member" onPress={goInvite} />
    </>
  );
}
