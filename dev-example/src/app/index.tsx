import { Stack, useRouter } from "expo-router";
import { Platform, Text, View } from "react-native";

import { FAB } from "@/components/FAB";
import { Glyph } from "@/components/Glyph";
import { HeaderButton } from "@/components/HeaderButton";
import { Row } from "@/components/Row";
import { Screen } from "@/components/Screen";
import { Section } from "@/components/Section";
import { ShortId } from "@/components/ShortId";
import { StatusChip } from "@/components/StatusChip";
import { colorFromString } from "@/lib/colors";
import { T } from "@/lib/theme";
import {
  useManyInvites,
  useManyProjects,
  useOwnDeviceInfo,
} from "@comapeo/core-react";

const tintedTitle = { color: T.primary, fontWeight: "500" as const };

export default function ProjectsHome() {
  const router = useRouter();
  const { data: projects } = useManyProjects();
  const { data: device } = useOwnDeviceInfo();
  const { data: invites } = useManyInvites();

  const pendingInvites = invites.filter((i) => i.state === "pending");
  const empty = projects.length === 0;

  const goNew = () => router.push("/new-project");
  const goJoin = () => router.push("/join");

  return (
    <>
      <Stack.Screen
        options={{
          title: "Projects",
          headerRight: () =>
            Platform.OS === "ios" ? (
              <HeaderButton label="＋" onPress={goNew} />
            ) : undefined,
        }}
      />
      <Screen>
        {pendingInvites.length > 0 ? (
          <Section
            header="Invites"
            footer="useManyInvites() · from other devices on your network"
          >
            <Row
              isLast
              onPress={() => router.push("/invites")}
              leading={
                <Glyph
                  bg="#DB2777"
                  ch="✉"
                  size={Platform.OS === "ios" ? 32 : 40}
                  radius={Platform.OS === "ios" ? 7 : 20}
                />
              }
              title={`${pendingInvites.length} pending invite${pendingInvites.length === 1 ? "" : "s"}`}
              subtitle={`from ${pendingInvites.map((i) => i.invitorName).join(", ")}`}
              right={
                <StatusChip label={`${pendingInvites.length}`} tone="warning" />
              }
            />
          </Section>
        ) : null}

        <Section header={empty ? "Get started" : "Your projects"}>
          {empty ? (
            <>
              <Row
                onPress={goJoin}
                leading={
                  <Glyph
                    bg={T.primary}
                    ch="▦"
                    size={Platform.OS === "ios" ? 36 : 40}
                    radius={Platform.OS === "ios" ? 8 : 20}
                  />
                }
                title={<Text style={tintedTitle}>Join a project</Text>}
                subtitle="Show your QR code to receive an invite"
              />
              <Row
                isLast
                onPress={goNew}
                leading={
                  <Glyph
                    bg="rgba(14,107,82,0.12)"
                    ch="＋"
                    size={Platform.OS === "ios" ? 36 : 40}
                    radius={Platform.OS === "ios" ? 8 : 20}
                  />
                }
                title={<Text style={tintedTitle}>Create a project</Text>}
                subtitle="Start a new project on this device"
              />
            </>
          ) : (
            projects.map((proj, i) => (
              <Row
                key={proj.projectId}
                isLast={i === projects.length - 1}
                onPress={() => router.push(`/projects/${proj.projectId}`)}
                leading={
                  <Glyph
                    bg={proj.projectColor || colorFromString(proj.projectId)}
                    ch={(proj.name ?? "?")[0]?.toUpperCase() ?? "?"}
                    size={Platform.OS === "ios" ? 36 : 40}
                    radius={Platform.OS === "ios" ? 8 : 20}
                  />
                }
                title={proj.name ?? "(untitled project)"}
                subtitle={
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <ShortId id={proj.projectId} size="xs" />
                  </View>
                }
              />
            ))
          )}
        </Section>

        {!empty ? (
          <Section header="Join another">
            <Row
              isLast
              onPress={goJoin}
              leading={
                <Glyph
                  bg="rgba(14,107,82,0.12)"
                  ch="▦"
                  size={Platform.OS === "ios" ? 32 : 40}
                  radius={Platform.OS === "ios" ? 7 : 20}
                />
              }
              title={<Text style={tintedTitle}>Show QR to join</Text>}
              subtitle="Let someone with a project invite this device"
            />
          </Section>
        ) : null}

        <Section header="Device">
          <Row
            isLast
            title="Device info"
            subtitle={device.name}
            right={<ShortId id={device.deviceId} size="xs" />}
            onPress={() => router.push("/device")}
          />
        </Section>
      </Screen>
      <FAB label="New project" onPress={goNew} />
    </>
  );
}
